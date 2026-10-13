/* Platform adapter for the versioned chenlong-cq browser SDK. */
(function (global) {
  "use strict";

  const CHENLONG_OFFLINE = global.__CHENLONG_OFFLINE__ === true;

  const scriptUrl = global.document?.currentScript?.src || global.document?.baseURI || global.location?.href;
  const sdkUrl = new URL("./lane/src/junction_follower.mjs", scriptUrl);
  const laneSrcDir = new URL("./lane/src/", scriptUrl).href;
  const SDK_MODULE_NAMES = [
    "branch.mjs", "camera_geometry.mjs", "crossing_stop.mjs", "follow_config.mjs",
    "intersection.mjs", "junction_follower.mjs", "junction_policy.mjs", "lane.mjs",
    "runtime_config.mjs", "worker.mjs"
  ];
  // worker.mjs 及其依赖闭包，按依赖顺序（被依赖者在前）。HTTP 明文页面无法注册
  // Service Worker，只有 HTTPS 的 SW 缓存或 HTTP 强缓存兜底，二者对 module worker
  // 的动态加载都不够可靠。这里在预热阶段把这些模块合并成自包含的 classic worker
  // 脚本，用 Blob URL 加载，彻底摆脱「执行巡线时断网拉取 worker.mjs」的失败。
  const WORKER_MODULE_NAMES = [
    "follow_config.mjs", "branch.mjs", "intersection.mjs", "crossing_stop.mjs",
    "lane.mjs", "worker.mjs"
  ];
  let workerBlobUrl = null;
  let sdkPromise = null;
  let activeRun = null;

  function loadSdk() {
    if (CHENLONG_OFFLINE) return Promise.resolve(global.__chenlongLaneSdk);
    if (!sdkPromise) sdkPromise = import(sdkUrl.href).catch(error => {
      sdkPromise = null;
      throw error;
    });
    return sdkPromise;
  }

  // 合并 worker.mjs 的依赖闭包，生成自包含的 classic worker 脚本。ES module 的
  // import/export 被剥离（依赖已按顺序内联），new Worker(blobUrl) 不再需要网络。
  async function buildWorkerBlobUrl() {
    if (CHENLONG_OFFLINE) {
      workerBlobUrl = URL.createObjectURL(new Blob([global.__chenlongLaneWorkerSrc], { type: "text/javascript" }));
      return;
    }
    const parts = [];
    for (const name of WORKER_MODULE_NAMES) {
      const response = await fetch(laneSrcDir + name, { cache: "reload" });
      if (!response.ok) throw new Error(`加载巡线 worker 模块失败：${name}（HTTP ${response.status}）`);
      let code = await response.text();
      code = code.replace(/^import\b[^\n]*$/gm, "").replace(/^(\s*)export\s+/gm, "$1");
      parts.push(`/* ==== ${name} ==== */\n${code}`);
    }
    workerBlobUrl = URL.createObjectURL(new Blob(parts, { type: "text/javascript" }));
  }

  // 页面打开时即预热全部巡线模块：逐条 fetch（顺带写入 Service Worker 缓存，断网后
  // 由 SW 兜底）+ 动态 import 主线程入口（把模块图加载进内存）。onProgress(done, total, name)
  // 用于驱动加载进度条。任一条失败不阻断整体，仅记日志。
  function preload(onProgress) {
    if (CHENLONG_OFFLINE) {
      return Promise.resolve().then(() => buildWorkerBlobUrl()).then(() => loadSdk()).then(() => {});
    }
    const total = SDK_MODULE_NAMES.length;
    let loaded = 0;
    const report = () => {
      loaded += 1;
      try { onProgress?.(loaded, total, SDK_MODULE_NAMES[loaded - 1]); } catch (error) { console.error(error); }
    };
    const warm = Promise.all(SDK_MODULE_NAMES.map(name =>
      fetch(laneSrcDir + name).then(report, report)
    ));
    return warm
      .then(() => buildWorkerBlobUrl().catch(error => { console.warn("巡线 worker 预合并失败：", error); }))
      .then(() => loadSdk())
      .then(() => {});
  }

  function notify(callback, value) {
    try { callback?.(value); } catch (error) { console.error(error); }
  }

  function cancelledError(reason = "已停止") {
    const error = new Error(reason);
    error.name = "AbortError";
    return error;
  }

  function drawNavRibbon(context, centers) {
    if (centers.length < 2) return;
    // Detection coordinates are evidence. Averaging x/y shortened both ends
    // and displaced the ribbon on bends, including at the track ends.
    const points = centers.map(([y, x]) => [x + 1, y + 126]);
    const topY = points.at(-1)[1];
    const span = Math.max(1, points[0][1] - topY);
    const left = [], right = [];
    points.forEach(([x, y], index) => {
      const halfWidth = 1.5 + 9.5 * (y - topY) / span;
      const previous = points[Math.max(0, index - 1)];
      const next = points[Math.min(points.length - 1, index + 1)];
      const dx = next[0] - previous[0], dy = next[1] - previous[1];
      const length = Math.hypot(dx, dy) || 1;
      left.push([x - dy / length * halfWidth, y + dx / length * halfWidth]);
      right.push([x + dy / length * halfWidth, y - dx / length * halfWidth]);
    });
    function edge(path) {
      for (let index = 1; index < path.length; index++) context.lineTo(...path[index]);
    }
    const gradient = context.createLinearGradient(0, topY, 0, points[0][1]);
    gradient.addColorStop(0, "rgba(56, 189, 248, 0.25)");
    gradient.addColorStop(0.5, "rgba(59, 130, 246, 0.55)");
    gradient.addColorStop(1, "rgba(37, 99, 235, 0.7)");
    context.fillStyle = gradient;
    context.beginPath();
    context.moveTo(...left[0]);
    edge(left);
    right.reverse();
    context.lineTo(...right[0]);
    edge(right);
    context.closePath();
    context.fill();
    // Mark the measured centre explicitly; round caps keep the first and last
    // sampled pixels visible even when a tilted ribbon ends between pixels.
    context.strokeStyle = "rgba(56, 189, 248, 0.85)";
    context.lineWidth = 2;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(...points[0]);
    edge(points);
    context.stroke();
  }

  function renderFrame(canvas, result) {
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (canvas.width !== 320) canvas.width = 320;
    if (canvas.height !== 240) canvas.height = 240;
    if (result.pixels?.byteLength === 320 * 240 * 4) {
      context.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), 320, 240), 0, 0);
    }
    renderOverlay(context, result);
  }

  function renderOverlay(context, result) {
    if (Number.isFinite(result.error)) drawNavRibbon(context, result.centers || []);
    const junction = result.intersection;
    if (junction) {
      context.strokeStyle = "#ff2d55";
      context.lineWidth = 2;
      if ([junction.left, junction.right, junction.slope].every(Number.isFinite)) {
        context.beginPath();
        context.moveTo(junction.left + 1, 126 + junction.y + junction.slope * (junction.left - junction.x));
        context.lineTo(junction.right + 1, 126 + junction.y + junction.slope * (junction.right - junction.x));
        context.stroke();
      }
      context.strokeRect(junction.x - 3, junction.y + 122, 8, 8);
    }
  }

  // Sample the already-open camera <img> on the main thread and feed normalized
  // 320x240 RGBA frames into the detection worker. Reusing the preview stream
  // avoids a second fetch (which the browser blocks as mixed content on HTTPS).
  function startFrameSampler(cameraElement, sdk, onFrame, onError) {
    if (!cameraElement || !sdk?.supportedCameraSize) return { stop() {} };
    const { supportedCameraSize, DETECTION_WIDTH, DETECTION_HEIGHT } = sdk;
    const canvas = document.createElement("canvas");
    canvas.width = DETECTION_WIDTH;
    canvas.height = DETECTION_HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    let stopped = false;
    let reported = false;
    function sample() {
      if (stopped) return;
      const naturalWidth = cameraElement.naturalWidth;
      const naturalHeight = cameraElement.naturalHeight;
      if (!naturalWidth || !naturalHeight) return;
      try {
        if (supportedCameraSize(naturalWidth, naturalHeight)) {
          context.drawImage(cameraElement, 0, 0, DETECTION_WIDTH, DETECTION_HEIGHT);
        } else {
          const scale = Math.min(DETECTION_WIDTH / naturalWidth, DETECTION_HEIGHT / naturalHeight);
          context.fillStyle = "#000";
          context.fillRect(0, 0, DETECTION_WIDTH, DETECTION_HEIGHT);
          const w = Math.round(naturalWidth * scale);
          const h = Math.round(naturalHeight * scale);
          context.drawImage(cameraElement, Math.floor((DETECTION_WIDTH - w) / 2), Math.floor((DETECTION_HEIGHT - h) / 2), w, h);
        }
        const imageData = context.getImageData(0, 0, DETECTION_WIDTH, DETECTION_HEIGHT);
        onFrame(imageData.data.buffer, naturalWidth, naturalHeight);
      } catch (error) {
        // Tainted canvas (missing CORS on the camera stream) or an undecoded
        // frame. Report once so the black screen is attributable, then let the
        // follower's freshness timeout surface the persistent failure.
        if (!reported) {
          reported = true;
          console.warn("循迹摄像头画面采样失败：", error);
          onError?.(error);
        }
      }
    }
    const timer = setInterval(sample, 1000 / 15);
    return { stop() { stopped = true; clearInterval(timer); } };
  }

  function start(options = {}) {
    const params = {};
    for (const [name, fallback, min, max] of [["base", 24, 0, 100], ["kp", 0.05, 0, 10], ["maxCorrection", 2, 0, 100]]) {
      const value = options[name] === undefined ? fallback : Number(options[name]);
      if (!Number.isFinite(value) || value < min || value > max) throw new Error(`循迹参数 ${name} 必须在 ${min}～${max} 之间`);
      params[name] = value;
    }
    const signal = options.signal;
    let follower = null, setup = null, runPromise = null, stopPromise = null;
    let cancelled = false, finished = false, settled = false;
    let latest = null, wheels = { left: 0, right: 0 };
    let resolveCompletion, rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // A terminal callback can arrive while start() is still pending.
    completion.catch(() => {});

    function settle(error, value) {
      if (settled) return;
      settled = true;
      if (error) rejectCompletion(error);
      else resolveCompletion(value);
    }

    function frame() {
      if (latest) notify(options.onFrame, { result: latest, wheels: { ...wheels } });
    }

    function stateChanged(state) {
      if (Object.hasOwn(state, "wheels")) {
        wheels = state.wheels ? { ...state.wheels } : { left: null, right: null };
        frame();
      }
      if (state.stop_confirmed === true) { wheels = { left: 0, right: 0 }; frame(); }
      if (settled) return;
      notify(options.onState, { ...state, state: state.status === "completed" || state.status === "cancelled" ? "stopped" : state.status });
      if (state.status === "completed" && state.stop_confirmed === true) {
        const lineEnd = state.completion_reason === "line_end";
        settle(null, { reachedJunction: !lineEnd, reachedLineEnd: lineEnd,
          reason: lineEnd ? "line_end" : "arrived_at_junction", stopConfirmed: true, state });
      } else if (state.status === "failed" || state.stop_confirmed === false) {
        settle(new Error(state.reason || "循迹失败，未能确认停车"));
      } else if (state.status === "cancelled") {
        settle(cancelledError(state.reason));
      }
    }

    async function run() {
      if (runPromise) return runPromise;
      runPromise = (async () => {
        if (cancelled || signal?.aborted) throw cancelledError();
        if (activeRun && activeRun.control !== control) {
          if (!activeRun.finished()) throw new Error("已有循迹任务正在运行");
          await activeRun.control.stop();
        }
        if (cancelled || signal?.aborted) throw cancelledError();
        // Two callers can both await the same previous stop. Only one may claim the next run.
        if (activeRun && activeRun.control !== control) throw new Error("已有循迹任务正在运行");
        activeRun = { control, finished: () => finished };
        let sdk = null;
        setup = (async () => {
          sdk = await loadSdk();
          const { createJunctionFollower } = sdk;
          if (cancelled || signal?.aborted) throw cancelledError();
          follower = createJunctionFollower({
            motorBaseUrl: options.baseUrl,
            workerUrl: workerBlobUrl,
            params,
            onState: stateChanged,
            onResult(result) {
              latest = result;
              renderFrame(options.canvas, result);
              notify(options.onResult, result);
              frame();
            }
          });
          return follower.start();
        })();
        let sampling = null;
        try {
          await setup;
          if (cancelled || signal?.aborted) {
            await follower?.stop();
            throw cancelledError();
          }
          sampling = startFrameSampler(options.cameraElement, sdk, (rgba, width, height) => {
            follower?.pushFrame(rgba, width, height);
          }, options.onSamplerError);
          return await completion;
        } finally {
          sampling?.stop();
          finished = true;
        }
      })();
      return runPromise;
    }

    function stop() {
      cancelled = true;
      if (stopPromise) return stopPromise;
      // Invalidate pending startup immediately; the SDK drains late I/O before zero.
      const earlyStop = follower ? follower.stop() : null;
      stopPromise = (async () => {
        const earlyState = await earlyStop;
        await setup?.catch(() => {});
        const state = follower ? earlyState || await follower.stop() : null;
        if (state?.stop_confirmed === false) throw new Error(state.reason || "未能确认小车停车");
        await follower?.destroy();
        if (follower?.status().stop_confirmed === false) throw new Error("未能确认小车停车");
        if (activeRun?.control === control) activeRun = null;
        return state;
      })().catch(error => {
        stopPromise = null;
        throw error;
      }).finally(() => {
        signal?.removeEventListener("abort", abort);
      });
      return stopPromise;
    }

    function abort() {
      cancelled = true;
      void stop().catch(error => settle(error));
    }
    const control = { run, stop };
    signal?.addEventListener("abort", abort, { once: true });
    return control;
  }

  global.BlocklyLaneFollow = { start, renderOverlay, preload };

  // 打开页面即预热巡线 SDK，避免连接小车断网后首次执行巡线才联网拉取而失败。
  // 有进度条则同步更新；10 秒兜底隐藏，防止任何异常导致遮罩卡住。
  if (global.document) {
    const overlay = global.document.getElementById("blocklyResourceLoader");
    const fill = global.document.getElementById("blocklyResourceLoaderFill");
    const status = global.document.getElementById("blocklyResourceLoaderStatus");
    const finish = () => overlay?.classList.add("is-hidden");
    const safety = setTimeout(finish, 10000);
    preload((done, total, name) => {
      if (fill) fill.style.width = Math.round((done / total) * 100) + "%";
      if (status) status.textContent = `加载 ${name}（${done}/${total}）`;
    }).then(() => { clearTimeout(safety); finish(); })
      .catch(() => { clearTimeout(safety); finish(); });
  }
})(window);
