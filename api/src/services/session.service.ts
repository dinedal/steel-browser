import { FastifyBaseLogger } from "fastify";
import { mkdir, mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { env } from "../env.js";
import { BrowserFingerprintWithHeaders } from "fingerprint-generator";
import { CredentialsOptions, SessionDetails } from "../modules/sessions/sessions.schema.js";
import {
  BrowserLaunchExtra,
  BrowserLauncherOptions,
  OptimizeBandwidthOptions,
} from "../types/index.js";
import { IProxyServer, ProxyServer } from "../utils/proxy.js";
import { getBaseUrl, getUrl } from "../utils/url.js";
import { CDPService } from "./cdp/cdp.service.js";
import { ShutdownReason } from "./cdp/plugins/core/base-plugin.js";
import { CookieData } from "./context/types.js";
import { FileService } from "./file.service.js";
import { SeleniumService } from "./selenium.service.js";
import { TimezoneFetcher } from "./timezone-fetcher.service.js";
import { deepMerge } from "../utils/context.js";

type Session = SessionDetails & {
  completion: Promise<void>;
  complete: (value: void) => void;
  proxyServer: IProxyServer | undefined;
};

const sessionStats = {
  duration: 0,
  eventCount: 0,
  timeout: 0,
  creditsUsed: 0,
  proxyTxBytes: 0,
  proxyRxBytes: 0,
};

const defaultSession = {
  status: "idle" as SessionDetails["status"],
  websocketUrl: getBaseUrl("ws"),
  debugUrl: getUrl("v1/sessions/debug"),
  debuggerUrl: getUrl("v1/devtools/inspector.html"),
  sessionViewerUrl: getBaseUrl(),
  dimensions: { width: 1920, height: 1080 },
  userAgent: "",
  isSelenium: false,
  proxy: "",
  solveCaptcha: false,
};

const ephemeralProfileRoot = path.join(os.tmpdir(), "steel-sessions");

export type ProxyFactory = (
  proxyUrl: string,
  options?: OptimizeBandwidthOptions,
) => Promise<IProxyServer> | IProxyServer;

export class SessionService {
  private logger: FastifyBaseLogger;
  private cdpService: CDPService;
  private seleniumService: SeleniumService;
  private fileService: FileService;
  private timezoneFetcher: TimezoneFetcher;
  private activeProfileDir: string | null = null;
  public proxyFactory: ProxyFactory = (proxyUrl) => new ProxyServer(proxyUrl);

  public pastSessions: Session[] = [];
  public activeSession: Session;

  constructor(config: {
    cdpService: CDPService;
    seleniumService: SeleniumService;
    fileService: FileService;
    logger: FastifyBaseLogger;
  }) {
    this.cdpService = config.cdpService;
    this.seleniumService = config.seleniumService;
    this.fileService = config.fileService;
    this.logger = config.logger;
    this.timezoneFetcher = new TimezoneFetcher(config.logger);
    this.cdpService.setDisconnectHandler(() => this.handleBrowserDisconnect());
    this.activeSession = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      ...defaultSession,
      ...sessionStats,
      userAgent: this.cdpService.getUserAgent() ?? "",
      dimensions: this.cdpService.getDimensions(),
      completion: Promise.resolve(),
      complete: () => {},
      proxyServer: undefined,
    };
  }

  public async startSession(options: {
    sessionId?: string;
    proxyUrl?: string;
    userAgent?: string;
    sessionContext?: {
      cookies?: CookieData[];
      localStorage?: Record<string, Record<string, any>>;
    };
    isSelenium?: boolean;
    fingerprint?: BrowserFingerprintWithHeaders;
    logSinkUrl?: string;
    blockAds?: boolean;
    optimizeBandwidth?: boolean | OptimizeBandwidthOptions;
    extensions?: string[];
    timezone?: string;
    dimensions?: { width: number; height: number };
    extra?: BrowserLaunchExtra;
    credentials: CredentialsOptions;
    skipFingerprintInjection?: boolean;
    userPreferences?: Record<string, any>;
    deviceConfig?: { device: "desktop" | "mobile" };
    fullscreen?: boolean;
    headless?: boolean;
    dangerouslyLogRequestDetails?: boolean;
    caCertificates?: string[];
  }): Promise<SessionDetails> {
    const {
      sessionId,
      proxyUrl,
      userAgent,
      sessionContext,
      extensions,
      logSinkUrl,
      dimensions,
      fingerprint,
      isSelenium,
      blockAds,
      optimizeBandwidth,
      extra,
      credentials,
      skipFingerprintInjection,
      userPreferences,
      deviceConfig,
      fullscreen,
      headless,
      dangerouslyLogRequestDetails,
      caCertificates,
    } = options;
    const resolvedSessionId = sessionId || uuidv4();

    // start fetching timezone as early as possible
    let timezonePromise: Promise<string>;
    if (options.timezone) {
      timezonePromise = Promise.resolve(options.timezone);
    } else {
      timezonePromise = this.timezoneFetcher.getTimezone(
        proxyUrl,
        env.DEFAULT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
    }

    // If dimensions not provided, get from CDP service
    const MIN_MOBILE_WIDTH = 508;
    const MIN_MOBILE_HEIGHT = 1074;
    const isMobileDevice = deviceConfig?.device === "mobile";
    const resolvedDimensions = dimensions || this.cdpService.getDimensions();
    const finalDimensions =
      isMobileDevice && resolvedDimensions
        ? {
            width: Math.max(resolvedDimensions.width, MIN_MOBILE_WIDTH),
            height: Math.max(resolvedDimensions.height, MIN_MOBILE_HEIGHT),
          }
        : resolvedDimensions;

    await this.resetSessionInfo({
      id: resolvedSessionId,
      status: "live",
      proxy: proxyUrl,
      solveCaptcha: false,
      dimensions: finalDimensions,
      isSelenium,
      deviceConfig,
    });

    const defaultUserPreferences = {
      plugins: {
        always_open_pdf_externally: true,
        plugins_disabled: ["Chrome PDF Viewer"],
      },
    };

    const mergedUserPreferences = userPreferences
      ? deepMerge(defaultUserPreferences, userPreferences)
      : defaultUserPreferences;

    // Normalize optimizeBandwidth: true => enable all flags (except lists)
    const normalizeOptimizeBandwidth = (
      value: boolean | OptimizeBandwidthOptions | undefined,
    ): OptimizeBandwidthOptions | undefined => {
      if (value === true) {
        return { blockImages: true, blockMedia: true, blockStylesheets: true };
      }
      if (value && typeof value === "object") {
        return { ...value };
      }
      return undefined;
    };

    const normalizedOptimize = normalizeOptimizeBandwidth(optimizeBandwidth);

    try {
      const userDataDir = await this.createEphemeralProfileDir();

      if (proxyUrl) {
        this.activeSession.proxyServer = await this.proxyFactory(proxyUrl, normalizedOptimize);
        await this.activeSession.proxyServer.listen();
      }

      const browserLauncherOptions: BrowserLauncherOptions = {
        options: {
          headless: headless ?? env.CHROME_HEADLESS,
          proxyUrl: this.activeSession.proxyServer?.url,
        },
        sessionContext,
        userAgent,
        blockAds,
        fingerprint,
        optimizeBandwidth: normalizedOptimize,
        extensions: extensions || [],
        logSinkUrl,
        timezone: timezonePromise,
        dimensions: finalDimensions,
        userDataDir,
        userPreferences: mergedUserPreferences,
        extra,
        credentials,
        skipFingerprintInjection,
        deviceConfig,
        fullscreen,
        dangerouslyLogRequestDetails,
        caCertificates,
      };

      if (isSelenium) {
        await this.cdpService.shutdown(ShutdownReason.MODE_SWITCH);
        await this.seleniumService.launch(browserLauncherOptions);

        Object.assign(this.activeSession, {
          websocketUrl: "",
          debugUrl: "",
          sessionViewerUrl: "",
          userAgent:
            userAgent ||
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          dimensions: this.cdpService.getDimensions(),
          deviceConfig,
        });

        return this.activeSession;
      } else {
        await this.cdpService.startNewSession(browserLauncherOptions);

        Object.assign(this.activeSession, {
          websocketUrl: getBaseUrl("ws"),
          debugUrl: getUrl("v1/sessions/debug"),
          debuggerUrl: getUrl("v1/devtools/inspector.html"),
          sessionViewerUrl: getBaseUrl(),
          userAgent:
            this.cdpService.getUserAgent() ||
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          dimensions: this.cdpService.getDimensions(),
          deviceConfig,
        });
      }
    } catch (error) {
      await this.cleanupActiveProfileDir();
      await this.resetSessionInfo({
        id: uuidv4(),
        status: "idle",
      });
      throw error;
    }

    return this.activeSession;
  }

  public async endSession(): Promise<SessionDetails> {
    this.activeSession.complete();
    this.activeSession.status = "released";
    this.activeSession.duration =
      new Date().getTime() - new Date(this.activeSession.createdAt).getTime();

    if (this.activeSession.proxyServer) {
      this.activeSession.proxyTxBytes = this.activeSession.proxyServer.txBytes;
      this.activeSession.proxyRxBytes = this.activeSession.proxyServer.rxBytes;
    }

    if (this.activeSession.isSelenium) {
      this.seleniumService.close();
      await this.cdpService.launch();
    } else {
      await this.cdpService.endSession();
    }

    const releasedSession = this.activeSession;

    await this.cleanupActiveProfileDir();

    await this.resetSessionInfo({
      id: uuidv4(),
      status: "idle",
    });

    this.pastSessions.push(releasedSession);

    return releasedSession;
  }

  private async resetSessionInfo(overrides?: Partial<SessionDetails>): Promise<SessionDetails> {
    this.activeSession.complete();

    await this.activeSession.proxyServer?.close(true);
    this.activeSession.proxyServer = undefined;

    const { promise, resolve } = Promise.withResolvers<void>();
    this.activeSession = {
      id: uuidv4(),
      ...defaultSession,
      ...overrides,
      ...sessionStats,
      userAgent: this.cdpService.getUserAgent() ?? "",
      createdAt: new Date().toISOString(),
      completion: promise,
      complete: resolve,
      proxyServer: undefined,
    };

    return this.activeSession;
  }

  private async createEphemeralProfileDir(): Promise<string> {
    await mkdir(ephemeralProfileRoot, { recursive: true });
    const profileDir = await mkdtemp(path.join(ephemeralProfileRoot, "session-"));
    this.activeProfileDir = profileDir;
    return profileDir;
  }

  private async cleanupActiveProfileDir(): Promise<void> {
    const profileDir = this.activeProfileDir;
    this.activeProfileDir = null;
    await this.removeOwnedProfileDir(profileDir);
  }

  private async removeOwnedProfileDir(profileDir: string | null): Promise<void> {
    if (!profileDir) {
      return;
    }

    const root = path.resolve(ephemeralProfileRoot);
    const target = path.resolve(profileDir);
    const relative = path.relative(root, target);

    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      this.logger.warn(`[SessionService] Refusing to remove non-owned profile dir: ${profileDir}`);
      return;
    }

    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn(`[SessionService] Failed to remove profile dir ${profileDir}: ${error}`);
    }
  }

  private async handleBrowserDisconnect(): Promise<void> {
    if (this.activeSession.status === "live") {
      await this.endSession();
      return;
    }

    await this.cdpService.endSession();
  }

  public setProxyFactory(factory: ProxyFactory) {
    this.proxyFactory = factory;
  }
}
