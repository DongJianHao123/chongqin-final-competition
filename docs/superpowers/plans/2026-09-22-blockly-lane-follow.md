# Blockly「沿线循迹」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Blockly 真实小车模式新增「沿线循迹」移动积木，让小车沿黄色主线行驶并在识别到下一个路口时自动停车，同时用独立循迹画布展示线路识别结果。

**Architecture:** 新建独立经典脚本 `lane-follow.js`（暴露 `window.BlocklyLaneFollow`），从 lane-lab 前端移植黄色主线检测 + PD 轮速 + follow 状态机 + MJPEG 解析 + `/api/lane/*` 板载控制。app.js 只负责新增积木定义、生成器、Robot API 入口与画布显隐。检测在主线程异步跑（`createImageBitmap` 异步解码）。

**Tech Stack:** 原生 JS（经典脚本、无构建）、Blockly、Node（server 静态服务）、node:test（regex 断言，与现有测试同风格）。

**参考源码（逐行移植，不转录偏差）：**
- `E:\Project\工作空间\ai\zheng\lane-lab\src\lane.mjs`（`detect`/`speeds`/`toPwm`/`roundEven`）
- `E:\Project\工作空间\ai\zheng\lane-lab\src\branch.mjs`（`findBranches`/`bottomCrossbar`）
- `E:\Project\工作空间\ai\zheng\lane-lab\src\intersection.mjs`（`detectIntersection`）
- `E:\Project\工作空间\ai\zheng\lane-lab\src\crossing_stop.mjs`（`CrossingStop`）
- `E:\Project\工作空间\ai\zheng\lane-lab\src\action_policy.mjs`（`ExitEvidence` + follow 状态机）
- `E:\Project\工作空间\ai\zheng\lane-lab\src\worker.mjs`（MJPEG 帧解析）

---

## 文件结构

- **Create** `projects/blockly-page3/lane-follow.js` — 循迹模块（纯函数 + 运行时 + 公开接口）。
- **Modify** `projects/blockly-page3/server.js:148-168` — `STATIC_FILES` 增加映射。
- **Modify** `projects/blockly-page3/index.html:358-362` — 加 `<script>`；`index.html:172-179` 附近加循迹 `<canvas>`；`index.html:195-216` toolbox 加积木。
- **Modify** `projects/blockly-page3/styles.css` — 循迹画布样式。
- **Modify** `projects/blockly-page3/app.js` — 积木定义、生成器、DOM 引用、`followLineToJunction`、Robot API。
- **Modify** `projects/blockly-page3/tests/block-catalog.test.js` — 断言。
- **Modify** `projects/blockly-page3/指导书.md` — 文档。

---

## Task 1: 挂载静态资源与骨架文件

**Files:**
- Create: `projects/blockly-page3/lane-follow.js`
- Modify: `projects/blockly-page3/server.js:148-168`
- Modify: `projects/blockly-page3/index.html:358-362`

- [ ] **Step 1: server.js 增加 STATIC_FILES 映射**

在 `projects/blockly-page3/server.js` 的 `STATIC_FILES` 数组里，`["/app.js", "app.js"]` 之后加一行：

```js
  ["/lane-follow.js", "lane-follow.js"],
```

- [ ] **Step 2: index.html 在 app.js 之前加载 lane-follow.js**

在 `projects/blockly-page3/index.html` 第 362 行 `app.js` 的 `<script>` 之前插入：

```html
  <script src="./lane-follow.js?v=20260922-lane-follow-001"></script>
```

- [ ] **Step 3: 创建 lane-follow.js 骨架（先暴露空接口，后续任务填充）**

创建 `projects/blockly-page3/lane-follow.js`，内容如下（`start` 暂为占位，Task 3 实现）：

```js
(function (global) {
  "use strict";
  global.BlocklyLaneFollow = {
    start() {
      throw new Error("BlocklyLaneFollow 尚未初始化");
    }
  };
})(window);
```

- [ ] **Step 4: 语法检查**

Run: `cd "E:\Project\工作空间\ai\zheng\competition-platform\projects\blockly-page3" && node --check lane-follow.js`
Expected: 无输出（通过）。

- [ ] **Step 5: Commit**

```bash
git add projects/blockly-page3/lane-follow.js projects/blockly-page3/server.js projects/blockly-page3/index.html
git commit -m "feat(blockly): 挂载 lane-follow 静态资源骨架"
```

---

## Task 2: 移植检测与 PD 纯函数到 lane-follow.js

**Files:**
- Modify: `projects/blockly-page3/lane-follow.js`

本任务把 lane-lab 的检测与轮速纯函数逐行移植进 IIFE（去掉 `import`/`export`，全部定义在同一作用域，函数间可直接互调）。

- [ ] **Step 1: 用下面的完整代码替换 lane-follow.js 的 IIFE 内部（`"use strict";` 之后、`global.BlocklyLaneFollow` 之前）**

```js
  // ===== 移植自 lane-lab/src/lane.mjs =====
  const INTENT_MAX = 50, PWM_STARTUP = 20;
  function toPwm(intent) {
    if (intent <= 0) return 0;
    return Math.round(PWM_STARTUP + (intent / INTENT_MAX) * (INTENT_MAX - PWM_STARTUP));
  }
  const roundEven = n => n - Math.floor(n) === 0.5 ? 2 * Math.round(n / 2) : Math.round(n);
  function speeds(error, previous, dt, params = { base: 22, kp: 0.03, kd: 0, maxCorrection: 12 }) {
    if (error === null) return { left: 0, right: 0 };
    const derivative = previous === null ? 0 : error - previous;
    const correction = Math.max(-params.maxCorrection, Math.min(params.maxCorrection, params.kp * error + params.kd * derivative));
    return { left: Math.max(0, Math.min(INTENT_MAX, toPwm(roundEven(params.base + correction)))),
             right: Math.max(0, Math.min(INTENT_MAX, toPwm(roundEven(params.base - correction)))) };
  }

  // ===== 移植自 lane-lab/src/branch.mjs =====
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
    const out = { fork: false, y: 0, left: empty(), right: empty() };
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
    return out;
  }
  function bottomCrossbar(rgba) {
    let columns = 0, touching = 0;
    for (let x = 1; x < 319; x++) {
      let count = 0, edge = 0;
      for (let y = 218; y < 240; y++) {
        const i = (y * 320 + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, s = mx === 0 ? 0 : Math.round(d * 255 / mx);
        let h = 0;
        if (d) { h = mx === r ? 60 * ((g - b) / d % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4); if (h < 0) h += 360; h = Math.round(h / 2); }
        if (h >= 15 && h <= 40 && s >= 25 && mx >= 60) { count++; if (y >= 236) edge++; }
      }
      if (count >= 3) columns++; if (edge >= 2) touching++;
    }
    return columns >= 100 && touching >= 12;
  }

  // ===== 移植自 lane-lab/src/intersection.mjs =====
  function detectIntersection(mask, observedCenters, alternativeTracks = []) {
    const width = 317, height = 112, samples = [];
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
      for (const track of [observedCenters, ...alternativeTracks]) {
        let near = track.filter(([y, x]) => {
          const d = y - (intercept + slope * (x - 158));
          return d > thickness / 2 + 4 && d < 65;
        }).slice(-6);
        let farSide = false;
        if (near.length < 4 && intercept >= 75) {
          near = track.filter(([y, x]) => {
            const d = intercept + slope * (x - 158) - y;
            return d > thickness / 2 + 4 && d < 65;
          }).slice(0, 6);
          farSide = true;
        }
        if (near.length < 4 || near[0][0] - near.at(-1)[0] < 15) continue;
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
        if (x - left.at(-1).x > 140 || right[0].x - x > 140) continue;
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
    const intersection = detectIntersection(clean, centers, stems);
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
    return { branches: findBranches(clean), bottomCrossbar: bottomCrossbar(rgba), error, centers, crossing: intersection !== null, intersection,
      confidence: error === null ? 0 : observedCount / 22, observedCount, inferredCenters, recoveredBottom };
  }
```

- [ ] **Step 2: 语法检查**

Run: `cd "E:\Project\工作空间\ai\zheng\competition-platform\projects\blockly-page3" && node --check lane-follow.js`
Expected: 无输出（通过）。注意 `BlocklyLaneFollow.start` 仍是 Task 1 的占位实现，本任务不涉及，不会报语法错。

- [ ] **Step 3: Commit**

```bash
git add projects/blockly-page3/lane-follow.js
git commit -m "feat(blockly): 移植 lane-lab 检测与 PD 纯函数到 lane-follow"
```

---

## Task 3: 移植 follow 状态机、MJPEG 解析、板载控制与画布渲染

**Files:**
- Modify: `projects/blockly-page3/lane-follow.js`

- [ ] **Step 1: 在 Task 2 代码之后、`global.BlocklyLaneFollow` 赋值之前，插入运行时代码**

```js
  // ===== 移植自 lane-lab/src/action_policy.mjs 的 ExitEvidence（follow 用） =====
  class ExitEvidence {
    constructor() { this.flags = []; this.first = null; this.maximum = 0; this.near = 0; this.bottomCount = 0; this.missing = 0; this.confirmed = false; this.bottom = false; }
    update(r) {
      const crossing = !!r.crossing, y = r.intersection?.y ?? 0, bottom = r.bottomCrossbar ?? false;
      this.flags.push(crossing); if (this.flags.length > 5) this.flags.shift();
      if (crossing) { this.first ??= y; this.maximum = Math.max(this.maximum, y); }
      this.confirmed ||= this.flags.filter(Boolean).length >= 3;
      if (!this.confirmed) return false;
      if (crossing && y < 50 && this.maximum >= 65) { this.near = this.bottomCount = 0; this.bottom = false; }
      else if (crossing && y >= 65) this.near++;
      if (bottom && this.near >= 2 && this.maximum - this.first >= 15) { if (++this.bottomCount >= 2) this.bottom = true; }
      else if (!this.bottom) this.bottomCount = 0;
      this.missing = this.bottom && !crossing && !bottom ? this.missing + 1 : 0;
      return this.missing >= 3;
    }
  }

  // follow 专用状态机（对齐 lane-lab ActionPolicy 的 follow 分支，去掉 move/rotate/pass）
  class FollowPolicy {
    constructor({ base, kp, kd, timeoutMs }) {
      this.base = base; this.kp = kp; this.kd = kd; this.timeoutMs = timeoutMs;
      this.exit = new ExitEvidence();
      this.previous = null; this.phase = "approach"; this.started = performance.now();
      this.hits = 0; this.missing = null;
    }
    motionFinished() { if (this.phase === "centering") this.phase = "done"; }
    step(r, now) {
      if (this.phase === "done") return { done: true };
      if (now - this.started > this.timeoutMs) throw new Error("沿线循迹超时");
      const b = r.branches ?? {};
      const ordinary = r.error;
      if (this.exit.update(r)) {
        this.phase = "centering";
        return { motion: ["up", "distance", 120, 22] };
      }
      const l = b.left?.points ?? [], rr = b.right?.points ?? [];
      const diverged = l.length >= 9 && rr.length >= 9 && l.some((p, i) => rr[i] && Math.abs(p[1] - rr[i][1]) > 35);
      const near = (b.fork && b.y >= 55) || (r.crossing && r.intersection?.y >= 55 && diverged);
      this.hits = near ? this.hits + 1 : 0;
      if (this.hits >= 3) { this.phase = "done"; return { done: true }; }
      if (!Number.isFinite(ordinary) || Math.abs(ordinary) > 260) {
        this.missing ??= now; this.previous = null;
        if (now - this.missing > 1200) throw new Error("沿线循迹丢失线路");
        return { wheels: { left: 0, right: 0 }, waiting: "track" };
      }
      this.missing = null;
      const wheels = speeds(ordinary, this.previous, 0, { base: this.base, kp: this.kp, kd: this.kd, maxCorrection: 7 });
      this.previous = ordinary;
      return { wheels };
    }
  }

  // ===== 板载 HTTP（no-cors fire-and-forget 与 JSON 读取分开） =====
  async function fireAndForget(url) {
    try { await fetch(url, { mode: "no-cors", cache: "no-store" }); } catch {}
  }
  async function laneRequest(baseUrl, path, data, timeoutMs = 1500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/api/lane/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data), signal: controller.signal
      });
      let result = null;
      try { result = await response.json(); } catch {}
      if (!response.ok) throw new Error(result?.error || `lane/${path}: HTTP ${response.status}`);
      return result;
    } finally { clearTimeout(timer); }
  }
  async function laneStart(baseUrl) {
    const r = await laneRequest(baseUrl, "start", {});
    if (typeof r?.token !== "string" || !r.token) throw new Error("无法获取循迹控制权");
    return r.token;
  }
  async function laneCommand(baseUrl, token, sequence, left, right) {
    const r = await laneRequest(baseUrl, "command", { token, sequence, left, right });
    if (r.accepted !== sequence) throw new Error("轮速指令被拒收");
  }
  async function laneStop(baseUrl, token) {
    try { await laneRequest(baseUrl, "stop", { token }, 1500); } catch {}
  }
  async function zeroWheels(baseUrl) {
    await fireAndForget(`${baseUrl}/api/motor/direct?left=0&right=0`);
  }

  // ===== 摄像头 =====
  async function openCamera(baseUrl) {
    await fireAndForget(`${baseUrl}/api/camera/open`);
  }

  // ===== MJPEG 帧解析（对齐 lane-lab worker.mjs 的 stream()） =====
  async function* mjpegFrames(baseUrl, signal) {
    const response = await fetch(`${baseUrl}/api/camera/stream`, { signal, cache: "no-store" });
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

  // ===== 循迹画布渲染 =====
  function renderFrame(canvas, bitmap, result, wheels) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = FRAME_W; canvas.height = FRAME_H;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    letterboxDraw(ctx, bitmap);
    const centers = result.centers || [];
    if (centers.length) {
      ctx.strokeStyle = "#ffdf00"; ctx.lineWidth = 2;
      ctx.beginPath();
      centers.forEach(([y, x], i) => { const px = x, py = 126 + y; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      ctx.stroke();
    }
    const b = result.branches || {};
    for (const [color, side] of [["#4ade80", "left"], ["#f87171", "right"]]) {
      const pts = b[side]?.points || [];
      if (!pts.length) continue;
      ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.beginPath();
      pts.forEach(([y, x], i) => { const px = x, py = 126 + y; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      ctx.stroke();
    }
    if (result.crossing && result.intersection) {
      const ix = result.intersection.x, iy = 126 + result.intersection.y;
      ctx.strokeStyle = "#ff2d55"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ix, iy, 6, 0, Math.PI * 2); ctx.stroke();
    }
    const err = result.error;
    const text = `偏差 ${err === null ? "无" : Math.round(err)} · 左 ${wheels.left} 右 ${wheels.right}`;
    ctx.fillStyle = "#0f172a"; ctx.fillRect(0, 0, FRAME_W, 18);
    ctx.fillStyle = "#e2e8f0"; ctx.font = "12px monospace"; ctx.fillText(text, 4, 13);
  }

  // ===== 公开接口 =====
  function start(options = {}) {
    const baseUrl = String(options.baseUrl || "");
    const canvas = options.canvas || null;
    const speed = Number(options.speed); if (!Number.isFinite(speed)) throw new Error("循迹速度无效");
    const timeoutMs = Number(options.timeoutMs); if (!Number.isFinite(timeoutMs)) throw new Error("循迹超时无效");
    const kp = Number(options.kp); if (!Number.isFinite(kp)) throw new Error("kp 无效");
    const kd = Number(options.kd); if (!Number.isFinite(kd)) throw new Error("kd 无效");
    const signal = options.signal || null;
    const onState = options.onState || (() => {});
    const onResult = options.onResult || (() => {});
    let controller = new AbortController();
    let token = null;
    let sequence = 0;
    let active = true;

    function emit(state, reason) { try { onState({ state, reason }); } catch {} }

    async function run() {
      if (signal?.aborted) throw new Error("已停止");
      emit("running");
      try {
        await openCamera(baseUrl);
        const policy = new FollowPolicy({ base: speed, kp, kd, timeoutMs });
        const frames = mjpegFrames(baseUrl, controller.signal);
        token = await laneStart(baseUrl);
        const offscreen = new OffscreenCanvas(FRAME_W, FRAME_H);
        const offCtx = offscreen.getContext("2d", { willReadFrequently: true });
        let reachedJunction = false;
        for await (const jpeg of frames) {
          if (!active || signal?.aborted) throw new Error("已停止");
          const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
          try {
            letterboxDraw(offCtx, bitmap);
            const pixels = offCtx.getImageData(0, 0, FRAME_W, FRAME_H);
            const result = detect(pixels.data);
            const wheels = speeds(result.error, null, 0, { base: speed, kp, kd, maxCorrection: 7 });
            try { onResult(result); } catch {}
            renderFrame(canvas, bitmap, result, wheels);
            const out = policy.step(result, performance.now());
            if (out.done) { reachedJunction = true; await laneCommand(baseUrl, token, ++sequence, 0, 0); break; }
            if (out.motion) {
              const [direction, unit, target, spd] = out.motion;
              await fireAndForget(`${baseUrl}/api/control?action=${direction}&speed=${spd}&${unit}=${target}`);
              await new Promise(r => setTimeout(r, 1600));
              policy.motionFinished();
            } else {
              await laneCommand(baseUrl, token, ++sequence, out.wheels.left, out.wheels.right);
            }
          } finally {
            bitmap.close();
          }
        }
        return { reachedJunction, reason: reachedJunction ? "arrived_at_junction" : "未到达路口" };
      } finally {
        await laneStop(baseUrl, token);
        await zeroWheels(baseUrl);
        emit("stopped");
      }
    }

    async function stop() {
      active = false;
      controller.abort();
      await laneStop(baseUrl, token);
      await zeroWheels(baseUrl);
    }

    return { run, stop };
  }

  global.BlocklyLaneFollow = { start };
```

- [ ] **Step 2: 语法检查**

Run: `cd "E:\Project\工作空间\ai\zheng\competition-platform\projects\blockly-page3" && node --check lane-follow.js`
Expected: 无输出（通过）。

- [ ] **Step 3: Commit**

```bash
git add projects/blockly-page3/lane-follow.js
git commit -m "feat(blockly): 实现 lane-follow 运行时与公开接口"
```

---

## Task 4: 新增积木定义与生成器

**Files:**
- Modify: `projects/blockly-page3/app.js:1359-1464`（积木定义区，紧跟 `robot_turn_right_90` 之后）
- Modify: `projects/blockly-page3/app.js:1790-1797`（生成器区）
- Modify: `projects/blockly-page3/index.html:195-216`（toolbox）

- [ ] **Step 1: 积木定义**

在 `projects/blockly-page3/app.js` 的 `Blockly.Blocks.robot_turn_right_90 = { ... };`（约 1434-1442 行）之后插入：

```js
  Blockly.Blocks.robot_follow_line = {
    init() {
      this.appendDummyInput().appendField("沿线循迹");
      this.appendValueInput("SPEED").setCheck("Number").appendField("速度");
      this.appendValueInput("TIMEOUT_S").setCheck("Number").appendField("超时(秒)");
      this.appendValueInput("KP").setCheck("Number").appendField("比例增益 kp");
      this.appendValueInput("KD").setCheck("Number").appendField("微分增益 kd");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#1177cc");
      this.setTooltip("让小车沿黄色主线行驶，识别到下一个路口（横线）时自动停车");
    }
  };
```

- [ ] **Step 2: 生成器**

在 `projects/blockly-page3/app.js` 的 `Blockly.JavaScript.robot_turn_right_90 = () => ...;`（约 1792 行）之后插入：

```js
  Blockly.JavaScript.robot_follow_line = block => {
    const speed = Blockly.JavaScript.valueToCode(block, "SPEED", Blockly.JavaScript.ORDER_NONE) || "8";
    const timeoutS = Blockly.JavaScript.valueToCode(block, "TIMEOUT_S", Blockly.JavaScript.ORDER_NONE) || "30";
    const kp = Blockly.JavaScript.valueToCode(block, "KP", Blockly.JavaScript.ORDER_NONE) || "0.045";
    const kd = Blockly.JavaScript.valueToCode(block, "KD", Blockly.JavaScript.ORDER_NONE) || "0.03";
    return `await robot.followLine(${speed}, ${timeoutS}, ${kp}, ${kd});\n`;
  };
```

- [ ] **Step 3: toolbox 加入积木**

在 `projects/blockly-page3/index.html` 小车移动分类的 `<block type="robot_turn_right_angle">...</block>`（约 213-215 行）之后、`</category>` 之前插入：

```xml
      <block type="robot_follow_line">
        <value name="SPEED"><shadow type="math_number"><field name="NUM">8</field></shadow></value>
        <value name="TIMEOUT_S"><shadow type="math_number"><field name="NUM">30</field></shadow></value>
        <value name="KP"><shadow type="math_number"><field name="NUM">0.045</field></shadow></value>
        <value name="KD"><shadow type="math_number"><field name="NUM">0.03</field></shadow></value>
      </block>
```

- [ ] **Step 4: 语法检查**

Run: `cd "E:\Project\工作空间\ai\zheng\competition-platform\projects\blockly-page3" && node --check app.js`
Expected: 无输出（通过）。

- [ ] **Step 5: Commit**

```bash
git add projects/blockly-page3/app.js projects/blockly-page3/index.html
git commit -m "feat(blockly): 新增沿线循迹积木定义与生成器"
```

---

## Task 5: 接入 Robot API 与 followLineToJunction

**Files:**
- Modify: `projects/blockly-page3/app.js:701-704`（DOM 引用）
- Modify: `projects/blockly-page3/app.js:6705-6820`（makeSimRobotApi）
- Modify: `projects/blockly-page3/app.js:7386-7462`（makeRealRobotApi）
- Modify: `projects/blockly-page3/app.js:7237` 附近（新增 followLineToJunction + 参数规范化 + 画布显隐）

- [ ] **Step 1: DOM 引用**

在 `projects/blockly-page3/app.js` 第 704 行 `const retryCameraButton = ...` 之后加：

```js
const laneFollowCanvas = document.querySelector("#laneFollowCanvas");
```

- [ ] **Step 2: 参数规范化与画布显隐辅助函数**

在 `projects/blockly-page3/app.js` 的 `realWait` 函数（约 7233-7235 行）之后插入：

```js
function normalizeFollowLineParams(speedValue, timeoutValue, kpValue, kdValue) {
  const speed = Number(speedValue);
  const timeoutS = Number(timeoutValue);
  const kp = Number(kpValue);
  const kd = Number(kdValue);
  return {
    speed: Number.isFinite(speed) ? Math.max(0, Math.min(50, speed)) : 8,
    timeoutS: Number.isFinite(timeoutS) ? Math.max(1, Math.min(120, timeoutS)) : 30,
    kp: Number.isFinite(kp) ? Math.max(0, Math.min(1, kp)) : 0.045,
    kd: Number.isFinite(kd) ? Math.max(0, Math.min(1, kd)) : 0.03
  };
}

function showLaneFollowCanvas() {
  if (!laneFollowCanvas) return;
  if (cameraStream) cameraStream.style.display = "none";
  laneFollowCanvas.hidden = false;
}

function hideLaneFollowCanvas() {
  if (!laneFollowCanvas) return;
  laneFollowCanvas.hidden = true;
  if (cameraStream) cameraStream.style.display = "";
}

async function followLineToJunction(context, speedValue, timeoutValue, kpValue, kdValue) {
  await waitForRunCheckpoint(context);
  const params = normalizeFollowLineParams(speedValue, timeoutValue, kpValue, kdValue);
  actionCount++;
  addLog(`真实小车：沿线循迹（速度 ${params.speed}，超时 ${params.timeoutS} 秒，kp ${params.kp}，kd ${params.kd}）。`);
  const baseUrl = context.robotBaseUrl || getValidatedRobotBaseUrl();
  showLaneFollowCanvas();
  const lane = BlocklyLaneFollow.start({
    baseUrl,
    canvas: laneFollowCanvas,
    speed: params.speed,
    timeoutMs: params.timeoutS * 1000,
    kp: params.kp,
    kd: params.kd,
    signal: context.signal,
    onState: state => {
      if (state?.state === "running") setStatus("沿线循迹中…");
    }
  });
  try {
    const result = await lane.run();
    if (result.reachedJunction) {
      setStatus("沿线循迹已到路口");
      addLog("沿线循迹：已到达路口并停车。");
    } else {
      addLog(`沿线循迹结束：${result.reason || "未到达路口"}。`);
    }
    return result;
  } finally {
    await lane.stop();
    hideLaneFollowCanvas();
  }
}
```

- [ ] **Step 3: makeSimRobotApi 加 followLine**

在 `projects/blockly-page3/app.js` 的 `makeSimRobotApi` 里，`turnAngle: ...` 之后（约 6712 行）加：

```js
    followLine: () => {
      throw new Error("沿线循迹只在真实小车模式可用，请切换到真实小车");
    },
```

- [ ] **Step 4: makeRealRobotApi 加 followLine**

在 `projects/blockly-page3/app.js` 的 `makeRealRobotApi` 里，`approach: ...` 之后（约 7417 行）加：

```js
    followLine: (speed, timeoutS, kp, kd) => followLineToJunction(context, speed, timeoutS, kp, kd),
```

- [ ] **Step 5: 语法检查**

Run: `cd "E:\Project\工作空间\ai\zheng\competition-platform\projects\blockly-page3" && node --check app.js`
Expected: 无输出（通过）。

- [ ] **Step 6: Commit**

```bash
git add projects/blockly-page3/app.js
git commit -m "feat(blockly): 接入 followLine Robot API 与循迹执行流程"
```

---

## Task 6: 循迹画布元素与样式

**Files:**
- Modify: `projects/blockly-page3/index.html:172-179`
- Modify: `projects/blockly-page3/styles.css`

- [ ] **Step 1: 加 canvas 元素**

在 `projects/blockly-page3/index.html` 第 179 行 `</div>`（camera-view 结束）之后、第 180 行 `<div id="runtimeFeedback">` 之前插入：

```html
            <canvas id="laneFollowCanvas" class="lane-follow-canvas" width="320" height="240" hidden></canvas>
```

- [ ] **Step 2: 加 CSS**

在 `projects/blockly-page3/styles.css` 末尾追加：

```css
.lane-follow-canvas {
  width: 100%;
  max-width: 320px;
  aspect-ratio: 4 / 3;
  border-radius: 8px;
  background: #0f172a;
  display: block;
}
.lane-follow-canvas[hidden] { display: none; }
```

- [ ] **Step 3: 人工验证（可选，需实车）**

Run: 启动平台后切换到真实小车模式，放置「沿线循迹」积木并运行，确认画布显示识别叠加。
Expected: 画布出现、执行结束后恢复原预览。

- [ ] **Step 4: Commit**

```bash
git add projects/blockly-page3/index.html projects/blockly-page3/styles.css
git commit -m "feat(blockly): 新增循迹画布元素与样式"
```

---

## Task 7: 测试与文档

**Files:**
- Modify: `projects/blockly-page3/tests/block-catalog.test.js`
- Modify: `projects/blockly-page3/指导书.md`

- [ ] **Step 1: 扩展 block-catalog.test.js**

在 `projects/blockly-page3/tests/block-catalog.test.js` 顶部，`const toolbox = ...` 之后加一行读取 lane-follow.js：

```js
const laneFollow = fs.readFileSync(path.join(root, "lane-follow.js"), "utf8");
```

在文件末尾（最后一个 `test(...)` 之后）新增一个测试：

```js
test("the lane-follow block and module are wired for real-car line following", () => {
  assert.match(app, /Blockly\.Blocks\.robot_follow_line\s*=\s*\{/);
  assert.match(app, /Blockly\.JavaScript\.robot_follow_line[\s\S]*?await robot\.followLine\(/);
  assert.match(app, /followLine:\s*\(speed, timeoutS, kp, kd\)\s*=>\s*followLineToJunction\(context, speed, timeoutS, kp, kd\)/);
  assert.match(app, /async function followLineToJunction\(/);
  assert.match(app, /followLine:\s*\(\)\s*=>\s*\{\s*throw new Error\("沿线循迹只在真实小车模式可用/);
  assert.match(toolbox, /<block type="robot_follow_line">/);

  assert.match(laneFollow, /function detect\(rgba\)/);
  assert.match(laneFollow, /function speeds\(error, previous, dt, params/);
  assert.match(laneFollow, /function findBranches\(mask\)/);
  assert.match(laneFollow, /function detectIntersection\(mask, observedCenters/);
  assert.match(laneFollow, /function bottomCrossbar\(rgba\)/);
  assert.match(laneFollow, /class CrossingStop/);
  assert.match(laneFollow, /global\.BlocklyLaneFollow\s*=\s*\{ start \}/);
  assert.match(laneFollow, /\$\{baseUrl\}\/api\/lane\/start/);
  assert.match(laneFollow, /\$\{baseUrl\}\/api\/lane\/command/);
  assert.match(laneFollow, /\$\{baseUrl\}\/api\/lane\/stop/);
  assert.match(laneFollow, /\$\{baseUrl\}\/api\/motor\/direct/);
  assert.match(laneFollow, /\$\{baseUrl\}\/api\/camera\/stream/);

  assert.match(guide, /沿线循迹/);
});
```

- [ ] **Step 2: 更新指导书**

在 `projects/blockly-page3/指导书.md` 第 33 行「小车移动」一行之后补充说明（保持列表行内格式）：

```markdown
- 小车移动：按厘米前进/后退、左转/右转 90°、按指定整数角度左转/右转、沿线循迹（沿黄色主线行驶到下一个路口自动停车，参数：速度、超时、kp、kd，仅真实小车模式可用）。
```

（即把第 33 行末尾的句号前追加 `、沿线循迹…`，或新增一行说明。以最小改动为准。）

- [ ] **Step 3: 运行测试**

Run: `cd "E:\Project\工作空间\ai\zheng\competition-platform\projects\blockly-page3" && node --test tests/block-catalog.test.js`
Expected: 全部通过（新增测试通过，既有测试不回归）。

- [ ] **Step 4: 全量语法检查**

Run: `cd "E:\Project\工作空间\ai\zheng\competition-platform\projects\blockly-page3" && node --check lane-follow.js && node --check app.js`
Expected: 无输出（通过）。

- [ ] **Step 5: Commit**

```bash
git add projects/blockly-page3/tests/block-catalog.test.js projects/blockly-page3/指导书.md
git commit -m "test(blockly): 覆盖沿线循迹积木与模块断言并更新指导书"
```

---

## 自检记录

- **Spec 覆盖**：积木/生成器（Task 4）→ Robot API 与执行流程（Task 5）→ lane-follow 模块（Task 2/3）→ 循迹画布与摄像头切换（Task 6）→ 服务端与静态资源（Task 1）→ 错误处理与停止（Task 3 的 FollowPolicy 超时/丢线、stop()）→ 测试与文档（Task 7）。全部 spec 章节有对应任务。
- **类型一致性**：`start({ baseUrl, canvas, speed, timeoutMs, kp, kd, signal, onState, onResult })` → `{ run, stop }` 在 Task 3 定义，Task 5 调用时字段名一致。积木字段 `SPEED/TIMEOUT_S/KP/KD` 与生成器 `valueToCode(block, "SPEED"/...)` 一致。
- **占位扫描**：无 TBD/TODO；所有代码步骤均含完整代码。
