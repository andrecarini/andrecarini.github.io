import { animate } from './anime.js';
import { lsGet, lsSet, LS_MOTION } from './config.js';
import {
  rt,
  liveOverlays,
  runningAnims,
  clearPulses,
} from './graph/state.js';
import { stopDrift, startDrift } from './graph/drift.js';
import { restartRewireTimer } from './graph/edges.js';
import { scheduleChurn } from './graph/build.js';
import { activePulses } from './pulses.js';

// ── MOTION PREFERENCE ────────────────────────────────────────────────
// Inline head script already set data-motion on <html> before first paint.
// Read it back here; in-session toggles persist to localStorage.
export let motionEnabled = document.documentElement.dataset.motion !== 'off';
let userChoseMotion = lsGet(LS_MOTION) !== null;

export function setMotion(on, { fromUser = true } = {}) {
  motionEnabled = on;
  document.documentElement.dataset.motion = on ? 'on' : 'off';

  if (fromUser) {
    userChoseMotion = true;
    lsSet(LS_MOTION, on ? 'on' : 'off');
  }

  // Sync toggle UI
  const btn = document.getElementById('motion-btn');
  if (btn) {
    btn.textContent = on ? 'ON' : 'OFF';
    btn.dataset.on = on ? 'true' : 'false';
  }

  if (on) resumeBackground();
  else    pauseBackground();
}

// Follow OS preference changes unless user has locked in a choice.
try {
  const mmMotion = matchMedia('(prefers-reduced-motion: reduce)');
  mmMotion.addEventListener('change', e => {
    if (!userChoseMotion) setMotion(!e.matches, { fromUser: false });
  });
} catch {}

// ── LIFECYCLE ────────────────────────────────────────────────────────
// Pause every background animation (drift + pulses + rewires + live overlays).
// Used for (1) motion=off, (2) tab hidden, (3) chaos mode — all cases where
// running the background would waste cycles or add visual noise.
// Overlays (reconnects + pulse halves) fade out smoothly over ~260ms
// rather than snapping off — the previous version called el.remove()
// immediately, which read as a visible hard cut when entering chaos.
export function pauseBackground() {
  stopDrift();
  if (rt.rewireTimer) { clearInterval(rt.rewireTimer); rt.rewireTimer = null; }
  // Stop churn too. Without this, backgrounded tabs accumulate pending
  // kills: churnTimer (setTimeout) keeps firing even while rAF is
  // throttled, so kill fades never complete and reallyRemoveNode never
  // runs. When the tab returns to foreground, all queued fades finish
  // at once and the graph collapses. See resumeBackground for restart.
  if (rt.churnTimer) { clearTimeout(rt.churnTimer); rt.churnTimer = null; }
  // Invalidate any in-flight pulse setTimeouts. scheduleHop() schedules
  // per-edge callbacks that check `version !== graphVersion` before doing
  // anything; bumping the version here short-circuits every pending one
  // so nothing new gets added to the DOM while the existing overlays fade.
  rt.graphVersion++;

  // Snapshot + clear tracking first so later code treats the graph as
  // empty even though the elements are still visually fading out.
  const snapshot = [...liveOverlays];
  liveOverlays.clear();
  activePulses.clear();

  for (const ov of snapshot) {
    const el = ov.el;
    try {
      animate(el, {
        opacity: 0,
        duration: 260,
        ease: 'out(2)',
        onComplete: () => { try { el.remove(); } catch {} }
      });
    } catch {
      try { el.remove(); } catch {}
    }
  }
}

export function resumeBackground() {
  if (!motionEnabled) return;
  if (!rt.raf)         startDrift();
  if (!rt.rewireTimer) restartRewireTimer();
  if (!rt.churnTimer)  scheduleChurn();
}

export function cleanup() {
  runningAnims.forEach(a => { try { a.cancel?.(); } catch {} });
  runningAnims.length = 0;
  if (rt.rewireTimer)    { clearInterval(rt.rewireTimer); rt.rewireTimer = null; }
  if (rt.churnTimer)     { clearTimeout(rt.churnTimer);   rt.churnTimer  = null; }
  if (rt.startupTimeout) { clearTimeout(rt.startupTimeout); rt.startupTimeout = null; }
  stopDrift();
  // Kill any overlays (they reference stale nodes after rebuild)
  for (const ov of liveOverlays) {
    try { ov.el.remove(); } catch {}
  }
  liveOverlays.clear();
  activePulses.clear();
  clearPulses();
}
