import { animate } from '../anime.js';
import {
  SVG_NS,
  edgesG,
  pulsesG,
  rt,
  nodes,
  adjacency,
  edgeIndex,
  liveOverlays,
  BREAK_DIST,
  BREAK_DIST2,
  FORM_DIST2,
} from './state.js';
import { FIXED_REWIRE_MS } from '../config.js';
import { fadeOutPulse } from '../pulses.js';
import { updateOverlayPosition } from './drift.js';

// ── RECOMPUTE EDGES (k-NN with hysteresis) ───────────────────────────
export function recomputeEdges() {
  if (nodes.length === 0) return;

  // Spatial hash: bin nodes into cells sized BREAK_DIST on a side. Any
  // two nodes within BREAK_DIST are guaranteed to be either in the same
  // cell or in one of the 8 neighbouring cells — so we check each node
  // only against that 3×3 neighbourhood instead of the whole graph.
  // Drops this from O(n²) to roughly O(n) at typical densities.
  const CELL = BREAK_DIST;
  const grid = new Map();                                  // "cx,cy" -> [indices]
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i].cur;
    const cx = Math.floor(n.x / CELL), cy = Math.floor(n.y / CELL);
    const key = cx + ',' + cy;
    let bucket = grid.get(key);
    if (!bucket) { bucket = []; grid.set(key, bucket); }
    bucket.push(i);
  }

  const candidates = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i].cur;
    const cxi = Math.floor(n.x / CELL), cyi = Math.floor(n.y / CELL);
    // Scan the 3×3 cell neighbourhood centred on this node.
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = grid.get((cxi + ox) + ',' + (cyi + oy));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;                            // preserve i<j ordering
          const dx = nodes[j].cur.x - n.x;
          const dy = nodes[j].cur.y - n.y;
          const d2 = dx*dx + dy*dy;
          const key = i + '-' + j;
          const exists = edgeIndex.has(key);
          const thresh2 = exists ? BREAK_DIST2 : FORM_DIST2;
          if (d2 < thresh2) {
            candidates[i].push({ j, d2 });
            candidates[j].push({ j: i, d2 });
          }
        }
      }
    }
  }

  const should = new Set();
  for (let i = 0; i < nodes.length; i++) {
    candidates[i].sort((a, b) => a.d2 - b.d2);
    const k = Math.min(nodes[i].k, candidates[i].length);
    for (let m = 0; m < k; m++) {
      const j = candidates[i][m].j;
      const a = Math.min(i, j), b = Math.max(i, j);
      should.add(a + '-' + b);
    }
  }

  // Remove
  const toRemove = [];
  for (const key of edgeIndex.keys()) {
    if (!should.has(key)) toRemove.push(key);
  }
  for (const key of toRemove) {
    const entry = edgeIndex.get(key);
    edgeIndex.delete(key);
    adjacency[entry.a] = adjacency[entry.a].filter(x => x !== entry.b);
    adjacency[entry.b] = adjacency[entry.b].filter(x => x !== entry.a);

    // Disrupt any in-flight pulse overlays on this edge. Flag them so the
    // branch's arrival pulse and next-hop don't fire, and smoothly fade the
    // visible pulse so the viewer doesn't see it drifting along a
    // non-existent edge. Longer fade (700ms) reads as a natural decay rather
    // than an abrupt cut.
    for (const ov of liveOverlays) {
      if (ov.mode === 'full-gradient' &&
          ((ov.a === entry.a && ov.b === entry.b) ||
           (ov.a === entry.b && ov.b === entry.a))) {
        fadeOutPulse(ov, 700);
      }
    }

    const el = entry.el;
    animate(el, {
      opacity: 0,
      duration: 650,
      ease: 'out(2)',
      onComplete: () => { try { el.remove(); } catch {} }
    });
  }

  // Add
  for (const key of should) {
    if (edgeIndex.has(key)) continue;
    const [ai, bi] = key.split('-').map(Number);

    const ln = document.createElementNS(SVG_NS, 'line');
    ln.x1.baseVal.value = nodes[ai].cur.x;
    ln.y1.baseVal.value = nodes[ai].cur.y;
    ln.x2.baseVal.value = nodes[bi].cur.x;
    ln.y2.baseVal.value = nodes[bi].cur.y;
    ln.classList.add('edge');
    ln.style.opacity = '0';
    edgesG.appendChild(ln);

    edgeIndex.set(key, { el: ln, a: ai, b: bi, hot: false });
    adjacency[ai].push(bi);
    adjacency[bi].push(ai);

    animateReconnect(ai, bi, ln);
  }
}

// ── NEW EDGE ANIMATION: two halves draw in from each node to midpoint ─
// Uses .glow-soft so reconnects are visually distinct from signal pulses
// (neutral hue, no drop-shadow). Reserves accent color for pulses only.
// Meeting point, draw speed, fade-out duration, and visible strength are
// all randomised per reconnect so the animation feels organic instead of
// every rewire looking identical.
function animateReconnect(a, b, edgeEl) {
  const meetRatio = 0.3 + Math.random() * 0.4;    // 0.3–0.7 along the edge
  const drawMs    = 600 + Math.random() * 750;    // 600–1350ms to draw
  const fadeMs    = 650 + Math.random() * 550;    // 650–1200ms tail fade
  const strength  = 0.15 + Math.random() * 0.4;   // 0.15–0.55 visible opacity — ambient, not loud

  function makeHalf(mode) {
    const el = document.createElementNS(SVG_NS, 'line');
    el.classList.add('glow-soft');
    el.setAttribute('pathLength', '1');
    el.setAttribute('stroke-dasharray', '1 1');
    el.setAttribute('stroke-dashoffset', '1');
    // Per-reconnect brightness. .glow-soft sets stroke + stroke-width,
    // but we override opacity inline so each animation has its own
    // visible strength without new CSS classes.
    el.style.opacity = strength;
    pulsesG.appendChild(el);
    const ov = { el, a, b, mode, meetRatio };
    liveOverlays.add(ov);
    updateOverlayPosition(ov);
    return ov;
  }

  const ovA = makeHalf('half-a');
  const ovB = makeHalf('half-b');

  // Draw inward (dashoffset 1 → 0 reveals the line from the node end outward)
  animate(ovA.el, {
    strokeDashoffset: 0,
    duration: drawMs,
    ease: 'out(2)',
    onComplete: () => {
      liveOverlays.delete(ovA);
      animate(ovA.el, {
        opacity: 0,
        duration: fadeMs,
        ease: 'out(2)',
        onComplete: () => { try { ovA.el.remove(); } catch {} }
      });
    }
  });
  animate(ovB.el, {
    strokeDashoffset: 0,
    duration: drawMs,
    ease: 'out(2)',
    onComplete: () => {
      liveOverlays.delete(ovB);
      animate(ovB.el, {
        opacity: 0,
        duration: fadeMs,
        ease: 'out(2)',
        onComplete: () => { try { ovB.el.remove(); } catch {} }
      });
    }
  });

  // Underlying edge fades in as the halves converge
  animate(edgeEl, {
    opacity: 1,
    duration: drawMs + 200,
    ease: 'out(2)'
  });
}

// ── TIMERS ───────────────────────────────────────────────────────────
export function restartRewireTimer() {
  if (rt.rewireTimer) clearInterval(rt.rewireTimer);
  rt.rewireTimer = setInterval(recomputeEdges, FIXED_REWIRE_MS);
}
