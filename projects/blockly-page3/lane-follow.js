(function (global) {
  "use strict";

  // ===== 移植自 lane-lab/examples/direct/app.mjs 的轮速映射（/api/motor/direct，±100 量程） =====
  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
  function wheelSpeeds(error, previous, params = { base: 24, kp: 0.05, kd: 0, maxCorrection: 2 }) {
    if (error === null) return { left: 0, right: 0 };
    const derivative = previous === null ? 0 : error - previous;
    const correction = clamp(params.kp * error + (params.kd || 0) * derivative, -params.maxCorrection, params.maxCorrection);
    return { left: Math.round(clamp(params.base + correction, 0, 100)),
             right: Math.round(clamp(params.base - correction, 0, 100)) };
  }

  // ===== 移植自 lane-lab(1)/src/branch.mjs（含 connectedFork 分叉点定位） =====
  function connectedFork(mask, root) {
    let left = root, right = root, common = root.mid, split = 0, hits = 0;
    for (let y = 105; y >= 1; y--) {
      const runs = [];
      for (let x = 1; x < 316;) {
        if (!mask[y * 317 + x]) { x++; continue; }
        const lo = x++; while (x < 316 && mask[y * 317 + x]) x++;
        if (x - lo >= 3) runs.push({ lo, hi: x - 1, mid: (lo + x - 1) / 2 });
      }
      const adjacent = (a, b) => Math.max(a.lo - b.hi, b.lo - a.hi) <= 1;
      const l = runs.filter(r => adjacent(r, left)), r = runs.filter(r => adjacent(r, right));
      if (!l.length || !r.length) {
        // Ignore a short edge spur before the approach stem is established.
        if (split > 86 && (l.length || r.length)) {
          left = right = (l.length ? l : r).reduce((a, b) => Math.abs(a.mid - common) <= Math.abs(b.mid - common) ? a : b);
          common = left.mid; split = 0; hits = 0; continue;
        }
        break;
      }
      left = l[0]; right = r.at(-1);
      if (left.lo === right.lo) { common = left.mid; split = 0; hits = 0; continue; }
      if (!split) split = y + 1;
      // Connected arms must extend to opposite sides of a supported approach stem.
      if (split <= 86 && split >= 20 && common - left.mid >= 20 && right.mid - common >= 20 && right.mid - left.mid >= 60) {
        if (++hits >= 3) return { x: common, y: split };
      } else hits = 0;
    }
    return null;
  }
  function findBranches(mask) {
    const rows = new Map();
    for (let y = 106; y >= 1; y -= 5) {
      const runs = [];
      for (let x = 1; x < 316;) {
        if (!mask[y * 317 + x]) { x++; continue; }
        const lo = x++;
        while (x < 316 && mask[y * 317 + x]) x++;
        if (x - lo >= 3 && x - lo <= 315) runs.push({ lo, hi: x - 1, mid: (lo + x - 1) / 2 });
      }
      rows.set(y, runs);
    }
    const empty = () => ({ error: null, points: [] });
    const out = { fork: false, y: 0, point: null, left: empty(), right: empty() };
    if (!rows.get(106).length) return out;
    const root = rows.get(106).reduce((a, b) => Math.abs(a.mid - 158) <= Math.abs(b.mid - 158) ? a : b);
    if (root.hi - root.lo > 110 || root.lo <= 2 || root.hi >= 314) return out;
    function trace(right) {
      let prev = root; const points = [[106, root.mid]]; let error = null;
      for (let y = 101; y >= 1; y -= 5) {
        const next = rows.get(y).filter(r => Math.max(r.lo - prev.hi, prev.lo - r.hi) <= 18 &&
          (r.hi - r.lo > 110 || prev.hi - prev.lo > 110 || Math.abs(r.mid - prev.mid) <= 55));
        if (!next.length) break;
        prev = right ? next.at(-1) : next[0];
        points.push([y, prev.hi - prev.lo > 110 ? Math.max(prev.lo, Math.min(prev.hi, points.at(-1)[1])) : prev.mid]);
      }
      if (points.length >= 9 && points[0][0] - points.at(-1)[0] >= 40) {
        const p = points.filter(([y]) => y >= 41 && y <= 76);
        if (p.length >= 5) error = (p.reduce((s, q) => s + q[1], 0) / p.length - 158.5) * 2;
      }
      return { error, points };
    }
    out.left = trace(false); out.right = trace(true);
    const n = Math.min(out.left.points.length, out.right.points.length);
    for (let i = 1; i + 2 < n; i++) {
      if ([25, 35, 45].every((v, j) => out.right.points[i + j][1] - out.left.points[i + j][1] >= v)) {
        out.fork = out.left.points.length >= 9 && out.right.points.length >= 9;
        out.y = out.right.points[i][0] + 5; break;
      }
    }
    const connected = connectedFork(mask, root);
    if (connected) { out.fork = true; out.y = connected.y; out.point = connected; }
    else if (out.fork) {
      // Use the last shared stem point, not the midpoint between distant arms.
      let shared = 0;
      for (let i = 1; i < n; i++) {
        if (Math.abs(out.right.points[i][1] - out.left.points[i][1]) > 3) break;
        shared = i;
      }
      const [y, x] = out.left.points[shared];
      out.point = { x, y };
    }
    if (out.point) {
      // At a shallow fork the final shared run can span most of one arm.
      // Project the narrow incoming stem instead of steering to that run's middle.
      const stem = out.left.points.filter(([y, x]) => y >= out.point.y + 12 && y <= out.point.y + 42 &&
        rows.get(y).some(r => Math.abs(r.mid - x) < 1 && r.hi - r.lo <= 60));
      if (stem.length >= 3) {
        const ym = stem.reduce((s, p) => s + p[0], 0) / stem.length;
        const xm = stem.reduce((s, p) => s + p[1], 0) / stem.length;
        const slope = stem.reduce((s, p) => s + (p[0] - ym) * (p[1] - xm), 0) / stem.reduce((s, p) => s + (p[0] - ym) ** 2, 0);
        const x = xm + slope * (out.point.y - ym);
        if (x >= 1 && x <= 315 && Math.abs(slope) <= 2 && stem.every(([y, x]) => Math.abs(x - xm - slope * (y - ym)) <= 4)) out.point.x = x;
      }
      out.y = out.point.y;
    }
    return out;
  }

  // ===== 移植自 lane-lab(1)/src/intersection.mjs（含近 T 型路口茎采样） =====
  function detectIntersection(mask, observedCenters, alternativeTracks = []) {
    const width = 317, height = 112, samples = [];
    // A near T junction has no far-side continuation. Sample the short incoming
    // stem at pixel spacing so it can still anchor a point near the image edge.
    const nearRows = [];
    for (let y = 110; y >= 80; y--) {
      const runs = [];
      for (let x = 1; x < 316;) {
        if (!mask[y * width + x]) { x++; continue; }
        const lo = x++; while (x < 316 && mask[y * width + x]) x++;
        if (x - lo >= 3 && x - lo <= 60) runs.push({ lo, hi: x - 1, x: (lo + x - 1) / 2 });
      }
      nearRows.push(runs);
    }
    const nearTracks = nearRows[0].map(root => {
      let prev = root; const points = [[110, root.x]];
      for (let i = 1; i < nearRows.length; i++) {
        const next = nearRows[i].filter(r => Math.max(r.lo - prev.hi, prev.lo - r.hi) <= 1 && Math.abs(r.x - prev.x) <= 3)
          .sort((a, b) => Math.abs(a.x - prev.x) - Math.abs(b.x - prev.x))[0];
        if (!next) break;
        points.push([110 - i, next.x]); prev = next;
      }
      return points;
    }).filter(points => points.length >= 6);
    // Column runs describe a thin transverse stripe, including tilted stripes.
    for (let x = 2; x < width - 2; x += 4) {
      for (let y = 1; y < height - 1;) {
        if (!mask[y * width + x]) { y++; continue; }
        const start = y++;
        while (y < height - 1 && mask[y * width + x]) y++;
        const mid = (start + y - 1) / 2, thickness = y - start;
        if (thickness >= 2 && thickness <= Math.min(34, 9 + mid * .23))
          samples.push({ x, y: mid, thickness });
      }
    }
    const candidates = [];
    for (let slope = -.6; slope <= .601; slope += .05) {
      const bins = new Map();
      for (const p of samples) {
        const intercept = Math.round((p.y - slope * (p.x - 158)) / 4) * 4;
        if (intercept < 8 || intercept > 108) continue;
        const group = bins.get(intercept) || [];
        group.push(p); bins.set(intercept, group);
      }
      for (const [intercept, points] of bins) {
        if (points.length >= 12) candidates.push({ slope, intercept, points });
      }
    }
    candidates.sort((a, b) => b.points.length - a.points.length);
    for (const { slope, intercept } of candidates) {
      const columns = new Map();
      for (const p of samples) {
        const residual = Math.abs(p.y - intercept - slope * (p.x - 158));
        if (residual > 4) continue;
        const previous = columns.get(p.x);
        if (!previous || residual < previous.residual) columns.set(p.x, { ...p, residual });
      }
      const points = [...columns.values()];
      const thickness = points.reduce((s, p) => s + p.thickness, 0) / points.length;
      for (const track of [observedCenters, ...alternativeTracks, ...(intercept >= 80 ? nearTracks : [])]) {
        const dense = nearTracks.includes(track);
        let near = track.filter(([y, x]) => {
          const d = y - (intercept + slope * (x - 158));
          return d > thickness / 2 + 4 && d < 65;
        }).slice(dense ? -8 : -6);
        let farSide = false;
        if (near.length < 4 && intercept >= 75) {
          near = track.filter(([y, x]) => {
            const d = intercept + slope * (x - 158) - y;
            return d > thickness / 2 + 4 && d < 65;
          }).slice(0, 6);
          farSide = true;
        }
        if (near.length < 4 || near[0][0] - near.at(-1)[0] < (dense ? 5 : 15)) continue;
        const ym = near.reduce((s, p) => s + p[0], 0) / near.length;
        const xm = near.reduce((s, p) => s + p[1], 0) / near.length;
        const variance = near.reduce((s, p) => s + (p[0] - ym) ** 2, 0);
        const heading = near.reduce((s, p) => s + (p[0] - ym) * (p[1] - xm), 0) / variance;
        if (Math.max(...near.map(([y, x]) => Math.abs(x - xm - heading * (y - ym)))) > 8) continue;
        const denominator = 1 - slope * heading;
        if (Math.abs(denominator) / Math.hypot(1, slope) / Math.hypot(1, heading) < .5) continue;
        const y = (intercept + slope * (xm - heading * ym - 158)) / denominator;
        const x = xm + heading * (y - ym);
        const distance = farSide ? y - near[0][0] : near.at(-1)[0] - y;
        if (y < 28 || y > 108 || x < 20 || x > 297 || distance > 35) continue;
        const arm = 22 + y * .18;
        const left = points.filter(p => p.x < x - arm / 2);
        const right = points.filter(p => p.x > x + arm / 2);
        if (left.length < 5 || right.length < 5 || x - left[0].x < arm || right.at(-1).x - x < arm) continue;
        if (x - left.at(-1).x > arm * 2 || right[0].x - x > arm * 2) continue;
        let supported = false;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          if (mask[Math.round(y + dy) * width + Math.round(x + dx)]) supported = true;
        }
        if (!supported) continue;
        return { x, y, slope, thickness, left: left[0].x, right: right.at(-1).x };
      }
    }
    return null;
  }

  // ===== 移植自 lane-lab/src/crossing_stop.mjs =====
  class CrossingStop {
    constructor({ window = 5, need = 3 } = {}) {
      this.window = window; this.need = need; this.flags = []; this.stopped = false;
    }
    update(crossing) {
      if (this.stopped) return true;
      this.flags.push(!!crossing);
      if (this.flags.length > this.window) this.flags.shift();
      if (this.flags.length >= this.need && this.flags.filter(f => f).length >= this.need) this.stopped = true;
      return this.stopped;
    }
  }

  // ===== 移植自 lane-lab/src/lane.mjs 的 detect（含内部 trace/fallback） =====
  function detect(rgba) {
    const mask = new Uint8Array(317 * 112);
    for (let y = 0; y < 112; y++) for (let x = 0; x < 317; x++) {
      const i = ((126 + y) * 320 + x + 1) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      const s = max === 0 ? 0 : Math.round(d * 255 / max);
      let h = 0;
      if (d !== 0) {
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
        if (h < 0) h += 360;
        h = Math.round(h / 2);
      }
      mask[y * 317 + x] = h >= 15 && h <= 40 && s >= 25 && max >= 60 ? 1 : 0;
    }
    const clean = new Uint8Array(mask.length);
    for (let y = 1; y < 111; y++) for (let x = 1; x < 316; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += mask[(y + dy) * 317 + x + dx];
      clean[y * 317 + x] = n >= 5 ? 1 : 0;
    }
    const rows = new Map(), wideRows = [];
    for (let y = 106; y >= 1; y -= 5) {
      const segments = [];
      for (let x = 0; x < 317;) {
        if (!clean[y * 317 + x]) { x++; continue; }
        const start = x++;
        while (x < 317 && (clean[y * 317 + x] || (x + 2 < 317 && clean[y * 317 + x + 1] && clean[y * 317 + x + 2]))) x++;
        const width = x - start;
        if (width > 120) wideRows.push({ y, start, end: x - 1 });
        else if (width >= 3) segments.push({ mid: (start + x - 1) / 2, width });
      }
      rows.set(y, segments);
    }
    function trace(seed = null) {
      const pts = seed ? [[seed.y, seed.x]] : [];
      let previous = seed ? seed.x : 158, previousY = seed ? seed.y : 111;
      let slope = 0, misses = 0;
      for (let y = seed ? seed.y - 5 : 106; y >= 1; y -= 5) {
        const predicted = previous + slope * (previousY - y), maxWidth = 12 + y * 0.45;
        let best = null, bestScore = Infinity;
        for (const { mid, width } of rows.get(y)) {
          const delta = Math.abs(mid - predicted);
          const limit = Math.min(50, 12 + (previousY - y) * 1.3 + misses * 8);
          if (pts.length && delta > limit) continue;
          const score = delta - (width <= maxWidth ? Math.min(width, 20) * 0.2 : 0) + (width > maxWidth ? 4 : 0);
          if (score < bestScore) { best = mid; bestScore = score; }
        }
        if (best !== null) {
          if (pts.length) slope = Math.max(-2, Math.min(2, (best - previous) / (previousY - y)));
          pts.push([y, best]); previous = best; previousY = y; misses = 0;
        } else if (pts.length) {
          if (seed) break;
          misses++;
          if (misses >= 2) { slope = 0; previous = pts.at(-1)[1]; }
        }
      }
      return pts;
    }
    let centers = trace();
    const inferredCenters = [];
    let recoveredBottom = false;
    const hasSupport = pts => pts.length >= 6 && pts[0][0] >= 75 && pts[0][0] - pts.at(-1)[0] >= 30;
    if (!hasSupport(centers) && wideRows.some(r => r.y === 106)) {
      for (let seedY = 101; seedY >= 86; seedY -= 5) {
        if (!rows.get(seedY).length) continue;
        const candidates = [];
        for (const seg of rows.get(seedY)) {
          if (seg.width > 12 + seedY * 0.45 + 8) continue;
          const pts = trace({ y: seedY, x: seg.mid });
          if (pts.length < 7) continue;
          const fit = pts.slice(0, 5);
          const ym = fit.reduce((s, p) => s + p[0], 0) / 5, xm = fit.reduce((s, p) => s + p[1], 0) / 5;
          const slope = fit.reduce((s, p) => s + (p[0] - ym) * (p[1] - xm), 0) / fit.reduce((s, p) => s + (p[0] - ym) ** 2, 0);
          const residual = Math.max(...fit.map(([y, x]) => Math.abs(x - (xm + slope * (y - ym)))));
          if (Math.abs(slope) > 1 || residual > 2.5) continue;
          const fill = [];
          for (let y = seedY + 5; y <= 106; y += 5) {
            const x = xm + slope * (y - ym);
            if (x < 1 || x > 315 || !wideRows.some(r => r.y === y && r.start <= x && x <= r.end)) break;
            fill.push([y, x]);
          }
          if (fill.length !== (106 - seedY) / 5) continue;
          candidates.push({ pts, fill, residual });
        }
        candidates.sort((a, b) => b.pts.length - a.pts.length || a.residual - b.residual);
        if (candidates.length && (candidates.length === 1 || candidates[0].pts.length >= candidates[1].pts.length + 3)) {
          centers = candidates[0].pts;
          inferredCenters.push(...candidates[0].fill);
          recoveredBottom = true;
        }
        break;
      }
    }
    const observedCount = centers.length;
    const observedSupport = hasSupport(centers);
    const stems = rows.get(106).filter(s => s.width <= 60).map(s => trace({ y: 106, x: s.mid }));
    const transverse = detectIntersection(clean, centers, stems);
    const branches = findBranches(clean);
    // A fork is a junction even when neither arm forms a transverse stripe.
    // Prefer its connected root over a line fit through just one shallow arm.
    const intersection = branches.point ? { ...branches.point, kind: "fork" }
      : transverse ? { ...transverse, kind: "transverse" } : null;
    const bridged = [];
    for (let i = 0; i + 1 < centers.length; i++) {
      const [y0, x0] = centers[i], [y1, x1] = centers[i + 1], gap = y0 - y1;
      if (gap <= 5 || gap > 40 || i < 1 || i + 2 >= centers.length) continue;
      const fill = [];
      for (let y = y0 - 5; y > y1; y -= 5) {
        const x = x0 + (x1 - x0) * (y0 - y) / gap;
        if (!wideRows.some(r => r.y === y && r.start <= x && x <= r.end)) { fill.length = 0; break; }
        fill.push([y, x]);
      }
      bridged.push(...fill);
    }
    inferredCenters.push(...bridged);
    centers.push(...inferredCenters);
    centers.sort((a, b) => b[0] - a[0]);
    let nearPixels = 0;
    for (let y = 75; y < 112; y++) for (let x = 0; x < 317; x++) nearPixels += clean[y * 317 + x];
    let error = null;
    if (observedSupport && nearPixels >= 100) {
      const threshold = centers[0][0] - (centers[0][0] - centers.at(-1)[0]) / 3;
      const near = centers.filter(p => p[0] >= threshold);
      error = (near.reduce((s, p) => s + p[1], 0) / near.length - 158.5) * 2;
    }
    return { branches, error, centers, crossing: intersection !== null, intersection,
      confidence: error === null ? 0 : observedCount / 22, observedCount, inferredCenters, recoveredBottom };
  }

  // ===== 板载 HTTP（no-cors fire-and-forget 轮速直控，无需前置握手） =====
  async function fireAndForget(url) {
    try { await fetch(url, { mode: "no-cors", cache: "no-store" }); } catch {}
  }
  function motorDirect(baseUrl, left, right) {
    fireAndForget(`${baseUrl}/api/motor/direct?left=${Math.round(left)}&right=${Math.round(right)}`);
  }

  // ===== 摄像头 =====
  async function openCamera(baseUrl) {
    await fireAndForget(`${baseUrl}/api/camera/open`);
  }

  // ===== MJPEG 帧解析（对齐 lane-lab worker.mjs 的 stream()） =====
  async function* mjpegFrames(baseUrl, signal) {
    const response = await fetch(`${baseUrl}/api/camera/stream?fps=12`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`视频流 HTTP ${response.status}`);
    if (!(response.headers.get("content-type") || "").includes("multipart/")) throw new Error("接口没有返回 MJPEG 视频流");
    const reader = response.body.getReader();
    let buffer = new Uint8Array();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error("视频流已断开");
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer); merged.set(value, buffer.length); buffer = merged;
        let offset = 0;
        while (true) {
          let start = -1, end = -1;
          for (let i = offset; i + 1 < buffer.length; i++) {
            if (buffer[i] === 255 && buffer[i + 1] === 216) { start = i; break; }
          }
          if (start < 0) { buffer = buffer.slice(-1); break; }
          for (let i = start + 2; i + 1 < buffer.length; i++) {
            if (buffer[i] === 255 && buffer[i + 1] === 217) { end = i + 2; break; }
          }
          if (end < 0) { buffer = buffer.slice(start); break; }
          yield buffer.slice(start, end);
          offset = end;
        }
        if (buffer.length > 4 * 1024 * 1024) throw new Error("MJPEG 帧过大或格式损坏");
      }
    } finally {
      try { await reader.cancel(); } catch {}
      reader.releaseLock();
    }
  }

  // ===== 帧处理（letterbox 320×240 + detect） =====
  const FRAME_W = 320, FRAME_H = 240;
  function letterboxDraw(ctx, bitmap) {
    const width = bitmap.width, height = bitmap.height;
    const scale = Math.min(FRAME_W / width, FRAME_H / height);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    const w = Math.round(width * scale), h = Math.round(height * scale);
    ctx.drawImage(bitmap, Math.floor((FRAME_W - w) / 2), Math.floor((FRAME_H - h) / 2), w, h);
  }

  // ===== 蓝色渐变近大远小导航带（自动驾驶导航线效果） =====
  function drawNavRibbon(ctx, centers) {
    if (!centers || centers.length < 2) return;
    const raw = centers.map(([y, x]) => [x, 126 + y]); // [px, py]
    // 移动平均平滑：消除逐帧检测抖动，让路线保持笔直；转弯处自然过渡为弧线
    const radius = 3;
    const pts = raw.map((_, i) => {
      let sx = 0, sy = 0, n = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(raw.length - 1, i + radius); j++) {
        sx += raw[j][0]; sy += raw[j][1]; n++;
      }
      return [sx / n, sy / n];
    });
    const bottom = pts[0];
    const top = pts[pts.length - 1];
    const span = Math.max(1, bottom[1] - top[1]);
    const maxHalf = 11, minHalf = 1.5;
    const left = [], right = [];
    for (let i = 0; i < pts.length; i++) {
      const [px, py] = pts[i];
      const t = (py - top[1]) / span; // 0 远 -> 1 近
      const half = minHalf + (maxHalf - minHalf) * t;
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const dx = next[0] - prev[0];
      const dy = next[1] - prev[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      left.push([px + nx * half, py + ny * half]);
      right.push([px - nx * half, py - ny * half]);
    }
    const grad = ctx.createLinearGradient(0, top[1], 0, bottom[1]);
    grad.addColorStop(0, "rgba(56, 189, 248, 0.25)");
    grad.addColorStop(0.5, "rgba(59, 130, 246, 0.55)");
    grad.addColorStop(1, "rgba(37, 99, 235, 0.7)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (let i = 0; i < left.length - 1; i++) {
      const p0 = left[Math.max(0, i - 1)];
      const p1 = left[i];
      const p2 = left[i + 1];
      const p3 = left[Math.min(left.length - 1, i + 2)];
      ctx.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1]
      );
    }
    const rev = right.slice().reverse();
    ctx.lineTo(rev[0][0], rev[0][1]);
    for (let i = 0; i < rev.length - 1; i++) {
      const p0 = rev[Math.max(0, i - 1)];
      const p1 = rev[i];
      const p2 = rev[i + 1];
      const p3 = rev[Math.min(rev.length - 1, i + 2)];
      ctx.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1]
      );
    }
    ctx.closePath();
    ctx.fill();
  }

  // ===== 循迹画布渲染（对齐 lane-lab/examples/direct/app.mjs 的 visualize） =====
  function renderFrame(canvas, bitmap, result) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = FRAME_W; canvas.height = FRAME_H;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    letterboxDraw(ctx, bitmap);
    drawNavRibbon(ctx, result.centers);
    if (result.intersection) {
      const it = result.intersection;
      ctx.strokeStyle = "#ff2d55"; ctx.lineWidth = 2;
      // fork 型交点只有 x/y（无横杆），transverse 型才有 slope/left/right 可画横杆。
      if (Number.isFinite(it.slope) && Number.isFinite(it.left) && Number.isFinite(it.right)) {
        ctx.beginPath();
        ctx.moveTo(1 + it.left, 126 + it.y + it.slope * (it.left - it.x));
        ctx.lineTo(1 + it.right, 126 + it.y + it.slope * (it.right - it.x));
        ctx.stroke();
      }
      ctx.strokeRect(it.x - 3, 126 + it.y - 4, 8, 8);
      ctx.lineWidth = 1;
    }
  }

  // ===== 公开接口 =====
  function start(options = {}) {
    const baseUrl = String(options.baseUrl || "");
    const canvas = options.canvas || null;
    const base = Number(options.base); if (!Number.isFinite(base)) throw new Error("基础速度无效");
    const kp = Number(options.kp); if (!Number.isFinite(kp)) throw new Error("kp 无效");
    const maxCorrection = Number(options.maxCorrection); if (!Number.isFinite(maxCorrection)) throw new Error("最大修正无效");
    const signal = options.signal || null;
    const onState = options.onState || (() => {});
    const onResult = options.onResult || (() => {});
    const onFrame = options.onFrame || (() => {});
    let controller = new AbortController();
    let active = true;

    function emit(state, reason) { try { onState({ state, reason }); } catch {} }

    async function run() {
      if (signal?.aborted) throw new Error("已停止");
      emit("running");
      let lastError = null;
      const stopPolicy = new CrossingStop();
      try {
        await openCamera(baseUrl);
        const frames = mjpegFrames(baseUrl, controller.signal);
        const offscreen = new OffscreenCanvas(FRAME_W, FRAME_H);
        const offCtx = offscreen.getContext("2d", { willReadFrequently: true });
        let reachedJunction = false;
        let lastControl = 0;
        for await (const jpeg of frames) {
          if (!active || signal?.aborted) throw new Error("已停止");
          const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
          try {
            letterboxDraw(offCtx, bitmap);
            const pixels = offCtx.getImageData(0, 0, FRAME_W, FRAME_H);
            const result = detect(pixels.data);
            const wheels = wheelSpeeds(result.error, lastError, { base, kp, maxCorrection });
            lastError = result.error;
            try { onResult(result); } catch {}
            try { onFrame({ result, wheels }); } catch {}
            renderFrame(canvas, bitmap, result);
            const now = performance.now();
            if (now - lastControl >= 90) {
              motorDirect(baseUrl, wheels.left, wheels.right);
              lastControl = now;
            }
            if (stopPolicy.update(result.crossing)) {
              reachedJunction = true;
              break;
            }
          } finally {
            bitmap.close();
          }
        }
        return { reachedJunction, reason: reachedJunction ? "arrived_at_junction" : "未到达路口" };
      } finally {
        await motorDirect(baseUrl, 0, 0);
        emit("stopped");
      }
    }

    async function stop() {
      active = false;
      controller.abort();
      await motorDirect(baseUrl, 0, 0);
    }

    return { run, stop };
  }

  global.BlocklyLaneFollow = { start };
})(window);
