import { cfg, defaults, persistCfg } from '../config.js';
import { motionEnabled, setMotion } from '../motion.js';
import { applyTheme, currentTheme } from '../theme.js';
import { chaosState } from '../chaos.js';
import { restartRewireTimer } from '../graph/edges.js';

// The "rebuild the world" callback is supplied by main.js at setup time
// (it's the `resize` function, which cleans up + rebuilds the graph +
// restarts animations). Passed in as a parameter rather than imported so
// ui/controls doesn't need to know about the graph layer.
let onRebuild = () => {};

// Cancel helper lives in chaos.js; call it via the direct import below
// but only inside the reset handler (avoids eager-evaluation issues with
// the ui ↔ chaos import cycle).
import { cancelChaos } from '../chaos.js';

// ── Panel open/close ────────────────────────────────────────────────
const panel   = document.getElementById('controls-panel');
const openBtn = document.getElementById('controls-btn');
export function setPanelOpen(open) {
  panel.dataset.open = open ? 'true' : 'false';
  openBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// ── Slider definitions ──────────────────────────────────────────────
const controls = [
  { key: 'pulseSpeed',     label: 'Pulse speed',     min: 0.25, max: 4,      step: 0.05,
    fmt: v => `${parseFloat((+v).toFixed(2))}×` },
  { key: 'pulseDashLen',   label: 'Pulse length',    min: 0.3,  max: 10,     step: 0.1,
    fmt: v => `${parseFloat((+v).toFixed(2))}×` },
  { key: 'pulseReach',     label: 'Pulse reach',     min: 2,    max: 25,     step: 1,
    fmt: v => `${v} hops` },
  { key: 'maxPulses',      label: 'Max pulses',      min: 10,   max: 200,    step: 5,
    fmt: v => `${v}` },
  { key: 'densityUi',      label: 'Density',         min: 0,    max: 100,    step: 1,
    fmt: v => `~${Math.floor((window.innerWidth * window.innerHeight) / (40000 - v*300))} nodes` },
  { key: 'drift',          label: 'Node drift',      min: 0,    max: 2,      step: 0.1,
    fmt: v => `${parseFloat((+v / 0.4).toFixed(2))}×` }
];

let densityDebounce = null;
function onSliderInput(c, raw) {
  const v = c.step < 1 ? parseFloat(raw) : parseInt(raw, 10);
  cfg[c.key] = v;
  document.getElementById('val-' + c.key).textContent = c.fmt(v);

  switch (c.key) {
    case 'densityUi':
      clearTimeout(densityDebounce);
      densityDebounce = setTimeout(() => onRebuild(), 250);
      break;
  }
  persistCfg();
}

export function syncControlsUI() {
  controls.forEach(c => {
    const slider = document.getElementById('ctrl-' + c.key);
    const value  = document.getElementById('val-' + c.key);
    if (slider) slider.value = cfg[c.key];
    if (value)  value.textContent = c.fmt(cfg[c.key]);
  });
}

// ── Setup (called once from main.js at boot) ────────────────────────
export function setupControls(options = {}) {
  onRebuild = typeof options.onRebuild === 'function' ? options.onRebuild : (() => {});

  // Theme button
  document.getElementById('theme-btn').addEventListener('click', () => {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark', { fromUser: true });
  });

  // Panel open / outside-click-close / Escape-close
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setPanelOpen(panel.dataset.open !== 'true');
  });
  document.addEventListener('click', (e) => {
    if (panel.dataset.open === 'true' &&
        !panel.contains(e.target) && !openBtn.contains(e.target)) {
      setPanelOpen(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.dataset.open === 'true') setPanelOpen(false);
  });

  const ctrlList = document.getElementById('ctrl-list');

  // Motion toggle block (top of panel)
  const toggleWrap = document.createElement('div');
  toggleWrap.className = 'ctrl-toggle';
  toggleWrap.innerHTML = `
    <span class="ctrl-label">Motion</span>
    <button class="toggle-btn" id="motion-btn" data-on="${motionEnabled}">${motionEnabled ? 'ON' : 'OFF'}</button>
  `;
  ctrlList.appendChild(toggleWrap);
  document.getElementById('motion-btn').addEventListener('click', () => {
    setMotion(!motionEnabled, { fromUser: true });
  });

  // Slider controls
  controls.forEach(c => {
    const wrap = document.createElement('div');
    wrap.className = 'ctrl';
    wrap.innerHTML = `
      <div class="ctrl-head">
        <span class="ctrl-label">${c.label}</span>
        <span class="ctrl-value" id="val-${c.key}"></span>
      </div>
      <input type="range" id="ctrl-${c.key}"
             min="${c.min}" max="${c.max}" step="${c.step}"
             value="${cfg[c.key]}">
    `;
    ctrlList.appendChild(wrap);
  });

  controls.forEach(c => {
    const el = document.getElementById('ctrl-' + c.key);
    el.addEventListener('input', () => onSliderInput(c, el.value));
  });

  document.getElementById('reset-btn').addEventListener('click', () => {
    Object.assign(cfg, defaults);
    persistCfg();
    syncControlsUI();
    restartRewireTimer();
    onRebuild();
    // If chaos is in a cancellable state, cancel it. Don't interrupt
    // an in-flight explosion/restore — those will complete naturally.
    if (chaosState === 'slowing' || chaosState === 'awaiting') cancelChaos();
  });
}
