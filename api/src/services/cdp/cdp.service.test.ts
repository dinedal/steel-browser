import { FastifyBaseLogger } from "fastify";
import { pino } from "pino";
import { Page, Target, TargetType } from "puppeteer-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CDPService } from "./cdp.service.js";

function createTargetSetup(device?: "desktop" | "mobile", headless = true) {
  const logger: FastifyBaseLogger = pino({ enabled: false });
  vi.spyOn(logger, "child").mockReturnValue(logger);
  const debug = vi.spyOn(logger, "debug");
  const service = new CDPService({ keepAlive: false }, logger);
  service["launchConfig"] = {
    options: { headless },
    deviceConfig: device ? { device } : undefined,
    customHeaders: { "x-test": "target-setup" },
    skipFingerprintInjection: true,
  };
  vi.spyOn(service["targetInstrumentationManager"], "attach").mockResolvedValue(undefined);
  const onPageCreated = vi.spyOn(service["pluginManager"], "onPageCreated");
  const page = {
    url: vi.fn().mockReturnValue("about:blank"),
    evaluateOnNewDocument: vi.fn<Page["evaluateOnNewDocument"]>().mockResolvedValue({
      identifier: "cursor-script",
    }),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    setRequestInterception: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
  const target = {
    type: () => TargetType.PAGE,
    page: vi.fn().mockResolvedValue(page),
  } as unknown as Target;

  return { service, page, target, debug, onPageCreated };
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
