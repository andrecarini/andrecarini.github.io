import { animate } from '../anime.js';
import {
  nodes,
  nodeEls,
  nodeHot,
  edgeIndex,
} from './state.js';
import { cfg } from '../config.js';
import { colors } from '../theme.js';

// ── MOUSE PROXIMITY (fill-only, both nodes and edges) ───────────────
let lastMM = 0;
export function onMouseMove(e) {
  const now = performance.now();
  if (now - lastMM < 24) return;
  lastMM = now;

  const mx = e.clientX, my = e.clientY;
  const R2 = cfg.hoverRadius * cfg.hoverRadius;

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i].cur;
    const dx = n.x - mx, dy = n.y - my;
    const inside = (dx*dx + dy*dy) < R2;
    if (inside && !nodeHot[i]) {
      nodeHot[i] = true;
      animate(nodeEls[i], { fill: colors.nodeHot, duration: 420, ease: 'out(3)' });
    } else if (!inside && nodeHot[i]) {
      nodeHot[i] = false;
      animate(nodeEls[i], { fill: colors.nodeIdle, duration: 900, ease: 'out(3)' });
    }
  }

  for (const entry of edgeIndex.values()) {
    const a = nodes[entry.a].cur, b = nodes[entry.b].cur;
    const midX = (a.x + b.x) * 0.5, midY = (a.y + b.y) * 0.5;
    const dx = midX - mx, dy = midY - my;
    const inside = (dx*dx + dy*dy) < R2;
    if (inside && !entry.hot) {
      entry.hot = true;
      animate(entry.el, { stroke: colors.edgeHot, duration: 420, ease: 'out(3)' });
    } else if (!inside && entry.hot) {
      entry.hot = false;
      animate(entry.el, { stroke: colors.edgeIdle, duration: 900, ease: 'out(3)' });
    }
  }
}
