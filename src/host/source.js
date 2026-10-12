/**
 * tianyicui-monitor — host-side live data source.
 *
 * Reads three public GitHub endpoints, assembles a JSON-safe snapshot and
 * caches it on disk. Contract (see CONTRACTS.md and task-1):
 *
 *   export const GITHUB_USER, UPSTREAM_REPO
 *   export function createSource(options) -> { getSnapshot(), invalidate() }
 *
 * Invariants this file keeps, deliberately:
 *
 *  * Newest-first paging, page 1 first, so the earliest stop condition is safe.
 *  * Stop paging on a short page (< per_page) OR when there is no Link rel=next.
 *    Page numbers are never constructed by hand after page 1.
 *  * Release pagination is pinned to at most 6 pages.
 *  * Unauthenticated refreshes never exceed 8 requests.
 *  * Every request is guarded by an AbortController timeout.
 *  * getSnapshot() NEVER rejects: failures resolve to ok:false, or to the last
 *    good cache with degraded:true.
 *  * Day keys are CST (UTC+8) and come from cstDayKey() in ../analytics.js —
 *    one bucketing implementation for client, host and offline build.
 *
 * Two data-shape decisions worth knowing about (both validated against the live
 * upstream while building this file):
 *
 *  1. tianyicui's activity is the UNION of the repo commits feed (matched on
 *     `author.login` / `commit.author.name`, deduped by sha) and his public
 *     PushEvents. The events feed alone is not enough: on 2026-10-09 it carried
 *     no PushEvent at all while the repo feed showed 12 tianyicui commits that
 *     day, so an events-only reader would report "0 commits today" for an
 *     obviously active maintainer. Repo commits win the day attribution because
 *     they use `commit.committer.date`, the same basis as the offline training
 *     series in data/ + build/extract_dataset.py.
 *
 *  2. `recent.days` is the number of days the fetched pages actually COVER, not
 *     a fixed 30. The commits feed runs ~100+ commits/day upstream, so two pages
 *     reach back only ~2 days; fabricating 28 leading zero days would corrupt
 *     the series and the all24 feature. Days younger than the fetch window are
 *     exact; the oldest (possibly half-covered) day is dropped unless paging
 *     reached the real end of the feed.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { cstDayKey, cstDayStart, DAY_MS } from '../analytics.js';

export const GITHUB_USER = 'tianyicui';
export const UPSTREAM_REPO = 'deepseek-ai/deepseek-harness';

/* ------------------------------------------------------------------ *
 * internal constants (not part of the frozen export surface)
 * ------------------------------------------------------------------ */

const API_ROOT = 'https://api.github.com';
const CACHE_FILE_NAME = 'snapshot.json';
const CACHE_VERSION = 1;

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12 * 1000;
const DEFAULT_RECENT_DAYS = 30;

const PER_PAGE = 100;
const EVENT_PAGE_CAP = 3;
const COMMIT_PAGE_CAP = 2; // unauthenticated
const COMMIT_PAGE_CAP_AUTH = 6;
const RELEASE_PAGE_CAP = 6; // pinned at <= 6 by requirement
const REQUEST_BUDGET = 8; // unauthenticated 60/h budget guard
const REQUEST_BUDGET_AUTH = 16;

const USER_AGENT = 'dsh-plugin-tianyicui-monitor';
/** Git author names that identify the maintainer, mirroring extract_dataset.py. */
const TY_AUTHOR_NAMES = new Set([GITHUB_USER, 'Tianyi Cui']);

/* ------------------------------------------------------------------ *
 * tiny helpers
 * ------------------------------------------------------------------ */

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    try {
      return headers.get(name);
    } catch {
      return null;
    }
  }
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return headers[k];
  }
  return null;
}

function readRateLimit(headers) {
  const reset = numOrNull(headerValue(headers, 'x-ratelimit-reset'));
  return {
    remaining: numOrNull(headerValue(headers, 'x-ratelimit-remaining')),
    limit: numOrNull(headerValue(headers, 'x-ratelimit-limit')),
    resetAt: reset == null ? null : reset * 1000, // unix seconds -> epoch ms
  };
}

function mergeRateLimit(prev, next) {
  return {
    remaining: next.remaining == null ? prev.remaining : next.remaining,
    limit: next.limit == null ? prev.limit : next.limit,
    resetAt: next.resetAt == null ? prev.resetAt : next.resetAt,
  };
}

function emptyRateLimit() {
  return { remaining: null, limit: null, resetAt: null };
}

/** Extract the `rel="next"` target from a GitHub Link header, or null. */
function parseLinkNext(header) {
  if (!header) return null;
  for (const part of String(header).split(',')) {
    const m = /<([^>]+)>\s*;\s*(.+)$/.exec(part.trim());
    if (!m) continue;
    if (/(^|;)\s*rel\s*=\s*"?next"?/i.test(m[2])) return m[1];
  }
  return null;
}

/** `dsh-v0.2.1-alpha.2` -> `0.2.1-alpha.2` (tolerates a missing `dsh-`/`v`). */
function parseReleaseVersion(tag) {
  return String(tag == null ? '' : tag)
    .trim()
    .replace(/^dsh-/i, '')
    .replace(/^v/i, '')
    .trim();
}

function bump(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

function minDefined(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return a < b ? a : b;
}

/* ------------------------------------------------------------------ *
 * request layer
 * ------------------------------------------------------------------ */

class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/**
 * Build the per-refresh request primitive. It owns the request budget, the
 * rate-limit accounting and the per-request timeout, so no call site can forget
 * any of the three.
 */
function createFetcher({ fetchImpl, token, timeoutMs, budget }) {
  let rateLimit = emptyRateLimit();

  async function request(url) {
    if (budget.used >= budget.max) {
      throw new UpstreamError(`request budget exhausted (${budget.max}) before ${url}`);
    }
    budget.used += 1;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
    };
    if (token) headers.authorization = `Bearer ${token}`;

    try {
      const res = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'follow' });
      if (res && res.headers) rateLimit = mergeRateLimit(rateLimit, readRateLimit(res.headers));

      const status = numOrNull(res && res.status) ?? 0;
      const okStatus = (res && res.ok === true) || (status >= 200 && status < 300);

      let body = null;
      let parseFailed = false;
      try {
        body = res && typeof res.json === 'function' ? await res.json() : null;
      } catch {
        parseFailed = true;
      }

      if (!okStatus) {
        let detail = body && typeof body.message === 'string' ? body.message : null;
        if (!detail && parseFailed && res && typeof res.text === 'function') {
          try {
            const raw = await res.text();
            if (typeof raw === 'string' && raw.trim()) detail = raw.trim().slice(0, 120);
          } catch {
            /* ignore: the status code alone is still a usable reason */
          }
        }
        throw new UpstreamError(`upstream HTTP ${status}${detail ? `: ${detail}` : ''} for ${url}`);
      }
      if (parseFailed) throw new UpstreamError(`invalid JSON from ${url} (HTTP ${status})`);
      if (!Array.isArray(body)) {
        throw new UpstreamError(`unexpected payload from ${url}: expected a JSON array`);
      }
      return { url, status, body, nextUrl: parseLinkNext(headerValue(res.headers, 'link')) };
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      if (timedOut || controller.signal.aborted) {
        throw new UpstreamError(`request timed out after ${timeoutMs}ms: ${url}`);
      }
      const msg = err && err.message ? err.message : String(err);
      throw new UpstreamError(`request failed: ${url}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    request,
    get rateLimit() {
      return rateLimit;
    },
  };
}

/**
 * Follow GitHub paging newest-first: start at `startUrl` (page 1, per_page=100),
 * then use only the server-provided Link rel=next. Stop on a short page, a
 * missing link, the page cap or an exhausted request budget.
 *
 * `complete` is true only when the loop reached the real end of the feed — that
 * is what tells us the oldest observed day is fully covered.
 */
async function collectPages({ startUrl, perPage, pageCap, fetcher, budget, onPage }) {
  let next = startUrl;
  let pages = 0;
  let complete = false;
  while (next) {
    if (pages >= pageCap || budget.used >= budget.max) break;
    const res = await fetcher.request(next);
    pages += 1;
    onPage(res.body, res);
    next = res.body.length < perPage ? null : res.nextUrl;
    if (next == null) {
      complete = true;
      break;
    }
  }
  return { pages, complete };
}

/* ------------------------------------------------------------------ *
 * upstream -> observed daily activity
 * ------------------------------------------------------------------ */

function createObserved() {
  return { tianyicui: {}, all: {} };
}

/** True when a repo commit belongs to the maintainer, by login or by git name. */
function isOwnCommit(item) {
  const login = item && item.author && item.author.login;
  if (login && login === GITHUB_USER) return true;
  const name = item && item.commit && item.commit.author && item.commit.author.name;
  return !!(name && TY_AUTHOR_NAMES.has(name));
}

/** Commit instant carried by one item of `GET /repos/:repo/commits`. */
function commitItemTime(item) {
  const iso = (item && item.commit && item.commit.committer && item.commit.committer.date) ||
    (item && item.commit && item.commit.author && item.commit.author.date);
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Repo commits: everything feeds `all`; the maintainer's own commits feed
 * `tianyicui` (deduped by sha against the events feed). Returns the oldest
 * instant bucketed on this page.
 */
function collectCommitPage(items, observed, store, ownShas) {
  let oldest = null;
  for (const item of items) {
    if (!item) continue;
    if (store) store.push(item);
    const t = commitItemTime(item);
    if (t == null) continue;
    oldest = minDefined(oldest, t);
    bump(observed.all, cstDayKey(t), 1);
    if (!isOwnCommit(item)) continue;
    const sha = item.sha;
    if (sha) {
      if (ownShas.has(sha)) continue;
      ownShas.add(sha);
    }
    bump(observed.tianyicui, cstDayKey(t), 1);
  }
  return oldest;
}

/**
 * tianyicui's public PushEvents. The feed is cross-repo, so it adds activity in
 * mirrors/forks the repo feed cannot see. Returns the oldest instant bucketed.
 */
function collectEventPage(events, observed, ownShas) {
  let oldest = null;
  for (const e of events) {
    if (!e || e.type !== 'PushEvent') continue;
    const actor = e.actor && e.actor.login;
    if (actor && actor !== GITHUB_USER) continue;
    const pushAt = Date.parse(e.created_at);
    if (!Number.isFinite(pushAt)) continue;

    const commits = e.payload && Array.isArray(e.payload.commits) ? e.payload.commits : null;
    if (commits && commits.length) {
      for (const c of commits) {
        const sha = c && c.sha;
        if (sha) {
          if (ownShas.has(sha)) continue;
          ownShas.add(sha);
        }
        const raw = c && c.timestamp ? Date.parse(c.timestamp) : NaN;
        const t = Number.isFinite(raw) ? raw : pushAt;
        oldest = minDefined(oldest, t);
        bump(observed.tianyicui, cstDayKey(t), 1);
      }
    } else {
      const n = numOrNull(e.payload && e.payload.distinct_size) ?? numOrNull(e.payload && e.payload.size) ?? 0;
      if (n > 0) {
        oldest = minDefined(oldest, pushAt);
        bump(observed.tianyicui, cstDayKey(pushAt), n);
      }
    }
  }
  return oldest;
}

function collectReleasePage(items, releases) {
  for (const r of items) {
    if (!r || typeof r.tag_name !== 'string') continue;
    const t = Date.parse(r.published_at || r.created_at);
    if (!Number.isFinite(t)) continue;
    const version = parseReleaseVersion(r.tag_name);
    if (!version) continue;
    releases.push({ version, time: t });
  }
}

/**
 * How many trailing CST days the fetched pages actually cover.
 *
 * Days strictly inside the fetched range are exact. The oldest fetched day is
 * only exact when paging reached the end of the feed; otherwise it may be half
 * counted, so it is dropped. The result is capped at `windowCap` days and always
 * includes today.
 */
function coverageWindowStart(startCandidates, nowMs, windowCap) {
  const todayStart = cstDayStart(nowMs);
  let start = todayStart;
  if (startCandidates.length) {
    start = Math.min(...startCandidates.map((c) => c.startMs));
  }
  const earliestAllowed = todayStart - (windowCap - 1) * DAY_MS;
  if (start < earliestAllowed) start = earliestAllowed;
  if (start > todayStart) start = todayStart;
  return start;
}

/* ------------------------------------------------------------------ *
 * snapshot assembly
 * ------------------------------------------------------------------ */

function emptySnapshot(nowMs) {
  return {
    ok: false,
    error: null,
    fetchedAt: nowMs,
    fromCache: false,
    rateLimit: emptyRateLimit(),
    today: null,
    recent: { days: 0, tianyicuiDaily: {}, allDaily: {} },
    releases: [],
    degraded: false,
  };
}

/**
 * Assemble the contract object. `observed` holds sparse CST day -> count maps;
 * the covered window is materialised with explicit zeros so the client can
 * render a gapless series without guessing.
 */
function buildSnapshot({
  nowMs,
  observed,
  windowStartMs,
  releases,
  rateLimit,
  fetchedAt,
  fromCache,
  degraded,
  error,
}) {
  const ty = observed && observed.tianyicui ? observed.tianyicui : {};
  const all = observed && observed.all ? observed.all : {};
  const todayStart = cstDayStart(nowMs);
  const days = Math.max(1, Math.round((todayStart - windowStartMs) / DAY_MS) + 1);
  const tianyicuiDaily = {};
  const allDaily = {};
  for (let i = days - 1; i >= 0; i--) {
    const key = cstDayKey(todayStart - i * DAY_MS);
    tianyicuiDaily[key] = ty[key] || 0;
    allDaily[key] = all[key] || 0;
  }
  const day = cstDayKey(nowMs);
  return {
    ok: true,
    error: error == null ? null : String(error),
    fetchedAt,
    fromCache: fromCache === true,
    rateLimit: rateLimit || emptyRateLimit(),
    today: { day, tianyicui: ty[day] || 0, all: all[day] || 0 },
    recent: { days, tianyicuiDaily, allDaily },
    releases,
    degraded: degraded === true,
  };
}

/** Deep copy so callers can never mutate the cached state we re-serve. */
function cloneSnapshot(snap) {
  const rateLimit = (snap && snap.rateLimit) || {};
  const recent = (snap && snap.recent) || {};
  const today = snap && snap.today;
  return {
    ok: snap && snap.ok === true,
    error: snap && typeof snap.error === 'string' ? snap.error : null,
    fetchedAt: numOrNull(snap && snap.fetchedAt) ?? 0,
    fromCache: snap && snap.fromCache === true,
    rateLimit: {
      remaining: numOrNull(rateLimit.remaining),
      limit: numOrNull(rateLimit.limit),
      resetAt: numOrNull(rateLimit.resetAt),
    },
    today: today
      ? {
          day: String(today.day),
          tianyicui: numOrNull(today.tianyicui) ?? 0,
          all: numOrNull(today.all) ?? 0,
        }
      : null,
    recent: {
      days: numOrNull(recent.days) ?? 0,
      tianyicuiDaily: { ...(recent.tianyicuiDaily || {}) },
      allDaily: { ...(recent.allDaily || {}) },
    },
    releases: Array.isArray(snap && snap.releases)
      ? snap.releases
          .filter((r) => r && typeof r.version === 'string' && Number.isFinite(Number(r.time)))
          .map((r) => ({ version: r.version, time: Number(r.time) }))
      : [],
    degraded: snap && snap.degraded === true,
  };
}

/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

export function createSource(options = {}) {
  const { fetchImpl, cacheDir = null, now = Date.now, token = null, logger = null } = options || {};

  const nowFn = typeof now === 'function' ? now : () => numOrNull(now) ?? Date.now();
  const maxAgeMs = clampInt(options.maxAgeMs ?? options.cacheMaxAgeMs, DEFAULT_MAX_AGE_MS, 0, Infinity);
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 10 * 60 * 1000);
  const recentDays = clampInt(options.recentDays, DEFAULT_RECENT_DAYS, 1, 400);
  const fetchFn =
    typeof fetchImpl === 'function'
      ? fetchImpl
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : null;
  const useToken = typeof token === 'string' && token.length > 0;

  const maxRequests = clampInt(options.maxRequests, useToken ? REQUEST_BUDGET_AUTH : REQUEST_BUDGET, 1, 60);
  const maxEventPages = clampInt(options.maxEventPages, EVENT_PAGE_CAP, 1, RELEASE_PAGE_CAP);
  const maxCommitPages = clampInt(
    options.maxCommitPages,
    useToken ? COMMIT_PAGE_CAP_AUTH : COMMIT_PAGE_CAP,
    1,
    RELEASE_PAGE_CAP,
  );
  const maxReleasePages = clampInt(options.maxReleasePages, RELEASE_PAGE_CAP, 1, RELEASE_PAGE_CAP);

  const cachePath = cacheDir ? path.join(cacheDir, CACHE_FILE_NAME) : null;
  let inflight = null;

  function log(level, message) {
    try {
      const fn = logger && typeof logger[level] === 'function' ? logger[level] : null;
      if (fn) fn.call(logger, `[tianyicui-monitor] ${message}`);
      else if (typeof logger === 'function') logger(`[tianyicui-monitor] ${level}: ${message}`);
    } catch {
      /* logging must never break a refresh */
    }
  }

  async function readCache() {
    if (!cachePath) return null;
    let raw;
    try {
      raw = await readFile(cachePath, 'utf8');
    } catch {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log('warn', `cache file is not valid JSON: ${cachePath}`);
      return null;
    }
    if (!parsed || parsed.v !== CACHE_VERSION || !parsed.snapshot || typeof parsed.snapshot !== 'object') {
      return null;
    }
    const fetchedAt = numOrNull(parsed.snapshot.fetchedAt);
    if (fetchedAt == null) return null;
    return { fetchedAt, snapshot: parsed.snapshot };
  }

  async function writeCache(snapshot, observed) {
    if (!cachePath) return;
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, JSON.stringify({ v: CACHE_VERSION, snapshot, raw: observed }), 'utf8');
    } catch (err) {
      log('warn', `could not write cache: ${err && err.message ? err.message : err}`);
    }
  }

  function fromCache(fetched, { degraded, error }) {
    const snap = cloneSnapshot(fetched.snapshot);
    snap.fetchedAt = fetched.fetchedAt;
    snap.fromCache = true;
    snap.degraded = degraded === true;
    snap.error = error == null ? null : String(error);
    return snap;
  }

  async function refresh() {
    const nowMs = nowFn();
    const cached = await readCache();
    const age = cached ? nowMs - cached.fetchedAt : Infinity;

    // 5) a young cache is served without touching the network.
    if (cached && age >= 0 && age <= maxAgeMs) return fromCache(cached, { degraded: false, error: null });

    if (!fetchFn) {
      const reason = 'no fetch implementation available';
      if (cached) return fromCache(cached, { degraded: true, error: reason });
      const snap = emptySnapshot(nowMs);
      snap.error = reason;
      return snap;
    }

    const observed = createObserved();
    const ownShas = new Set();
    const commitItems = [];
    const releases = [];
    const errors = [];
    const budget = { used: 0, max: maxRequests };
    const fetcher = createFetcher({ fetchImpl: fetchFn, token: useToken ? token : null, timeoutMs, budget });

    const eventsUrl = `${API_ROOT}/users/${GITHUB_USER}/events/public?per_page=${PER_PAGE}&page=1`;
    const commitsUrl = `${API_ROOT}/repos/${UPSTREAM_REPO}/commits?per_page=${PER_PAGE}&page=1`;
    const releasesUrl = `${API_ROOT}/repos/${UPSTREAM_REPO}/releases?per_page=${PER_PAGE}&page=1`;

    const commitsState = { oldestMs: null, complete: false };
    const eventsState = { oldestMs: null, complete: false };

    const phases = [
      {
        name: 'commits',
        run: async () => {
          const r = await collectPages({
            startUrl: commitsUrl,
            perPage: PER_PAGE,
            pageCap: maxCommitPages,
            fetcher,
            budget,
            onPage: (page) => {
              commitsState.oldestMs = minDefined(commitsState.oldestMs, collectCommitPage(page, observed, commitItems, ownShas));
            },
          });
          commitsState.complete = r.complete;
        },
      },
      {
        name: 'events',
        run: async () => {
          const r = await collectPages({
            startUrl: eventsUrl,
            perPage: PER_PAGE,
            pageCap: maxEventPages,
            fetcher,
            budget,
            onPage: (page) => {
              eventsState.oldestMs = minDefined(eventsState.oldestMs, collectEventPage(page, observed, ownShas));
            },
          });
          eventsState.complete = r.complete;
        },
      },
      {
        name: 'releases',
        run: () =>
          collectPages({
            startUrl: releasesUrl,
            perPage: PER_PAGE,
            pageCap: maxReleasePages,
            fetcher,
            budget,
            onPage: (page) => collectReleasePage(page, releases),
          }),
      },
    ];

    const failed = new Set();
    for (const phase of phases) {
      try {
        await phase.run();
      } catch (err) {
        failed.add(phase.name);
        errors.push(`${phase.name}: ${err && err.message ? err.message : err}`);
      }
    }

    const budgetStarved = budget.used >= budget.max;
    if (failed.size === phases.length) {
      // 6) nothing usable upstream: fall back to the last good cache, degraded.
      const reason = errors.join('; ') || 'upstream refresh failed';
      log('warn', reason);
      if (cached) return fromCache(cached, { degraded: true, error: reason });
      const snap = emptySnapshot(nowMs);
      snap.error = reason;
      snap.rateLimit = fetcher.rateLimit;
      return snap;
    }

    // Coverage: drop the oldest day when paging was truncated (that day can only
    // be partially counted), keep it when the feed really ended there.
    const candidates = [];
    for (const state of [commitsState, eventsState]) {
      if (state.oldestMs == null) continue;
      let startMs = cstDayStart(state.oldestMs);
      if (!state.complete) startMs += DAY_MS;
      candidates.push({ startMs });
    }
    const windowStartMs = coverageWindowStart(candidates, nowMs, recentDays);

    // Deduplicate releases by version, oldest-first (the same convention as the
    // offline bundle at data/dsh_releases.json).
    const byVersion = new Map();
    for (const r of releases) if (!byVersion.has(r.version)) byVersion.set(r.version, r);
    const sortedReleases = [...byVersion.values()].sort((a, b) => a.time - b.time);

    const partial = errors.length > 0;
    const snapshot = buildSnapshot({
      nowMs,
      observed,
      windowStartMs,
      releases: sortedReleases,
      rateLimit: fetcher.rateLimit,
      fetchedAt: nowMs,
      fromCache: false,
      degraded: partial,
      error: partial ? `partial refresh: ${errors.join('; ')}` : null,
    });
    if (partial) log('warn', snapshot.error);
    if (budgetStarved) log('info', `request budget reached (${budget.max}) for this refresh`);

    await writeCache(snapshot, observed);
    return snapshot;
  }

  function getSnapshot() {
    if (!inflight) {
      inflight = refresh()
        .catch((err) => {
          // refresh() is written not to throw; this is the last-resort guard so
          // the host half can never take the plugin down.
          const snap = emptySnapshot(nowFn());
          snap.error = `internal error: ${err && err.message ? err.message : err}`;
          return snap;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  async function invalidate() {
    inflight = null;
    if (!cachePath) return;
    try {
      await rm(cachePath, { force: true });
    } catch (err) {
      log('warn', `could not remove cache: ${err && err.message ? err.message : err}`);
    }
  }

  return { getSnapshot, invalidate };
}
