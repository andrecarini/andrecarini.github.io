// ══════════════════════════════════════════════════════════════════════
//    Boot + top-level event wiring
// ══════════════════════════════════════════════════════════════════════
// Everything of substance lives in the domain modules. This file just
// wires DOM events to module entry points and owns the resize/rebuild
// routine that ties cleanup, buildGraph, and startAnimations together.

import { engine } from './anime.js';
import { svg, rt, nodes } from './graph/state.js';
import { cfg } from './config.js';
import { motionEnabled, pauseBackground, resumeBackground, cleanup } from './motion.js';
import { buildGraph, startAnimations } from './graph/build.js';
import { onMouseMove } from './graph/hover.js';
import { activePulses, findNearestNode, emitFromNode } from './pulses.js';
import {
  chaosState,
  onChaosPress,
  onChaosMove,
  onChaosRelease,
} from './chaos.js';
import {
  audioSuspend,
  audioResume,
  ensureMuteBtn,
} from './audio.js';
import { updateThemeIcon } from './theme.js';
import { setupControls, syncControlsUI } from './ui/controls.js';
import { setupContactButtons } from './ui/contact.js';

// Let anime.js auto-pause its internal scheduler when the tab is
// hidden. This complements our own visibilitychange handler (which
// stops our rAF + timers); together they make sure nothing runs while
// the user isn't looking. Belt-and-braces — either would catch most of
// the work, but engine.pauseOnDocumentHidden additionally freezes any
// in-flight tweens that were mid-keyframe when the tab lost focus, so
// they don't jump on resume.
if (engine) engine.pauseOnDocumentHidden = true;

// ── Resize / rebuild ─────────────────────────────────────────────────
function resize() {
  rt.W = window.innerWidth;
  rt.H = window.innerHeight;
  svg.setAttribute('viewBox', `0 0 ${rt.W} ${rt.H}`);
  svg.setAttribute('width',  rt.W);
  svg.setAttribute('height', rt.H);

  cleanup();
  buildGraph();
  startAnimations();
  syncControlsUI();
}

let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(resize, 180);
}, { passive: true });

// Hover always works regardless of motion setting — it's user-driven feedback,
// not ambient animation. But keep it extra subtle via the theme colors.
window.addEventListener('mousemove', onMouseMove, { passive: true });

// Click-triggered pulses. Fires on every click anywhere in the document —
// the nearest node becomes the origin and fans out pulses along its edges.
// Gated on motion being enabled and the background not being frozen by chaos.
// Throttled: clicks faster than CLICK_COOLDOWN ms apart are ignored.
// Clicks only emit pulses during idle or detonated states. Chaos awaiting
// is handled by pointerdown/pointerup below (press-and-hold mechanic).
// Also refuses clicks when the active pulse count is near cap, to avoid
// piling up fade-eviction work during click storms.
const CLICK_COOLDOWN = 300;
let lastClickTime = 0;
window.addEventListener('click', (e) => {
  // slowing / awaiting / pulling / exploding / restoring: click does
  // nothing. idle / detonated allow normal pulse emission.
  if (chaosState !== 'idle' && chaosState !== 'detonated') return;
  if (!motionEnabled) return;
  if (nodes.length === 0) return;
  if (activePulses.size >= Math.floor(cfg.maxPulses * 0.85)) return;
  const now = performance.now();
  if (now - lastClickTime < CLICK_COOLDOWN) return;
  lastClickTime = now;
  const idx = findNearestNode(e.clientX, e.clientY);
  if (idx >= 0 && !nodes[idx]?.dying) emitFromNode(idx);
});

// Press-and-hold mechanic for chaos detonation. pointerdown during
// 'awaiting' starts the gravity pull; pointerup / pointercancel / blur
// ends it and triggers the explosion with force scaled by hold time.
// pointermove while pulling retargets the gravity well so the user can
// drag the cursor around and have the chars chase it.
// Pointer events unify mouse/touch/pen cleanly.
window.addEventListener('pointerdown', (e) => {
  if (chaosState === 'awaiting') {
    onChaosPress(e.clientX, e.clientY);
  }
});
window.addEventListener('pointermove', (e) => {
  onChaosMove(e.clientX, e.clientY);
});
const handleChaosRelease = () => {
  if (chaosState === 'pulling') onChaosRelease();
};
window.addEventListener('pointerup',     handleChaosRelease);
window.addEventListener('pointercancel', handleChaosRelease);
// Safety: if window loses focus while user is holding (alt-tab, etc.),
// release automatically so we don't get stuck in 'pulling'.
window.addEventListener('blur', handleChaosRelease);

// Tab visibility covers true tab-hide / background. Separate blur/focus
// below covers "focused on another window but this tab is still the
// foreground tab" — different browser event for a different scenario.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pauseBackground();
    audioSuspend();
  } else {
    resumeBackground();
    audioResume();
  }
});

// Window-level focus lifecycle. Tab-switch is already covered by
// `visibilitychange` above (tab truly hides). But clicking out to
// another window while keeping the tab active keeps our rAF running
// against a display the user isn't watching — wasted CPU/GPU + battery.
// We pause after a short grace window so transient focus losses
// (DevTools, native alerts, quick alt-tab) don't flicker.
const BLUR_PAUSE_GRACE_MS = 2000;
let blurPauseTimer = null;
let pausedByBlur   = false;
window.addEventListener('blur', () => {
  if (blurPauseTimer || pausedByBlur) return;
  blurPauseTimer = setTimeout(() => {
    blurPauseTimer = null;
    // visibilitychange may already have paused us (tab hidden wins).
    // Only flag and pause if we're still running.
    if (!document.hidden) {
      pausedByBlur = true;
      pauseBackground();
      audioSuspend();
    }
  }, BLUR_PAUSE_GRACE_MS);
});
window.addEventListener('focus', () => {
  if (blurPauseTimer) {
    clearTimeout(blurPauseTimer);
    blurPauseTimer = null;
  }
  if (pausedByBlur) {
    pausedByBlur = false;
    resumeBackground();
    audioResume();
  }
});

// ── BOOT ─────────────────────────────────────────────────────────────
updateThemeIcon();
ensureMuteBtn();   // create (hidden) so Fun Mode can just toggle display
setupControls({ onRebuild: resize });
setupContactButtons();
resize();

// Lock the rise animations off once they've completed. Prevents them
// from re-triggering if splitText.revert() mutates the DOM later.
setTimeout(() => {
  document.body.classList.add('loaded');
}, 2100);
