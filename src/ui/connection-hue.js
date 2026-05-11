// Per-ChargePoint color. The hue is a stable per-CP property assigned at
// creation time (`pickHue`) and persisted on the CP record as `cp.hue`, so
// duplicating, reordering, and reload all keep the same color. The CP
// detail's hue slider writes back to the same field.

const GOLDEN_ANGLE = 137.508;
const SEED_HUE = 200; // first CP starts blue-ish

// Pick a hue for a new CP that's maximally distinct from `existingHues`.
// Steps the golden-angle sequence from the most-recent hue, which gives
// good visual separation for any practical number of CPs.
export function pickHue(existingHues = []) {
  if (existingHues.length === 0) return SEED_HUE;
  const last = existingHues[existingHues.length - 1];
  return (last + GOLDEN_ANGLE) % 360;
}

// Read the hue off a CP record. Anything we can't resolve (null cp, log
// entry for a CP we no longer have locally) falls back to the seed hue —
// callers don't have to null-check the input.
export function hueOf(cp) {
  return (cp && typeof cp.hue === 'number') ? cp.hue : SEED_HUE;
}

export function bgFor(cp, alpha = 0.18) {
  return `hsla(${hueOf(cp)}, 65%, 45%, ${alpha})`;
}

export function fgFor(cp) {
  return `hsl(${hueOf(cp)}, 70%, 65%)`;
}

// HSL → hex; uses the same saturation/lightness as fgFor so the color
// picker's swatch matches the actual log/chip color.
export function hueToHex(hue) {
  const s = 0.70, l = 0.65;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + (hue % 360) / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// Hex → hue. Saturation/lightness are dropped — only the hue channel is
// stored on the CP record. Pickers that yield gray ramps return SEED_HUE.
export function hexToHue(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return SEED_HUE;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return SEED_HUE; // gray; no meaningful hue
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  return (h + 360) % 360;
}
