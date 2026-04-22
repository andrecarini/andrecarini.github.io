import {
  rt,
  nodes,
  nodeEls,
  edgeIndex,
  liveOverlays,
} from './state.js';
import { cfg, PULSE_ENERGY_THRESHOLD } from '../config.js';
import { pulseNode, selectNextHop, scheduleHop } from '../pulses.js';
import { audioArrivalBell } from '../audio.js';

// ── DRIFT TICK — runs at native rAF rate (no throttle) for smooth motion. ─
// Per-node position is the sum of two independent sinusoids per axis,
// giving each node a non-repeating-looking trajectory.
// Logical time: accumulates only while the drift tick is running. This way
// motion-pause doesn't cause phase jumps on resume — sin/cos arguments (for
// node drift) and pulse-sweep progress both read from logicalTime, not wall
// clock. On pause, stopDrift halts the accumulator. On resume, the first
// post-resume frame computes dt=0 (lastRaf reset in startDrift) and things
// continue from exactly where they were.
//
// timeScale multiplies dt before accumulation. 1 = normal speed, 0 = frozen.
// Chaos mode tweens this from 1→0 for a smooth halt, then 0→1 for resume.
// Packaged into a single object so chaos.js can write `clock.timeScale` and
// pulses.js can read `clock.logicalTime` — both through the same live
// binding without needing setter functions.
export const clock = {
  logicalTime: 0,
  lastRaf:     0,
  timeScale:   1,
  lastDriftMul: 0,   // for skip-when-zero optimization in driftTick
};

// Max per-frame dt passed to logicalTime. rAF can deliver very long
// frames during GC pauses, tab-throttle recovery, or heavy work on
// other threads. Without a cap those long frames produce visible
// "hops" in pulse progress — each unit of dt translates to gradient
// endpoint movement, so a 50ms frame moves the pulse 3× as far as a
// 16ms frame. Clamping the dt converts "one big hop" into "one
// slightly long frame plus mild wall-clock lag," which is far less
// perceptible.
const MAX_FRAME_DT = 33;

function driftTick(t) {
  rt.raf = requestAnimationFrame(driftTick);
  const rawDt = clock.lastRaf === 0 ? 0 : (t - clock.lastRaf);
  const dt    = Math.min(rawDt, MAX_FRAME_DT);
  clock.lastRaf = t;
  clock.logicalTime += dt * clock.timeScale;
  const lt = clock.logicalTime;

  const mul = cfg.drift;
  // Skip node + edge updates when drift is zero AND was zero last frame.
  // When drift transitions 0→anything or anything→0, we still run once
  // so nodes snap to their correct positions for the new drift level.
  const skipDriftLoops = (mul === 0 && clock.lastDriftMul === 0);
  clock.lastDriftMul = mul;

  if (!skipDriftLoops) {
    // Direct baseVal.value writes — SVG DOM's fast path. setAttribute
    // parses strings; baseVal.value is a typed numeric setter. At
    // ~500 writes per frame × 60 fps, the savings are meaningful.
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const dx = Math.sin(lt * n.freqX  + n.phaseX)  * n.ampX
               + Math.sin(lt * n.freqX2 + n.phaseX2) * n.ampX * 0.35;
      const dy = Math.cos(lt * n.freqY  + n.phaseY)  * n.ampY
               + Math.cos(lt * n.freqY2 + n.phaseY2) * n.ampY * 0.35;
      const cx = n.x + dx * mul;
      const cy = n.y + dy * mul;
      n.cur.x = cx;
      n.cur.y = cy;
      const el = nodeEls[i];
      el.cx.baseVal.value = cx;
      el.cy.baseVal.value = cy;
    }
    for (const entry of edgeIndex.values()) {
      const el = entry.el;
      const na = nodes[entry.a].cur, nb = nodes[entry.b].cur;
      el.x1.baseVal.value = na.x;
      el.y1.baseVal.value = na.y;
      el.x2.baseVal.value = nb.x;
      el.y2.baseVal.value = nb.y;
    }
  }
  // Overlay loop always runs — pulse progress advances regardless of
  // whether nodes moved this frame. Also covers reconnect halves and
  // pulseNode glow orbs that need to track drifted positions. Also the
  // home for logical-time arrival triggers on gradient pulses: firing
  // them here (rather than via setTimeout) guarantees the node glow
  // ignites when the pulse VISUALLY arrives, since both the gradient
  // sweep and these thresholds read the same `logicalTime` clock.
  for (const ov of liveOverlays) {
    updateOverlayPosition(ov);
    if (ov.mode !== 'full-gradient' || ov.disrupted) continue;

    // Node-glow fires PULSE_GLOW_PRE ms before the leading tip lands,
    // so its peak coincides with arrival.
    if (!ov.arrivedGlow && clock.logicalTime >= ov.glowFiresAt) {
      ov.arrivedGlow = true;
      if (ov.version === rt.graphVersion) {
        const toIdx = nodes.indexOf(ov.toNode);
        if (toIdx >= 0) {
          pulseNode(toIdx, ov.newEnergy);
          // Bell: y-position → pitch within pentatonic. Energy gates
          // very dim arrivals so long cascades don't swamp the mix.
          audioArrivalBell(ov.toNode.cur.y / rt.H, ov.newEnergy);
        }
      }
    }

    // Next hop fires the instant the leading tip reaches the destination.
    if (!ov.arrivedHop && clock.logicalTime >= ov.hopFiresAt) {
      ov.arrivedHop = true;
      if (ov.version === rt.graphVersion && ov.newEnergy > PULSE_ENERGY_THRESHOLD) {
        const curToIdx = nodes.indexOf(ov.toNode);
        if (curToIdx >= 0) {
          const nextIdx = selectNextHop(curToIdx, ov.visitTimes);
          if (nextIdx >= 0) {
            scheduleHop(curToIdx, nextIdx, ov.newEnergy, ov.visitTimes, ov.version);
          }
        }
      }
    }
  }
}

export function startDrift() {
  clock.lastRaf = 0;
  rt.raf = requestAnimationFrame(driftTick);
}
export function stopDrift() {
  if (rt.raf) { cancelAnimationFrame(rt.raf); rt.raf = null; }
}

export function updateOverlayPosition(ov) {
  const { el, mode } = ov;
  if (mode === 'node') {
    const n = ov.node?.cur;
    if (!n) return;
    el.cx.baseVal.value = n.x;
    el.cy.baseVal.value = n.y;
    return;
  }
  const na = nodes[ov.a]?.cur, nb = nodes[ov.b]?.cur;
  if (!na || !nb) return;
  if (mode === 'full-gradient') {
    // Sweep the gradient's endpoints along the edge based on elapsed
    // *logical* time. leadF goes 0 → (1 + pulseLen); trailF lags by pulseLen.
    // Using logicalTime means the sweep freezes when drift is paused, rather
    // than jumping ahead when motion resumes.
    const prog   = Math.min((clock.logicalTime - ov.startTime) / ov.totalDuration, 1);
    const leadF  = prog * (1 + ov.pulseLen);
    const trailF = leadF - ov.pulseLen;
    const dx = nb.x - na.x, dy = nb.y - na.y;
    const g = ov.gradient;
    g.x1.baseVal.value = na.x + dx * trailF;
    g.y1.baseVal.value = na.y + dy * trailF;
    g.x2.baseVal.value = na.x + dx * leadF;
    g.y2.baseVal.value = na.y + dy * leadF;
    el.x1.baseVal.value = na.x;
    el.y1.baseVal.value = na.y;
    el.x2.baseVal.value = nb.x;
    el.y2.baseVal.value = nb.y;
    return;
  }
  if (mode === 'full') {
    // Multi-layer pulse: el is a <g>, layers are the child <line>s.
    for (const line of ov.layers) {
      line.x1.baseVal.value = na.x;
      line.y1.baseVal.value = na.y;
      line.x2.baseVal.value = nb.x;
      line.y2.baseVal.value = nb.y;
    }
  } else if (mode === 'half-a') {
    const r = ov.meetRatio ?? 0.5;
    const mx = na.x + (nb.x - na.x) * r;
    const my = na.y + (nb.y - na.y) * r;
    el.x1.baseVal.value = na.x;
    el.y1.baseVal.value = na.y;
    el.x2.baseVal.value = mx;
    el.y2.baseVal.value = my;
  } else if (mode === 'half-b') {
    const r = ov.meetRatio ?? 0.5;
    const mx = na.x + (nb.x - na.x) * r;
    const my = na.y + (nb.y - na.y) * r;
    el.x1.baseVal.value = nb.x;
    el.y1.baseVal.value = nb.y;
    el.x2.baseVal.value = mx;
    el.y2.baseVal.value = my;
  }
}
