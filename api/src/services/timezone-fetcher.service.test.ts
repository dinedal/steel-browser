import axios from "axios";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../env.js";
import { TimezoneFetcher } from "./timezone-fetcher.service.js";

vi.mock("../env.js", () => ({
  env: { DEFAULT_TIMEZONE: undefined, TIMEZONE_SERVICE_URL: undefined },
}));

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;

describe("TimezoneFetcher", () => {
  beforeEach(() => {
    env.DEFAULT_TIMEZONE = undefined;
    vi.spyOn(axios, "get").mockResolvedValue({ data: { timezone: "America/New_York" } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([undefined, "http://proxy.example:8080", "socks5://proxy.example:1080"])(
    "uses the configured timezone without a lookup for proxy %s",
    async (proxyUrl) => {
      env.DEFAULT_TIMEZONE = "UTC";

      await expect(
        new TimezoneFetcher(logger).getTimezone(proxyUrl, "Europe/London"),
      ).resolves.toBe("UTC");
      expect(axios.get).not.toHaveBeenCalled();
    },
  );

  it("detects the timezone when none is configured", async () => {
    await expect(new TimezoneFetcher(logger).getTimezone(undefined, "UTC")).resolves.toBe(
      "America/New_York",
    );
    expect(axios.get).toHaveBeenCalledOnce();
  });

  it("uses the fallback when an unconfigured lookup fails", async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error("timeout"));

    await expect(new TimezoneFetcher(logger).getTimezone(undefined, "UTC")).resolves.toBe("UTC");
    expect(axios.get).toHaveBeenCalledOnce();
  });
});
