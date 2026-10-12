/**
 * tianyicui-monitor — probability classification.
 *
 * Turns the model's calibrated probability into a three-state verdict the UI can
 * colour and the locale dictionaries can label. Pure and dependency free.
 *
 * Bands (frozen by CONTRACTS.md):
 *   p == null            -> unknown / neutral
 *   p >= 0.90            -> release-likely
 *   p >= 0.80            -> watch
 *   otherwise            -> quiet
 */

/** Probability at or above which we call a 72h release likely. */
export const LIKELY_THRESHOLD = 0.9;

/** Probability at or above which the panel switches to "watch". */
export const WATCH_THRESHOLD = 0.8;

/** Semantic tone, used by views to pick a theme color. */
export const TONES = ['danger', 'warn', 'calm', 'neutral'];

const LEVELS = {
  'release-likely': { tone: 'danger' },
  watch: { tone: 'warn' },
  quiet: { tone: 'calm' },
  unknown: { tone: 'neutral' },
};

/**
 * @param {number|string|null|undefined} p calibrated probability (0..1)
 * @returns {{level:'release-likely'|'watch'|'quiet'|'unknown',
 *            label:string, labelEn:string, tone:'danger'|'warn'|'calm'|'neutral',
 *            probability:number|null}}
 */
export function classifyProbability(p) {
  let value = p;
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { level: 'unknown', label: '暂无数据', labelEn: 'no data', tone: 'neutral', probability: null };
  }

  const level =
    value >= LIKELY_THRESHOLD ? 'release-likely' : value >= WATCH_THRESHOLD ? 'watch' : 'quiet';
  const labels = {
    'release-likely': { label: '很可能发布', labelEn: 'release likely' },
    watch: { label: '关注', labelEn: 'watch' },
    quiet: { label: '平静', labelEn: 'quiet' },
  }[level];

  return {
    level,
    label: labels.label,
    labelEn: labels.labelEn,
    tone: LEVELS[level].tone,
    probability: value,
  };
}

/** Map a tone to a theme color, with a safe non-hex fallback. */
export function toneColor(tone, theme) {
  const t = theme && typeof theme === 'object' ? theme : {};
  const pick = (key) => (typeof t[key] === 'string' && t[key] ? t[key] : null);
  switch (tone) {
    case 'danger':
      return pick('danger') || pick('accent') || 'currentColor';
    case 'warn':
      return pick('accent') || pick('label') || 'currentColor';
    case 'calm':
      return pick('labelSecondary') || pick('label') || 'currentColor';
    default:
      return pick('border') || pick('labelTertiary') || 'currentColor';
  }
}
