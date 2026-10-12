#!/usr/bin/env node
/**
 * Read tianyicui's contribution graph — the ONLY credential-free source that
 * reflects private activity.
 *
 * Why this exists: `GET /users/{u}/events/public` omits any PushEvent for
 * tianyicui, and unauthenticated REST cannot list private repos. But the profile
 * contribution graph is served to anonymous callers and, because the account has
 * "include private contributions on my profile" enabled, its daily numbers
 * already fold in private work. GitHub returns only the COUNT, never which repo.
 *
 * HONEST CAVEAT, recorded in the artifact:
 * GitHub describes these as "contributions", which counts commits + pull
 * requests + issues + code reviews — not commits alone. It is therefore NOT
 * summable with the commit counts, and the UI must keep them separate.
 * Evidence: 2026-10-08 shows 13 contributions while the repo has 122 public
 * commits that day, so the number is not a commit count.
 *
 * NOTE ON TLS: this machine routes HTTPS through a local intercepting proxy
 * whose root is NOT in Node's trust store (curl trusts it, Node does not). The
 * root is extracted from the live chain into build/certs/chain1.pem and passed
 * via NODE_EXTRA_CA_CERTS by `npm run contributions`, rather than disabling
 * certificate verification.
 *
 *   npm run contributions      # handles the CA for you
 *   node build/scan_contributions.mjs
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'tianyicui';
const URL = `https://github.com/users/${TARGET}/contributions`;

/** Parse per-day counts out of the server-rendered calendar. */
export function parseContributionCalendar(html) {
  const id2date = {};
  for (const m of html.matchAll(/<td\b([^>]*)>/g)) {
    const attrs = m[1];
    const id = /id="([^"]+)"/.exec(attrs);
    const day = /data-date="(\d{4}-\d{2}-\d{2})"/.exec(attrs);
    if (id && day) id2date[id[1]] = day[1];
  }
  const byDay = {};
  for (const m of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([\s\S]*?)<\/tool-tip>/g)) {
    const id = m[1];
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const hit = /^(No|\d+) contributions? on ([A-Z][a-z]+)/.exec(text);
    if (!hit) continue;
    const day = id2date[id];
    if (!day) continue;
    byDay[day] = hit[1] === 'No' ? 0 : Number(hit[1]);
  }
  const header = /([\d,]+)\s*\n?\s*contributions\s*\n?\s*in the last year/.exec(html);
  return {
    byDay,
    declaredTotal: header ? Number(header[1].replace(/,/g, '')) : null,
    days: Object.keys(byDay).length,
  };
}

async function main() {
  const res = await fetch(URL, {
    headers: { 'User-Agent': 'dsh-tianyicui-monitor', Accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${URL}`);
  const html = await res.text();
  const { byDay, declaredTotal, days } = parseContributionCalendar(html);
  if (!days) throw new Error('parsed 0 days — GitHub markup may have changed');

  const sum = Object.values(byDay).reduce((a, b) => a + b, 0);
  const keys = Object.keys(byDay).sort();
  const artifact = {
    generatedAt: Date.now(),
    target: TARGET,
    source: URL,
    metric: 'contributions',
    metricNote:
      'GitHub "contributions" = commits + pull requests + issues + code reviews. NOT a commit count, and must not be summed with commit totals.',
    includesPrivate: true,
    includesPrivateNote:
      'This account has "include private contributions on my profile" enabled, so these daily counts already fold in private activity. GitHub returns only the count, never which repository.',
    declaredTotal,
    parsedTotal: sum,
    totalsMatch: declaredTotal === sum,
    days,
    firstDay: keys[0],
    lastDay: keys[keys.length - 1],
    byDay,
  };
  writeFileSync(resolve(ROOT, 'data/contributions.json'), JSON.stringify(artifact, null, 1));
  console.log(`days=${days} parsedTotal=${sum} declaredTotal=${declaredTotal} match=${artifact.totalsMatch}`);
  console.log(`range ${artifact.firstDay} .. ${artifact.lastDay}`);
  console.log('wrote data/contributions.json');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}
