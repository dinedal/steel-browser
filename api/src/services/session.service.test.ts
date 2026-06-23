import { access } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

import { SessionService } from "./session.service.js";

const profileRoot = path.join(os.tmpdir(), "steel-sessions");

const baseStartOptions = (sessionId: string) => ({
  sessionId,
  timezone: "UTC",
  credentials: undefined,
});

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const expectOwnedProfileDir = (profileDir: string) => {
  const root = path.resolve(profileRoot);
  const target = path.resolve(profileDir);
  const relative = path.relative(root, target);

  expect(relative).toBeTruthy();
  expect(relative.startsWith("..")).toBe(false);
  expect(path.isAbsolute(relative)).toBe(false);
};

const createLogger = () =>
  ({
    child: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  }) as any;

const createService = () => {
  let disconnectHandler: (() => Promise<void>) | undefined;

  const cdpService = {
    endSession: vi.fn().mockResolvedValue(undefined),
    getDimensions: vi.fn(() => ({ width: 1280, height: 720 })),
    getUserAgent: vi.fn(() => "test-user-agent"),
    launch: vi.fn().mockResolvedValue(undefined),
    setDisconnectHandler: vi.fn((handler: () => Promise<void>) => {
      disconnectHandler = handler;
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    startNewSession: vi.fn().mockResolvedValue({}),
  };

  const seleniumService = {
    close: vi.fn(),
    launch: vi.fn().mockResolvedValue(undefined),
  };

  const service = new SessionService({
    cdpService: cdpService as any,
    fileService: {} as any,
    logger: createLogger(),
    seleniumService: seleniumService as any,
  });

  return {
    cdpService,
    disconnectHandler: () => disconnectHandler,
    seleniumService,
    service,
  };
};

describe("SessionService ephemeral profiles", () => {
  it("uses a unique owned profile directory for each sequential session", async () => {
    const { cdpService, service } = createService();

    await service.startSession(baseStartOptions("00000000-0000-4000-8000-000000000001"));
    const firstProfileDir = cdpService.startNewSession.mock.calls[0][0].userDataDir;

    expectOwnedProfileDir(firstProfileDir);
    expect(await exists(firstProfileDir)).toBe(true);

    await service.endSession();
    expect(await exists(firstProfileDir)).toBe(false);

    await service.startSession(baseStartOptions("00000000-0000-4000-8000-000000000002"));
    const secondProfileDir = cdpService.startNewSession.mock.calls[1][0].userDataDir;

    expectOwnedProfileDir(secondProfileDir);
    expect(secondProfileDir).not.toBe(firstProfileDir);
    expect(await exists(secondProfileDir)).toBe(true);

    await service.endSession();
    expect(await exists(secondProfileDir)).toBe(false);
  });

  it("ignores legacy persistence inputs and still creates an owned ephemeral profile", async () => {
    const { cdpService, service } = createService();
    const requestedProfileDir = path.join(os.tmpdir(), "caller-requested-steel-profile");

    await service.startSession({
      ...baseStartOptions("00000000-0000-4000-8000-000000000003"),
      persist: true,
      userDataDir: requestedProfileDir,
    } as any);

    const actualProfileDir = cdpService.startNewSession.mock.calls[0][0].userDataDir;

    expect(actualProfileDir).not.toBe(requestedProfileDir);
    expectOwnedProfileDir(actualProfileDir);

    await service.endSession();
    expect(await exists(actualProfileDir)).toBe(false);
  });

  it("cleans up the owned profile and resets to idle when launch fails", async () => {
    const { cdpService, service } = createService();
    cdpService.startNewSession.mockRejectedValueOnce(new Error("launch failed"));

    await expect(
      service.startSession(baseStartOptions("00000000-0000-4000-8000-000000000004")),
    ).rejects.toThrow("launch failed");

    const failedProfileDir = cdpService.startNewSession.mock.calls[0][0].userDataDir;

    expectOwnedProfileDir(failedProfileDir);
    expect(await exists(failedProfileDir)).toBe(false);
    expect(service.activeSession.status).toBe("idle");
  });

  it("cleans up the owned profile when a live browser disconnects", async () => {
    const { cdpService, disconnectHandler, service } = createService();

    expect(cdpService.setDisconnectHandler).toHaveBeenCalledOnce();

    await service.startSession(baseStartOptions("00000000-0000-4000-8000-000000000005"));
    const profileDir = cdpService.startNewSession.mock.calls[0][0].userDataDir;

    const handleDisconnect = disconnectHandler();
    expect(handleDisconnect).toBeDefined();
    await handleDisconnect!();

    expect(cdpService.endSession).toHaveBeenCalledOnce();
    expect(service.activeSession.status).toBe("idle");
    expect(service.pastSessions).toHaveLength(1);
    expect(await exists(profileDir)).toBe(false);
  });
});
