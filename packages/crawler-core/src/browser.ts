/**
 * Bongeszos crawl runtime (spec 11.2/10, 6.3).
 *
 * ALAPSZABALY (spec 38/9): headless bongeszot NEM szabad hasznalni, ha stabil
 * HTTP/JSON megoldas elerheto. A Playwright ezert LUSTA import: ha nincs
 * telepitve, a rendszer tovabb mukodik, csak a browser mod nem elerheto.
 *
 * A bongeszo process MINDIG bezar siker, timeout es hiba utan is (spec 32.5).
 */
import type { CrawlPolicy, FetchInit, FetchResponse } from '@radovin/contracts';
import { logger } from '@radovin/observability';
import { assertSafeUrl, evaluateResponse } from './guard.js';

type PlaywrightModule = {
  chromium: {
    launch(opts: Record<string, unknown>): Promise<BrowserLike>;
  };
};

interface BrowserLike {
  newContext(opts: Record<string, unknown>): Promise<ContextLike>;
  close(): Promise<void>;
  isConnected(): boolean;
}
interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
interface PageLike {
  goto(url: string, opts: Record<string, unknown>): Promise<ResponseLike | null>;
  content(): Promise<string>;
  url(): string;
  waitForSelector(selector: string, opts: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
interface ResponseLike {
  status(): number;
  headers(): Record<string, string>;
  url(): string;
}

let playwright: PlaywrightModule | null = null;
let playwrightUnavailableReason: string | null = null;
let browser: BrowserLike | null = null;

export async function isBrowserAvailable(): Promise<boolean> {
  if (playwright) return true;
  if (playwrightUnavailableReason) return false;
  try {
    // Dinamikus, valtozoba tett modulnev: a TypeScript igy nem koveteli meg
    // a fordítási idejű tipusdeklaraciot egy opcionalis fuggosegre.
    const moduleName = 'playwright';
    playwright = (await import(/* @vite-ignore */ moduleName)) as unknown as PlaywrightModule;
    return true;
  } catch (err) {
    playwrightUnavailableReason = err instanceof Error ? err.message : String(err);
    logger.warn('crawler.browser.unavailable', {
      reason: playwrightUnavailableReason,
      hint: 'A bongeszos crawl kikapcsolva. Telepitesi parancs: npm i playwright && npx playwright install chromium',
    });
    return false;
  }
}

async function getBrowser(): Promise<BrowserLike> {
  if (browser?.isConnected()) return browser;
  if (!playwright) {
    const ok = await isBrowserAvailable();
    if (!ok) throw new Error(`A Playwright nem elerheto: ${playwrightUnavailableReason}`);
  }
  browser = await playwright!.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    try { await browser.close(); } catch { /* mar bezart */ }
    browser = null;
  }
}

export interface BrowserFetchOptions {
  policy: CrawlPolicy;
  userAgent: string;
  count?: (key: string, by?: number) => void;
  hostAllowlist?: string[];
}

/**
 * Bongeszos letoltes. A context es a page MINDIG bezar (finally),
 * fuggetlenul attol, hogy siker vagy hiba tortent.
 */
export function createBrowserFetcher(opts: BrowserFetchOptions) {
  const count = opts.count ?? (() => undefined);

  return async function browserFetch(rawUrl: string, init: FetchInit = {}): Promise<FetchResponse> {
    const started = Date.now();
    const url = await assertSafeUrl(rawUrl, { hostAllowlist: opts.hostAllowlist });
    count('requests_attempted');
    count('browser_requests');

    let context: ContextLike | null = null;
    let page: PageLike | null = null;
    try {
      const b = await getBrowser();
      context = await b.newContext({
        userAgent: opts.policy.userAgent ?? opts.userAgent,
        locale: 'hu-HU',
        timezoneId: 'Europe/Budapest',
        viewport: { width: 1366, height: 900 },
        javaScriptEnabled: true,
        extraHTTPHeaders: { 'accept-language': 'hu-HU,hu;q=0.9,en;q=0.6' },
      });
      page = await context.newPage();

      const timeout = init.timeoutMs ?? opts.policy.requestTimeoutMs;
      const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout });

      if (init.waitForSelector) {
        try {
          await page.waitForSelector(init.waitForSelector, { timeout: Math.min(timeout, 12_000) });
        } catch {
          count('selector_timeouts');
        }
      }

      const body = await page.content();
      const finalUrl = page.url();
      const status = response?.status() ?? 0;
      const headers = response?.headers() ?? {};
      const contentType = headers['content-type'] ?? 'text/html';
      const guard = evaluateResponse({ status: status || 200, body, contentType, url: finalUrl });

      count(status >= 200 && status < 400 ? 'requests_succeeded' : 'requests_failed');
      count(`http_${status}`);

      return {
        ok: status >= 200 && status < 400 && !guard.blocked,
        status: status || 200,
        url: rawUrl,
        finalUrl,
        redirectChain: finalUrl !== url.toString() ? [url.toString(), finalUrl] : [],
        headers: sanitizeHeaders(headers),
        body,
        contentType,
        fromCache: false,
        timingMs: Date.now() - started,
        guard,
      };
    } catch (err) {
      count('requests_failed');
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('crawler.browser.failed', { url: rawUrl, error: message });
      return {
        ok: false, status: 0, url: rawUrl, finalUrl: rawUrl, redirectChain: [],
        headers: {}, body: '', contentType: '', fromCache: false,
        timingMs: Date.now() - started,
        guard: { blocked: true, reason: 'challenge', detail: message },
      };
    } finally {
      // A bongeszo eroforras MINDIG felszabadul (spec 32.5)
      try { await page?.close(); } catch { /* ignore */ }
      try { await context?.close(); } catch { /* ignore */ }
    }
  };
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^(set-cookie|cookie|authorization)$/i.test(k)) continue;
    out[k.toLowerCase()] = v;
  }
  return out;
}
