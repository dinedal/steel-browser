import { describe, expect, it, vi } from "vitest";

import {
  handleGetSessionDetails,
  handleLaunchBrowserSession,
  handleReleaseBrowserSessionById,
} from "./sessions.controller.js";
import { SessionAlreadyActiveError, SessionService } from "../../services/session.service.js";

const createLogger = () =>
  ({
    child: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  }) as any;

// Real SessionService instance (only the CDP/browser layer is stubbed, matching
// the conventions in session.service.test.ts) so these tests exercise the
// actual lifecycle lock and current-session semantics.
const createServer = () => {
  const cdpService = {
    endSession: vi.fn().mockResolvedValue(undefined),
    getDimensions: vi.fn(() => ({ width: 1280, height: 720 })),
    getUserAgent: vi.fn(() => "test-user-agent"),
    launch: vi.fn().mockResolvedValue(undefined),
    setDisconnectHandler: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    startNewSession: vi.fn().mockResolvedValue({}),
  };

  const sessionService = new SessionService({
    cdpService: cdpService as any,
    fileService: {} as any,
    logger: createLogger(),
    seleniumService: { close: vi.fn(), launch: vi.fn().mockResolvedValue(undefined) } as any,
  });

  const server = {
    sessionService,
    log: { error: vi.fn() },
  } as any;

  return { cdpService, server, sessionService };
};

const createReply = () =>
  ({
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  }) as any;

const startOptions = (sessionId: string) => ({
  sessionId,
  timezone: "UTC",
  credentials: undefined as any,
});

const releaseRequest = (sessionId: string) =>
  ({
    params: { sessionId },
    headers: { host: "steel.example.com" },
  }) as any;

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

describe("handleReleaseBrowserSessionById", () => {
  const liveId = "00000000-0000-4000-8000-0000000000aa";
  const staleId = "00000000-0000-4000-8000-0000000000bb";

  it("returns 404 for a stale ID and the current session survives", async () => {
    const { cdpService, server, sessionService } = createServer();
    await sessionService.startSession(startOptions(liveId));

    const reply = createReply();
    await handleReleaseBrowserSessionById(server, releaseRequest(staleId), reply);

    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({ success: false, message: "session not current" });
    expect(cdpService.endSession).not.toHaveBeenCalled();
    expect(sessionService.activeSession.id).toBe(liveId);
    expect(sessionService.activeSession.status).toBe("live");
  });

  it("releases the current session when the ID matches", async () => {
    const { cdpService, server, sessionService } = createServer();
    await sessionService.startSession(startOptions(liveId));

    const reply = createReply();
    await handleReleaseBrowserSessionById(server, releaseRequest(liveId), reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, id: liveId, status: "released" }),
    );
    expect(cdpService.endSession).toHaveBeenCalledOnce();
    expect(sessionService.activeSession.status).toBe("idle");
    expect(sessionService.activeSession.id).not.toBe(liveId);
  });

  it("returns 404 when re-releasing an already released ID", async () => {
    const { cdpService, server, sessionService } = createServer();
    await sessionService.startSession(startOptions(liveId));

    const firstReply = createReply();
    await handleReleaseBrowserSessionById(server, releaseRequest(liveId), firstReply);
    expect(firstReply.send).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    const secondReply = createReply();
    await handleReleaseBrowserSessionById(server, releaseRequest(liveId), secondReply);

    expect(secondReply.code).toHaveBeenCalledWith(404);
    expect(secondReply.send).toHaveBeenCalledWith({
      success: false,
      message: "session not current",
    });
    expect(cdpService.endSession).toHaveBeenCalledOnce();
    expect(sessionService.activeSession.status).toBe("idle");
  });

  it("cannot release a successor session when a stale release races a fresh start", async () => {
    const { cdpService, server, sessionService } = createServer();
    const successorId = "00000000-0000-4000-8000-0000000000cc";

    // Client A's session S1 lives and is released (e.g. reaped by the broker).
    await sessionService.startSession(startOptions(liveId));
    await sessionService.endSession();
    cdpService.endSession.mockClear();

    // Client B reclaims the pod: start of S2 is in flight and holds the lock.
    const launch = Promise.withResolvers<object>();
    cdpService.startNewSession.mockReturnValueOnce(launch.promise as any);
    const start = sessionService.startSession(startOptions(successorId));
    await vi.waitFor(() => expect(cdpService.startNewSession).toHaveBeenCalledTimes(2));

    // Client A's late release for S1 arrives mid-start. It must queue behind
    // the lock — no controller-side precheck can pass and then release S2.
    const reply = createReply();
    const staleRelease = handleReleaseBrowserSessionById(server, releaseRequest(liveId), reply);

    await Promise.resolve();
    expect(cdpService.endSession).not.toHaveBeenCalled();

    launch.resolve({});
    await start;
    await staleRelease;

    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({ success: false, message: "session not current" });
    expect(cdpService.endSession).not.toHaveBeenCalled();
    expect(sessionService.activeSession.id).toBe(successorId);
    expect(sessionService.activeSession.status).toBe("live");

    await sessionService.endSession();
  });
});

describe("handleGetSessionDetails", () => {
  const liveId = "00000000-0000-4000-8000-0000000000dd";
  const staleId = "00000000-0000-4000-8000-0000000000ee";

  it("returns the real status for the matching current session", async () => {
    const { server, sessionService } = createServer();
    await sessionService.startSession(startOptions(liveId));

    const reply = createReply();
    await handleGetSessionDetails(server, releaseRequest(liveId), reply);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: liveId, status: "live" }),
    );
  });

  it("returns a released stub for a non-matching ID without touching pastSessions", async () => {
    const { server, sessionService } = createServer();
    await sessionService.startSession(startOptions(liveId));
    const pastSessionsBefore = [...sessionService.pastSessions];

    const reply = createReply();
    await handleGetSessionDetails(server, releaseRequest(staleId), reply);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: staleId, status: "released", duration: 0 }),
    );
    expect(sessionService.pastSessions).toEqual(pastSessionsBefore);
    expect(sessionService.activeSession.id).toBe(liveId);
    expect(sessionService.activeSession.status).toBe("live");
  });
});
