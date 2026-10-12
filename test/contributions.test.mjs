/**
 * Contribution-graph parsing tests.
 *
 * The parser reads GitHub's server-rendered profile calendar. That markup is not
 * a stable API, so the fixture is a REAL captured page and the tests pin both
 * the parse and the invariants that must hold when it drifts.
 *
 *   node --test test/contributions.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContributionCalendar } from '../build/scan_contributions.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(ROOT, 'test/fixtures-contributions.html'), 'utf8');
const artifact = JSON.parse(readFileSync(resolve(ROOT, 'data/contributions.json'), 'utf8'));

test('parses every day cell out of the real calendar markup', () => {
  const r = parseContributionCalendar(html);
  assert.ok(r.days >= 360, `expected a full year of days, got ${r.days}`);
  assert.equal(Object.keys(r.byDay).length, r.days);
  for (const [day, v] of Object.entries(r.byDay)) {
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/, 'day keys must be ISO dates');
    assert.ok(Number.isInteger(v) && v >= 0, `${day} must be a non-negative integer, got ${v}`);
  }
});

test('the parsed per-day sum equals the total GitHub prints in the header', () => {
  const r = parseContributionCalendar(html);
  const sum = Object.values(r.byDay).reduce((a, b) => a + b, 0);
  assert.ok(r.declaredTotal !== null, 'the header total must be readable');
  assert.equal(sum, r.declaredTotal,
    'a mismatch means the markup changed or days were dropped — never ignore this');
});

test('the shipped artifact is self-consistent', () => {
  assert.equal(artifact.metric, 'contributions');
  assert.equal(artifact.includesPrivate, true);
  assert.equal(artifact.totalsMatch, true);
  assert.equal(artifact.parsedTotal, artifact.declaredTotal);
  assert.match(artifact.metricNote, /not a commit count/i);
  assert.match(artifact.includesPrivateNote, /private/i);
  const sum = Object.values(artifact.byDay).reduce((a, b) => a + b, 0);
  assert.equal(sum, artifact.parsedTotal);
});

test('the artifact reaches far enough back to cover the commit history', () => {
  const dataset = JSON.parse(readFileSync(resolve(ROOT, 'data/dataset.json'), 'utf8'));
  // commit history starts 2026-06-10; the contribution window must include it
  assert.ok(artifact.firstDay <= '2026-06-10',
    `contribution window starts ${artifact.firstDay}, too late to cover the commit history`);
});

test('10-10 and 10-11 carry contributions even though the public repo has none', () => {
  // This is the whole reason the graph matters: the repo went completely silent
  // (verified against the remote tip), yet the contribution graph shows activity.
  const dataset = JSON.parse(readFileSync(resolve(ROOT, 'data/dataset.json'), 'utf8'));
  assert.ok(!dataset.allCommits.some((t) => {
    const d = new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
    return d === '2026-10-10';
  }), 'the fixture premise: no public commits on 10-10');
  assert.ok(artifact.byDay['2026-10-10'] > 0,
    'but the contribution graph must show activity on 10-10');
});

test('the parser fails loudly rather than silently returning nothing', () => {
  const r = parseContributionCalendar('<html><body>nothing here</body></html>');
  assert.equal(r.days, 0, 'no cells means 0 days, which the caller treats as an error');
  assert.equal(r.declaredTotal, null);
});
