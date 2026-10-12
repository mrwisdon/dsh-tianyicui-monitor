#!/usr/bin/env node
/**
 * DeepSeek model release timeline, for display alongside DSH releases.
 *
 * Source: the Hugging Face organisation API, which is the only public source that
 * exposes a creation date per model. Model cards are created at publication, so
 * `createdAt` is a good proxy for the release date.
 *
 * Scope: models published since the DSH repository was created, because the
 * question this answers is "how do model launches line up with DSH releases".
 * Adapters, distills, quantisations and base checkpoints are recorded but flagged
 * `flagship: false`, so they can be shown or hidden without losing the data.
 *
 *   node build/fetch_models.mjs
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORG = 'deepseek-ai';

// Name shapes that are NOT a standalone model release.
const VARIANT = [
  /-Distill-/i, /-Base$/i, /-SFT$/i, /-RL$/i, /-Chat$/i, /-Instruct/i,
  /^eagle3_/i, /^dflash_/i, /^dspark_/i, /-GGUF$/i, /-AWQ$/i, /-GPTQ$/i, /-W8A8/i, /-FP8$/i,
];
// A flagship is a named generation: DeepSeek-V4, DeepSeek-V4.1-Flash, DeepSeek-R1, ...
const FLAGSHIP = /^deepseek-ai\/DeepSeek-(V\d(\.\d+)?|R\d|Coder|Math|VL|MoE|LLM|OCR|Prover|Janus)\b/;

async function fetchAll() {
  const out = [];
  for (let skip = 0; skip < 500; skip += 100) {
    const res = await fetch(
      `https://huggingface.co/api/models?author=${ORG}&sort=createdAt&direction=-1&limit=100&skip=${skip}`,
      { headers: { 'User-Agent': 'dsh-tianyicui-monitor' } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} from huggingface`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

async function main() {
  // the lower bound: when the DSH repository was created
  const ds = JSON.parse(readFileSync(resolve(ROOT, 'data/dataset.json'), 'utf8'));
  const sinceMs = ds.meta.firstCommitMs;
  const since = new Date(sinceMs).toISOString().slice(0, 10);

  const models = await fetchAll();
  const releases = [];
  for (const m of models) {
    const id = m.modelId || '';
    const created = m.createdAt;
    if (!created) continue;
    const time = Date.parse(created);
    if (!Number.isFinite(time) || time < sinceMs) continue;
    const name = id.split('/').pop();
    releases.push({
      name,
      id,
      time,
      day: created.slice(0, 10),
      flagship: FLAGSHIP.test(id) && !VARIANT.some((re) => re.test(name)),
      downloads: m.downloads || 0,
    });
  }
  releases.sort((a, b) => a.time - b.time);

  const artifact = {
    generatedAt: Date.now(),
    source: 'https://huggingface.co/api/models?author=deepseek-ai (createdAt)',
    org: ORG,
    scopeNote:
      'Only models published since the DSH repository was created. Adapters, distills, quantisations and base checkpoints are included but flagged flagship:false.',
    since,
    total: releases.length,
    flagshipCount: releases.filter((r) => r.flagship).length,
    releases,
  };
  writeFileSync(resolve(ROOT, 'data/models.json'), JSON.stringify(artifact, null, 1));

  console.log(`since ${since}: ${releases.length} model cards, ${artifact.flagshipCount} flagship`);
  for (const r of releases) {
    console.log(`  ${r.day}  ${r.flagship ? 'FLAGSHIP' : 'variant '}  ${r.name}`);
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
