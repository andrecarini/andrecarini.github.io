import { animate } from './anime.js';
import {
  SVG_NS,
  pulsesG,
  pulsesFxG,
  rt,
  nodes,
  nodeEls,
  adjacency,
  liveOverlays,
} from './graph/state.js';
import {
  cfg,
  currentPulseDecay,
  PULSE_BASE_E,
  PULSE_GLOW_PRE,
  PULSE_REF_EDGE_LEN,
  PULSE_MIN_LEN_FACTOR,
  PULSE_ENERGY_THRESHOLD,
  PULSE_CHARGE_MS,
  PULSE_HOLD_MS,
  PULSE_DISCHARGE_MS,
} from './config.js';
import { clock, updateOverlayPosition } from './graph/drift.js';
import { colors } from './theme.js';
import { audioArpeggio } from './audio.js';

// ── EDGE GEOMETRY ───────────────────────────────────────────────────
// Effective edge traversal time (ms) for a pulse, snapshotted at
// emission time. Edge length may drift during traversal but the
// duration stays fixed so pulses don't accelerate/decelerate mid-edge.
export function computeEdgeE(a, b) {
  const na = nodes[a]?.cur, nb = nodes[b]?.cur;
  const baseE = PULSE_BASE_E / cfg.pulseSpeed;
  if (!na || !nb) return baseE;
  const edgeLen = Math.hypot(nb.x - na.x, nb.y - na.y);
  const lenFactor = Math.max(PULSE_MIN_LEN_FACTOR, edgeLen / PULSE_REF_EDGE_LEN);
  return baseE * lenFactor;
}

// ── EDGE GLOW (light pulse along a single edge) ─────────────────────
// Single-line, single-gradient approach. The stroke is a linearGradient
// whose endpoints (x1,y1 → trailing edge, x2,y2 → leading edge) sweep
// along the underlying edge as the pulse progresses. The gradient stops
// define the comet shape — sharp leading edge, soft trailing fade — and
// spreadMethod="pad" with transparent endpoint stops means everything
// outside the gradient range (ahead of the head, behind the tail) is
// transparent, so the pulse cleanly enters and exits the edge.
//
// Motion is driven by the drift tick reading `startTime` from the overlay
// record — no per-frame anime.js animations for pulse movement at all.
// Only the disruption fade uses anime.js. This keeps per-pulse cost to:
// 2 DOM elements (1 gradient + 1 line), 4 stops, 8 attribute updates per
// frame — versus the previous 10 lines × 10 animations per pulse.
//
// The gradient's stop opacities are pre-baked with the pulse's energy
// factor so they don't need updating during flight.
// Concurrent-pulse cap is user-tunable via cfg.maxPulses. Each live gradient
// pulse costs: a linearGradient in the DOM, a stroked line (compositely
// filtered via the .pulses-fx group), and per-frame endpoint updates.
export const activePulses = new Set();   // insertion order = age order (oldest first)

// Fade out and remove a gradient pulse. Used both for edge-disruption
// (when underlying edge breaks) and for cap-enforced eviction. The fade
// prevents visual pops — pulses don't just vanish.
export function fadeOutPulse(ov, duration = 500) {
  if (ov.disrupted) return;
  ov.disrupted = true;
  activePulses.delete(ov);
  if (ov.cleanupTimer) clearTimeout(ov.cleanupTimer);
  animate(ov.el, {
    opacity: 0,
    duration,
    ease: 'out(2)',
    onComplete: () => {
      liveOverlays.delete(ov);
      try { ov.gradient.remove(); ov.el.remove(); } catch {}
    }
  });
}

let pulseGradientCounter = 0;

// Gradient stop shape: opacity envelope from tail (offset 0) to head
// (offset 0.99), with a sharp drop to transparent at offset 1.0 so the
// "beyond head" region (painted with pad spreading of the last stop) is
// transparent. First stop is also transparent for symmetric "before tail".
const PULSE_STOPS = [
  { offset: 0.00, o: 0.00 },   // tail tip — transparent
  { offset: 0.25, o: 0.04 },
  { offset: 0.50, o: 0.18 },
  { offset: 0.72, o: 0.44 },
  { offset: 0.87, o: 0.74 },
  { offset: 0.95, o: 0.94 },
  { offset: 0.99, o: 1.00 },   // head plateau
  { offset: 1.00, o: 0.00 }    // sharp cutoff past head
];

function createEdgeGlow(a, b, energy = 1) {
  // Enforce concurrent-pulse cap. If we're over, fade out the oldest live
  // gradient pulse (insertion order in the Set). Fade is fast (250ms) so
  // it clears the slot quickly, but still smooth enough to avoid visual pop.
  while (activePulses.size >= cfg.maxPulses) {
    const oldest = activePulses.values().next().value;
    if (!oldest) break;
    fadeOutPulse(oldest, 250);
  }

  const E             = computeEdgeE(a, b);
  const pulseLen      = cfg.pulseDashLen;
  const totalDuration = E * (1 + pulseLen);    // wall time for pulse to fully exit edge

  const gid = `pg${++pulseGradientCounter}`;
  const gradient = document.createElementNS(SVG_NS, 'linearGradient');
  gradient.setAttribute('id', gid);
  gradient.setAttribute('gradientUnits', 'userSpaceOnUse');
  // spreadMethod defaults to 'pad' which is what we want — stops at 0.00
  // and 1.00 are both transparent, so outside-range paint is transparent.
  for (const { offset, o } of PULSE_STOPS) {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', String(offset));
    stop.style.stopColor   = 'var(--accent)';
    stop.style.stopOpacity = String(Math.max(0, Math.min(1, o * energy)));
    gradient.appendChild(stop);
  }
  pulsesFxG.appendChild(gradient);

  const line = document.createElementNS(SVG_NS, 'line');
  line.classList.add('glow-pulse');
  line.setAttribute('stroke', `url(#${gid})`);
  pulsesFxG.appendChild(line);

  const ov = {
    el: line,
    gradient,
    a, b,
    mode: 'full-gradient',
    disrupted: false,
    startTime: clock.logicalTime,    // logical, not wall — freezes with drift
    totalDuration,
    pulseLen
  };
  liveOverlays.add(ov);
  activePulses.add(ov);
  updateOverlayPosition(ov);

  // Natural-completion cleanup. Uses wall-time setTimeout — during motion
  // pause, pulses freeze visually (logical time is frozen) but this timer
  // keeps running, so after a long-enough pause they'll simply be gone on
  // resume. Acceptable per user requirements.
  ov.cleanupTimer = setTimeout(() => {
    activePulses.delete(ov);
    liveOverlays.delete(ov);
    try { gradient.remove(); line.remove(); } catch {}
  }, totalDuration + 50);

  return ov;
}

// ── NODE PULSE (when a signal arrives) ──────────────────────────────
// Charge / hold / discharge: fast 180ms ramp to peak, brief 900ms hold
// at peak (so the "charged" state is clearly visible while the pulse
// traverses the node), then a long 3000ms discharge with out(2) easing
// for an exponential-ish fall-off. Applied to fill, fill-opacity, and
// glow opacity so the whole node reads as one unit being energised and
// bleeding off together.
// `energy` (0..1) scales the peak fill-opacity and glow opacity, so
// progressively dimmer pulses read as "less charge remaining".
export function pulseNode(idx, energy = 1) {
  if (idx < 0 || !nodeEls[idx]) return;
  if (energy <= 0.01) return;
  const n = nodes[idx];
  const el = nodeEls[idx];

  // Peak fill-opacity lerps from the node's baseline alpha toward full
  // opacity by the energy factor. At energy=1 the node maxes out; at low
  // energy the peak is only marginally above baseline.
  const peakAlpha = n.alpha + (1 - n.alpha) * energy;

  // Merge fill + fillOpacity into a single animate() call. Both share
  // the charge/hold/discharge envelope; two separate calls scheduled
  // duplicate ticks and onBegin bookkeeping for no benefit.
  animate(el, {
    fill: [
      { to: colors.nodeHot,  duration: PULSE_CHARGE_MS,    ease: 'out(2)' },
      { to: colors.nodeHot,  duration: PULSE_HOLD_MS,      ease: 'linear' },
      { to: colors.nodeIdle, duration: PULSE_DISCHARGE_MS, ease: 'out(2)' }
    ],
    fillOpacity: [
      { to: peakAlpha, duration: PULSE_CHARGE_MS,    ease: 'out(2)' },
      { to: peakAlpha, duration: PULSE_HOLD_MS,      ease: 'linear' },
      { to: n.alpha,   duration: PULSE_DISCHARGE_MS, ease: 'out(2)' }
    ]
  });

  // Glow overlay — tracked in liveOverlays so it follows drift.
  const glow = document.createElementNS(SVG_NS, 'circle');
  glow.setAttribute('cx', n.cur.x);
  glow.setAttribute('cy', n.cur.y);
  glow.setAttribute('r', n.r);
  glow.setAttribute('opacity', '0');
  glow.classList.add('node-glow');
  pulsesG.appendChild(glow);

  // Store the node REFERENCE rather than its index. Churn can splice
  // nodes out mid-glow, shifting every index above the dead one down by
  // one; a stored index would then silently start tracking a different
  // node and the glow would teleport across the screen. References
  // survive reindexing because the object identity is stable.
  const ov = { el: glow, node: n, mode: 'node' };
  liveOverlays.add(ov);

  animate(glow, {
    opacity: [
      { to: energy, duration: PULSE_CHARGE_MS,    ease: 'out(2)' },
      { to: energy, duration: PULSE_HOLD_MS,      ease: 'linear' },
      { to: 0,      duration: PULSE_DISCHARGE_MS, ease: 'out(2)' }
    ],
    onComplete: () => {
      liveOverlays.delete(ov);
      try { glow.remove(); } catch {}
    }
  });
}

// ── CLICK-TRIGGERED PULSE EMISSION ─────────────────────────────────
// A click finds the nearest node, flashes it at full energy, and sends
// one independent pulse down each outgoing edge. Each branch walks the
// graph hop-by-hop, losing energy per hop, and dies when empty.
export function findNearestNode(x, y) {
  let bestIdx = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i].cur;
    const dx = n.x - x, dy = n.y - y;
    const d2 = dx*dx + dy*dy;
    if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
  }
  return bestIdx;
}

export function emitFromNode(startIdx) {
  if (startIdx < 0 || !nodes[startIdx]) return;
  if (!adjacency[startIdx] || adjacency[startIdx].length === 0) return;
  const version = rt.graphVersion;
  const now = performance.now();

  // Flash the origin at full energy.
  pulseNode(startIdx, 1.0);
  // If audio is active, fire an arpeggio seeded by the origin node —
  // different start node = different pentatonic rotation.
  audioArpeggio(startIdx);

  // One branch per outgoing edge. Each gets its own visitTimes so branches
  // are genuinely independent — they can cross each other's paths.
  // visitTimes is keyed by node object reference (not index) so it remains
  // valid even when reallyRemoveNode reindexes arrays mid-walk.
  for (const neighbour of adjacency[startIdx]) {
    const visitTimes = new Map();
    visitTimes.set(nodes[startIdx], now);
    scheduleHop(startIdx, neighbour, 1.0, visitTimes, version);
  }
}

// Pick the next neighbour for a continuing pulse branch. Unvisited
// neighbours are preferred (random among them); otherwise fall back to
// the least-recently-visited one so branches keep flowing in dense
// clusters. visitTimes is keyed by node REFERENCE (not index) so it
// remains valid across reallyRemoveNode reindexing.
export function selectNextHop(fromIdx, visitTimes) {
  const options = adjacency[fromIdx];
  if (!options || options.length === 0) return -1;

  const unvisited = options.filter(n => !visitTimes.has(nodes[n]));
  if (unvisited.length > 0) {
    return unvisited[(Math.random() * unvisited.length) | 0];
  }
  return options.reduce((oldest, n) => {
    const tCurr   = visitTimes.get(nodes[n])      ?? -Infinity;
    const tOldest = visitTimes.get(nodes[oldest]) ?? -Infinity;
    return tCurr < tOldest ? n : oldest;
  }, options[0]);
}

// Emit one pulse hop along an edge. Creates the gradient overlay and
// decorates it with logical-time triggers (glowFiresAt / hopFiresAt) so
// the drift tick can fire the arrival node-glow and the next hop at the
// moment the pulse VISUALLY arrives — not when wall time says it should.
// This matters whenever wall time outpaces logical time (dropped frames,
// timeScale < 1 during the chaos slow-down), where the old setTimeout
// approach would light the destination node before the pulse got there.
export function scheduleHop(from, to, energy, visitTimes, version) {
  if (version !== rt.graphVersion) return;
  if (energy <= PULSE_ENERGY_THRESHOLD) return;
  const fromNode = nodes[from];
  const toNode   = nodes[to];
  if (!fromNode || !toNode) return;
  // Edge may have been hysteresis-broken between scheduling and firing.
  if (!adjacency[from] || !adjacency[from].includes(to)) return;

  const E         = computeEdgeE(from, to);   // leading tip reaches destination at E units of LOGICAL time
  const newEnergy = energy - currentPulseDecay();

  // Create the visual pulse. ov.startTime is snapshotted against
  // logicalTime inside createEdgeGlow, so our thresholds below share the
  // same clock the gradient endpoints advance against.
  const overlay = createEdgeGlow(from, to, energy);

  overlay.toNode       = toNode;
  overlay.newEnergy    = newEnergy;
  overlay.visitTimes   = visitTimes;
  overlay.version      = version;
  overlay.arrivedGlow  = false;
  overlay.arrivedHop   = false;
  // Node-glow anticipates arrival by PULSE_GLOW_PRE so its peak aligns
  // with the moment the leading tip reaches the destination.
  overlay.glowFiresAt  = overlay.startTime + Math.max(0, E - PULSE_GLOW_PRE);
  overlay.hopFiresAt   = overlay.startTime + E;

  // Record arrival time for the "least recently visited" tiebreak. Wall
  // time is fine here — this only orders hops relative to each other.
  visitTimes.set(toNode, performance.now());
}
