"use strict";

(function installBlocklySimulationClock(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.BlocklySimulationClock = api;
})(typeof globalThis === "object" ? globalThis : window, () => {
  const STEP_MS = 16;
  const DEBUG_PLAYBACK_RATES = Object.freeze([1, 2, 4]);

  function normalizePlaybackRate(value) {
    const rate = Number(value);
    return DEBUG_PLAYBACK_RATES.includes(rate) ? rate : 1;
  }

  function effectivePlaybackRate({ target = "sim", runMode = "debug", playbackRate = 1 } = {}) {
    if (target !== "sim" || runMode !== "debug") return 1;
    return normalizePlaybackRate(playbackRate);
  }

  function nextLogicalStep(remainingMs, maximumStepMs = STEP_MS) {
    const remaining = Number(remainingMs);
    const maximum = Number(maximumStepMs);
    if (!Number.isFinite(remaining) || remaining <= 0) return 0;
    const safeMaximum = Number.isFinite(maximum) && maximum > 0 ? maximum : STEP_MS;
    return Math.min(remaining, safeMaximum);
  }

  function realDelayMs(logicalStepMs, options = {}) {
    const logical = Math.max(0, Number(logicalStepMs) || 0);
    return logical / effectivePlaybackRate(options);
  }

  return Object.freeze({
    STEP_MS,
    DEBUG_PLAYBACK_RATES,
    normalizePlaybackRate,
    effectivePlaybackRate,
    nextLogicalStep,
    realDelayMs
  });
});
