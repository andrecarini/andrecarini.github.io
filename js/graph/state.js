// ── SVG REFERENCES ───────────────────────────────────────────────────
// Root container + sub-groups. DOM nodes are stable for the lifetime of
// the page, so these are module-level consts.
export const SVG_NS     = 'http://www.w3.org/2000/svg';
export const svg        = document.getElementById('field');
export const edgesG     = svg.querySelector('.edges');
export const nodesG     = svg.querySelector('.nodes');
export const pulsesG    = svg.querySelector('.pulses');
export const pulsesFxG  = svg.querySelector('.pulses-fx');

// Clear all pulse overlays while preserving the pulses-fx sub-group as a
// container. Called from buildGraph/pauseBackground/cleanup — anywhere we
// were previously calling pulsesG.replaceChildren().
export function clearPulses() {
  Array.from(pulsesG.children).forEach(ch => {
    if (ch !== pulsesFxG) ch.remove();
  });
  pulsesFxG.replaceChildren();
}

// ── GRAPH GEOMETRY CONSTANTS ─────────────────────────────────────────
export const FORM_DIST   = 160;    // form threshold
export const BREAK_DIST  = 210;    // break threshold (hysteresis deadband = 50px)
export const FORM_DIST2  = FORM_DIST * FORM_DIST;
export const BREAK_DIST2 = BREAK_DIST * BREAK_DIST;
export const MIN_DIST    = 72;

// ── GRAPH STATE ──────────────────────────────────────────────────────
// Mutable collections: `export const`, mutated in place. Consumers can
// iterate / push / splice / delete. Never reassigned — buildGraph clears
// via .length = 0 / .clear() rather than `nodes = []`.
export const nodes        = [];
export const adjacency    = [];
export const nodeEls      = [];
export const nodeHot      = [];
export const edgeIndex    = new Map();
export const liveOverlays = new Set();   // { el, a, b, mode: 'full' | 'half-a' | 'half-b' | 'node' | 'full-gradient' }
export const runningAnims = [];

// Primitives that genuinely change: viewport size, timer ids, raf id,
// graph rebuild counter. Grouped into a single object so importers can
// read + write without needing one setter per field.
//   rt.W, rt.H — viewport dimensions
//   rt.raf — current rAF id for the drift tick (or null when stopped)
//   rt.rewireTimer — setInterval id for recomputeEdges
//   rt.churnTimer — setTimeout id for scheduleChurn
//   rt.startupTimeout — setTimeout id for the intro-rewire handoff
//   rt.graphVersion — bumped whenever the graph rebuilds (pulse hops
//       gated on this so async cleanups during a rebuild no-op instead
//       of touching fresh nodes).
export const rt = {
  W: 0,
  H: 0,
  raf: null,
  rewireTimer: null,
  churnTimer: null,
  startupTimeout: null,
  graphVersion: 0,
};
