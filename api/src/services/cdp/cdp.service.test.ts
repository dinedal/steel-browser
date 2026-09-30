import { EventEmitter } from "events";
import { FastifyBaseLogger } from "fastify";
import { pino } from "pino";
import { Browser, HTTPRequest, Page, Target, TargetType } from "puppeteer-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmitEvent } from "../../types/index.js";
import { CDPService } from "./cdp.service.js";
import { LaunchTimeoutError } from "./errors/launch-errors.js";
import { ShutdownReason } from "./plugins/core/base-plugin.js";

function createTargetSetup(device?: "desktop" | "mobile", headless = true) {
  const logger: FastifyBaseLogger = pino({ enabled: false });
  vi.spyOn(logger, "child").mockReturnValue(logger);
  const debug = vi.spyOn(logger, "debug");
  const logError = vi.spyOn(logger, "error");
  const service = new CDPService({ keepAlive: false }, logger);
  service["launchConfig"] = {
    options: { headless },
    deviceConfig: device ? { device } : undefined,
    customHeaders: { "x-test": "target-setup" },
    skipFingerprintInjection: true,
  };
  vi.spyOn(service["targetInstrumentationManager"], "attach").mockResolvedValue(undefined);
  const onPageCreated = vi.spyOn(service["pluginManager"], "onPageCreated");
  const page = Object.assign(new EventEmitter(), {
    url: vi.fn().mockReturnValue("about:blank"),
    evaluateOnNewDocument: vi.fn<Page["evaluateOnNewDocument"]>().mockResolvedValue({
      identifier: "cursor-script",
    }),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    setRequestInterception: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    target: vi.fn(),
  });
  vi.spyOn(page, "on");
  const target = {
    _targetId: "test-target",
    type: () => TargetType.PAGE,
    page: vi.fn().mockResolvedValue(page),
  } as unknown as Target;
  page.target.mockReturnValue(target);

  const browser = Object.assign(new EventEmitter(), {
    connected: true,
    process: vi.fn().mockReturnValue({}),
  });
  service["registerBrowserHandlers"](browser as unknown as Browser);

  return { service, page, target, browser, debug, logError, onPageCreated };
}

describe("CDPService target cursor setup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a rejected cursor script and completes target setup without an unhandled rejection", async () => {
    const { service, page, target, debug } = createTargetSetup();
    const error = new Error("Requesting main frame too early!");
    const injection = Promise.withResolvers<{ identifier: string }>();
    page.evaluateOnNewDocument.mockReturnValueOnce(injection.promise);
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);

    try {
      const setup = service["handleNewTarget"](target);
      await vi.waitFor(() => expect(page.evaluateOnNewDocument).toHaveBeenCalledOnce());
      injection.reject(error);

      await expect(setup).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(debug).toHaveBeenCalledWith(`[CDPService] Error installing mouse helper: ${error}`);
      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(page.setExtraHTTPHeaders).toHaveBeenCalledWith(
        expect.objectContaining({ "x-test": "target-setup" }),
      );
      expect(page.setRequestInterception).toHaveBeenCalledWith(true);
      expect(page.on).toHaveBeenCalledWith("request", expect.any(Function));
      expect(page.on).toHaveBeenCalledWith("response", expect.any(Function));
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  it.each([undefined, "mobile"] as const)(
    "awaits normal cursor setup for device %s before continuing",
    async (device) => {
      const { service, page, target, debug } = createTargetSetup(device);
      const injection = Promise.withResolvers<{ identifier: string }>();
      page.evaluateOnNewDocument.mockReturnValueOnce(injection.promise);
      let completed = false;
      const setup = service["handleNewTarget"](target).then(() => {
        completed = true;
      });

      await vi.waitFor(() => expect(page.evaluateOnNewDocument).toHaveBeenCalledOnce());
      expect(page.evaluateOnNewDocument).toHaveBeenCalledWith(
        expect.any(Function),
        device || "desktop",
      );
      expect(completed).toBe(false);
      expect(page.setExtraHTTPHeaders).not.toHaveBeenCalled();

      injection.resolve({ identifier: "cursor-script" });
      await setup;

      expect(completed).toBe(true);
      expect(page.setRequestInterception).toHaveBeenCalledWith(true);
      expect(debug).not.toHaveBeenCalled();
    },
  );

  it("skips cursor setup in headed mode", async () => {
    const { service, page, target } = createTargetSetup("desktop", false);

    await service["handleNewTarget"](target);

    expect(page.evaluateOnNewDocument).not.toHaveBeenCalled();
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);
  });

  it.each(["plugins", "headers", "request interception"])(
    "preserves required %s setup errors",
    async (operation) => {
      const { service, page, target, debug, onPageCreated } = createTargetSetup();
      const error = new Error(`${operation} setup failed`);
      if (operation === "plugins") {
        onPageCreated.mockRejectedValueOnce(error);
      } else if (operation === "headers") {
        page.setExtraHTTPHeaders.mockRejectedValueOnce(error);
      } else {
        page.setRequestInterception.mockRejectedValueOnce(error);
      }

      await expect(service["handleNewTarget"](target)).rejects.toBe(error);

      expect(debug).not.toHaveBeenCalled();
      expect(page.on).not.toHaveBeenCalled();
    },
  );
});

describe("CDPService event error boundaries", () => {
  const unhandledRejection = vi.fn();

  beforeEach(() => {
    unhandledRejection.mockClear();
    process.on("unhandledRejection", unhandledRejection);
  });

  afterEach(async () => {
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
      vi.restoreAllMocks();
    }
  });

  it.each(["headers", "request interception"])(
    "logs failed target %s setup and closes the incomplete page",
    async (operation) => {
      const { browser, page, target, logError } = createTargetSetup();
      const error = new Error("Protocol error (Network.setCacheDisabled): Target closed");
      if (operation === "headers") {
        page.setExtraHTTPHeaders.mockRejectedValueOnce(error);
      } else {
        page.setRequestInterception.mockRejectedValueOnce(error);
      }

      browser.emit("targetcreated", target);

      await vi.waitFor(() => {
        expect(logError).toHaveBeenCalledWith(
          { err: error, event: "targetcreated" },
          "[CDPService] Event handler failed",
        );
      });
      expect(page.close).toHaveBeenCalledOnce();
      expect(page.on).not.toHaveBeenCalled();
    },
  );

  it("retains the setup error when closing the failed target also rejects", async () => {
    const { browser, page, target, logError } = createTargetSetup();
    const setupError = new Error("Target closed during interception setup");
    const closeError = new Error("Session closed during cleanup");
    page.setRequestInterception.mockRejectedValueOnce(setupError);
    page.close.mockRejectedValueOnce(closeError);

    browser.emit("targetcreated", target);

    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith(
        { err: setupError, event: "targetcreated" },
        "[CDPService] Event handler failed",
      );
    });
    expect(logError).toHaveBeenCalledWith(
      { err: closeError, event: "targetcreated.close" },
      "[CDPService] Event handler failed",
    );
  });

  it("keeps target setup working when optional cursor injection loses its session", async () => {
    const { browser, page, target, debug, logError } = createTargetSetup();
    const error = new Error(
      "Protocol error (Page.addScriptToEvaluateOnNewDocument): Session closed",
    );
    page.evaluateOnNewDocument.mockRejectedValueOnce(error);

    browser.emit("targetcreated", target);

    await vi.waitFor(() => expect(page.on).toHaveBeenCalledWith("request", expect.any(Function)));
    expect(debug).toHaveBeenCalledWith(`[CDPService] Error installing mouse helper: ${error}`);
    expect(logError).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
  });

  it("contains failures from target-change notifications", async () => {
    const { service, browser, target, logError } = createTargetSetup();
    const error = new Error("Page notification failed");
    service.on(EmitEvent.PageId, () => {
      throw error;
    });

    browser.emit("targetchanged", target);

    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith(
        { err: error, event: "targetchanged" },
        "[CDPService] Event handler failed",
      );
    });
    await expect(service["handleTargetChange"](target)).rejects.toBe(error);
  });

  it("contains a launch timeout during disconnected recovery and remains unhealthy", async () => {
    const { service, browser, logError } = createTargetSetup();
    const error = new LaunchTimeoutError(60000);
    const recover = vi.fn().mockRejectedValue(error);
    service.setDisconnectHandler(recover);
    browser.connected = false;
    service["browserInstance"] = browser as unknown as Browser;

    browser.emit("disconnected");

    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith(
        { err: error, event: "disconnected" },
        "[CDPService] Event handler failed",
      );
    });
    expect(recover).toHaveBeenCalledOnce();
    expect(service.isRunning()).toBe(false);
    await expect(service["onDisconnect"]()).rejects.toBe(error);
  });

  it("preserves a direct launch timeout for its caller", async () => {
    const { service } = createTargetSetup();
    const error = new LaunchTimeoutError(60000);
    const launchInternal = vi
      .spyOn(service as unknown as { launchInternal: () => Promise<Browser> }, "launchInternal")
      .mockRejectedValue(error);

    await expect(service.launch()).rejects.toBe(error);

    expect(launchInternal).toHaveBeenCalledOnce();
  });

  it.each(["continue", "abort"])("contains rejected request %s operations", async (operation) => {
    const { service, page, target, logError } = createTargetSetup();
    const error = new Error("Protocol error: Target closed");
    service["launchConfig"]!.optimizeBandwidth = { blockImages: operation === "abort" };
    await service["handleNewTarget"](target);
    const request = {
      url: () => "https://example.com/image.png",
      headers: () => ({}),
      resourceType: () => "image",
      continue: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    request[operation].mockRejectedValue(error);

    page.emit("request", request);

    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith(
        { err: error, event: "request" },
        "[CDPService] Event handler failed",
      );
    });
    expect(request[operation]).toHaveBeenCalledOnce();
    await expect(
      service["handlePageRequest"](request as unknown as HTTPRequest, page as unknown as Page),
    ).rejects.toBe(error);
  });

  it.each(["request", "response"])(
    "blocks file %s traffic even when session teardown rejects",
    async (event) => {
      const { service, page, target, logError } = createTargetSetup();
      await service["handleNewTarget"](target);
      const error = new LaunchTimeoutError(60000);
      const endSession = vi.spyOn(service, "endSession").mockRejectedValue(error);
      const request = {
        url: () => "file:///etc/passwd",
        headers: () => ({}),
        continue: vi.fn(),
      };

      page.emit(event, request);

      await vi.waitFor(() => {
        expect(logError).toHaveBeenCalledWith(
          { err: error, event },
          "[CDPService] Event handler failed",
        );
      });
      expect(page.close).toHaveBeenCalledOnce();
      expect(endSession).toHaveBeenCalledWith(ShutdownReason.SECURITY_VIOLATION);
      expect(request.continue).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "disconnected", "no process", "running"])(
    "reports browser health for %s state",
    (state) => {
      const { service, browser } = createTargetSetup();
      if (state !== "missing") {
        service["browserInstance"] = browser as unknown as Browser;
      }
      browser.connected = state !== "disconnected";
      browser.process.mockReturnValue(state === "no process" ? null : {});

      expect(service.isRunning()).toBe(state === "running");
    },
  );
});
