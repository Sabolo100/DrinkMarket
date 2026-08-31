/**
 * robots.txt feldolgozas az RFC 9309 szerint (spec 11.5).
 * https://www.rfc-editor.org/info/rfc9309/
 *
 * FONTOS (spec 29.2): a robots.txt technikai protokoll, NEM onmagaban teljes
 * jogi engedely. Az automatizalt hozzaferes jogi megfelelosegét kulon kell
 * ellenorizni; erre szolgal a shops.policy_disabled kapcsolo.
 */

interface RuleGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
  crawlDelay?: number;
}

export interface RobotsTxt {
  groups: RuleGroup[];
  sitemaps: string[];
  raw: string;
}

export function parseRobots(text: string): RobotsTxt {
  const groups: RuleGroup[] = [];
  const sitemaps: string[] = [];
  let current: RuleGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    switch (field) {
      case 'user-agent': {
        if (!current || !lastWasAgent) {
          current = { agents: [], allow: [], disallow: [] };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastWasAgent = true;
        break;
      }
      case 'allow': {
        if (current) { current.allow.push(value); lastWasAgent = false; }
        break;
      }
      case 'disallow': {
        if (current) { current.disallow.push(value); lastWasAgent = false; }
        break;
      }
      case 'crawl-delay': {
        if (current) {
          const n = Number.parseFloat(value);
          if (Number.isFinite(n)) current.crawlDelay = n;
          lastWasAgent = false;
        }
        break;
      }
      case 'sitemap': {
        if (value) sitemaps.push(value);
        lastWasAgent = false;
        break;
      }
      default:
        lastWasAgent = false;
    }
  }
  return { groups, sitemaps, raw: text };
}

/** A legspecifikusabb illeszkedo csoport kivalasztasa (RFC 9309 2.2.1). */
function selectGroup(robots: RobotsTxt, userAgent: string): RuleGroup | null {
  const ua = userAgent.toLowerCase();
  let best: { group: RuleGroup; score: number } | null = null;
  for (const group of robots.groups) {
    for (const agent of group.agents) {
      let score = -1;
      if (agent === '*') score = 0;
      else if (ua.includes(agent)) score = agent.length;
      if (score >= 0 && (!best || score > best.score)) best = { group, score };
    }
  }
  return best?.group ?? null;
}

/** Path minta illeszkedes, `*` es `$` tamogatassal (RFC 9309 2.2.3). */
function pathMatches(pattern: string, path: string): number {
  if (pattern === '') return -1;
  const anchored = pattern.endsWith('$');
  const p = anchored ? pattern.slice(0, -1) : pattern;
  const parts = p.split('*');

  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (part === '') {
      if (i === 0) continue;
      continue;
    }
    const found = i === 0 ? (path.startsWith(part) ? 0 : -1) : path.indexOf(part, pos);
    if (found < 0) return -1;
    pos = found + part.length;
  }
  if (anchored && pos !== path.length) {
    // Az utolso resz utan mar nem lehet semmi
    const lastPart = parts[parts.length - 1] ?? '';
    if (!path.endsWith(lastPart)) return -1;
  }
  return p.replace(/\*/g, '').length;
}

export interface RobotsDecision {
  allowed: boolean;
  reason: string;
  matchedRule?: string;
  crawlDelay?: number;
}

/**
 * Engedelyezett-e az adott URL letoltese?
 * Ha nincs robots.txt vagy nem tolthetó le, az RFC szerint megengedő az
 * ertelmezes, DE a rendszer ezt naplozza es a jogi ellenorzes kulon fut.
 */
export function isAllowed(robots: RobotsTxt | null, url: string, userAgent: string): RobotsDecision {
  if (!robots) return { allowed: true, reason: 'Nincs elerheto robots.txt - RFC 9309 szerint megengedo ertelmezes.' };
  const group = selectGroup(robots, userAgent);
  if (!group) return { allowed: true, reason: 'Nincs illeszkedo user-agent csoport.' };

  let path: string;
  try {
    const u = new URL(url);
    path = `${u.pathname}${u.search}`;
  } catch {
    return { allowed: false, reason: 'Ervenytelen URL.' };
  }

  let bestAllow = -1;
  let bestAllowRule = '';
  let bestDisallow = -1;
  let bestDisallowRule = '';

  for (const rule of group.allow) {
    const len = pathMatches(rule, path);
    if (len > bestAllow) { bestAllow = len; bestAllowRule = rule; }
  }
  for (const rule of group.disallow) {
    if (rule === '') continue; // ures Disallow = minden engedelyezett
    const len = pathMatches(rule, path);
    if (len > bestDisallow) { bestDisallow = len; bestDisallowRule = rule; }
  }

  if (bestDisallow < 0) {
    return { allowed: true, reason: 'Nincs tilto szabaly.', crawlDelay: group.crawlDelay };
  }
  if (bestAllow >= bestDisallow) {
    return { allowed: true, reason: `Allow felulirja a Disallow-t: "${bestAllowRule}"`, matchedRule: bestAllowRule, crawlDelay: group.crawlDelay };
  }
  return {
    allowed: false,
    reason: `A robots.txt tiltja: "Disallow: ${bestDisallowRule}"`,
    matchedRule: bestDisallowRule,
    crawlDelay: group.crawlDelay,
  };
}
