import { lsGet, lsSet, LS_THEME } from './config.js';
import { edgeIndex, nodeEls } from './graph/state.js';

// ── THEMES ───────────────────────────────────────────────────────────
// Hover: same-hue alpha brightening only. Kept intentionally subtle —
// bigger jumps make the background feel hyperactive near the cursor.
export const themes = {
  dark: {
    edgeIdle: 'rgba(140,170,220,0.13)',
    edgeHot:  'rgba(160,190,235,0.28)',
    nodeIdle: 'rgba(170,200,240,0.55)',
    nodeHot:  'rgba(190,215,245,0.82)',
    accent:   '#5eead4'
  },
  light: {
    edgeIdle: 'rgba(30,55,95,0.15)',
    edgeHot:  'rgba(30,55,95,0.32)',
    nodeIdle: 'rgba(30,55,95,0.55)',
    nodeHot:  'rgba(20,40,75,0.82)',
    accent:   '#0d9488'
  }
};

// `currentTheme` and `colors` are reassigned from applyTheme. ES-modules
// live bindings let importers read these via `import { colors }` and see
// the latest value inside function bodies.
export let currentTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
export let colors = themes[currentTheme];
let userChoseTheme = lsGet(LS_THEME) !== null;

const ICON_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const ICON_SUN  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;

export function updateThemeIcon() {
  document.getElementById('theme-btn').innerHTML =
    currentTheme === 'dark' ? ICON_SUN : ICON_MOON;
}

let themeSwapTimer = null;
export function applyTheme(name, { fromUser = true } = {}) {
  currentTheme = name;
  colors = themes[name];

  document.body.classList.add('theme-transitioning');
  document.documentElement.dataset.theme = name;

  for (const entry of edgeIndex.values()) {
    entry.el.style.stroke = '';
    entry.el.style.strokeWidth = '';
  }
  nodeEls.forEach(el => { el.style.fill = ''; });

  updateThemeIcon();

  if (fromUser) {
    userChoseTheme = true;
    lsSet(LS_THEME, name);
  }

  clearTimeout(themeSwapTimer);
  themeSwapTimer = setTimeout(() => {
    document.body.classList.remove('theme-transitioning');
  }, 550);
}

// Follow OS theme changes unless the user has made an explicit choice.
try {
  const mm = matchMedia('(prefers-color-scheme: light)');
  mm.addEventListener('change', e => {
    if (!userChoseTheme) applyTheme(e.matches ? 'light' : 'dark', { fromUser: false });
  });
} catch {}
