/**
 * Direct GitHub reader — environment agnostic.
 *
 * It runs in the browser (installed plugin half) and in Node (CLI refresh,
 * tests) by taking `fetch` from the caller, so both paths exercise the same
 * parsing code.
 *
 * Why the browser fetches upstream directly: the public endpoints send
 * `Access-Control-Allow-Origin: *`, and the DSH shell sets no Content-Security-
 * Policy, so no host round trip is needed. The host-side source module exists for
 * the same work off-page.
 *
 * All day keys are CST (UTC+8) to match how the maintainers actually work.
 */
import { cstDayKey } from './analytics.js';

export const GITHUB_USER = 'tianyicui';
export const UPSTREAM_REPO = 'deepseek-ai/deepseek-harness';

const API = 'https://api.github.com';
const DEFAULT_PAGES = 5;
const DEFAULT_TIMEOUT = 12_000;

function resolveFetch(fetchImpl) {
  const f = fetchImpl || (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
  if (typeof f !== 'function') throw new Error('no fetch implementation available');
  return f;
}

function headers(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function getJson(fetchImpl, url, { token, timeout }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const res = await fetchImpl(url, {
      headers: headers(token),
      signal: controller ? controller.signal : undefined,
    });
    const rateLimit = {
      remaining: numOrNull(res.headers?.get?.('x-ratelimit-remaining')),
      limit: numOrNull(res.headers?.get?.('x-ratelimit-limit')),
      resetAt: (() => {
        const v = numOrNull(res.headers?.get?.('x-ratelimit-reset'));
        return v == null ? null : v * 1000;
      })(),
    };
    if (!res.ok) {
      const limited = res.status === 403 || res.status === 429;
      const err = new Error(
        limited
          ? `GitHub API rate limit reached (HTTP ${res.status})`
          : `GitHub ${res.status} for ${url}`,
      );
      err.status = res.status;
      err.rateLimit = rateLimit;
      err.rateLimited = limited;
      throw err;
    }
    const body = await res.json();
    return { body, rateLimit, link: res.headers?.get?.('link') || null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseNextLink(link) {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (m && m[2] === 'next') return m[1];
  }
  return null;
}

/**
 * Read recent commits for the upstream repo until `sinceMs` is covered.
 *
 * @param {object} opts
 * @param {Function} [opts.fetchImpl]
 * @param {string|null} [opts.token]
 * @param {number} [opts.sinceMs]      stop once commits predate this instant
 * @param {number} [opts.maxPages]
 * @param {number} [opts.perPage]
 * @param {Function} [opts.now]
 * @returns {Promise<{ok:boolean,error:string|null,tianyicuiDaily:Record<string,number>,allDaily:Record<string,number>,days:number,lastCommitMs:number|null,rateLimit:object|null,requests:number}>}
 */
export async function fetchRecentCommitDays(opts = {}) {
  const {
    fetchImpl,
    token = null,
    sinceMs = Date.now() - 90 * 24 * 3600 * 1000,
    maxPages = DEFAULT_PAGES,
    perPage = 100,
    timeout = DEFAULT_TIMEOUT,
  } = opts;

  const out = {
    ok: false,
    error: null,
    rateLimited: false,
    tianyicuiDaily: {},
    allDaily: {},
    days: 0,
    lastCommitMs: null,
    rateLimit: null,
    requests: 0,
  };

  let doFetch;
  try {
    doFetch = resolveFetch(fetchImpl);
  } catch (err) {
    out.error = String((err && err.message) || err);
    return out;
  }

  let url = `${API}/repos/${UPSTREAM_REPO}/commits?per_page=${perPage}`;
  try {
    for (let page = 0; page < maxPages; page++) {
      const { body, rateLimit, link } = await getJson(doFetch, url, { token, timeout });
      out.requests += 1;
      out.rateLimit = rateLimit;
      if (!Array.isArray(body) || body.length === 0) { out.ok = true; break; }

      let reachedCutoff = false;
      for (const c of body) {
        const iso = c?.commit?.committer?.date || c?.commit?.author?.date;
        if (!iso) continue;
        const ms = Date.parse(iso);
        if (!Number.isFinite(ms)) continue;
        if (out.lastCommitMs == null || ms > out.lastCommitMs) out.lastCommitMs = ms;
        if (ms < sinceMs) { reachedCutoff = true; continue; }
        const key = cstDayKey(ms);
        out.allDaily[key] = (out.allDaily[key] || 0) + 1;
        const login = c?.author?.login;
        if (login === GITHUB_USER) out.tianyicuiDaily[key] = (out.tianyicuiDaily[key] || 0) + 1;
      }

      out.ok = true;
      if (reachedCutoff || body.length < perPage) break;
      const next = parseNextLink(link);
      if (!next) break;
      url = next;
    }
  } catch (err) {
    out.error = String((err && err.message) || err);
    out.rateLimited = !!err.rateLimited;
    if (err.rateLimit) out.rateLimit = err.rateLimit;
    // partial results are still useful
    if (out.requests > 0 && Object.keys(out.allDaily).length) out.ok = true;
  }

  out.days = Object.keys(out.allDaily).length;
  return out;
}

/**
 * Read releases, newest first, until one predates `sinceMs`.
 * @returns {Promise<{ok:boolean,error:string|null,releases:Array<{version:string,time:number}>,rateLimit:object|null}>}
 */
export async function fetchReleases(opts = {}) {
  const {
    fetchImpl,
    token = null,
    sinceMs = Date.now() - 400 * 24 * 3600 * 1000,
    maxPages = 6,
    perPage = 100,
    timeout = DEFAULT_TIMEOUT,
  } = opts;

  const out = { ok: false, error: null, rateLimited: false, releases: [], rateLimit: null };
  let doFetch;
  try {
    doFetch = resolveFetch(fetchImpl);
  } catch (err) {
    out.error = String((err && err.message) || err);
    return out;
  }

  const byVersion = new Map();
  let url = `${API}/repos/${UPSTREAM_REPO}/releases?per_page=${perPage}`;
  try {
    for (let page = 0; page < maxPages; page++) {
      const { body, rateLimit, link } = await getJson(doFetch, url, { token, timeout });
      out.rateLimit = rateLimit;
      if (!Array.isArray(body) || body.length === 0) { out.ok = true; break; }
      let reachedCutoff = false;
      for (const r of body) {
        const iso = r?.published_at || r?.created_at;
        const ms = iso ? Date.parse(iso) : NaN;
        if (!Number.isFinite(ms)) continue;
        if (ms < sinceMs) { reachedCutoff = true; continue; }
        const tag = String(r?.tag_name || '');
        const version = tag.replace(/^dsh-v/, '');
        if (!version) continue;
        byVersion.set(version, { version, time: ms });
      }
      out.ok = true;
      if (reachedCutoff || body.length < perPage) break;
      const next = parseNextLink(link);
      if (!next) break;
      url = next;
    }
  } catch (err) {
    out.error = String((err && err.message) || err);
    out.rateLimited = !!err.rateLimited;
    if (err.rateLimit) out.rateLimit = err.rateLimit;
    if (byVersion.size) out.ok = true;
  }
  out.releases = [...byVersion.values()].sort((a, b) => a.time - b.time);
  return out;
}

/** One-shot refresh used by the client half and by `build/refresh.mjs`. */
export async function refresh(opts = {}) {
  const { sinceDays = 90, ...rest } = opts;
  const sinceMs = (rest.now ? rest.now() : Date.now()) - sinceDays * 24 * 3600 * 1000;
  const [commits, releases] = await Promise.all([
    fetchRecentCommitDays({ ...rest, sinceMs }),
    fetchReleases({ ...rest, sinceMs: sinceMs - 320 * 24 * 3600 * 1000 }),
  ]);
  const rateLimit = commits.rateLimit || releases.rateLimit || null;
  const rateLimited = !!(commits.rateLimited || releases.rateLimited);
  return {
    ok: commits.ok || releases.ok,
    // Distinguish "no data yet" from "GitHub refused us", so the panel can show a
    // countdown instead of a blank or a raw 403.
    error: commits.error || releases.error || null,
    rateLimited,
    rateLimit,
    fetchedAt: Date.now(),
    tianyicuiDaily: commits.tianyicuiDaily,
    allDaily: commits.allDaily,
    releases: releases.releases,
    lastCommitMs: commits.lastCommitMs,
  };
}
