// ══════════════════════════════════════════════════════════════════════
//    AUDIO — ambient generative music for Fun Mode
// ══════════════════════════════════════════════════════════════════════
// Design: Tone.js is lazy-loaded on first unmute (≈200 KB — we don't pay
// the network cost unless the user wants audio). Everything is pinned to
// the C major pentatonic scale so nothing can sound dissonant. A slow
// chord pad cycles on a timer; user clicks fire arpeggios; pulse
// arrivals ping single bells chosen by the arriving node's y-position
// (higher on screen = higher note). The audio context is suspended when
// the tab is hidden, the window loses focus, or Fun Mode ends — so we
// don't waste cycles/battery when nobody's listening.
//
// Smoothness notes:
//   - Pad voices are basic Tone.Synth (one oscillator + one envelope).
//     The earlier AMSynth (2 oscillators + modulator + 2 envelopes) was
//     roughly 2× the CPU per voice, and with chord overlap + arpeggios +
//     pulse bells peak polyphony occasionally crossed the budget of a
//     typical laptop audio callback, producing the clicks/pops we heard.
//   - Hard polyphony cap at 12 on the pad PolySynth. Voice stealing is
//     rare at this cap but preferable to underrun pops when it happens.
//   - Scheduler lookAhead is raised to 0.2s so the audio worklet has
//     buffer headroom to ride through main-thread stalls (drift ticks,
//     splitText, anime writes) without dropping audio frames.
//   - Every trigger schedules at `Tone.now() + 0.03` rather than exactly
//     now — scheduling slightly in the future prevents the worklet from
//     receiving events it's already past and having to reconcile.
//   - Bells are rate-limited to at most one per ~60 ms, so a dense pulse
//     cascade (many simultaneous arrivals) can't flood polyphony.

const PENTA_C = ['C4','D4','E4','G4','A4','C5','D5','E5','G5','A5','C6'];
// Pentatonic chord clusters — every note is in-scale, so arpeggios and
// chords never clash. Cycle progression is I → vi-ish → sus → rooted.
const CHORD_CLUSTERS = [
  ['C3', 'E4', 'G4'],
  ['A3', 'C5', 'E5'],
  ['G3', 'C5', 'D5'],
  ['E3', 'G4', 'A4'],
];
const CHORD_CYCLE_MS = 8000;                  // 32s full cycle
const CHORD_CYCLE_S  = CHORD_CYCLE_MS / 1000;
// Chord sustains a bit past the next chord's onset so releases overlap —
// long enough that the bed doesn't dip to silence, short enough that we
// don't double-stack the chord voice count on the crossover. Was +1.5,
// which let peak polyphony climb to 6 chord voices for 1.5s every cycle
// on top of arpeggios + bells — a common trigger for audio underruns.
const CHORD_SUSTAIN_S = CHORD_CYCLE_S + 0.6;
// Safety cap on pad polyphony. Exceeds typical concurrent voice demand
// (3 chord + 4 arpeggio + a few bells) but stops runaway stacking during
// dense pulse cascades. Voice stealing below this threshold essentially
// never fires; the cap is insurance against the worst case.
const PAD_MAX_POLYPHONY = 12;
// Scheduler lookahead. Default 0.1s is tuned for interactive latency
// (instruments reacting to a keyboard); an ambient generative scene
// doesn't need that and benefits enormously from the extra buffer
// against main-thread stalls.
const AUDIO_LOOKAHEAD_S = 0.2;
// Small offset applied to every scheduled note. Prevents "scheduled in
// the past" events which Tone has to reconcile inside the worklet and
// which occasionally produced audible artefacts under load.
const SCHEDULE_SLACK_S = 0.03;
// Minimum interval between consecutive arrival bells. A cascade that
// arrives at 20 nodes across two frames would otherwise fire 20 bells
// in ~30 ms and demolish polyphony. One bell every 60 ms still sounds
// dense but keeps voice count sane.
const BELL_MIN_INTERVAL_MS = 60;
const ARPEGGIO_GAP_S = 0.12;                  // seconds between arpeggio notes
const ARPEGGIO_VEL   = 0.55;
const BELL_VEL_CAP   = 0.6;
const CHORD_VEL      = 0.75;
const DRONE_VEL      = 0.35;
const AUDIO_MASTER_DB = -7;                   // bumped up — earlier -12 read too quiet
const TONE_ESM_URL = 'https://esm.sh/tone@15.1.22';

let audioMuted      = true;    // user preference within this Fun Mode session
let audioLoaded     = false;   // Tone.js imported + synth chain built
let audioActive     = false;   // audio context is running + chord loop ticking
let audioEls        = null;    // { Tone, synth, reverb, chorus, filter }
let audioChordTimer = null;
let audioChordIdx   = 0;

async function audioLoad() {
  if (audioLoaded) return;
  // Dynamic import — first call pays the network + parse cost. Kept
  // awaitless until here so iOS keeps its user-gesture association.
  const Tone = await import(TONE_ESM_URL);
  // Give the scheduler more buffer before we build anything on it.
  // Raising lookAhead is cheap but substantially improves resilience to
  // brief main-thread stalls on this page (drift + splitText + anime).
  try { Tone.getContext().lookAhead = AUDIO_LOOKAHEAD_S; } catch {}
  const destination = Tone.getDestination();
  destination.volume.value = -Infinity;
  // Cheap, lush ambient tail — Freeverb is ~10× lighter than
  // convolution Reverb and fine for a pad bed.
  const reverb = new Tone.Freeverb({ roomSize: 0.9, dampening: 3000, wet: 0.55 });
  const chorus = new Tone.Chorus({ frequency: 0.5, depth: 0.7, wet: 0.4 }).start();
  const filter = new Tone.Filter(1800, 'lowpass');
  // Basic Tone.Synth (triangle osc + envelope) instead of AMSynth. We
  // lose the amplitude-modulation shimmer, but the filter + chorus +
  // reverb chain still gives the voice plenty of movement, and per-voice
  // CPU drops roughly in half — which matters when peak polyphony
  // during an arpeggio + chord-overlap + bell cascade can stack 10+
  // voices at once. The envelope shape matches the old AMSynth carrier
  // envelope so the pad's attack/release character is preserved.
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope:   { attack: 2, decay: 1, sustain: 0.8, release: 4 },
    volume: -9,   // was -14 — earlier pass was near-inaudible on typical speakers
  });
  // Cap total simultaneous voices. Voice stealing above this is
  // preferable to buffer underruns — stolen voices release via the
  // normal envelope, underruns pop.
  try { synth.maxPolyphony = PAD_MAX_POLYPHONY; } catch {}
  // Separate drone voice: a continuous low note on the tonic that
  // never releases while unmuted. Guarantees the bed is never silent
  // between chord hits, even if Freeverb tail has decayed. Its own
  // synth so its envelope/volume can be tuned independently of the
  // pad chords.
  const drone = new Tone.MonoSynth({
    oscillator: { type: 'sine' },
    envelope:   { attack: 4, decay: 1, sustain: 1, release: 6 },
    filter:     { Q: 2, type: 'lowpass', rolloff: -24 },
    filterEnvelope: { attack: 4, decay: 2, sustain: 0.6, release: 6, baseFrequency: 200, octaves: 2 },
    volume: -16,
  });
  drone.chain(chorus, reverb, destination);
  synth.chain(filter, chorus, reverb, destination);
  audioEls = { Tone, synth, drone, reverb, chorus, filter };
  audioLoaded = true;
}

async function audioUnmute() {
  audioMuted = false;
  updateMuteBtn();
  try {
    if (!audioLoaded) await audioLoad();
  } catch (err) {
    console.warn('Audio load failed:', err);
    audioMuted = true;
    updateMuteBtn();
    return;
  }
  const { Tone } = audioEls;
  // Tone.start() unlocks the audio context. Must happen inside a user
  // gesture in every modern browser. Extra resume() for iOS, which
  // lets the context go stale after a few seconds of backgrounding.
  try { await Tone.start(); } catch {}
  try { await Tone.getContext().rawContext.resume(); } catch {}
  audioActive = true;
  Tone.getDestination().volume.rampTo(AUDIO_MASTER_DB, 0.8);
  audioStartDrone();
  audioStartChord();
}

export function audioMute() {
  audioMuted = true;
  updateMuteBtn();
  if (!audioLoaded || !audioEls) return;
  const { Tone } = audioEls;
  Tone.getDestination().volume.rampTo(-Infinity, 0.6);
  audioStopChord();
  audioStopDrone();
  // Suspend context after the fade so we're truly idle while muted.
  setTimeout(() => {
    if (audioMuted) {
      try { Tone.getContext().rawContext.suspend(); } catch {}
      audioActive = false;
    }
  }, 700);
}

// Continuous tonic drone — a single sustained note that runs the entire
// time we're unmuted. Guarantees the bed never dips to silence between
// chord notes. Released (not detuned) on mute so the release tail can
// still carry.
let droneActive = false;
function audioStartDrone() {
  if (!audioEls || droneActive) return;
  const { Tone, drone } = audioEls;
  try { drone.triggerAttack('C3', Tone.now() + SCHEDULE_SLACK_S, DRONE_VEL); } catch {}
  droneActive = true;
}
function audioStopDrone() {
  if (!audioEls || !droneActive) return;
  const { Tone, drone } = audioEls;
  try { drone.triggerRelease(Tone.now() + SCHEDULE_SLACK_S); } catch {}
  droneActive = false;
}

function audioStartChord() {
  audioStopChord();
  const fire = () => {
    if (audioMuted || !audioEls) return;
    const { Tone, synth } = audioEls;
    const cluster = CHORD_CLUSTERS[audioChordIdx % CHORD_CLUSTERS.length];
    audioChordIdx++;
    try {
      // Sustain past the next chord's onset so releases overlap — the
      // bed never drops to silence between chords.
      synth.triggerAttackRelease(cluster, CHORD_SUSTAIN_S, Tone.now() + SCHEDULE_SLACK_S, CHORD_VEL);
    } catch {}
    audioChordTimer = setTimeout(fire, CHORD_CYCLE_MS);
  };
  fire();
}
function audioStopChord() {
  if (audioChordTimer) {
    clearTimeout(audioChordTimer);
    audioChordTimer = null;
  }
}

// Arpeggio fired when the user click-emits a pulse. 4 notes, ascending
// along pentatonic, moderately audible so it clearly reads as "this
// click made music".
export function audioArpeggio(seed) {
  if (audioMuted || !audioActive || !audioEls) return;
  const { Tone, synth } = audioEls;
  // All four notes share one `now` base so the gap pattern is exact
  // even if Tone.now() advances between trigger calls.
  const now = Tone.now() + SCHEDULE_SLACK_S;
  for (let i = 0; i < 4; i++) {
    const note = PENTA_C[((seed | 0) + i * 2) % PENTA_C.length];
    try {
      synth.triggerAttackRelease(note, '8n', now + i * ARPEGGIO_GAP_S, ARPEGGIO_VEL);
    } catch {}
  }
}

// Bell fired when a pulse arrives at a node. y-position maps to pitch
// (top of screen = highest note). Skipped for very dim arrivals so
// far-cascade tails don't overwhelm the mix. Rate-limited: a dense
// cascade can arrive at many nodes in the same frame and firing every
// one of them stacks polyphony in a way that audibly crackles.
let lastBellAtMs = 0;
export function audioArrivalBell(yRatio, energy) {
  if (audioMuted || !audioActive || !audioEls) return;
  if (energy < 0.25) return;
  const nowMs = performance.now();
  if (nowMs - lastBellAtMs < BELL_MIN_INTERVAL_MS) return;
  lastBellAtMs = nowMs;
  const { Tone, synth } = audioEls;
  const idx = Math.max(0, Math.min(PENTA_C.length - 1,
    Math.floor((1 - yRatio) * PENTA_C.length)));
  try {
    // '4n' (500ms @ 120bpm) rather than '2n' (1s) — half the time a
    // bell occupies a voice, half the peak polyphony from back-to-back
    // cascade arrivals. With the synth's 4s release tail the bell still
    // rings out audibly into the reverb.
    synth.triggerAttackRelease(PENTA_C[idx], '4n', Tone.now() + SCHEDULE_SLACK_S, Math.min(BELL_VEL_CAP, energy * 0.7));
  } catch {}
}

// Suspend/resume for visibility + blur. Only acts if audio was ever
// loaded — no-op otherwise.
export function audioSuspend() {
  if (!audioEls) return;
  try { audioEls.Tone.getContext().rawContext.suspend(); } catch {}
}
export function audioResume() {
  if (!audioEls || audioMuted) return;
  try { audioEls.Tone.getContext().rawContext.resume(); } catch {}
}

// ── Music CTA — prominent pill at top-center ────────────────────────
// Earlier design stuck a tiny icon button in the toolbar; visitors
// didn't notice it. Promoted to a wide pill that lives at the same
// top-center location as the chaos hint toast (the toast slides
// below it via CSS). Pulses gently while muted to draw the eye.
const ICON_VOLUME_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`;
const ICON_VOLUME_ON  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;

let muteBtn = null;
export function ensureMuteBtn() {
  if (muteBtn) return muteBtn;
  muteBtn = document.createElement('button');
  muteBtn.className = 'music-cta';
  muteBtn.id = 'music-cta';
  muteBtn.dataset.visible = 'false';
  muteBtn.dataset.muted   = 'true';
  muteBtn.setAttribute('aria-label', 'Unmute ambient music');
  renderMuteBtn();
  document.body.appendChild(muteBtn);
  // Stop propagation: the window-level click handler would otherwise
  // emit a pulse at the CTA's location; pointerdown during `awaiting`
  // would trigger the gravity press.
  muteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (audioMuted) await audioUnmute();
    else audioMute();
  });
  muteBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  return muteBtn;
}
function renderMuteBtn() {
  if (!muteBtn) return;
  const icon  = audioMuted ? ICON_VOLUME_OFF : ICON_VOLUME_ON;
  const label = audioMuted ? 'Unmute music'   : 'Mute music';
  muteBtn.innerHTML = `${icon}<span>${label}</span>`;
}
function updateMuteBtn() {
  if (!muteBtn) return;
  muteBtn.dataset.muted = audioMuted ? 'true' : 'false';
  muteBtn.setAttribute(
    'aria-label',
    audioMuted ? 'Unmute ambient music' : 'Mute ambient music'
  );
  renderMuteBtn();
}
export function setMuteBtnVisible(visible) {
  ensureMuteBtn();
  muteBtn.dataset.visible = visible ? 'true' : 'false';
  // Leaving Fun Mode while unmuted — force-mute so nothing plays
  // while the button is hidden.
  if (!visible && !audioMuted) audioMute();
}
