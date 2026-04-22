import { animate, createDrawable, createTimeline, stagger } from '../anime.js';
import {
  SVG_NS,
  edgesG,
  nodesG,
  svg,
  rt,
  nodes,
  adjacency,
  nodeEls,
  nodeHot,
  edgeIndex,
  liveOverlays,
  runningAnims,
  clearPulses,
  FORM_DIST2,
  MIN_DIST,
} from './state.js';
import { cfg, getDensityValue } from '../config.js';
import { activePulses } from '../pulses.js';
import { motionEnabled } from '../motion.js';
import { chaosState } from '../chaos.js';
import { restartRewireTimer } from './edges.js';
import { startDrift } from './drift.js';

// ── BUILD GRAPH ──────────────────────────────────────────────────────
export function buildGraph() {
  rt.graphVersion++;
  edgesG.replaceChildren();
  nodesG.replaceChildren();
  clearPulses();
  liveOverlays.clear();

  nodes.length = 0;
  const DENSITY = getDensityValue();
  const target = Math.max(30, Math.floor((rt.W * rt.H) / DENSITY));
  const maxAttempts = target * 60;   // bumped: modulated minDist rejects more in voids
  let attempts = 0;

  // Density field: a random-phased sum of sinusoids at three frequencies,
  // sampled fresh per graph build so each rebuild gets a different topology
  // of clusters and voids. Range roughly [-1.85, +1.85] but clamped effectively.
  // Positive = dense (clusters), negative = sparse (voids).
  const nseed  = Math.random() * 10000;
  const nfreq1 = 0.0028;
  const nfreq2 = nfreq1 * 2.3;
  const nfreq3 = nfreq1 * 5.8;
  function densityField(x, y) {
    return (
            Math.sin(x * nfreq1 + nseed)       * Math.cos(y * nfreq1 + nseed * 1.1)
      + 0.55 * Math.sin(x * nfreq2 + nseed * 0.7) * Math.cos(y * nfreq2 + nseed * 1.3)
      + 0.30 * Math.sin(x * nfreq3 + nseed * 0.3) * Math.cos(y * nfreq3 + nseed * 1.7)
    );
  }

  while (nodes.length < target && attempts < maxAttempts) {
    attempts++;
    const x = Math.random() * rt.W;
    const y = Math.random() * rt.H;
    // Local packing distance modulated by density: exp(-d) means clusters
    // pack ~e× tighter than baseline and voids push out ~e× further.
    // Factor 0.95 shapes the strength of the variance.
    const d       = densityField(x, y);
    const localMd = MIN_DIST * Math.exp(-0.95 * d);
    const localMd2 = localMd * localMd;
    let ok = true;
    for (let i = 0; i < nodes.length; i++) {
      const dx = nodes[i].x - x, dy = nodes[i].y - y;
      if (dx*dx + dy*dy < localMd2) { ok = false; break; }
    }
    if (ok) {
      // Per-node visual & structural variance so nodes don't all look identical:
      //   r       — radius, 1.7 to 3.1 (base was 2.4)
      //   alpha   — fill-opacity multiplier, 0.55 to 1.0 (composes with CSS var's alpha)
      //   k       — own neighbour count, 2 to 4 (used as the top-K cap in recompute)
      const r     = 1.7 + Math.random() * 1.4;
      const alpha = 0.55 + Math.random() * 0.45;
      const k     = 2 + ((Math.random() * 3) | 0);
      // Two decoupled harmonics per axis — sum of two sines gives
      // non-repeating-looking quasi-chaotic paths instead of clean Lissajous.
      nodes.push({
        x, y,
        cur: { x, y },
        r, alpha, k,
        ampX:    15 + Math.random() * 10,
        ampY:    15 + Math.random() * 10,
        freqX:   0.00020 + Math.random() * 0.00045,
        freqY:   0.00020 + Math.random() * 0.00045,
        freqX2:  0.00070 + Math.random() * 0.00055,
        freqY2:  0.00070 + Math.random() * 0.00055,
        phaseX:  Math.random() * Math.PI * 2,
        phaseY:  Math.random() * Math.PI * 2,
        phaseX2: Math.random() * Math.PI * 2,
        phaseY2: Math.random() * Math.PI * 2,
      });
    }
  }

  nodeEls.length = 0;
  for (const n of nodes) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', n.x);
    c.setAttribute('cy', n.y);
    c.setAttribute('r', n.r);
    c.setAttribute('fill-opacity', n.alpha);
    c.classList.add('node');
    nodesG.appendChild(c);
    nodeEls.push(c);
  }
  nodeHot.length = 0;
  for (let i = 0; i < nodes.length; i++) nodeHot.push(false);

  adjacency.length = 0;
  for (let i = 0; i < nodes.length; i++) adjacency.push([]);
  edgeIndex.clear();

  for (let i = 0; i < nodes.length; i++) {
    const dists = [];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
      const d2 = dx*dx + dy*dy;
      if (d2 < FORM_DIST2) dists.push({ j, d2 });
    }
    dists.sort((a, b) => a.d2 - b.d2);
    const k = Math.min(nodes[i].k, dists.length);
    for (let m = 0; m < k; m++) {
      const j = dists[m].j;
      const a = Math.min(i, j), b = Math.max(i, j);
      const key = a + '-' + b;
      if (edgeIndex.has(key)) continue;

      const ln = document.createElementNS(SVG_NS, 'line');
      ln.setAttribute('x1', nodes[a].x);
      ln.setAttribute('y1', nodes[a].y);
      ln.setAttribute('x2', nodes[b].x);
      ln.setAttribute('y2', nodes[b].y);
      ln.classList.add('edge');
      edgesG.appendChild(ln);

      edgeIndex.set(key, { el: ln, a, b, hot: false });
      adjacency[a].push(b);
      adjacency[b].push(a);
    }
  }
}

// ── NODE LIFECYCLE (churn + burst spawn) ─────────────────────────────
// Ambient "appearing/disappearing" behaviour so the background feels
// alive rather than static. Two mechanisms:
//   • churnNode: pick a random existing node, fade it out, teleport it
//     to a new position, fade it back in. No array manipulation —
//     indices stay stable, edges get invalidated and rebuilt by rewire.
//   • spawnNode / burstSpawn: append new nodes, animate them scaling
//     in from r=0. Used after detonation to visibly raise density.
// Both are gated on chaos state (only run during idle).

function spawnNode() {
  // Cap total nodes at 2× target to prevent unbounded growth from
  // repeated detonations.
  const target = Math.max(30, Math.floor((rt.W * rt.H) / getDensityValue()));
  if (nodes.length >= target * 2) return;

  const x = Math.random() * rt.W;
  const y = Math.random() * rt.H;
  const r = 1.7 + Math.random() * 1.4;
  const alpha = 0.55 + Math.random() * 0.45;
  const n = {
    x, y,
    cur: { x, y },
    r, alpha,
    k: 2 + ((Math.random() * 3) | 0),
    ampX:    15 + Math.random() * 10,
    ampY:    15 + Math.random() * 10,
    freqX:   0.00020 + Math.random() * 0.00045,
    freqY:   0.00020 + Math.random() * 0.00045,
    freqX2:  0.00070 + Math.random() * 0.00055,
    freqY2:  0.00070 + Math.random() * 0.00055,
    phaseX:  Math.random() * Math.PI * 2,
    phaseY:  Math.random() * Math.PI * 2,
    phaseX2: Math.random() * Math.PI * 2,
    phaseY2: Math.random() * Math.PI * 2,
  };
  nodes.push(n);
  adjacency.push([]);
  nodeHot.push(false);

  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('cx', x);
  c.setAttribute('cy', y);
  c.setAttribute('r', 0);
  c.setAttribute('fill-opacity', alpha);
  c.classList.add('node');
  c.style.opacity = '0';
  nodesG.appendChild(c);
  nodeEls.push(c);

  // Animate r and opacity together — node pops into existence with a
  // brief radius overshoot so the spawn is visually obvious. Previously
  // a straight ease-in made spawns easy to miss; the overshoot + settle
  // gives each new node a small "bloom" moment.
  animate(c, {
    r: [
      { to: r * 1.45, duration: 320, ease: 'out(3)' },
      { to: r,        duration: 380, ease: 'out(2)' }
    ],
    opacity: [
      { to: 1, duration: 320, ease: 'out(2)' }
    ]
  });
}

// Spawn `count` new nodes over a few seconds with random stagger.
// Aborts early if chaos state leaves 'detonated' (user restored before
// burst finished).
export function burstSpawn(count) {
  let i = 0;
  function next() {
    if (i >= count) return;
    if (chaosState !== 'detonated') return;
    i++;
    spawnNode();
    setTimeout(next, 80 + Math.random() * 220);
  }
  next();
}

// Pick a random node and kill it — fade out the element, then actually
// splice it out of all data structures (nodes, nodeEls, nodeHot,
// adjacency), reindex edgeIndex keys, reindex liveOverlays, and fade
// out any in-flight pulses/reconnects that touched it.
//
// This used to be a simple "teleport to a new position" which avoided
// all the index-management complexity but wasn't what ambient
// appear/disappear actually looks like. Proper spawn + kill is what the
// user wants.
function killNode(idx) {
  if (idx < 0 || idx >= nodes.length) return;
  const n = nodes[idx];
  if (!n || n.dying) return;
  n.dying = true;                      // skipped by click handler + churn

  const el = nodeEls[idx];
  if (!el) return;

  animate(el, {
    opacity: 0,
    r: 0,
    duration: 500,
    ease: 'in(2)',
    onComplete: () => reallyRemoveNode(n)
  });
}

// Locate the dying node by object reference (not index — other kills in
// flight may have shifted indices between killNode firing and this
// callback landing). Then splice and reindex everything.
function reallyRemoveNode(n) {
  const idx = nodes.indexOf(n);
  if (idx < 0) return;                 // already gone
  const el = nodeEls[idx];

  // 1. Remove edges whose endpoint was this node.
  for (const [key, entry] of [...edgeIndex.entries()]) {
    if (entry.a === idx || entry.b === idx) {
      edgeIndex.delete(key);
      try { entry.el.remove(); } catch {}
    }
  }

  // 2. Fade out + remove overlays (pulses / reconnect halves) touching it.
  //    Fade rather than snap — the alternative is pulses vanishing
  //    mid-flight, which reads as glitchy.
  for (const ov of [...liveOverlays]) {
    if (ov.a === idx || ov.b === idx) {
      liveOverlays.delete(ov);
      activePulses.delete(ov);
      const ovEl = ov.el;
      animate(ovEl, {
        opacity: 0,
        duration: 220,
        ease: 'out(2)',
        onComplete: () => { try { ovEl.remove(); } catch {} }
      });
    }
  }

  // 3. Splice out of all parallel arrays.
  nodes.splice(idx, 1);
  nodeEls.splice(idx, 1);
  nodeHot.splice(idx, 1);
  adjacency.splice(idx, 1);

  // 4. Fix adjacency lists: drop references to the removed index and
  //    decrement any index that was higher than the removed one.
  for (let i = 0; i < adjacency.length; i++) {
    const list = adjacency[i];
    const next = [];
    for (let k = 0; k < list.length; k++) {
      const j = list[k];
      if (j === idx) continue;
      next.push(j > idx ? j - 1 : j);
    }
    adjacency[i] = next;
  }

  // 5. Reindex edgeIndex. Keys are "min-max" of endpoint indices, so
  //    they have to be rebuilt whenever an index shifts.
  const rebuilt = new Map();
  for (const entry of edgeIndex.values()) {
    let a = entry.a, b = entry.b;
    if (a > idx) a--;
    if (b > idx) b--;
    entry.a = a; entry.b = b;
    rebuilt.set(Math.min(a, b) + '-' + Math.max(a, b), entry);
  }
  edgeIndex.clear();
  for (const [k, v] of rebuilt) edgeIndex.set(k, v);

  // 6. Reindex any remaining overlays (edges that survived step 1).
  for (const ov of liveOverlays) {
    if (ov.a > idx) ov.a--;
    if (ov.b > idx) ov.b--;
  }

  // 7. Remove the node element.
  try { el?.remove(); } catch {}
}

// Recurring schedule for ambient node churn. Each tick spawns one new
// node immediately, then (after a short delay so the spawn is visually
// distinct) kills a random one. Net count drifts slightly but stays
// bounded by the caps in spawnNode (≤ 2× target) and the kill guard
// (≥ 0.6× target). Both guards are gentle — they let the graph grow
// after explosions and shrink back toward target naturally.
//
// Gated on idle chaos state + motion enabled + non-empty graph. Timer
// keeps rescheduling unconditionally so it resumes naturally after
// chaos or after motion toggles back on.
// Safety cap: if too many kill-fades are still in flight, skip this
// churn tick. Defends against any scenario where animate() onComplete
// callbacks are lagging behind their setTimeout schedule — a weak
// device under load, a heavy scroll, another tab's GPU contention.
// Without this, pending kills could pile up during foreground slowdown
// just as they did during tab-background (fixed separately in
// pauseBackground). 3 is generous: typical steady state has 0–1.
const MAX_PENDING_KILLS = 3;
export function scheduleChurn() {
  if (rt.churnTimer) clearTimeout(rt.churnTimer);
  const delay = 450 + Math.random() * 500;       // 0.45–0.95s between ticks
  rt.churnTimer = setTimeout(() => {
    if (motionEnabled && chaosState === 'idle' && nodes.length > 0) {
      const target = Math.max(30, Math.floor((rt.W * rt.H) / getDensityValue()));

      // Count nodes currently fading out. If too many, defer — the kill
      // fades haven't completed yet so reallyRemoveNode hasn't spliced
      // them out. Continuing to schedule more would let them accumulate.
      let pendingKills = 0;
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].dying) pendingKills++;
      }
      if (pendingKills >= MAX_PENDING_KILLS) {
        scheduleChurn();
        return;
      }

      // Upfront check: find a kill candidate before deciding to spawn.
      // Spawn and kill are paired — pairing them tightly prevents the
      // graph from drifting upward during pulse-heavy moments (kills
      // blocked because every non-dying node is a pulse endpoint, but
      // spawns still firing at 1.3× cap). When pulses eventually clear,
      // several kills would fire in rapid succession as the backlog
      // released, which read as visible hiccups.
      //
      // Collect indices currently carrying pulses. Kill-eligible means:
      // not already dying, and not a pulse endpoint.
      const busyIndices = new Set();
      for (const ov of activePulses) {
        busyIndices.add(ov.a);
        busyIndices.add(ov.b);
      }

      // Find a kill candidate now (deterministic search). Respects the
      // density floor — won't report a candidate if killing would drop
      // us below 60% of target.
      const floor = Math.max(12, Math.floor(target * 0.6));
      let killCandidate = -1;
      if (nodes.length > floor) {
        const startIdx = Math.floor(Math.random() * nodes.length);
        for (let k = 0; k < nodes.length; k++) {
          const tryIdx = (startIdx + k) % nodes.length;
          if (nodes[tryIdx].dying) continue;
          if (busyIndices.has(tryIdx)) continue;
          killCandidate = tryIdx;
          break;
        }
      }

      // If we can't kill, skip spawn too. Graph stays at current size
      // for this tick; next tick retries once some pulses have cleared.
      if (killCandidate < 0) {
        scheduleChurn();
        return;
      }

      // Spawn first (if under cap). Lower cap than before (1.3× vs 1.6×)
      // — we spawn more often now, so we need a tighter ceiling.
      if (nodes.length < target * 1.3) {
        spawnNode();
      }

      // Kill the pre-selected candidate. Brief delay so the spawn
      // registers visually before this node starts fading. We re-verify
      // that the candidate is still eligible in case the graph shifted
      // during the delay (spawn inserts at the end, so indices stay
      // stable, but a pulse could have landed on this node since).
      setTimeout(() => {
        if (chaosState !== 'idle' || !motionEnabled) return;
        const n = nodes[killCandidate];
        if (!n || n.dying) return;
        // Re-check busy in case a pulse arrived since upfront selection.
        for (const ov of activePulses) {
          if (ov.a === killCandidate || ov.b === killCandidate) return;
        }
        killNode(killCandidate);
      }, 300 + Math.random() * 300);
    }
    scheduleChurn();
  }, delay);
}

// ── STARTUP ANIMATION ────────────────────────────────────────────────
// Draws edges on via their pathLength, fades nodes in, then kicks off
// rewire + churn timers a bit later so the intro has time to read before
// the graph starts breathing.
export function startAnimations() {
  if (!motionEnabled) {
    // Motion off: render a static graph. No intro, no drift, no timers.
    nodeEls.forEach(el => { el.style.opacity = '1'; });
    for (const { el } of edgeIndex.values()) el.style.opacity = '1';
    return;
  }

  startDrift();

  const drawable = createDrawable('svg#field .edge');
  const intro = createTimeline()
    .add(drawable, {
      draw: ['0 0', '0 1'],
      duration: 1400,
      ease: 'inOut(3)',
      delay: stagger(8, { from: 'center' })
    })
    .add(nodeEls, {
      opacity: [0, 1],
      duration: 700,
      ease: 'out(3)',
      delay: stagger(6, { from: 'center' })
    }, '-=900');
  runningAnims.push(intro);

  rt.startupTimeout = setTimeout(() => {
    restartRewireTimer();
    if (!rt.churnTimer) scheduleChurn();
  }, 2500);
}

