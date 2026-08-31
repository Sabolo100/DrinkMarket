/**
 * SSRF-vedelem es valaszminoseg-ellenorzes (spec 29.1, 11.4).
 *
 * A crawler NEM erhet el privat IP-tartomanyt, metadata endpointot vagy belso
 * hostot felhasznaloi URL alapjan. A HTTP 200 SEM jelenti automatikusan, hogy
 * a crawl sikeres volt.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { GuardVerdict } from '@radovin/contracts';

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'metadata.google.internal',
  'metadata.goog', 'instance-data', 'kubernetes.default',
]);

const BLOCKED_IP_LITERALS = new Set(['169.254.169.254', '100.100.100.200', '0.0.0.0']);

export class SsrfError extends Error {
  constructor(message: string, public readonly hostname: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** IPv4/IPv6 privat, loopback, link-local es egyeb tiltott tartomany. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map((p) => Number.parseInt(p, 10));
    const [a = 0, b = 0] = parts;
    if (a === 10) return true;                                  // 10.0.0.0/8
    if (a === 127) return true;                                 // loopback
    if (a === 0) return true;                                   // 0.0.0.0/8
    if (a === 169 && b === 254) return true;                    // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                    // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
    if (a === 192 && b === 0) return true;                      // 192.0.0.0/24
    if (a >= 224) return true;                                  // multicast + reserved
    return false;
  }
  if (family === 6) {
    const addr = address.toLowerCase();
    if (addr === '::' || addr === '::1') return true;
    if (addr.startsWith('fe80')) return true;                   // link-local
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique local
    if (addr.startsWith('ff')) return true;                     // multicast
    // IPv4-mapped
    const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

export interface UrlGuardOptions {
  /** Ha meg van adva, csak ezekre a hostokra engedelyezett a keres. */
  hostAllowlist?: string[];
  allowPrivate?: boolean;
}

/**
 * URL biztonsagi ellenorzese letoltes elott. Feloldja a DNS-t, es
 * elutasit minden privat cimre mutato hostot.
 */
export async function assertSafeUrl(rawUrl: string, opts: UrlGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Ervenytelen URL: ${rawUrl}`, rawUrl);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Csak http/https engedelyezett, kapott: ${url.protocol}`, url.hostname);
  }
  if (url.username || url.password) {
    throw new SsrfError('Az URL-ben szereplo hitelesitesi adat nem engedelyezett.', url.hostname);
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new SsrfError(`Tiltott hostnev: ${hostname}`, hostname);
  }
  if (BLOCKED_IP_LITERALS.has(hostname)) {
    throw new SsrfError(`Tiltott IP-cim: ${hostname}`, hostname);
  }

  if (opts.hostAllowlist?.length) {
    const allowed = opts.hostAllowlist.some(
      (h) => hostname === h.toLowerCase() || hostname.endsWith(`.${h.toLowerCase()}`),
    );
    if (!allowed) {
      throw new SsrfError(`A host nem szerepel az engedelyezettek kozott: ${hostname}`, hostname);
    }
  }

  if (opts.allowPrivate) return url;

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new SsrfError(`Privat IP-cim tiltott: ${hostname}`, hostname);
    return url;
  }

  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    if (!results.length) throw new SsrfError(`A hostnev nem oldhato fel: ${hostname}`, hostname);
    for (const r of results) {
      if (isPrivateAddress(r.address)) {
        throw new SsrfError(`A hostnev privat cimre mutat (${r.address}): ${hostname}`, hostname);
      }
    }
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    throw new SsrfError(`DNS feloldas sikertelen: ${hostname}`, hostname);
  }

  return url;
}

// ═══════════════════════════════════════════════════════════════════════════
// Valaszminoseg: a HTTP 200 nem jelenti a crawl sikeret (spec 11.4)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * EGYERTELMU challenge-jelek: ezek csak akkor fordulnak elo, ha a vedelmi
 * rendszer ténylegesen kozbelepett. Onmagukban blokkolonak szamitanak.
 */
const HARD_CHALLENGE_PATTERNS: Array<[RegExp, GuardVerdict['reason'], string]> = [
  [/cf-browser-verification|cf_chl_|challenge-platform|__cf_chl/i, 'challenge', 'Cloudflare challenge oldal.'],
  [/<title>[^<]*just a moment[^<]*<\/title>/i, 'challenge', 'Cloudflare "Just a moment" varakoztato oldal.'],
  [/attention required!?\s*\|\s*cloudflare/i, 'challenge', 'Cloudflare blokk oldal.'],
  [/_incap_ses_|incapsula incident id/i, 'challenge', 'Imperva/Incapsula vedelmi oldal.'],
  [/<title>[^<]*(?:access denied|hozzaferes megtagadva)[^<]*<\/title>/i, 'challenge', 'Hozzaferes megtagadva.'],
];

/**
 * GYENGE jelek: a puszta emlitesuk NEM bizonyitek. Egy webshop nyitolapja
 * teljesen szabalyosan tartalmazhat reCAPTCHA scriptet a kapcsolati vagy
 * hirlevel-urlaphoz. Ezeket csak akkor tekintjuk blokkolasnak, ha az oldalon
 * NINCS valodi tartalom sem (lasd az ures shell ellenorzest lentebb).
 *
 * Ez azert kritikus, mert a tevesen `blocked`-nak jelolt egeszseges forras
 * pontosan az a hiba, amit a spec 11.4 es 38/10 tilt: technikai fals riasztas,
 * ami megakadalyozza az uzleti kovetkeztetest es felesleges riasztast general.
 */
const WEAK_CHALLENGE_PATTERNS: Array<[RegExp, string]> = [
  [/g-recaptcha|grecaptcha|h-captcha|hcaptcha|cf-turnstile/i, 'CAPTCHA widget az oldalon.'],
  [/\bcaptcha\b/i, 'CAPTCHA emlites az oldalon.'],
];

/**
 * A magyar mintakat EKEZETMENTESITETT szovegen illesztjuk. Enelkul a
 * "nem talalhato" minta soha nem illeszkedne a valos "nem található"
 * szovegre - a felismeres nemetul mukodne, magyarul nem.
 */
function deaccentForMatch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const AGE_GATE_PATTERNS: Array<[RegExp, string]> = [
  [/elmultam\s*18|elmúltam\s*18|betoltotted\s*a\s*18|betöltötted\s*a\s*18/i, 'Magyar korellenorzo kapu.'],
  [/are you (?:over|at least)\s*(?:18|21)|age\s*verification|age[- ]gate/i, 'Angol korellenorzo kapu.'],
  [/eletkor.{0,20}ellenorz|életkor.{0,20}ellenőrz/i, 'Korellenorzo kapu.'],
];

const LOGIN_PATTERNS: Array<[RegExp, string]> = [
  [/<form[^>]*(?:login|bejelentkez|signin)/i, 'Bejelentkezesi urlap.'],
  [/kerjuk,?\s*jelentkezzen\s*be|please\s*(?:log\s*in|sign\s*in)\s*to\s*(?:view|see)/i, 'Bejelentkezes szukseges.'],
];

const SOFT_404_PATTERNS: Array<[RegExp, string]> = [
  [/a\s*keresett\s*oldal\s*nem\s*talalhato|nem\s*talalhato\s*a\s*termek/i, 'Magyar soft 404.'],
  [/\b404\b.{0,40}(?:not found|nem talalhato)/i, 'Soft 404 jelzes.'],
  [/page\s*not\s*found|product\s*(?:not\s*found|no\s*longer\s*available)/i, 'Angol soft 404.'],
  [/<title>[^<]*(?:404|nem talalhato|not found)[^<]*<\/title>/i, 'A cimben 404 szerepel.'],
];

export interface GuardInput {
  status: number;
  body: string;
  contentType: string;
  url: string;
  /** Ha vart termekoldalt, de a body gyanusan ures. */
  expectProduct?: boolean;
}

/**
 * Blokkolas, challenge, age gate, ures JS shell es soft 404 felismerese.
 * Ezek eredmenye `parse_error` vagy `blocked`, SOHA nem `not_found` (spec 38/10).
 */
export function evaluateResponse(input: GuardInput): GuardVerdict {
  const { status, body, contentType } = input;

  if (status === 429) return { blocked: true, reason: 'rate_limited', detail: 'HTTP 429 - tul sok keres.' };
  if (status === 403 || status === 401) {
    return { blocked: true, reason: 'challenge', detail: `HTTP ${status} - hozzaferes megtagadva.` };
  }
  if (status >= 500) {
    return { blocked: true, reason: 'challenge', detail: `HTTP ${status} - szerveroldali hiba.` };
  }

  const isHtml = contentType.includes('html') || body.trimStart().startsWith('<');
  if (!isHtml) {
    // JSON / XML valasz: nincs mit challenge-elni
    return { blocked: false, reason: 'ok' };
  }

  const head = body.slice(0, 60_000);
  // Ekezetmentes valtozat a magyar nyelvu mintakhoz (lasd deaccentForMatch).
  const headNorm = deaccentForMatch(head);

  // ── 1. Egyertelmu challenge: onmagaban blokkolo ─────────────────────────
  for (const [re, reason, detail] of HARD_CHALLENGE_PATTERNS) {
    if (re.test(head) || re.test(headNorm)) return { blocked: true, reason, detail };
  }

  // A lathato szoveg es a strukturalt tartalom megallapitasa. Ez dönti el,
  // hogy a gyenge jelek valodi blokkolast jelentenek-e.
  const textContent = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const hasStructured = /"@type"\s*:\s*"(?:Product|ItemList|WebSite|Organization)"|__NEXT_DATA__|window\.__NUXT__/i.test(body);
  const hasProductSignal = /"@type"\s*:\s*"Product"|itemtype="[^"]*schema\.org\/Product/i.test(body);
  // Egy mukodo webshopoldal soha nem ilyen sovany. A hatar szandekosan alacsony:
  // inkabb engedjunk at egy gyanus oldalt (a kinyeres ugyis elbukik rajta),
  // mint hogy egeszseges forrast jelentsunk blokkoltnak.
  const looksLikeShell = textContent.length < 400 && !hasStructured;

  // ── 2. Gyenge jelek: CSAK ures shell mellett szamitanak blokkolasnak ────
  if (looksLikeShell) {
    for (const [re, detail] of WEAK_CHALLENGE_PATTERNS) {
      if (re.test(head)) {
        return { blocked: true, reason: 'challenge', detail: `${detail} (tartalom nelkuli oldalon)` };
      }
    }
  }

  // ── 3. Age gate: csak ha a termektartalom nincs meg az oldalon ──────────
  for (const [re, detail] of AGE_GATE_PATTERNS) {
    if ((re.test(head) || re.test(headNorm)) && !hasProductSignal && looksLikeShell) {
      return { blocked: true, reason: 'age_gate', detail };
    }
  }

  // ── 4. Bejelentkezes-kenyszer ──────────────────────────────────────────
  for (const [re, detail] of LOGIN_PATTERNS) {
    if ((re.test(head) || re.test(headNorm)) && !hasProductSignal && looksLikeShell) {
      return { blocked: true, reason: 'login_required', detail };
    }
  }

  // ── 5. Soft 404 ────────────────────────────────────────────────────────
  if (status === 404) {
    return { blocked: true, reason: 'soft_404', detail: 'HTTP 404.' };
  }
  for (const [re, detail] of SOFT_404_PATTERNS) {
    if (re.test(head) || re.test(headNorm)) return { blocked: true, reason: 'soft_404', detail };
  }

  // ── 6. Ures JS shell ───────────────────────────────────────────────────
  if (looksLikeShell) {
    return {
      blocked: true,
      reason: 'empty_shell',
      detail: `Ures JS shell: ${textContent.length} karakternyi lathato szoveg, strukturalt adat nelkul.`,
    };
  }

  return { blocked: false, reason: 'ok' };
}
