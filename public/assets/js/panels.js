const SIZE = 640;

function readPixels(img) {
  const scale = SIZE / Math.max(img.naturalWidth, img.naturalHeight);
  const W = Math.max(8, Math.round(img.naturalWidth * scale));
  const H = Math.max(8, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);
  canvas.width = 0;
  const lum = new Float32Array(W * H);
  const chroma = new Float32Array(W * H);
  for (let k = 0, i = 0; k < lum.length; k++, i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    lum[k] = r * 0.299 + g * 0.587 + b * 0.114;
    chroma[k] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  return { W, H, lum, chroma };
}

function borderLuminance({ W, H, lum }) {
  const values = [];
  for (let x = 0; x < W; x++) values.push(lum[x], lum[(H - 1) * W + x]);
  for (let y = 0; y < H; y++) values.push(lum[y * W], lum[y * W + W - 1]);
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

function integral(px, isBackground) {
  const { W, H } = px;
  const table = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      if (!isBackground(y * W + x)) row++;
      table[(y + 1) * (W + 1) + x + 1] = table[y * (W + 1) + x + 1] + row;
    }
  }
  const sum = (x0, y0, x1, y1) => table[y1 * (W + 1) + x1] - table[y0 * (W + 1) + x1] - table[y1 * (W + 1) + x0] + table[y0 * (W + 1) + x0];
  return { W, H, sum };
}

function trim(r, a, ratio) {
  let { x0, y0, x1, y1 } = r;
  const limit = (len) => Math.max(1, len * ratio);
  while (y0 < y1 && a.sum(x0, y0, x1, y0 + 1) <= limit(x1 - x0)) y0++;
  while (y1 > y0 && a.sum(x0, y1 - 1, x1, y1) <= limit(x1 - x0)) y1--;
  while (x0 < x1 && a.sum(x0, y0, x0 + 1, y1) <= limit(y1 - y0)) x0++;
  while (x1 > x0 && a.sum(x1 - 1, y0, x1, y1) <= limit(y1 - y0)) x1--;
  return { x0, y0, x1, y1 };
}

function splits(r, a, horizontal) {
  const length = horizontal ? r.y1 - r.y0 : r.x1 - r.x0;
  const across = horizontal ? r.x1 - r.x0 : r.y1 - r.y0;
  const limit = Math.max(1, across * 0.1);
  const minGap = a.minGap || Math.max(2, Math.round((horizontal ? a.H : a.W) * 0.004));
  const cuts = [];
  let run = 0;
  for (let k = 0; k < length; k++) {
    const ink = horizontal
      ? a.sum(r.x0, r.y0 + k, r.x1, r.y0 + k + 1)
      : a.sum(r.x0 + k, r.y0, r.x0 + k + 1, r.y1);
    if (ink <= limit) {
      run++;
    } else {
      if (run >= minGap && k - run > 0) cuts.push(k - Math.ceil(run / 2));
      run = 0;
    }
  }
  return cuts;
}

function segment(r, a, dir, depth, out) {
  const t = trim(r, a, 0.1);
  const w = t.x1 - t.x0;
  const h = t.y1 - t.y0;
  if (w < a.W * 0.08 || h < a.H * 0.05) return;
  if (depth < 7) {
    for (const horizontal of [true, false]) {
      const cuts = splits(t, a, horizontal);
      if (!cuts.length) continue;
      const parts = [];
      let start = 0;
      for (const c of [...cuts, horizontal ? h : w]) {
        parts.push(horizontal
          ? { x0: t.x0, y0: t.y0 + start, x1: t.x1, y1: t.y0 + c }
          : { x0: t.x0 + start, y0: t.y0, x1: t.x0 + c, y1: t.y1 });
        start = c;
      }
      if (!horizontal && dir === 'rtl') parts.reverse();
      parts.forEach((p) => segment(p, a, dir, depth + 1, out));
      return;
    }
  }
  out.push(t);
}

function detect(a, dir) {
  const rects = [];
  segment({ x0: 0, y0: 0, x1: a.W, y1: a.H }, a, dir, 0, rects);
  const area = a.W * a.H;
  const panels = rects.filter((r) => (r.x1 - r.x0) * (r.y1 - r.y0) > area * 0.02);
  const covered = panels.reduce((s, r) => s + (r.x1 - r.x0) * (r.y1 - r.y0), 0) / area;
  return { panels, covered };
}

export function analyzePage(img, dir = 'ltr') {
  if (!img || !img.naturalWidth) return null;
  let px;
  try {
    px = readPixels(img);
  } catch {
    return null;
  }
  const { W, H, lum, chroma } = px;
  const edge = borderLuminance(px);
  const tolerance = edge > 200 || edge < 55 ? 40 : 28;
  const white = (k) => lum[k] > 222 && chroma[k] < 40;
  const black = (k) => lum[k] < 38;
  const candidates = [
    integral(px, white),
    integral(px, black),
    integral(px, (k) => Math.abs(lum[k] - edge) <= tolerance)
  ];
  const frames = [integral(px, white), integral(px, black)];
  frames.forEach((f) => { f.minGap = 1; });

  const boundsSource = candidates[edge > 200 ? 0 : edge < 55 ? 1 : 2];
  const b = trim({ x0: 0, y0: 0, x1: W, y1: H }, boundsSource, 0.012);
  const pad = 0.006;
  const bounds = b.x1 > b.x0 && b.y1 > b.y0
    ? {
        x: Math.max(0, b.x0 / W - pad),
        y: Math.max(0, b.y0 / H - pad),
        w: Math.min(1, (b.x1 - b.x0) / W + pad * 2),
        h: Math.min(1, (b.y1 - b.y0) / H + pad * 2)
      }
    : { x: 0, y: 0, w: 1, h: 1 };

  let best = { panels: [], covered: 0 };
  for (const a of [...candidates, ...frames]) {
    const result = detect(a, dir);
    const n = result.panels.length;
    if (n < 2 || n > 14 || result.covered < 0.45) continue;
    if (n > best.panels.length || (n === best.panels.length && result.covered > best.covered)) best = result;
  }

  const panels = best.panels.map((r) => {
    const m = 0.008;
    const x = Math.max(0, r.x0 / W - m);
    const y = Math.max(0, r.y0 / H - m);
    return { x, y, w: Math.min(1 - x, (r.x1 - r.x0) / W + m * 2), h: Math.min(1 - y, (r.y1 - r.y0) / H + m * 2) };
  });
  return { bounds, panels };
}
