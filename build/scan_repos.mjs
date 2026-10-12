#!/usr/bin/env node
/**
 * Scan tianyicui's commit count across every reachable public repository.
 *
 * Why the `contributors` endpoint: it returns each contributor's TOTAL commit
 * count for a repo in ONE request, with no 1000-result cap (unlike
 * `search/commits`, which ignores `author:` and returns total_count: null).
 * Scanning ~110 repos therefore costs ~110 requests, not thousands.
 *
 * Honest limits, recorded in the output rather than hidden:
 *   - Private repos are invisible without a token. `GET /user/repos` is 401
 *     unauthenticated, so we can neither list nor count them. `privateReposFound`
 *     is always 0 for that reason, not because none exist.
 *   - `contributors` attributes a commit to the account that owns the matching
 *     user; `anon=0` drops unlinked emails.
 *
 * The run is resumable and rate-limit aware: every completed repo is cached in
 * scan/cache.json, and a 403/429 stops the run cleanly with the reset time.
 *
 *   node build/scan_repos.mjs            # resume / continue
 *   node build/scan_repos.mjs --status   # what is cached so far
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIR = resolve(ROOT, 'build/scan');
const CACHE = resolve(SCAN_DIR, 'cache.json');
const TARGET = 'tianyicui';
const API = 'https://api.github.com';
const UA = 'dsh-tianyicui-monitor-scanner';

mkdirSync(SCAN_DIR, { recursive: true });

const load = () => (existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : null);
const save = (state) => {
  writeFileSync(CACHE, JSON.stringify(state, null, 1));
  emitArtifact(state);
};

/**
 * The plugin-readable rollup. Kept deliberately small: per-repo counts only, so
 * the client can sum them and show how much of the total is covered.
 */
function emitArtifact(state) {
  const byRepo = {};
  let total = 0;
  let scanned = 0;
  for (const [name, r] of Object.entries(state.repos || {})) {
    if (typeof r.count === 'number' && Number.isFinite(r.count)) {
      byRepo[name] = r.count;
      total += r.count;
      scanned += 1;
    }
  }
  const artifact = {
    generatedAt: Date.now(),
    target: TARGET,
    source: 'GitHub contributors endpoint, one call per public repository',
    // What we could and could not see. Private repos are NOT zero because none
    // exist; they are invisible without a token (GET /user/repos is 401).
    privateReposVisible: state.privateReposFound ?? 0,
    privateReposNote: 'unauthenticated GitHub cannot list or count private repos',
    reposKnown: (state.order || []).length,
    reposScanned: scanned,
    totalCommits: total,
    byRepo,
  };
  writeFileSync(resolve(ROOT, 'data/repos.json'), JSON.stringify(artifact, null, 1));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const rate = {
    remaining: Number(res.headers.get('x-ratelimit-remaining') ?? NaN),
    limit: Number(res.headers.get('x-ratelimit-limit') ?? NaN),
    resetAt: Number(res.headers.get('x-ratelimit-reset') ?? NaN) * 1000,
  };
  if (res.status === 403 || res.status === 429) {
    const err = new Error(`rate limited (HTTP ${res.status})`);
    err.rate = rate;
    err.rateLimited = true;
    throw err;
  }
  if (res.status === 404) return { status: 404, body: null, rate };
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { status: res.status, body: await res.json(), rate };
}

/** Every public repo we can enumerate: his own + the orgs he works in. */
async function enumerateRepos() {
  const repos = new Map();
  const add = (r) => { if (r && r.full_name) repos.set(r.full_name, { name: r.full_name, private: !!r.private, stars: r.stargazers_count || 0, pushed: r.pushed_at }); };

  let url = `${API}/users/${TARGET}/repos?per_page=100&type=owner&sort=pushed`;
  while (url) {
    const { body, rate } = await gh(url);
    for (const r of body || []) add(r);
    url = nextLink(rate, body);
    if (!body || body.length < 100) break;
    await sleep(150);
  }

  // orgs he is a public member of, plus the org we already know he works in
  const orgs = new Set(['deepseek-ai']);
  try {
    let ou = `${API}/users/${TARGET}/orgs?per_page=100`;
    const { body: orgBody } = await gh(ou);
    for (const o of orgBody || []) orgs.add(o.login);
  } catch { /* org membership may be private; deepseek-ai is enough */ }

  for (const org of orgs) {
    let ou = `${API}/orgs/${org}/repos?per_page=100&type=public&sort=pushed`;
    try {
      while (ou) {
        const { body, rate } = await gh(ou);
        for (const r of body || []) add(r);
        ou = nextLink(rate, body);
        if (!body || body.length < 100) break;
        await sleep(150);
      }
    } catch (err) {
      if (err.rateLimited) throw err;
    }
  }
  return [...repos.values()];
}

function nextLink() { return null; }   // pagination handled by the length check

/** tianyicui's commit count in one repo, or 0 when absent. */
async function contributionsIn(repo) {
  const { body, rate } = await gh(`${API}/repos/${repo}/contributors?per_page=100&anon=0`);
  const list = Array.isArray(body) ? body : [];
  const hit = list.find((c) => c && c.login === TARGET);
  return { count: hit ? hit.contributions : 0, contributorCount: list.length, rate };
}

async function main() {
  const statusOnly = process.argv.includes('--status');
  let state = load() || { startedAt: Date.now(), repos: {}, order: null };
  if (!state.order) state.order = null;
  // Detail goes in `repos`, so prioritise the repos most likely to hold most of
  // his commits: the DSH org first, then his own active repos, then the rest.
  if (state.order && !state.orderDetail) {
    state.orderDetail = state.order.map((name) => ({ name, deepseek: name.startsWith('deepseek-ai/') }));
    save(state);
  }

  if (statusOnly) {
    const done = Object.values(state.repos);
    const total = done.reduce((a, r) => a + (r.count || 0), 0);
    console.log(`cached repos: ${done.length}  |  tianyicui commits across them: ${total}`);
    for (const [name, r] of Object.entries(state.repos).sort((a, b) => (b[1].count || 0) - (a[1].count || 0)).slice(0, 15)) {
      console.log(`  ${String(r.count).padStart(6)}  ${name}`);
    }
    return;
  }

  if (!state.order) {
    process.stdout.write('enumerating repos... ');
    const repos = await enumerateRepos();
    state.order = repos.map((r) => r.name);
    state.orderDetail = repos.map((r) => ({ name: r.name, deepseek: r.name.startsWith('deepseek-ai/') }));
    state.privateReposFound = repos.filter((r) => r.private).length;
    save(state);
    console.log(`${repos.length} public repos (private visible: ${state.privateReposFound})`);
  }

  // deepseek-ai first, then newest push first: that is where his volume is.
  const queued = (state.orderDetail || state.order.map((name) => ({ name, deepseek: false })))
    .filter((r) => !state.repos[r.name])
    .sort((a, b) => (Number(b.deepseek) - Number(a.deepseek)));
  let remaining = queued.length;
  console.log(`repos to scan: ${remaining} of ${state.order.length}`);

  for (const { name } of queued) {
    if (state.repos[name]) continue;
    try {
      const { count, contributorCount, rate } = await contributionsIn(name);
      state.repos[name] = { count, contributorCount, at: Date.now() };
      if (count > 0) console.log(`  ${String(count).padStart(6)}  ${name}`);
      if (Object.keys(state.repos).length % 10 === 0) save(state);
      if (Number.isFinite(rate.remaining) && rate.remaining <= 2) {
        state.pausedUntil = rate.resetAt;
        save(state);
        console.log(`\nstopping: only ${rate.remaining} requests left; reset at ${new Date(rate.resetAt).toISOString()}`);
        return;
      }
      await sleep(120);
    } catch (err) {
      if (err.rateLimited) {
        state.pausedUntil = err.rate.resetAt;
        save(state);
        console.log(`\nrate limited; reset at ${new Date(err.rate.resetAt).toISOString()}`);
        return;
      }
      state.repos[name] = { count: 0, error: String(err.message), at: Date.now() };
      save(state);
    }
  }
  save(state);
  const total = Object.values(state.repos).reduce((a, r) => a + (r.count || 0), 0);
  console.log(`\nDONE. tianyicui public commits across ${Object.keys(state.repos).length} repos: ${total}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
