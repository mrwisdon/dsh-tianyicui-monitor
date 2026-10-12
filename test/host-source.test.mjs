/**
 * Host data-source tests.
 *
 *   node --test test/host-source.test.mjs
 *
 * No real network: every test injects a fake fetchImpl and an injected clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createSource, GITHUB_USER, UPSTREAM_REPO } from '../src/host/source.js';

const T0 = Date.parse('2026-10-09T06:00:00Z'); // 2026-10-09 14:00 CST
const EVENTS_1 = `https://api.github.com/users/${GITHUB_USER}/events/public?per_page=100&page=1`;
const COMMITS_1 = `https://api.github.com/repos/${UPSTREAM_REPO}/commits?per_page=100&page=1`;
const RELEASES_1 = `https://api.github.com/repos/${UPSTREAM_REPO}/releases?per_page=100&page=1`;

/* ------------------------------------------------------------------ *
 * fakes
 * ------------------------------------------------------------------ */

function jsonRes(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function malformedRes({ status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async json() {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
    async text() {
      return '<html>bad gateway</html>';
    },
  };
}

function rateLimitHeaders(remaining = 59, limit = 60, resetSec = 1791000000) {
  return {
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-reset': String(resetSec),
  };
}

/** fetchImpl that records every call and delegates to `handler` (swappable). */
function makeFake(fetchImplFn) {
  const state = { handler: fetchImplFn, calls: [] };
  const fn = async (url, init) => {
    state.calls.push({ url: String(url), init });
    return state.handler(String(url), state.calls.length, init);
  };
  Object.defineProperty(fn, 'calls', { get: () => state.calls });
  fn.setHandler = (h) => {
    state.handler = h;
  };
  fn.reset = () => {
    state.calls.length = 0;
  };
  return fn;
}

function pushEvent(sha, createdAt, n = 1) {
  return {
    type: 'PushEvent',
    actor: { login: GITHUB_USER },
    created_at: createdAt,
    payload: {
      size: n,
      distinct_size: n,
      commits: Array.from({ length: n }, (_, i) => ({ sha: `${sha}-${i}`, message: `commit ${i}` })),
    },
  };
}

function commitItem(date, login = null, name = null) {
  return {
    sha: `c-${date}-${login || name || 'x'}`,
    author: login ? { login } : null,
    commit: { committer: { date }, author: { name: name || login || 'someone', date } },
  };
}

function releaseItem(tag, published) {
  return { tag_name: tag, published_at: published, name: tag };
}

async function tempCacheDir() {
  return mkdtemp(path.join(tmpdir(), 'tymon-'));
}

/** Assert the call resolves (never throws) and return its value. */
async function resolving(factory) {
  let value;
  await assert.doesNotReject(async () => {
    value = await factory();
  });
  return value;
}

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/**
 * A well-formed upstream:
 *   events  page1 = 100 events (97 filler + 3 real), page2 = 2 events (short -> stop)
 *   commits page1 = 100 items (97 filler + 3 real), page2 = 5 items (short -> stop)
 *   releases page1 = 2 items, no Link -> stop
 */
function happyHandler() {
  return (url) => {
    if (url === EVENTS_1) {
      const events = [
        pushEvent('e1', '2026-10-08T17:00:00Z', 1), // CST 10-09 01:00
        pushEvent('e2', '2026-10-08T08:00:00Z', 1), // CST 10-08 16:00
        pushEvent('e3', '2026-10-09T04:00:00Z', 1), // CST 10-09 12:00
      ];
      for (let i = 0; i < 97; i++) events.push(pushEvent(`f${i}`, '2026-09-15T00:00:00Z', 1));
      return jsonRes(events, {
        headers: {
          ...rateLimitHeaders(58, 60),
          link: `<${EVENTS_1.replace('page=1', 'page=2')}>; rel="next"`,
        },
      });
    }
    if (url.includes('/events/public') && url.includes('page=2')) {
      return jsonRes([pushEvent('e4', '2026-09-14T00:00:00Z', 2)], { headers: rateLimitHeaders(57, 60) });
    }
    if (url === COMMITS_1) {
      const items = [
        commitItem('2026-10-09T02:00:00Z', 'someone'), // CST 10-09 10:00
        commitItem('2026-10-08T20:00:00Z', 'someone'), // CST 10-09 04:00
        commitItem('2026-10-07T10:00:00Z', 'someone'), // CST 10-07 18:00
      ];
      for (let i = 0; i < 97; i++) items.push(commitItem('2026-09-01T00:00:00Z', 'someone'));
      return jsonRes(items, {
        headers: {
          ...rateLimitHeaders(56, 60),
          link: `<${COMMITS_1.replace('page=1', 'page=2')}>; rel="next"`,
        },
      });
    }
    if (url.includes('/commits') && url.includes('page=2')) {
      const items = [];
      for (let i = 0; i < 5; i++) items.push(commitItem('2026-09-20T00:00:00Z', 'someone'));
      return jsonRes(items, { headers: rateLimitHeaders(55, 60) });
    }
    if (url === RELEASES_1) {
      return jsonRes(
        [
          releaseItem('dsh-v0.2.1-alpha.2', '2026-10-08T10:00:00Z'),
          releaseItem('dsh-v0.2.0', '2026-10-01T10:00:00Z'),
        ],
        { headers: rateLimitHeaders(54, 60) },
      );
    }
    throw new Error(`no fake route for ${url}`);
  };
}

function makeSource({ cacheDir = null, now = () => T0, fetchImpl, ...rest } = {}) {
  return createSource({ cacheDir, now, fetchImpl, token: null, ...rest });
}

/* ------------------------------------------------------------------ *
 * export surface
 * ------------------------------------------------------------------ */

test('module exports exactly the frozen surface', async () => {
  const mod = await import('../src/host/source.js');
  assert.deepEqual(Object.keys(mod).sort(), ['GITHUB_USER', 'UPSTREAM_REPO', 'createSource']);
  assert.equal(GITHUB_USER, 'tianyicui');
  assert.equal(UPSTREAM_REPO, 'deepseek-ai/deepseek-harness');
});

/* ------------------------------------------------------------------ *
 * happy path
 * ------------------------------------------------------------------ */

test('happy path: assembles the contract snapshot from three endpoints', async () => {
  const cacheDir = await tempCacheDir();
  const fetchImpl = makeFake(happyHandler());
  const source = makeSource({ cacheDir, fetchImpl });

  const snap = await source.getSnapshot();

  assert.equal(snap.ok, true);
  assert.equal(snap.error, null);
  assert.equal(snap.fromCache, false);
  assert.equal(snap.degraded, false);
  assert.equal(snap.fetchedAt, T0);
  assert.deepEqual(Object.keys(snap).sort(), [
    'degraded',
    'error',
    'fetchedAt',
    'fromCache',
    'ok',
    'rateLimit',
    'recent',
    'releases',
    'today',
  ]);

  // page 1 first, page 2 only because Link rel=next said so
  const urls = fetchImpl.calls.map((c) => c.url);
  assert.deepEqual(
    urls,
    [COMMITS_1, COMMITS_1.replace('page=1', 'page=2'), EVENTS_1, EVENTS_1.replace('page=1', 'page=2'), RELEASES_1],
    `unexpected request sequence: ${urls.join(' ')}`,
  );

  // CST day keys: UTC 2026-10-08T17:00Z is 2026-10-09 01:00 CST
  assert.deepEqual(snap.today, { day: '2026-10-09', tianyicui: 2, all: 2 });
  assert.equal(snap.recent.days, 30);
  assert.equal(Object.keys(snap.recent.tianyicuiDaily).length, 30);
  assert.equal(snap.recent.tianyicuiDaily['2026-10-09'], 2);
  assert.equal(snap.recent.tianyicuiDaily['2026-10-08'], 1);
  assert.equal(snap.recent.allDaily['2026-10-09'], 2);
  assert.equal(snap.recent.allDaily['2026-10-07'], 1);
  // 97 filler events on 2026-09-15 (inside the window) + 2 on page 2 (09-14)
  assert.equal(snap.recent.tianyicuiDaily['2026-09-15'], 97);
  assert.equal(snap.recent.tianyicuiDaily['2026-09-14'], 2);
  // commits outside the 30-day window are dropped from `recent`
  assert.equal(Object.keys(snap.recent.allDaily).includes('2026-09-01'), false);

  // releases: version parsed out of tag_name, chronological order
  assert.deepEqual(snap.releases, [
    { version: '0.2.0', time: Date.parse('2026-10-01T10:00:00Z') },
    { version: '0.2.1-alpha.2', time: Date.parse('2026-10-08T10:00:00Z') },
  ]);

  assert.deepEqual(snap.rateLimit, {
    remaining: 54,
    limit: 60,
    resetAt: 1791000000 * 1000,
  });
});

test('paging stops on a short page even when Link rel=next is absent, and page 1 is used first', async () => {
  const calls = [];
  const fetchImpl = makeFake((url) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/users/')) {
      return jsonRes([pushEvent('e1', '2026-10-09T01:00:00Z', 1)]); // short page, no Link
    }
    if (url.includes('/releases')) return jsonRes([releaseItem('dsh-v0.2.0', '2026-10-01T10:00:00Z')]);
    return jsonRes([commitItem('2026-10-09T01:00:00Z', 'someone')]);
  });
  const snap = await makeSource({ fetchImpl }).getSnapshot();

  assert.equal(snap.ok, true);
  assert.equal(calls.length, 3, `one request per endpoint expected, got ${calls.join(' ')}`);
  assert.ok(calls[0].includes('page=1'));
  assert.ok(snap.recent.tianyicuiDaily['2026-10-09'] >= 1);
});

/* ------------------------------------------------------------------ *
 * rate limit
 * ------------------------------------------------------------------ */

test('403 rate limit without cache -> ok:false, never throws, headers surfaced', async () => {
  const cacheDir = await tempCacheDir();
  const fetchImpl = makeFake(() =>
    jsonRes({ message: 'API rate limit exceeded for 1.2.3.4.' }, { status: 403, headers: rateLimitHeaders(0, 60, 1791003600) }),
  );
  const source = makeSource({ cacheDir, fetchImpl });

  const snap = await resolving(() => source.getSnapshot());

  assert.equal(snap.ok, false);
  assert.equal(snap.fromCache, false);
  assert.equal(snap.degraded, false);
  assert.match(snap.error, /403/);
  assert.match(snap.error, /rate limit/i);
  assert.deepEqual(snap.rateLimit, { remaining: 0, limit: 60, resetAt: 1791003600 * 1000 });
  assert.equal(snap.today, null);
  assert.deepEqual(snap.recent, { days: 0, tianyicuiDaily: {}, allDaily: {} });
  assert.deepEqual(snap.releases, []);
  // unauth budget: at most 8 requests, even though all three phases failed
  assert.ok(fetchImpl.calls.length <= 8, `requests=${fetchImpl.calls.length}`);
});

/* ------------------------------------------------------------------ *
 * cache
 * ------------------------------------------------------------------ */

test('cache hit: a young cache is served without touching the network', async () => {
  const cacheDir = await tempCacheDir();
  const fetchImpl = makeFake(happyHandler());
  let clock = T0;
  const source = makeSource({ cacheDir, fetchImpl, now: () => clock, maxAgeMs: 30 * 60 * 1000 });

  const fresh = await source.getSnapshot();
  assert.equal(fresh.fromCache, false);

  fetchImpl.reset();
  fetchImpl.setHandler(() => {
    throw new Error('network must not be used for a young cache');
  });
  clock = T0 + 5 * 60 * 1000;

  const cached = await source.getSnapshot();
  assert.equal(cached.fromCache, true);
  assert.equal(cached.degraded, false);
  assert.equal(cached.ok, true);
  assert.equal(cached.error, null);
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(cached.today, fresh.today);
  assert.deepEqual(cached.recent, fresh.recent);
  assert.equal(cached.fetchedAt, T0, 'fetchedAt stays at the upstream read time');

  // requirement 5: the assembled snapshot really is JSON on disk under cacheDir
  const onDisk = JSON.parse(await readFile(path.join(cacheDir, 'snapshot.json'), 'utf8'));
  assert.equal(onDisk.v, 1);
  assert.equal(onDisk.snapshot.ok, true);
  assert.equal(onDisk.snapshot.today.day, '2026-10-09');
  assert.equal(onDisk.snapshot.recent.days, 30);
});

test('cache expiry: a stale cache triggers a refresh and the cache is rewritten', async () => {
  const cacheDir = await tempCacheDir();
  const fetchImpl = makeFake(happyHandler());
  let clock = T0;
  const source = makeSource({ cacheDir, fetchImpl, now: () => clock, maxAgeMs: 60 * 1000 });

  const first = await source.getSnapshot();
  assert.equal(first.today.tianyicui, 2);

  clock = T0 + 61 * 1000; // one ms past maxAgeMs
  fetchImpl.reset();
  fetchImpl.setHandler((url) => {
    if (url.startsWith('https://api.github.com/users/')) {
      return jsonRes([
        pushEvent('n1', '2026-10-09T05:00:00Z', 1),
        pushEvent('n2', '2026-10-09T05:30:00Z', 1),
        pushEvent('n3', '2026-10-09T05:40:00Z', 1),
        pushEvent('n4', '2026-10-09T05:45:00Z', 1),
        pushEvent('n5', '2026-10-09T05:50:00Z', 1),
      ]);
    }
    if (url.includes('/releases')) return jsonRes([releaseItem('dsh-v0.3.0', '2026-10-09T05:00:00Z')]);
    return jsonRes([commitItem('2026-10-09T05:00:00Z', 'someone')]);
  });

  const refreshed = await source.getSnapshot();
  assert.equal(refreshed.fromCache, false);
  assert.equal(refreshed.degraded, false);
  assert.equal(refreshed.today.tianyicui, 5);
  assert.equal(refreshed.fetchedAt, clock);
  assert.equal(fetchImpl.calls.length, 3);

  // the new state was persisted: a later call within maxAge serves it
  fetchImpl.setHandler(() => {
    throw new Error('should be served from cache');
  });
  clock = T0 + 90 * 1000;
  const served = await source.getSnapshot();
  assert.equal(served.fromCache, true);
  assert.equal(served.today.tianyicui, 5);
  assert.deepEqual(served.releases, [{ version: '0.3.0', time: Date.parse('2026-10-09T05:00:00Z') }]);
});

test('degraded: upstream failure with a stale cache returns the last good cache, degraded:true', async () => {
  const cacheDir = await tempCacheDir();
  const fetchImpl = makeFake(happyHandler());
  let clock = T0;
  const source = makeSource({ cacheDir, fetchImpl, now: () => clock, maxAgeMs: 60 * 1000 });

  const first = await source.getSnapshot();

  clock = T0 + 10 * 60 * 1000;
  fetchImpl.reset();
  fetchImpl.setHandler(() => {
    throw new Error('ECONNREFUSED 140.82.121.6:443');
  });

  const snap = await resolving(() => source.getSnapshot());
  assert.equal(snap.ok, true);
  assert.equal(snap.fromCache, true);
  assert.equal(snap.degraded, true);
  assert.match(snap.error, /events:/);
  assert.match(snap.error, /ECONNREFUSED/);
  assert.deepEqual(snap.today, first.today);
  assert.deepEqual(snap.recent, first.recent);
  assert.equal(snap.fetchedAt, T0);
});

test('invalidate() drops the cache so the next call goes upstream again', async () => {
  const cacheDir = await tempCacheDir();
  const fetchImpl = makeFake(happyHandler());
  let clock = T0;
  const source = makeSource({ cacheDir, fetchImpl, now: () => clock, maxAgeMs: 60 * 60 * 1000 });

  await source.getSnapshot();
  await source.invalidate();

  fetchImpl.reset();
  fetchImpl.setHandler(() => {
    throw new Error('offline');
  });
  const snap = await source.getSnapshot();
  assert.equal(snap.ok, false);
  assert.equal(snap.fromCache, false);
  assert.match(snap.error, /offline/);
  assert.ok(fetchImpl.calls.length > 0, 'a refresh should have been attempted');
});

/* ------------------------------------------------------------------ *
 * failure modes
 * ------------------------------------------------------------------ */

test('malformed JSON -> ok:false with a readable error, never throws', async () => {
  const fetchImpl = makeFake(() => malformedRes());
  const snap = await resolving(() => makeSource({ fetchImpl }).getSnapshot());
  assert.equal(snap.ok, false);
  assert.equal(snap.today, null);
  assert.match(snap.error, /invalid JSON/i);
});

test('timeout: a hung socket is aborted and reported, never throws', async () => {
  const seen = [];
  const fetchImpl = makeFake((url, n, init) => {
    seen.push(init);
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      });
    });
  });
  const started = Date.now();
  const snap = await resolving(() => makeSource({ fetchImpl, timeoutMs: 25 }).getSnapshot());
  const elapsed = Date.now() - started;

  assert.equal(snap.ok, false);
  assert.match(snap.error, /timed out after 25ms/);
  assert.ok(elapsed < 5000, `elapsed=${elapsed}ms`);
  assert.equal(seen.length, 3, 'one attempt per phase');
  assert.ok(seen.every((init) => init.signal.aborted), 'every request signal was aborted');
});

test('non-JSON, non-2xx and empty bodies are all handled without throwing', async () => {
  for (const handler of [
    () => malformedRes({ status: 500 }),
    () => jsonRes(null, { status: 200 }),
    () => jsonRes({ message: 'Not Found' }, { status: 404 }),
  ]) {
    const snap = await resolving(() => makeSource({ fetchImpl: makeFake(handler) }).getSnapshot());
    assert.equal(snap.ok, false);
    assert.ok(typeof snap.error === 'string' && snap.error.length > 0);
  }
});

/* ------------------------------------------------------------------ *
 * paging rules
 * ------------------------------------------------------------------ */

test('Link rel=next is followed verbatim instead of guessing page numbers', async () => {
  const eventsPage7 = EVENTS_1.replace('page=1', 'page=7');
  const fetchImpl = makeFake((url) => {
    if (url === EVENTS_1) {
      const events = [];
      for (let i = 0; i < 100; i++) events.push(pushEvent(`e${i}`, '2026-10-09T01:00:00Z', 1));
      return jsonRes(events, { headers: { link: `<${eventsPage7}>; rel="next"` } });
    }
    if (url === eventsPage7) return jsonRes([pushEvent('last', '2026-10-08T01:00:00Z', 1)]);
    if (url.includes('/releases')) return jsonRes([]);
    return jsonRes([]);
  });

  const snap = await makeSource({ fetchImpl }).getSnapshot();
  assert.equal(snap.ok, true);
  const eventUrls = fetchImpl.calls.map((c) => c.url).filter((u) => u.includes('/events/public'));
  assert.deepEqual(eventUrls, [EVENTS_1, eventsPage7]);
  assert.ok(!eventUrls.some((u) => u.includes('page=2')), 'page numbers must not be constructed');
});

test('release paging is pinned to <= 6 pages and the unauth budget to <= 8 requests', async () => {
  const fetchImpl = makeFake((url) => {
    if (url.startsWith('https://api.github.com/users/')) return jsonRes([pushEvent('e1', '2026-10-09T01:00:00Z', 1)]);
    if (url.includes('/releases')) {
      const items = [];
      for (let i = 0; i < 100; i++) items.push(releaseItem(`dsh-v0.1.${i}`, '2026-10-01T10:00:00Z'));
      const next = url.includes('page=')
        ? url.replace(/page=\d+/, (m) => `page=${Number(m.slice(5)) + 1}`)
        : `${url}&page=2`;
      return jsonRes(items, { headers: { link: `<${next}>; rel="next"` } });
    }
    return jsonRes([commitItem('2026-10-09T01:00:00Z', 'someone')]);
  });

  const snap = await makeSource({ fetchImpl }).getSnapshot();
  assert.equal(snap.ok, true);
  const releaseCalls = fetchImpl.calls.filter((c) => c.url.includes('/releases'));
  assert.ok(releaseCalls.length <= 6, `release pages=${releaseCalls.length}`);
  assert.equal(releaseCalls.length, 6);
  assert.ok(fetchImpl.calls.length <= 8, `total requests=${fetchImpl.calls.length}`);
  assert.equal(fetchImpl.calls.length, 8);
  // variants collapsed by version, ascending
  assert.equal(snap.releases.length, 100);
});

test('authenticated refreshes use the larger budget without exceeding it', async () => {
  const fetchImpl = makeFake((url) => {
    if (url.startsWith('https://api.github.com/users/')) return jsonRes([pushEvent('e1', '2026-10-09T01:00:00Z', 1)]);
    if (url.includes('/releases')) return jsonRes([releaseItem('dsh-v0.2.0', '2026-10-01T10:00:00Z')]);
    return jsonRes([commitItem('2026-10-09T01:00:00Z', 'someone')]);
  });
  const source = createSource({ fetchImpl, token: 'ghp_example' });
  const snap = await source.getSnapshot();
  assert.equal(snap.ok, true);
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), [COMMITS_1, EVENTS_1, RELEASES_1]);
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer ghp_example');
});

/* ------------------------------------------------------------------ *
 * partial refresh
 * ------------------------------------------------------------------ */

test('events failure still yields repo activity + releases, marked degraded, using author.login', async () => {
  const fetchImpl = makeFake((url) => {
    if (url.startsWith('https://api.github.com/users/')) throw new Error('events endpoint exploded');
    if (url.includes('/releases')) return jsonRes([releaseItem('dsh-v0.2.1-alpha.2', '2026-10-08T10:00:00Z')]);
    return jsonRes([
      commitItem('2026-10-09T02:00:00Z', GITHUB_USER), // CST 10-09
      commitItem('2026-10-09T03:00:00Z', 'someone-else'),
      commitItem('2026-10-08T20:00:00Z', null, 'Tianyi Cui'), // CST 10-09 via git name
    ]);
  });

  const snap = await makeSource({ fetchImpl }).getSnapshot();
  assert.equal(snap.ok, true);
  assert.equal(snap.degraded, true);
  assert.match(snap.error, /partial refresh/);
  assert.match(snap.error, /events/);
  assert.deepEqual(snap.today, { day: '2026-10-09', tianyicui: 2, all: 3 });
  assert.deepEqual(snap.releases, [{ version: '0.2.1-alpha.2', time: Date.parse('2026-10-08T10:00:00Z') }]);
});

/* ------------------------------------------------------------------ *
 * upstream-validated semantics
 * ------------------------------------------------------------------ */

test("tianyicui's activity is recovered from the repo feed when the events feed has no PushEvent", async () => {
  // Live upstream on 2026-10-09: /users/tianyicui/events/public carried 0
  // PushEvents, while the repo feed showed 12 tianyicui commits that day.
  const fetchImpl = makeFake((url) => {
    if (url.includes('/events/public')) return jsonRes([]);
    if (url.includes('/releases')) return jsonRes([]);
    return jsonRes([
      commitItem('2026-10-09T02:00:00Z', GITHUB_USER), // CST 10-09
      commitItem('2026-10-09T03:00:00Z', 'someone-else'),
      commitItem('2026-10-08T20:00:00Z', null, 'Tianyi Cui'), // CST 10-09 via git name
    ]);
  });

  const snap = await makeSource({ fetchImpl }).getSnapshot();
  assert.equal(snap.ok, true);
  assert.equal(snap.degraded, false);
  assert.deepEqual(snap.today, { day: '2026-10-09', tianyicui: 2, all: 3 });
});

test('a commit seen in both the repo feed and the events feed is counted once (sha dedupe)', async () => {
  const sharedSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const sharedEvent = {
    type: 'PushEvent',
    actor: { login: GITHUB_USER },
    created_at: '2026-10-09T02:00:00Z',
    payload: { size: 1, distinct_size: 1, commits: [{ sha: sharedSha, message: 'shared' }] },
  };
  const crossRepoEvent = {
    type: 'PushEvent',
    actor: { login: GITHUB_USER },
    created_at: '2026-10-09T04:00:00Z',
    payload: { size: 1, distinct_size: 1, commits: [{ sha: 'other-repo-sha', message: 'elsewhere' }] },
  };
  const fetchImpl = makeFake((url) => {
    if (url.includes('/events/public')) return jsonRes([sharedEvent, crossRepoEvent]);
    if (url.includes('/releases')) return jsonRes([]);
    return jsonRes([
      { sha: sharedSha, author: { login: GITHUB_USER }, commit: { committer: { date: '2026-10-09T02:00:00Z' }, author: { name: 'Tianyi Cui' } } },
      commitItem('2026-10-09T05:00:00Z', 'someone-else'),
    ]);
  });

  const snap = await makeSource({ fetchImpl }).getSnapshot();
  // shared sha counted once (repo feed wins) + the cross-repo push
  assert.deepEqual(snap.today, { day: '2026-10-09', tianyicui: 2, all: 2 });
});

test('recent.days reflects real fetched coverage: the possibly-partial oldest day is dropped', async () => {
  const commitsPage2Url = COMMITS_1.replace('page=1', 'page=2');
  const fetchImpl = makeFake((url) => {
    if (url === COMMITS_1) {
      const items = [];
      for (let i = 0; i < 100; i++) items.push(commitItem('2026-10-09T02:00:00Z', 'someone'));
      return jsonRes(items, { headers: { link: `<${commitsPage2Url}>; rel="next"` } });
    }
    if (url === commitsPage2Url) {
      const items = [];
      for (let i = 0; i < 50; i++) items.push(commitItem('2026-10-08T02:00:00Z', 'someone'));
      for (let i = 0; i < 50; i++) items.push(commitItem('2026-10-07T02:00:00Z', 'someone'));
      // more pages exist, but the page cap stops us: the oldest day is partial
      return jsonRes(items, { headers: { link: `<${COMMITS_1.replace('page=1', 'page=3')}>; rel="next"` } });
    }
    if (url.includes('/events/public')) return jsonRes([pushEvent('e1', '2026-10-09T05:00:00Z', 1)]);
    return jsonRes([]);
  });

  const snap = await makeSource({ fetchImpl }).getSnapshot();
  assert.equal(snap.ok, true);
  assert.equal(snap.recent.days, 2, 'coverage, not a fabricated 30-day window');
  assert.deepEqual(Object.keys(snap.recent.allDaily).sort(), ['2026-10-08', '2026-10-09']);
  assert.equal(snap.recent.allDaily['2026-10-09'], 100);
  assert.equal(snap.recent.allDaily['2026-10-08'], 50, 'partial 10-07 excluded');
  assert.equal(snap.recent.tianyicuiDaily['2026-10-09'], 1);
});

test('recentDays caps the window even when the fetched coverage is older', async () => {
  const fetchImpl = makeFake((url) => {
    if (url.includes('/events/public')) return jsonRes([pushEvent('e1', '2026-10-09T05:00:00Z', 1)]);
    if (url.includes('/releases')) return jsonRes([]);
    return jsonRes([commitItem('2026-10-05T02:00:00Z', 'someone')]); // CST 10-05, complete page
  });

  const snap = await makeSource({ fetchImpl, recentDays: 2 }).getSnapshot();
  assert.equal(snap.recent.days, 2);
  assert.deepEqual(Object.keys(snap.recent.allDaily).sort(), ['2026-10-08', '2026-10-09']);
  assert.equal(snap.recent.allDaily['2026-10-09'], 0, 'the 10-05 commit is outside the capped window');
});

/* ------------------------------------------------------------------ *
 * concurrency
 * ------------------------------------------------------------------ */

test('concurrent getSnapshot() calls share a single refresh', async () => {
  const fetchImpl = makeFake(async (url) => {
    await new Promise((r) => setTimeout(r, 5));
    return happyHandler()(url);
  });
  const source = makeSource({ fetchImpl });
  const [a, b] = await Promise.all([source.getSnapshot(), source.getSnapshot()]);
  assert.equal(a, b, 'the same in-flight promise is shared');
  assert.ok(fetchImpl.calls.length <= 8, `requests=${fetchImpl.calls.length}`);
});

test('a broken cache file is ignored rather than fatal', async () => {
  const cacheDir = await tempCacheDir();
  await writeFile(path.join(cacheDir, 'snapshot.json'), '{not json at all', 'utf8');
  const fetchImpl = makeFake(happyHandler());
  const snap = await resolving(() => makeSource({ cacheDir, fetchImpl }).getSnapshot());
  assert.equal(snap.ok, true);
  assert.equal(snap.fromCache, false);
  const repaired = JSON.parse(await readFile(path.join(cacheDir, 'snapshot.json'), 'utf8'));
  assert.equal(repaired.v, 1);
});
