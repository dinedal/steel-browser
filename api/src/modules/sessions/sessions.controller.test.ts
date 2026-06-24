import { describe, expect, it, vi } from "vitest";

import { handleLaunchBrowserSession } from "./sessions.controller.js";
import { SessionAlreadyActiveError } from "../../services/session.service.js";

describe("handleLaunchBrowserSession", () => {
  it("returns request-scoped public urls for launched sessions", async () => {
    const startSession = vi.fn().mockResolvedValue({
      id: "session-1",
      websocketUrl: "ws://localhost:3000/",
      debugUrl: "http://localhost:3000/v1/sessions/debug",
      debuggerUrl: "http://localhost:3000/v1/devtools/inspector.html",
      sessionViewerUrl: "http://localhost:3000/",
      createdAt: new Date().toISOString(),
      status: "live",
      duration: 0,
      eventCount: 0,
      timeout: 0,
      creditsUsed: 0,
      userAgent: "ua",
      proxy: "",
      proxyTxBytes: 0,
      proxyRxBytes: 0,
      solveCaptcha: false,
      isSelenium: false,
    });

    const server = {
      sessionService: { startSession },
      log: { error: vi.fn() },
    } as any;

    const request = {
      body: {
        persist: true,
        sessionId: "session-1",
        userDataDir: "/tmp/caller-profile",
      },
      headers: {
        host: "steel.example.com",
        "x-forwarded-proto": "https",
      },
    } as any;

    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as any;

    const result = await handleLaunchBrowserSession(server, request, reply);

    expect(startSession).toHaveBeenCalledOnce();
    expect(startSession.mock.calls[0][0]).not.toHaveProperty("persist");
    expect(startSession.mock.calls[0][0]).not.toHaveProperty("userDataDir");
    expect(result.websocketUrl).toBe("wss://steel.example.com/");
    expect(result.debugUrl).toBe("https://steel.example.com/v1/sessions/debug");
    expect(result.debuggerUrl).toBe("https://steel.example.com/v1/devtools/inspector.html");
    expect(result.sessionViewerUrl).toBe("https://steel.example.com/");
  });

  it("returns 409 when the pod already has a live session", async () => {
    const startSession = vi
      .fn()
      .mockRejectedValue(new SessionAlreadyActiveError("00000000-0000-4000-8000-000000000001"));

    const server = {
      sessionService: { startSession },
      log: { error: vi.fn() },
    } as any;

    const request = {
      body: {
        sessionId: "00000000-0000-4000-8000-000000000002",
      },
      headers: {
        host: "steel.example.com",
      },
    } as any;

    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as any;

    await handleLaunchBrowserSession(server, request, reply);

    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      message: "Session 00000000-0000-4000-8000-000000000001 is already live in this Steel process",
    });
  });
});
