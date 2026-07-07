import { afterEach, describe, expect, it, vi } from "vitest";

import { runPageWarmup, WarmupFailedError } from "./warmup.js";

const warmupUrl = "https://render.example.com/shell";

const createLogger = () =>
  ({
    child: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  }) as any;

const createPage = () => ({
  close: vi.fn().mockResolvedValue(undefined),
  evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
  goto: vi.fn().mockResolvedValue(undefined),
  waitForFunction: vi.fn().mockResolvedValue(undefined),
});

describe("runPageWarmup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("evaluates the init script on new documents before navigating", async () => {
    const page = createPage();

    await runPageWarmup(
      page as any,
      { url: warmupUrl, initScript: "window.__warm = true;", timeoutMs: 5000 },
      createLogger(),
    );

    expect(page.evaluateOnNewDocument).toHaveBeenCalledOnce();
    expect(page.evaluateOnNewDocument).toHaveBeenCalledWith("window.__warm = true;");
    expect(page.evaluateOnNewDocument.mock.invocationCallOrder[0]).toBeLessThan(
      page.goto.mock.invocationCallOrder[0],
    );
  });

  it("skips init script injection when no script is given", async () => {
    const page = createPage();

    await runPageWarmup(page as any, { url: warmupUrl, timeoutMs: 5000 }, createLogger());

    expect(page.evaluateOnNewDocument).not.toHaveBeenCalled();
  });

  it("navigates with waitUntil load and polls the raw ready expression within budget", async () => {
    const page = createPage();

    await runPageWarmup(
      page as any,
      { url: warmupUrl, readyExpression: "!!window.ready", timeoutMs: 5000 },
      createLogger(),
    );

    expect(page.goto).toHaveBeenCalledOnce();
    const [gotoUrl, gotoOptions] = page.goto.mock.calls[0];
    expect(gotoUrl).toBe(warmupUrl);
    expect(gotoOptions.waitUntil).toBe("load");
    expect(gotoOptions.timeout).toBeGreaterThan(0);
    expect(gotoOptions.timeout).toBeLessThanOrEqual(5000);

    expect(page.waitForFunction).toHaveBeenCalledOnce();
    const [expression, waitOptions] = page.waitForFunction.mock.calls[0];
    expect(expression).toBe("!!window.ready");
    expect(waitOptions.polling).toBe(100);
    expect(waitOptions.timeout).toBeGreaterThan(0);
    expect(waitOptions.timeout).toBeLessThanOrEqual(5000);
  });

  it("skips readiness polling when no expression is given", async () => {
    const page = createPage();

    await runPageWarmup(page as any, { url: warmupUrl, timeoutMs: 5000 }, createLogger());

    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it("maps navigation failures to phase navigation", async () => {
    const page = createPage();
    page.goto.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_REFUSED"));

    await expect(
      runPageWarmup(page as any, { url: warmupUrl, timeoutMs: 5000 }, createLogger()),
    ).rejects.toMatchObject({
      name: "WarmupFailedError",
      code: "warmup_failed",
      statusCode: 502,
      phase: "navigation",
    });
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it("maps readiness failures to phase readiness", async () => {
    const page = createPage();
    page.waitForFunction.mockRejectedValueOnce(new Error("Waiting failed: 5000ms exceeded"));

    await expect(
      runPageWarmup(
        page as any,
        { url: warmupUrl, readyExpression: "!!window.ready", timeoutMs: 5000 },
        createLogger(),
      ),
    ).rejects.toMatchObject({ name: "WarmupFailedError", phase: "readiness" });
  });

  it("rejects at the hard deadline when a CDP call wedges", async () => {
    vi.useFakeTimers();
    const page = createPage();
    page.goto.mockReturnValueOnce(new Promise(() => {}) as any);

    const warmup = runPageWarmup(page as any, { url: warmupUrl, timeoutMs: 5000 }, createLogger());
    const expectation = expect(warmup).rejects.toMatchObject({
      name: "WarmupFailedError",
      phase: "deadline",
    });

    await vi.advanceTimersByTimeAsync(7000);
    await expectation;
  });

  it("leaves no live timers after a successful warmup", async () => {
    vi.useFakeTimers();
    const page = createPage();

    await runPageWarmup(page as any, { url: warmupUrl, timeoutMs: 5000 }, createLogger());

    expect(vi.getTimerCount()).toBe(0);
  });

  it("wraps unexpected failures as WarmupFailedError", async () => {
    const page = createPage();
    page.evaluateOnNewDocument.mockRejectedValueOnce(new Error("session closed"));

    await expect(
      runPageWarmup(
        page as any,
        { url: warmupUrl, initScript: "window.__warm = true;", timeoutMs: 5000 },
        createLogger(),
      ),
    ).rejects.toBeInstanceOf(WarmupFailedError);
  });

  it("leaves the warmed page intact on success", async () => {
    const page = createPage();

    await runPageWarmup(
      page as any,
      { url: warmupUrl, readyExpression: "!!window.ready", timeoutMs: 5000 },
      createLogger(),
    );

    expect(page.goto).toHaveBeenCalledOnce();
    expect(page.close).not.toHaveBeenCalled();
  });
});
