// Runs in <head>, before anything is drawn: puts the page in the light or dark look it had last time (app.js keeps
// "noctyl.look" up to date), or the system's look on a first visit, so the background never flashes the wrong one.
// The rest of the page stays hidden until app.js has applied your settings (styles.css: html:not(.app-ready) .app).
'use strict';
(() => {
  let light = matchMedia('(prefers-color-scheme: light)').matches;
  try { const v = localStorage.getItem('noctyl.look'); if (v === 'light' || v === 'dark') light = v === 'light'; } catch { /* storage blocked */ }
  // iPhone Safari ignores "no zoom" in the viewport tag: cancel its pinch gesture here (scrolling and swiping still work)
  for (const g of ['gesturestart', 'gesturechange']) document.addEventListener(g, e => e.preventDefault(), { passive: false });
  if (/[?&]hud=1\b/.test(location.search)) return;
  // opened from the home screen (no browser bars): styles.css lets the page fill the whole screen
  if (navigator.standalone || matchMedia('(display-mode: standalone)').matches) document.documentElement.classList.add('standalone');
  if (light) document.documentElement.classList.add('light');
  // a color theme's background (Colors & themes), so the page doesn't flash the default one first
  try { const bg = localStorage.getItem('noctyl.lookBg'); if (/^#[0-9a-f]{6}$/i.test(bg || '')) document.documentElement.style.setProperty('--bg', bg); } catch { /* storage blocked */ }
})();
