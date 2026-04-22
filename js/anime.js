// Single import point for anime.js so every module shares one parsed
// instance instead of re-fetching (native ESM resolves same URL to same
// module, but the indirection here means we can swap CDN / pin version
// in one place).
export {
  animate,
  createTimeline,
  stagger,
  createDrawable,
  splitText,
  engine,
} from 'https://cdn.jsdelivr.net/npm/animejs@4/+esm';
