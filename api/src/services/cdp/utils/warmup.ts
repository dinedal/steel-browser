import { FastifyBaseLogger } from "fastify";
import { Page } from "puppeteer-core";

export type WarmupPhase = "navigation" | "readiness" | "deadline";

export class WarmupFailedError extends Error {
  public readonly statusCode = 502;
  public readonly code = "warmup_failed";

  constructor(
    url: string,
    public readonly phase: WarmupPhase,
    cause: unknown,
  ) {
    super(
      `Warmup of ${url} failed during ${phase}: ${cause instanceof Error ? cause.message : cause}`,
    );
    this.name = "WarmupFailedError";
  }
}

export interface WarmupOptions {
  url: string;
  initScript?: string;
  readyExpression?: string;
  timeoutMs: number;
}

// Extra slack past the caller's budget before the hard deadline fires. The
// puppeteer calls below carry their own timeouts; this only trips when a CDP
// call wedges entirely, so it can never hold the session lifecycle lock open.
const HARD_DEADLINE_GRACE_MS = 2000;

/**
 * Navigate `page` to the warmup URL and block until it is ready. The page is
 * left intact on success so an attaching CDP client adopts it as-is. Failures
 * reject with WarmupFailedError; the caller owns browser teardown.
 */
export async function runPageWarmup(
  page: Page,
  options: WarmupOptions,
  logger: FastifyBaseLogger,
): Promise<void> {
  const { url, initScript, readyExpression, timeoutMs } = options;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const budget = () => Math.max(deadline - Date.now(), 1);

  const warm = async (): Promise<void> => {
    if (initScript) {
      await page.evaluateOnNewDocument(initScript);
    }

    try {
      await page.goto(url, { waitUntil: "load", timeout: budget() });
    } catch (error) {
      throw new WarmupFailedError(url, "navigation", error);
    }

    if (readyExpression) {
      try {
        // Pass the raw string: puppeteer evaluates it via Runtime.evaluate,
        // which is CSP-immune and sidesteps the esbuild __name serialization
        // workaround that function-valued evaluate needs.
        await page.waitForFunction(readyExpression, { polling: 100, timeout: budget() });
      } catch (error) {
        throw new WarmupFailedError(url, "readiness", error);
      }
    }
  };

  let hardDeadlineTimer: NodeJS.Timeout | undefined;
  const hardDeadline = new Promise<never>((_, reject) => {
    hardDeadlineTimer = setTimeout(() => {
      reject(
        new WarmupFailedError(
          url,
          "deadline",
          new Error(`warmup did not settle within ${timeoutMs + HARD_DEADLINE_GRACE_MS}ms`),
        ),
      );
    }, timeoutMs + HARD_DEADLINE_GRACE_MS);
  });

  try {
    const warmPromise = warm();
    // If the hard deadline wins the race the abandoned warm promise may still
    // reject later (e.g. when the browser is killed); keep that from surfacing
    // as an unhandled rejection.
    warmPromise.catch(() => {});
    await Promise.race([warmPromise, hardDeadline]);
    logger.debug(`[Warmup] Page warmed at ${url} in ${Date.now() - startedAt}ms`);
  } catch (error) {
    throw error instanceof WarmupFailedError
      ? error
      : new WarmupFailedError(url, "navigation", error);
  } finally {
    clearTimeout(hardDeadlineTimer);
  }
}
