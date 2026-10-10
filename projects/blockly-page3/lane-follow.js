/* Platform adapter for the versioned chenlong-cq browser SDK. */
(function (global) {
  "use strict";

  const scriptUrl = global.document?.currentScript?.src || global.document?.baseURI || global.location?.href;
  const sdkUrl = new URL("./lane/src/junction_follower.mjs", scriptUrl);
  let sdkPromise = null;
  let activeRun = null;

  function loadSdk() {
    if (!sdkPromise) sdkPromise = import(sdkUrl.href).catch(error => {
      sdkPromise = null;
      throw error;
    });
    return sdkPromise;
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
        setup = (async () => {
          const { createJunctionFollower } = await loadSdk();
          if (cancelled || signal?.aborted) throw cancelledError();
          follower = createJunctionFollower({
            cameraBaseUrl: options.baseUrl,
            motorBaseUrl: options.baseUrl,
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
        try {
          await setup;
          if (cancelled || signal?.aborted) {
            await follower?.stop();
            throw cancelledError();
          }
          return await completion;
        } finally {
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

  global.BlocklyLaneFollow = { start, renderOverlay };
})(window);
