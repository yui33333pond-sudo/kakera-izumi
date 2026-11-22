// 星座の画面：かけらを夜空に置く。似たものは近くに集まり、一度置いた位置は動かない
// 指やマウスで動かし、ピンチ・ホイールで寄る。星を押すとそのかけらが開く

export function openSky({ host, stars, colorOf, labelOf, onPick, onClose }) {
  host.innerHTML = `<div class="sky-top"><span class="sky-title">星座</span><span class="sky-count">${stars.length} 個の星</span><button class="ghost small" id="skyClose">閉じる ✕</button></div><canvas id="skyCanvas"></canvas><div class="sky-tip" id="skyTip" hidden></div>`;
  host.hidden = false;
  document.body.classList.add('locked');
  const cv = host.querySelector('#skyCanvas'), tip = host.querySelector('#skyTip');
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0, H = 0, scale = 1, tx = 0, ty = 0, hover = null;

  function fit() {
    W = host.clientWidth; H = host.clientHeight - 52;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    if (!stars.length) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of stars) { x0 = Math.min(x0, s.pos_x); x1 = Math.max(x1, s.pos_x); y0 = Math.min(y0, s.pos_y); y1 = Math.max(y1, s.pos_y); }
    const span = Math.max(x1 - x0, y1 - y0, 0.2);
    scale = (Math.min(W, H) * 0.85) / span;
    tx = W / 2 - ((x0 + x1) / 2) * scale; ty = H / 2 - ((y0 + y1) / 2) * scale;
  }
  const sx = (s) => s.pos_x * scale + tx, sy = (s) => s.pos_y * scale + ty;
  const now = Date.now();

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#050f13'; ctx.fillRect(0, 0, W, H);
    for (const s of stars) {
      const x = sx(s), y = sy(s);
      if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
      const age = (now - new Date(s.created_at).getTime()) / 864e5;
      const r = (age < 3 ? 3.6 : age < 30 ? 2.8 : 2.2) * Math.min(1.8, Math.max(0.8, Math.sqrt(scale / 300)));
      ctx.globalAlpha = age < 3 ? 1 : age < 30 ? 0.85 : 0.6;
      ctx.fillStyle = colorOf(s);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (s === hover) { ctx.globalAlpha = 1; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
  }

  function nearest(px, py) {
    let best = null, bd = 22 * 22;
    for (const s of stars) { const dx = sx(s) - px, dy = sy(s) - py, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = s; } }
    return best;
  }
  function showTip(s, px, py) {
    hover = s;
    if (!s) { tip.hidden = true; draw(); return; }
    tip.textContent = labelOf(s);
    tip.hidden = false;
    tip.style.left = Math.min(Math.max(8, px + 12), W - 240) + 'px';
    tip.style.top = Math.min(py + 64, H) + 'px';
    draw();
  }

  // ---- 動かす・寄る ----
  const pts = new Map();
  let moved = false, pinch = null;
  const rect = () => cv.getBoundingClientRect();
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = false; if (pts.size === 2) pinch = null; });
  cv.addEventListener('pointermove', (e) => {
    const r = rect();
    if (!pts.has(e.pointerId)) { if (e.pointerType === 'mouse') { const s = nearest(e.clientX - r.left, e.clientY - r.top); if (s !== hover) showTip(s, e.clientX - r.left, e.clientY - r.top); } return; }
    const prev = pts.get(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
      tx += dx; ty += dy; draw();
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      if (pinch) zoomAt(cx, cy, d / pinch);
      pinch = d; moved = true;
    }
  });
  const up = (e) => {
    const r = rect();
    if (pts.size === 1 && !moved) {
      const s = nearest(e.clientX - r.left, e.clientY - r.top);
      if (s) { if (e.pointerType === 'mouse' || hover === s) onPick(s); else showTip(s, e.clientX - r.left, e.clientY - r.top); }
      else showTip(null);
    }
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); pinch = null; });
  function zoomAt(cx, cy, f) {
    const ns = Math.min(Math.max(scale * f, 20), 200000);
    f = ns / scale; tx = cx - (cx - tx) * f; ty = cy - (cy - ty) * f; scale = ns; draw();
  }
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const r = rect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

  const onResize = () => { fit(); draw(); };
  window.addEventListener('resize', onResize);
  const close = () => { window.removeEventListener('resize', onResize); host.hidden = true; host.innerHTML = ''; document.body.classList.remove('locked'); onClose && onClose(); };
  host.querySelector('#skyClose').addEventListener('click', close);
  fit(); draw();
  return { close };
}

// 新しい星の置き場所：すでに置いた近い星たちの重心のそば。近い星がなければ空のどこか
export function placeNear(neighbors) {
  const placed = neighbors.filter((n) => n.pos_x != null && n.similarity >= 0.3).slice(0, 4);
  const jitter = () => (Math.random() - 0.5) * 0.06;
  if (!placed.length) {
    const a = Math.random() * Math.PI * 2, r = 0.3 + Math.random() * 0.9;
    return { pos_x: Math.cos(a) * r, pos_y: Math.sin(a) * r };
  }
  let wx = 0, wy = 0, w = 0;
  for (const n of placed) { const k = Math.max(0.05, n.similarity) ** 2; wx += n.pos_x * k; wy += n.pos_y * k; w += k; }
  // 似ていないほど少し離す
  const far = 1 - Math.min(0.9, placed[0].similarity);
  const a = Math.random() * Math.PI * 2;
  return { pos_x: wx / w + Math.cos(a) * far * 0.12 + jitter(), pos_y: wy / w + Math.sin(a) * far * 0.12 + jitter() };
}
