import { animate, splitText } from './anime.js';
import { rt } from './graph/state.js';
import { clock, startDrift } from './graph/drift.js';
import { motionEnabled, setMotion, pauseBackground, resumeBackground } from './motion.js';
import { restartRewireTimer } from './graph/edges.js';
import { burstSpawn, scheduleChurn } from './graph/build.js';
import { setMuteBtnVisible } from './audio.js';
import { setPanelOpen } from './ui/controls.js';

// ── CHAOS MODE ───────────────────────────────────────────────────────
// State machine:
//   idle      → (button press)          → slowing
//   slowing   → (slow-down completes)    → awaiting
//   slowing   → (button press)           → idle        (cancel, tween back up)
//   awaiting  → (pointerdown anywhere)   → pulling     (start gravity pull)
//   awaiting  → (button press)           → idle        (cancel, tween back up)
//   pulling   → (pointerup / max hold)   → exploding   (force scales with hold)
//   exploding → (all chars complete)     → detonated
//   detonated → (button press: Restore)  → restoring
//   restoring → (content faded back in)  → idle
//
// In 'detonated' state the background resumes (ambient motion returns) but
// the content stays absent — clicks emit normal pulses. The user must press
// the Chaos button again (labelled 'Restore' in this state) to rebuild the
// page. Button is a no-op during exploding/restoring.
export let chaosState  = 'idle';
let chaosSplit        = null;
// Full animated set for the pull / explode / implode choreography:
//   - chaosTextChars — per-character spans produced by splitText, filtered
//     to those that are NOT inside an atomic UI container.
//   - chaosElements — chaosTextChars PLUS the atomic containers
//     themselves (pills, contact buttons, coming-soon links). Atomic
//     containers animate as single units so their pill/button visuals
//     stay together rather than disintegrating into glitchy chars.
let chaosTextChars    = null;
let chaosElements     = null;
let chaosTimeScaleRaf = null;
const chaosBtn   = document.getElementById('chaos-btn');
const chaosToast = document.getElementById('chaos-toast');

function setChaosBtn(tooltip, active) {
  chaosBtn.dataset.tooltip = tooltip || '';
  chaosBtn.dataset.active = active ? 'true' : 'false';
  chaosBtn.setAttribute('aria-label', tooltip || 'Fun mode');
}

// Stop window click handler from treating a chaos-button click as a
// normal-pulse click. Also give the button exclusive control over its
// state.
chaosBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleChaos();
});
// Also stop pointerdown so that during 'awaiting', clicking the button
// to cancel doesn't get intercepted by the press-and-hold handler.
// Without this, clicking the button during awaiting would trigger
// onChaosPress on pointerdown, then onChaosRelease on pointerup, and
// then the button's click handler would run toggleChaos — the user
// would end up with a tiny-force explosion instead of a cancel.
chaosBtn.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
});

// Smooth tween of the timeScale multiplier via a manual rAF. Independent
// of the drift tick — this runs even when drift is stopped, so we can
// tween timeScale before restarting drift on resume.
// easeType: 'out' (default) for slowdown (fast decel, linger at target);
//           'inOut' for resume (gentle ramp in, gentle landing).
function tweenTimeScale(target, duration, onComplete, easeType = 'out') {
  if (chaosTimeScaleRaf) cancelAnimationFrame(chaosTimeScaleRaf);
  const start = performance.now();
  const from  = clock.timeScale;
  function tick() {
    const p = Math.min((performance.now() - start) / duration, 1);
    let eased;
    if (easeType === 'inOut') {
      // smootherstep — gentle on both ends
      eased = p * p * (3 - 2 * p);
    } else if (easeType === 'in') {
      eased = p * p;
    } else {
      // out(2): fast start, slow landing
      eased = 1 - Math.pow(1 - p, 2);
    }
    clock.timeScale = from + (target - from) * eased;
    if (p < 1) {
      chaosTimeScaleRaf = requestAnimationFrame(tick);
    } else {
      chaosTimeScaleRaf = null;
      onComplete?.();
    }
  }
  tick();
}

export function toggleChaos() {
  switch (chaosState) {
    case 'idle':
      // Fun Mode is built around movement — splitText char animations,
      // gravity pull, explosion. If the user had motion turned off
      // (either manually or via prefers-reduced-motion), clicking Fun
      // Mode implies consent to motion for this session. Turn it on
      // automatically with fromUser:true so the UI toggle reflects the
      // change and the choice persists (they can still flip it back).
      if (!motionEnabled) setMotion(true, { fromUser: true });
      startChaos();
      break;
    case 'slowing':    cancelChaos();  break;
    case 'awaiting':   cancelChaos();  break;
    case 'detonated':  restoreFromDetonated(); break;
    case 'pulling':
    case 'exploding':
    case 'restoring':  /* ignore — let the animation finish */ break;
  }
}

// Detect pointer type for toast wording. (pointer: coarse) = primary
// input is touch-like (finger on a phone/tablet). Falls back to desktop
// wording if matchMedia is unavailable.
const IS_TOUCH_INPUT = (() => {
  try { return matchMedia('(pointer: coarse)').matches; } catch { return false; }
})();
// Split across two lines so the prompt reads as a beat: the press
// instruction sits on one line, the payoff on the next. Each line keeps
// its own `text-wrap: balance` flow inside the toast.
const CHAOS_TOAST_LINE_1 = IS_TOUCH_INPUT
  ? 'Tap and hold for gravitational pull'
  : 'Click and hold for gravitational pull';
const CHAOS_TOAST_LINE_2 = 'release to explode';

// Phase 1: smoothly slow the background to a halt, then show the toast.
// 420ms slowdown — fast enough that the user isn't twiddling their thumbs,
// slow enough to feel like a deliberate transition rather than a snap.
function startChaos() {
  chaosState = 'slowing';
  setChaosBtn('Cancel', true);
  // (Music CTA is no longer revealed here — it shows only once we're
  // in `detonated`, after the explosion settles. Keeping it hidden
  // during slowing/awaiting/pulling/exploding avoids fighting the
  // chaos toast and the press-and-hold prompt for attention.)
  // Close the controls panel so it doesn't cover the toast / block clicks.
  setPanelOpen(false);
  // Disable all content interaction for the duration of chaos — text
  // selection, link clicks, etc. The class is removed in cancelChaos and
  // at the end of restoreFromDetonated.
  document.body.classList.add('chaos-active');
  const line1 = document.createElement('span');
  line1.className = 'chaos-toast-line';
  line1.textContent = CHAOS_TOAST_LINE_1;
  const line2 = document.createElement('span');
  line2.className = 'chaos-toast-line';
  line2.textContent = CHAOS_TOAST_LINE_2;
  chaosToast.replaceChildren(line1, line2);
  tweenTimeScale(0, 420, () => {
    if (chaosState !== 'slowing') return;   // cancelled mid-slowdown
    // Clear residual pulses and fully halt background. Drift was visually
    // frozen by timeScale=0 but still ticking; stop it fully to save frames.
    pauseBackground();
    chaosState = 'awaiting';
    chaosToast.dataset.visible = 'true';
  });
}

// Cancel path: used if the user presses Chaos during slowing or awaiting.
// Ramps time back up with a gentle inOut curve so the background doesn't
// snap back to life — 1000ms + smootherstep eases in and out of motion.
export function cancelChaos() {
  chaosToast.dataset.visible = 'false';
  chaosState = 'idle';
  setChaosBtn('Fun mode', false);
  // Back to idle — hide the mute button and force-mute (inside
  // setMuteBtnVisible) so audio doesn't run while the button isn't
  // visible for the user to turn it off.
  setMuteBtnVisible(false);
  document.body.classList.remove('chaos-active');
  if (motionEnabled) {
    // If awaiting, drift was stopped by pauseBackground; resume it.
    // timeScale is 0, so drift visibly starts frozen and accelerates.
    if (!rt.raf)         startDrift();
    if (!rt.rewireTimer) restartRewireTimer();
    if (!rt.churnTimer)  scheduleChurn();
    tweenTimeScale(1, 1000, null, 'inOut');
  } else {
    // If motion is off we shouldn't resume ambient animation. Just snap
    // timeScale back to 1 so a future motion toggle works normally.
    clock.timeScale = 1;
  }
}

// Phase 2a (press): user pressed down. Transition to 'pulling' state,
// begin the gravity phase with manually-driven rAF ticks — progress is a
// linear function of hold time so we can interrupt at any point when the
// user releases. No anime.js on chars yet; direct style.transform writes.
const PULL_MAX_MS = 2200;        // time to reach full-strength explosion; holding past this does nothing further
const PULL_MIN_FORCE = 0.15;     // even a quick tap produces *some* force
let pullData = null;

export function onChaosPress(cx, cy) {
  if (chaosState !== 'awaiting') return;
  chaosState = 'pulling';
  chaosToast.dataset.visible = 'false';
  setChaosBtn('', true);         // stay active — user is mid-interaction

  // Split all text inside `.content` in one call — this matches the
  // original monolith approach which was rock-solid, unlike per-element
  // iteration which didn't play well with `text-wrap: balance` on the
  // lede. We then filter OUT chars that live inside an atomic UI
  // container (pill, contact button, coming-soon link) so those chars
  // stay untouched — the atomic container animates as a unit and its
  // internal chars move with it.
  let split;
  try {
    // Split both at word and char level. Words are plain inline spans;
    // the browser's `text-wrap: balance` algorithm treats them like
    // regular text words (break points at whitespace between word
    // spans), which lands chars at the same positions plain text would
    // occupy. Without `words: true`, chars-as-inline-block compute a
    // different balance than plain text and produce a last-frame
    // reflow snap when `revert()` restores the plain text at the end
    // of the implosion.
    split = splitText('.content', { chars: true, words: true });
  } catch (err) {
    console.error('splitText failed', err);
    chaosState = 'detonated';
    setChaosBtn('Normal mode', true);
    return;
  }
  if (!split?.chars?.length) {
    chaosState = 'detonated';
    setChaosBtn('Normal mode', true);
    return;
  }
  chaosSplit = split;

  // Apply the signal-corruption filter only to the actual text blocks
  // (tag, h1, ledes) — not to `.content` as a whole. When `.content`
  // had the filter, every ~42ms the whole block repainted, which made
  // pills, contact buttons, and coming-soon links flicker (their
  // compositor layers couldn't keep up with the filter-animation
  // churn). Scoping to text keeps the effect where it visually belongs
  // and leaves the UI chrome rendering stable.
  const corruptEls = document.querySelectorAll('.content .tag, .content h1, .content .lede');
  corruptEls.forEach(el => el.classList.add('chaos-content-corrupt'));

  // Collect atomic UI elements that should animate as single units.
  // Includes the .tag-rule hairline next to "Software engineer" so it
  // gets pulled/exploded/imploded alongside the pills and buttons; if
  // it stayed a pseudo-element it would be stuck in the .tag's layout
  // slot while the rest of the content scattered.
  const atomicEls = Array.from(document.querySelectorAll(
    '.content .tag-rule, .content .meta-pill, .content .contact-btn, .content .soon-link'
  ));
  const atomicSet = new Set(atomicEls);
  // isInsideAtomic climbs the parent chain from a char span and returns
  // true as soon as it hits an atomic container. Stops at document.body
  // as a safety rail.
  const isInsideAtomic = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      if (atomicSet.has(p)) return true;
      p = p.parentElement;
    }
    return false;
  };
  const textChars = split.chars.filter(ch => !isInsideAtomic(ch));
  chaosTextChars = textChars;
  chaosElements = [...textChars, ...atomicEls];

  // Batch-read rects upfront to avoid layout thrash during pull ticks.
  const rects = chaosElements.map(el => el.getBoundingClientRect());

  const charStates = chaosElements.map((el, i) => {
    const r = rects[i];
    const px = r.left + r.width  / 2;
    const py = r.top  + r.height / 2;
    return {
      el,
      // Character's pre-pull centre — fixed reference for dynamic target
      // computation in pullTick (lets us recompute pull direction as the
      // cursor moves during the hold).
      originX:     px,
      originY:     py,
      gravScale:   0.3 + Math.random() * 0.25,   // 0.3–0.55 at full hold (visible, not collapsed)
      preSpin:     (Math.random() - 0.5) * 360,
      preTiltX:    (Math.random() - 0.5) * 40,
      preTiltY:    (Math.random() - 0.5) * 40,
      // Orbital drift: each char gets a random starting phase offset and
      // angular velocity (rad/s). Scaled by progress^4 in pullTick so the
      // orbit only kicks in near max pull, then keeps chars gently moving
      // around the bubble instead of frozen. Mix of CW and CCW rotations.
      orbitPhase:  (Math.random() - 0.5) * 0.6,  // ±0.3 rad ≈ ±17°
      orbitFreq:   (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.9),
      // Desync seed for high-frequency positional jitter during pull.
      // Combined with two different frequencies in pullTick to produce
      // non-repeating micro-tremor that adds to the corrupted-signal
      // aesthetic of the CSS glitch keyframes (which can't animate
      // transform without clobbering the orbital position).
      jitterSeed:  Math.random() * Math.PI * 2,
      // Tracked live during pull so the explosion anime.js calls can
      // read these exact values.
      curTx: 0, curTy: 0, curScale: 1, curRot: 0,
      curTiltX: 0, curTiltY: 0, curOpacity: 1,
    };
  });

  // Add glitch class with random desync delay (negative to start mid-cycle).
  // Only applied to the text-char spans OUTSIDE atomic containers —
  // pills and buttons keep their own CSS (background / border / drop
  // shadow); the glitch filter keyframes would fight with those and
  // read as broken rather than atmospheric.
  for (const el of chaosTextChars) {
    el.style.animationDelay = `-${Math.random() * 780}ms`;
    el.classList.add('chaos-char-glitch');
  }

  // Gravity distortion lens — driven manually during pull too so its
  // scale tracks hold progress.
  const lens = document.createElement('div');
  lens.className = 'chaos-gravity-lens';
  lens.style.left = cx + 'px';
  lens.style.top  = cy + 'px';
  document.body.appendChild(lens);

  pullData = {
    cx, cy,
    startTime: performance.now(),
    charStates,
    lens,
    raf: null,
  };

  pullTick();
}

// Allow main.js's pointermove handler to retarget the well without
// leaking pullData across module boundaries.
export function onChaosMove(cx, cy) {
  if (chaosState === 'pulling' && pullData) {
    pullData.cx = cx;
    pullData.cy = cy;
  }
}

// Base radius of the gravity lens element in CSS px (half its box
// width). Chars orbit at exactly `LENS_BASE_R * lensScale` so they
// sit on the bubble's rendered edge — coupling the two radii with a
// single constant prevents them from drifting apart when the bubble's
// scale formula changes.
const LENS_BASE_R = 60;

// rAF loop during 'pulling' — updates every char's transform + the lens
// based on current hold progress and current cursor position (which may
// have moved since press). Progress caps at 1.0 for the gravity ramp,
// but the tick keeps running so chars continue orbiting the cursor,
// the lens keeps breathing, and cursor moves keep retargeting. Release
// only fires on pointerup.
function pullTick() {
  if (chaosState !== 'pulling' || !pullData) return;

  const elapsed    = performance.now() - pullData.startTime;
  const elapsedSec = elapsed / 1000;
  const progress   = Math.min(elapsed / PULL_MAX_MS, 1);
  // in(4): very slow start, rapid finish — gravity accelerating toward
  // the click point.
  const eased = Math.pow(progress, 4);

  // Lens sizing — computed up front so chars orbit at the same radius
  // the lens is actually rendering at, including the breathe.
  const lensBase  = 0.2 + 1.2 * eased;                          // 0.2 → 1.4
  const breathe   = 1 + 0.05 * eased * Math.sin(elapsedSec * 2.2);
  const lensScale = lensBase * breathe;
  // Orbit radius = bubble's live visual radius. Chars sit on the edge
  // instead of collapsing inside. Minimum radius keeps chars from
  // piling at the cursor at very low pull progress.
  const orbitR = Math.max(24, LENS_BASE_R * lensScale);

  const cx = pullData.cx, cy = pullData.cy;

  for (const s of pullData.charStates) {
    // Vector from cursor to char's *original* position. Recomputed each
    // frame so moving the cursor shifts the pull target. This vector
    // also fixes the per-char reference angle for orbital motion, so a
    // char that started "north" of the cursor continues to orbit from
    // that starting angle rather than jumping when the cursor moves.
    const dxCO = s.originX - cx;
    const dyCO = s.originY - cy;
    const dist = Math.hypot(dxCO, dyCO);

    let tx = 0, ty = 0;

    if (dist > 0.5) {
      // At progress=0 the target is the char's origin (no translate).
      // At progress=1 the target is a point on the bubble's edge,
      // starting at the char's original angle but drifting tangentially
      // via orbitPhase + orbitFreq*elapsedSec*eased — so the ring is
      // alive even at max hold instead of frozen.
      const baseAngle  = Math.atan2(dyCO, dxCO);
      const driftAngle = baseAngle + s.orbitPhase * eased + s.orbitFreq * elapsedSec * eased;
      const orbitX = cx + Math.cos(driftAngle) * orbitR;
      const orbitY = cy + Math.sin(driftAngle) * orbitR;
      tx = (orbitX - s.originX) * eased;
      ty = (orbitY - s.originY) * eased;
    }

    // High-frequency positional tremor. Two sinusoids at 23 / 17 rad/s
    // desynced via jitterSeed — the group looks like live, unstable
    // signal rather than smooth interpolation. Amplitude scales with
    // `eased` so the jitter only kicks in as gravity takes hold.
    const jitterAmp = 3 * eased;
    const jx = (Math.sin(elapsedSec * 23 + s.jitterSeed)       +
                Math.sin(elapsedSec * 11 + s.jitterSeed * 1.7) * 0.5) * jitterAmp;
    const jy = (Math.cos(elapsedSec * 17 + s.jitterSeed * 1.3) +
                Math.cos(elapsedSec *  7 + s.jitterSeed * 0.9) * 0.5) * jitterAmp;
    tx += jx;
    ty += jy;

    s.curTx      = tx;
    s.curTy      = ty;
    s.curScale   = 1 - (1 - s.gravScale) * eased;
    s.curRot     = s.preSpin   * eased;
    s.curTiltX   = s.preTiltX  * eased;
    s.curTiltY   = s.preTiltY  * eased;
    s.curOpacity = 1 - 0.5 * eased;   // 1 → 0.5 across full hold

    // Use translateX/translateY individually (not compound translate()):
    // anime.js v4's transform parser handles individual functions but
    // can stumble on the two-argument compound form, which breaks the
    // explosion handoff later.
    s.el.style.transform =
      `translateX(${tx}px) translateY(${ty}px) ` +
      `scale(${s.curScale}) ` +
      `rotate(${s.curRot}deg) ` +
      `rotateX(${s.curTiltX}deg) rotateY(${s.curTiltY}deg)`;
    s.el.style.opacity = String(s.curOpacity);
  }

  // Gravity lens: grows with pull progress, follows cursor if it moved.
  // Base scale 0.2 → 1.4 maps to visual 24px → 168px against the 120px
  // CSS base (kept near 1× so the backdrop-filter renders at native
  // resolution). Breathing uses the same `lensScale` the char ring
  // above reads, so bubble and chars inhale/exhale together.
  if (pullData.lens) {
    const lensOpacity = Math.min(1, progress * 2.5);    // full opacity by 40%
    pullData.lens.style.left = cx + 'px';
    pullData.lens.style.top  = cy + 'px';
    pullData.lens.style.transform = `scale(${lensScale})`;
    pullData.lens.style.opacity   = String(lensOpacity);
  }

  // No auto-release at progress >= 1. At max hold, chars keep drifting
  // around the bubble from the orbital component, the lens keeps
  // breathing, cursor movement retargets the pull, and explosion only
  // fires on actual pointerup.
  pullData.raf = requestAnimationFrame(pullTick);
}

// Phase 2b (release): user released. Compute force from hold duration,
// kick off the explosion with each char flying outward from its current
// post-pull position (not origin-relative). `from` is NOT used in anime
// keyframes — v4 ignores that key in keyframe objects — so the explosion
// targets are absolute current-plus-offset values.
export function onChaosRelease() {
  if (chaosState !== 'pulling' || !pullData) return;

  cancelAnimationFrame(pullData.raf);

  const elapsed = performance.now() - pullData.startTime;
  const force   = Math.max(PULL_MIN_FORCE, Math.min(elapsed / PULL_MAX_MS, 1));

  chaosState = 'exploding';
  setChaosBtn('', true);   // stay active through the animation

  const { cx, cy, charStates, lens } = pullData;
  pullData = null;

  // Detonation effects scaled by force — weak hold produces subtle
  // flash + shake, full hold is dramatic.
  createChaosFlash(cx, cy, force);
  createScreenFlash(force);
  shakeContent(force);

  // Fade the lens out now that the well has collapsed.
  if (lens) {
    animate(lens, {
      opacity: 0,
      scale: 1.4 + force * 0.8,   // 1.4 (min) → 2.2 (max) — brief expansion as the well collapses
      duration: 420,
      ease: 'out(3)',
      onComplete: () => { try { lens.remove(); } catch {} }
    });
  }

  document.querySelectorAll('.chaos-content-corrupt')
    .forEach(el => el.classList.remove('chaos-content-corrupt'));

  // Non-linear force curve — low force (quick tap) produces a very
  // gentle scatter, full force a dramatic but bounded detonation.
  // Linear scaling felt too strong at both ends; f^1.4 keeps small taps
  // small, and the peak multipliers cap the max so chars don't fly
  // across half the galaxy.
  const fEase = Math.pow(force, 1.4);
  const distMult  = 0.15 + fEase * 0.95;   // 0.18 (min) → 1.1 (max) — was 1.7
  const spinMult  = 0.2  + fEase * 0.8;    // 0.22 → 1.0 — was 1.5
  const burstMult = 0.35 + fEase * 0.65;   // 0.38 → 1.0 — was 1.3

  // Base animation duration — longer at low force so peak velocity is
  // lower. A weak release reads as chars drifting outward over ~2s
  // rather than rocketing off in ~1s.
  const durationBonus = (1 - force) * 500;   // +500ms at min force, +0ms at max

  let completed = 0;
  const total = charStates.length;

  for (const s of charStates) {
    const angle = Math.random() * Math.PI * 2;
    // Base distance reduced and the random add scaled by force — at low
    // force chars travel a short, tight scatter; at max force they span
    // multiple viewport dimensions.
    const dist = (250 + Math.random() * Math.max(rt.W, rt.H) * 1.1) * distMult;
    // Target is offset from char's CURRENT position (s.curTx/curTy),
    // not from origin. This way even if the anime translateX initial
    // value is unknown (v4 parser quirks), the animation terminus is
    // correct and chars fly outward relative to where they actually are.
    const ex = s.curTx + Math.cos(angle) * dist;
    const ey = s.curTy + Math.sin(angle) * dist;

    const expMs    = 1100 + Math.random() * 700 + durationBonus;
    const spinPost = s.curRot   + (Math.random() - 0.5) * 1800 * spinMult;
    const tumbleX  = s.curTiltX + (Math.random() - 0.5) * 1200 * spinMult;
    const tumbleY  = s.curTiltY + (Math.random() - 0.5) * 1200 * spinMult;

    const burstMs  = 90;
    const settleMs = 260;
    const fadeMs   = expMs - burstMs - settleMs;
    const burstTo  = (1.6 + Math.random() * 0.8) * burstMult;
    const flightTo = 0.55 + Math.random() * 0.4;

    animate(s.el, {
      translateX: [
        { to: ex, duration: expMs, ease: 'out(3)' }
      ],
      translateY: [
        { to: ey, duration: expMs, ease: 'out(3)' }
      ],
      rotate: [
        { to: spinPost, duration: expMs, ease: 'out(2)' }
      ],
      rotateX: [
        { to: tumbleX, duration: expMs, ease: 'out(2)' }
      ],
      rotateY: [
        { to: tumbleY, duration: expMs, ease: 'out(2)' }
      ],
      scale: [
        { to: burstTo,  duration: burstMs,  ease: 'out(2)' },
        { to: flightTo, duration: settleMs, ease: 'out(2)' },
        { to: 0,        duration: fadeMs,   ease: 'in(2)'  }
      ],
      opacity: [
        { to: 0.65, duration: burstMs,  ease: 'out(2)' },
        { to: 0.35, duration: settleMs, ease: 'linear' },
        { to: 0,    duration: fadeMs,   ease: 'in(2)'  }
      ],
      onComplete: () => {
        if (++completed === total) finishExplosion();
      }
    });
  }

  // Safety net: if for any reason not all per-char onComplete callbacks
  // fire (anime.js corner case, element yanked from DOM, whatever),
  // force-finish after a generous max. finishExplosion is idempotent
  // via the state guard, so double-calling is harmless.
  const maxExpected = 4000;          // worst-case expMs (2300 at min force) + buffer
  setTimeout(() => {
    if (chaosState === 'exploding') finishExplosion();
  }, maxExpected);
}

// Multi-layer explosion at the click point. Four DOM elements, each
// with its own visual (halo, hot core, conic-gradient beams, shock ring)
// animated on different timings. Layered compositing via mix-blend-mode
// screen brightens the scene underneath rather than occluding it.
//
// Force curve: every peak value is multiplied by f^1.4. Low force is
// dramatically subdued — a quick tap produces a barely-visible flicker
// — while max force is still restrained but clearly dramatic. The
// Math.max floors on opacity prevent the flash from disappearing
// entirely at min force.
function createChaosFlash(x, y, force = 1) {
  const f     = Math.max(0.15, Math.min(force, 1));
  const fEase = Math.pow(f, 1.4);   // steeper than linear — low force much gentler

  const layers = [
    {
      cls: 'chaos-flash-halo',
      scaleTo: 0.3 + fEase * 1.1,                        // 0.3 (min) → 1.4 (max)
      scaleDur: 620,
      scaleEase: 'out(3)',
      opacityKeys: [
        { to: Math.max(0.01, fEase * 0.15), duration: 80,  ease: 'out(2)' },
        { to: 0,                            duration: 540, ease: 'out(2)' }
      ],
    },
    {
      cls: 'chaos-flash-beams',
      scaleTo: 0.5 + fEase * 1.4,                        // 0.5 → 1.9
      scaleDur: 560,
      scaleEase: 'out(3)',
      rotateTo: 4 + fEase * 12,                          // 4° → 16°
      opacityKeys: [
        { to: Math.max(0.01, fEase * 0.12), duration: 50,  ease: 'out(2)' },
        { to: 0,                            duration: 510, ease: 'out(2)' }
      ],
    },
    {
      cls: 'chaos-flash-core',
      scaleTo: 0.3 + fEase * 1.0,                        // 0.3 → 1.3
      scaleDur: 380,
      scaleEase: 'out(3)',
      opacityKeys: [
        { to: Math.max(0.025, fEase * 0.22), duration: 40,  ease: 'out(2)' },
        { to: 0,                             duration: 340, ease: 'out(2)' }
      ],
    },
    {
      cls: 'chaos-flash-ring',
      // Base size bumped from 60px → 300px in CSS for resolution; scale
      // range compressed proportionally so visual diameter stays at
      // 60px (min) → 330px (max).
      scaleTo: 0.2 + fEase * 0.9,                        // 0.2 → 1.1 (visual 60px → 330px)
      scaleDur: 860,
      scaleEase: 'out(3)',
      opacityKeys: [
        { to: Math.max(0.015, fEase * 0.18), duration: 40,  ease: 'out(2)' },
        { to: 0,                             duration: 820, ease: 'out(2)' }
      ],
    },
  ];

  let remaining = layers.length;
  for (const def of layers) {
    const el = document.createElement('div');
    el.className = def.cls;
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
    document.body.appendChild(el);

    const props = {
      scale: [{ to: def.scaleTo, duration: def.scaleDur, ease: def.scaleEase }],
      opacity: def.opacityKeys,
      onComplete: () => {
        try { el.remove(); } catch {}
        if (--remaining === 0) { /* all layers gone */ }
      }
    };
    if (def.rotateTo != null) {
      props.rotate = [{ to: def.rotateTo, duration: def.scaleDur, ease: def.scaleEase }];
    }
    animate(el, props);
  }
}

// Full-viewport flash for the moment of detonation. Brief brightening
// pass in the accent color. Peak opacity scales with force.
function createScreenFlash(force = 1) {
  const f     = Math.max(0.15, Math.min(force, 1));
  const fEase = Math.pow(f, 1.4);
  const flash = document.createElement('div');
  flash.className = 'chaos-screen-flash';
  document.body.appendChild(flash);
  animate(flash, {
    opacity: [
      { to: Math.max(0.01, fEase * 0.12), duration: 60,  ease: 'out(2)' },  // 0.01 (min) → 0.12 (max)
      { to: 0,                             duration: 420, ease: 'out(3)' }
    ],
    onComplete: () => { try { flash.remove(); } catch {} }
  });
}

// Screen shake applied to .content — its coordinate frame shakes, so all
// the char animations (which are relative to that frame) shake with it.
// Toolbar and controls panel are outside .content, so they stay put as
// the user requested. Magnitude scales with force — a weak release
// barely shivers, a full hold shakes hard.
function shakeContent(force = 1) {
  const contentEl = document.querySelector('.content');
  if (!contentEl) return;
  const f     = Math.max(0.15, Math.min(force, 1));
  const fEase = Math.pow(f, 1.4);
  const peakMag = 1.5 + fEase * 8;        // ~1.7px (min) → 9.5px (max)
  const xFrames = [];
  const yFrames = [];
  const N = 7;
  for (let i = 0; i < N; i++) {
    const mag = peakMag * (1 - i / N);    // magnitude decays over time
    xFrames.push({ to: (Math.random() - 0.5) * mag * 2, duration: 42, ease: 'linear' });
    yFrames.push({ to: (Math.random() - 0.5) * mag * 2, duration: 42, ease: 'linear' });
  }
  xFrames.push({ to: 0, duration: 50, ease: 'out(2)' });
  yFrames.push({ to: 0, duration: 50, ease: 'out(2)' });
  animate(contentEl, {
    translateX: xFrames,
    translateY: yFrames
  });
}

// Phase 3: all chars done animating. Resume background motion, but keep
// the exploded state — content stays absent, button becomes 'Normal'.
// The user has to press Normal to rebuild.
// Idempotent: safe to call multiple times (the safety timeout in
// onChaosRelease may call this in addition to the per-char onComplete
// counter).
function finishExplosion() {
  if (chaosState !== 'exploding') return;   // already finished
  chaosState = 'detonated';
  setChaosBtn('Normal mode', true);
  // Reveal the ambient-music CTA now — the scene has quieted down to
  // ambient drift, no toast is competing for the top-center slot, and
  // it's the natural moment for the visitor to linger + consider audio.
  setMuteBtnVisible(true);

  // Aggressive failsafe: hide every animated element unconditionally.
  // Belt-and-suspenders against any anime.js edge case where an
  // animation didn't run or complete properly. Combining opacity:0
  // and visibility:hidden means even CSS keyframes or !important
  // rules can't override us. Also strip the `chaos-char-glitch`
  // class + its inline animation-delay: while visibility:hidden
  // usually elides painting, some browsers still evaluate the
  // filter/text-shadow keyframes every 780ms. Removing the class is
  // a free ~N-filter-eval-per-second save over the 4+ s gap between
  // detonation and restore. The restore path re-adds it.
  if (chaosElements) {
    for (const el of chaosElements) {
      el.style.opacity    = '0';
      el.style.visibility = 'hidden';
      el.classList.remove('chaos-char-glitch');
      el.style.animationDelay = '';
    }
  }

  // Smoothly raise node density: spawn a burst of new nodes over a few
  // seconds, each scaling in from nothing. Capped so repeated detonations
  // can't unboundedly grow the graph.
  burstSpawn(22 + Math.floor(Math.random() * 16));

  // Resume ambient background so the page isn't dead silent while
  // exploded. Honour motionEnabled; if motion is off, just snap timeScale.
  // Gentle inOut ramp (1100ms) so motion fades in rather than springing
  // back — paired with the smooth pauseBackground fade-out, the whole
  // chaos→exploded→ambient cycle reads as continuous.
  if (motionEnabled) {
    if (!rt.raf)         startDrift();
    if (!rt.rewireTimer) restartRewireTimer();
    if (!rt.churnTimer)  scheduleChurn();
    tweenTimeScale(1, 1100, null, 'inOut');
  } else {
    clock.timeScale = 1;
  }
}

// From 'detonated' back to 'idle'. Instead of just fading `.content`
// opacity in, we implode the exploded chars: seed them at random
// off-screen positions with subtle glitch effects and animate them back
// into place. Reads as a reverse explosion at ~40% of the original
// drama. splitText.revert() happens last, once chars have settled, so
// the pristine DOM is restored.
//
// The background (drift + pulses + rewire + churn) is paused for the
// duration of the implosion — running ~40 char animations + their
// glitch keyframes + the background's ~200 node updates on the same
// frame budget produced visible judder during the fly-in. Resumed
// from `finishOnce` once the chars have settled.
function restoreFromDetonated() {
  chaosState = 'restoring';
  setChaosBtn('', true);   // stay active through the restore animation

  // Hide the music CTA immediately as the restore begins — it was the
  // signpost for the `detonated` state and holding it on-screen while
  // chars fly back in reads as stale UI. setMuteBtnVisible(false) also
  // force-mutes so audio stops now rather than a second later.
  setMuteBtnVisible(false);

  // Pause drift/rewire/churn and fade out any live pulse overlays.
  // Equivalent to what startChaos does on its way into `awaiting`,
  // for the same reason: free the frame budget for the char animations
  // that are about to dominate the paint.
  pauseBackground();

  const content = document.querySelector('.content');
  const elements = chaosElements;

  // No animated elements (splitText failed earlier, or already reverted)
  // — fall back to the opacity fade so the state machine still
  // terminates.
  if (!elements || !elements.length) {
    try { chaosSplit?.revert?.(); } catch {}
    chaosSplit = null;
    chaosTextChars = null;
    chaosElements = null;
    document.body.classList.remove('chaos-active');
    if (content) {
      content.style.transform = '';
      content.style.opacity = '0';
      animate(content, {
        opacity: 1,
        duration: 700,
        ease: 'out(2)',
        onComplete: () => {
          content.style.opacity = '';
          chaosState = 'idle';
          setChaosBtn('Fun mode', false);
          setMuteBtnVisible(false);
          resumeBackground();
        }
      });
    } else {
      chaosState = 'idle';
      setChaosBtn('Fun mode', false);
      setMuteBtnVisible(false);
      resumeBackground();
    }
    return;
  }

  // Clear any transform left on the container (shakeContent may still
  // have it set to 0 — belt-and-suspenders).
  if (content) content.style.transform = '';

  // Seed each char off-screen with a random angle/rotation/scale and
  // opacity=0. `visibility:hidden` is lifted so the browser actually
  // paints the char from its seeded position on the next frame.
  // Scatter radius is ~60% of the longer viewport axis — far enough
  // that the chars visibly fly in, close enough they arrive quickly.
  const ww = window.innerWidth, wh = window.innerHeight;
  const scatterBase = Math.max(ww, wh) * 0.6;
  const seeds = elements.map(() => {
    const angle  = Math.random() * Math.PI * 2;
    const dist   = scatterBase * (0.65 + Math.random() * 0.55);
    return {
      sx:  Math.cos(angle) * dist,
      sy:  Math.sin(angle) * dist,
      rot: (Math.random() - 0.5) * 540,      // ±270°
      tx:  (Math.random() - 0.5) * 30,       // subtle 3D tumble
      ty:  (Math.random() - 0.5) * 30,
      scl: 0.5 + Math.random() * 0.15,       // 0.5 – 0.65 → grows to 1
    };
  });

  // Only the splitText chars OUTSIDE atomic containers get the glitch
  // class re-applied on restore. Atomic pills/buttons keep their own
  // CSS intact during the fly-in.
  const textCharSet = new Set(chaosTextChars ?? []);
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const s  = seeds[i];
    el.style.visibility = '';
    el.style.opacity    = '0';
    el.style.transform  =
      `translateX(${s.sx}px) translateY(${s.sy}px) ` +
      `scale(${s.scl}) rotate(${s.rot}deg) ` +
      `rotateX(${s.tx}deg) rotateY(${s.ty}deg)`;
    if (textCharSet.has(el)) {
      // Restart glitch with a fresh desync phase so the implosion gets
      // a subtle corruption texture like the original pull.
      el.style.animationDelay = `-${Math.random() * 780}ms`;
      el.classList.add('chaos-char-glitch');
    }
  }

  // Quiet reverse flash — brief accent-tinted dim that fades out as
  // chars settle. Much lower opacity than the explosion flash.
  const softFlash = document.createElement('div');
  softFlash.className = 'chaos-screen-flash';
  document.body.appendChild(softFlash);
  animate(softFlash, {
    opacity: [
      { to: 0.04, duration: 220, ease: 'out(2)' },
      { to: 0,    duration: 620, ease: 'out(3)' }
    ],
    onComplete: () => { try { softFlash.remove(); } catch {} }
  });

  let completed = 0;
  const total   = elements.length;
  const finishOnce = () => {
    if (chaosState !== 'restoring') return;   // already finished
    // Strip glitch + inline styles before revert() so the pristine
    // output doesn't inherit any of our scratch state.
    for (const el of elements) {
      el.classList.remove('chaos-char-glitch');
      el.style.animationDelay = '';
      el.style.opacity        = '';
      el.style.transform      = '';
    }
    try { chaosSplit?.revert?.(); } catch {}
    chaosSplit = null;
    chaosTextChars = null;
    chaosElements = null;
    document.body.classList.remove('chaos-active');
    chaosState = 'idle';
    setChaosBtn('Fun mode', false);
    // Fun Mode over — hide the mute button; setMuteBtnVisible also
    // force-mutes so audio stops while the button is invisible.
    setMuteBtnVisible(false);
    // Restart the background (drift + rewire + churn) that we paused
    // at the top of restoreFromDetonated.
    resumeBackground();
  };

  for (let i = 0; i < elements.length; i++) {
    const el  = elements[i];
    const dur = 720 + Math.random() * 220;   // 0.72–0.94s, slight jitter
    animate(el, {
      translateX: { to: 0, duration: dur, ease: 'out(3)' },
      translateY: { to: 0, duration: dur, ease: 'out(3)' },
      rotate:     { to: 0, duration: dur, ease: 'out(2)' },
      rotateX:    { to: 0, duration: dur, ease: 'out(2)' },
      rotateY:    { to: 0, duration: dur, ease: 'out(2)' },
      scale:      { to: 1, duration: dur, ease: 'out(3)' },
      opacity:    { to: 1, duration: Math.floor(dur * 0.75), ease: 'out(2)' },
      onComplete: () => {
        if (++completed === total) finishOnce();
      }
    });
  }

  // Safety net: if per-char onCompletes don't all fire (element yanked,
  // anime.js edge case), force-finish after the worst-case flight plus
  // a buffer. `finishOnce` is idempotent via the state guard.
  setTimeout(finishOnce, 1300);
}
