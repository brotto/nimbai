import { ALLOWED_ORIGINS } from './sources.js';

export class SourceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly nextSteps?: string,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

export interface FetchOptions {
  /** Hard deadline for the request. Default 12 s. */
  timeoutMs?: number;
  /** Retries on 5xx / network error, with backoff. Default 2. */
  retries?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HttpClientConfig {
  /**
   * Contact string required by the NWS API and good practice elsewhere.
   * NWS rejects requests without an identifying User-Agent.
   */
  userAgent: string;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRIES = 2;

/**
 * Rejects any URL outside the source catalogue. The server fetches only the
 * origins it ships with, so a crafted location name or bbox can never make it
 * call an arbitrary host.
 */
export function assertAllowed(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SourceError(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new SourceError(`Refusing non-HTTPS request to ${parsed.origin}`);
  }
  if (!ALLOWED_ORIGINS.includes(parsed.origin)) {
    throw new SourceError(
      `Origin ${parsed.origin} is not in the NimbAI source catalogue`,
      undefined,
      'This is a bug in NimbAI: add the source to packages/core/src/sources.ts, with its licence.',
    );
  }
  return parsed;
}

export class HttpClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly config: HttpClientConfig) {
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async raw(url: string, opts: FetchOptions = {}): Promise<Response> {
    assertAllowed(url);
    const retries = opts.retries ?? DEFAULT_RETRIES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const timer = new AbortController();
      const timeout = setTimeout(() => timer.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.config.userAgent, ...opts.headers },
          // Both: a caller's signal must not disable the deadline.
          signal:
            opts.signal === undefined ? timer.signal : AbortSignal.any([opts.signal, timer.signal]),
          redirect: 'error',
        });
        if (res.status >= 500 && attempt < retries) {
          lastError = new SourceError(`${url} returned ${res.status}`, res.status);
          await backoff(attempt);
          continue;
        }
        if (!res.ok) {
          throw new SourceError(`${url} returned ${res.status}`, res.status);
        }
        return res;
      } catch (err) {
        lastError = err;
        if (err instanceof SourceError && err.status !== undefined && err.status < 500) throw err;
        if (attempt === retries) break;
        await backoff(attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new SourceError(`Request to ${url} failed`, undefined, String(lastError));
  }

  async json<T>(url: string, opts: FetchOptions = {}): Promise<T> {
    const res = await this.raw(url, {
      ...opts,
      headers: { Accept: 'application/geo+json, application/json;q=0.9', ...opts.headers },
    });
    return (await res.json()) as T;
  }

  async text(url: string, opts: FetchOptions = {}): Promise<string> {
    const res = await this.raw(url, opts);
    return await res.text();
  }

  /** HEAD-or-GET probe used by `nimbai_get_sources_status`. */
  async probe(url: string, timeoutMs = 6000): Promise<{ ok: boolean; latencyMs: number }> {
    const started = Date.now();
    try {
      await this.raw(url, { timeoutMs, retries: 0 });
      return { ok: true, latencyMs: Date.now() - started };
    } catch {
      return { ok: false, latencyMs: Date.now() - started };
    }
  }
}

function backoff(attempt: number): Promise<void> {
  const ms = 250 * 2 ** attempt;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Strips control characters and caps length on anything that came from an
 * external source before it is handed back to a model, so third-party text
 * cannot carry instructions or blow the context budget.
 */
export function sanitizeExternalText(input: string, maxChars = 8000): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…[truncated]` : cleaned;
}
