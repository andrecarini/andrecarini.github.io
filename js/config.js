// ── STORAGE ──────────────────────────────────────────────────────────
export const LS_CFG    = 'portfolio-bg-cfg-v2';   // bumped when pulseSpeed changed from ms to multiplier
export const LS_THEME  = 'portfolio-bg-theme';
export const LS_MOTION = 'portfolio-bg-motion';

export function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

// ── CONFIG ───────────────────────────────────────────────────────────
export const defaults = {
  pulseSpeed:     1.0,    // speed multiplier (higher = faster); 1.0 = baseline
  pulseDashLen:   3.0,    // fraction of each edge covered by the visible dash (can exceed 1)
  pulseReach:     12,     // target hop count before pulse fizzles (higher = pulse reaches further)
  maxPulses:      60,     // concurrent pulse cap — oldest fade-evicted when exceeded
  densityUi:      90,
  drift:          0.4,
  hoverRadius:    200
};
export const FIXED_REWIRE_MS = 500;  // not user-tunable; internal constant

// Pulse-chain constants (click-triggered pulses).
// The arrival fraction (progress at which the leading tip reaches the
// destination) derives from dash length: 1 / (1 + L). Keeping this inline
// at call sites so the slider can change it live.
export const PULSE_BASE_E           = 1250;  // ms per REFERENCE-length edge at pulseSpeed=1.0
export const PULSE_GLOW_PRE         = 180;   // ms before arrival that the node-glow animation fires (so it peaks at arrival)
// Reference edge length in px. Pulses now traverse at constant visual
// speed (px/ms) rather than constant duration — short edges complete
// quickly, long edges linger. An edge of exactly PULSE_REF_EDGE_LEN px
// takes PULSE_BASE_E / pulseSpeed ms to traverse.
export const PULSE_REF_EDGE_LEN     = 150;
// Minimum length factor so pulses on very short edges still have
// enough duration for the gradient sweep to read properly.
export const PULSE_MIN_LEN_FACTOR   = 0.4;
export const PULSE_ENERGY_THRESHOLD = 0.05;  // pulse dies when energy falls to/below this

// Node-pulse envelope (charge / hold / discharge).
export const PULSE_CHARGE_MS    = 180;
export const PULSE_HOLD_MS      = 900;
export const PULSE_DISCHARGE_MS = 3000;

// `cfg` is mutated in place throughout the app. Resets overwrite fields
// via Object.assign rather than reassigning the reference, so every
// importer sees the same object.
export const cfg = { ...defaults };
try {
  const saved = JSON.parse(lsGet(LS_CFG));
  if (saved && typeof saved === 'object') Object.assign(cfg, defaults, saved);
} catch {}

export function persistCfg() { lsSet(LS_CFG, JSON.stringify(cfg)); }
export function getDensityValue() { return 40000 - (cfg.densityUi / 100) * 30000; }

// Per-hop energy decay is derived from pulseReach so the slider reads as
// "roughly how many hops before fizzling". Starting energy 1.0 decays by
// this amount per hop; pulse dies once energy ≤ threshold (0.05).
// Example: reach=12 → decay = 0.95/11 ≈ 0.086, fizzles after ~12 hops.
export function currentPulseDecay() {
  return (1 - PULSE_ENERGY_THRESHOLD) / Math.max(1, cfg.pulseReach - 1);
}
