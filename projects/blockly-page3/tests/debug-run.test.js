"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const clock = require(path.join(root, "simulation-clock.js"));

function simulatedTrace(totalMs, options) {
  const logicalSteps = [];
  const roadSamples = [];
  let elapsed = 0;
  let position = 0;
  let realDelay = 0;
  while (elapsed < totalMs) {
    const dt = clock.nextLogicalStep(totalMs - elapsed);
    elapsed += dt;
    position += 1.25 * dt / 1000;
    logicalSteps.push(dt);
    roadSamples.push({ position, dt });
    realDelay += clock.realDelayMs(dt, options);
  }
  return { elapsed, position, logicalSteps, roadSamples, realDelay };
}

test("1x scored and 4x debug runs use an identical logical simulation trace", () => {
  for (const totalMs of [1, 16, 17, 260, 1000, 1234.5, 32000]) {
    const scored = simulatedTrace(totalMs, { target: "sim", runMode: "scored", playbackRate: 4 });
    const debug = simulatedTrace(totalMs, { target: "sim", runMode: "debug", playbackRate: 4 });
    assert.equal(scored.elapsed, totalMs);
    assert.equal(debug.elapsed, totalMs);
    assert.equal(scored.position, debug.position);
    assert.deepEqual(scored.logicalSteps, debug.logicalSteps);
    assert.deepEqual(scored.roadSamples, debug.roadSamples);
    assert.equal(scored.realDelay, totalMs, "计分运行必须强制 1×");
    assert.equal(debug.realDelay, totalMs / 4, "4×只能缩短真实等待");
  }
});

test("unsupported rates, scored runs, and real robots can never accelerate semantics", () => {
  assert.deepEqual(clock.DEBUG_PLAYBACK_RATES, [1, 2, 4]);
  assert.equal(clock.normalizePlaybackRate(8), 1);
  assert.equal(clock.effectivePlaybackRate({ target: "sim", runMode: "scored", playbackRate: 4 }), 1);
  assert.equal(clock.effectivePlaybackRate({ target: "real", runMode: "debug", playbackRate: 4 }), 1);
  assert.equal(clock.effectivePlaybackRate({ target: "sim", runMode: "debug", playbackRate: 4 }), 4);
});

test("the UI separates debug controls from the fixed-speed scored entry point", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

  assert.match(html, /id="debugSpeedButton"[\s\S]*?>调试 1×</);
  assert.match(html, /id="runButton"[\s\S]*?>调试运行</);
  assert.match(html, /id="stepButton"/);
  assert.match(html, /id="scoreRunButton"[\s\S]*?>计时运行</);
  assert.match(html, /simulation-clock\.js\?v=20260918-penalty-log-001[\s\S]*app\.js\?v=20260918-penalty-log-001/);
  assert.match(server, /\["\/simulation-clock\.js", "simulation-clock\.js"\]/);
  assert.match(server, /\["\/debug-run\.css", "debug-run\.css"\]/);
  assert.match(app, /context\.runMode === "scored" && primaryUser && actionCount > 0[\s\S]*archivePrimaryRun\(plainCode, context\)/);
  assert.match(app, /if \(context\?\.target !== "sim" \|\| context\.runMode !== "scored"\) return null/);
  assert.match(app, /scoreRunButton\?\.addEventListener\("click", \(\) => void runProgram\(\{ runMode: "scored", playbackRate: 1 \}\)\)/);
  assert.match(app, /activeRun\.runMode !== "debug" \|\| !requestRunPause/);
});

test("score deductions remain visible with their reason, logical time, and position", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "debug-run.css"), "utf8");

  assert.match(html, /id="primaryScorePenalties"[\s\S]*id="primaryPenaltyTotal"[\s\S]*id="primaryPenaltyList"/);
  assert.match(html, /debug-run\.css\?v=20260918-penalty-log-001/);
  assert.match(app, /function recordPrimaryCollisionPenalty\([\s\S]*primaryPenaltyEvents\.push/);
  assert.match(app, /function startPrimaryOffRoadPenalty\([\s\S]*kind: "off-road"/);
  assert.match(app, /function finishPrimaryOffRoadPenalty\([\s\S]*event\.active = false/);
  assert.match(app, /位置 X \$\{event\.x\.toFixed\(1\)\} \/ Z \$\{event\.z\.toFixed\(1\)\}/);
  assert.match(app, /本次已记录 \$\{primaryPenaltyEvents\.length\} 条扣分/);
  assert.match(app, /recordPrimaryCollisionPenalty\(clearanceInfo, \{[\s\S]*newlyFailedObstacle/);
  assert.match(app, /function samplePrimaryRoadRule\([\s\S]*startPrimaryOffRoadPenalty\(\)[\s\S]*updatePrimaryOffRoadPenalty\(sampledDurationMs\)[\s\S]*finishPrimaryOffRoadPenalty\(\)/);
  assert.match(app, /function resetRobot\([\s\S]*resetPrimaryPenaltyEvents\(\)/);
  assert.match(app, /primaryOffRoadActive = false;[\s\S]*finishPrimaryOffRoadPenalty\("run-ended"\)/);
  assert.doesNotMatch(app, /还需运送 .*个红色目标物/);
  assert.match(css, /\.primary-score-penalties ol[\s\S]*max-height:[^;]+;[\s\S]*overflow-y: auto/);
  assert.match(css, /\.primary-penalty-item\.is-active/);
});

test("run-to-block executes from the baseline and pauses before the target statement", () => {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const highlightStart = app.indexOf("async function highlightExecutionBlock(");
  const highlightEnd = app.indexOf("function updateCode(", highlightStart);
  const highlightBody = app.slice(highlightStart, highlightEnd);
  assert.match(app, /id: "chenlong_debug_run_to_block"[\s\S]*displayText: "调试运行到此处"/);
  assert.match(app, /runProgram\(\{[\s\S]*runMode: "debug",[\s\S]*playbackRate: 4,[\s\S]*runToBlockId: String\(blockId\)/);
  assert.match(app, /missionAttempt = null;[\s\S]*restoreMissionBaseline\(\);[\s\S]*resetRobot\(\);[\s\S]*createRunContext/);
  assert.match(highlightBody, /setExecutionHighlight\(blockId\)[\s\S]*context\.runToBlockId === highlightedId[\s\S]*requestRunPause\(context, "run-to-block"\)[\s\S]*await waitForRunCheckpoint\(context\)/);
});

test("simulation decisions use logical steps while wall time only controls playback", () => {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const moveStart = app.indexOf("async function moveRobot(sign");
  const moveEnd = app.indexOf("async function turnRobot(", moveStart);
  const moveBody = app.slice(moveStart, moveEnd);
  const telemetryStart = app.indexOf("function updateRobotTelemetry(");
  const telemetryEnd = app.indexOf("function initTrajectoryLine(", telemetryStart);
  const telemetryBody = app.slice(telemetryStart, telemetryEnd);
  const archiveStart = app.indexOf("async function archivePrimaryRun(");
  const archiveEnd = app.indexOf("window.getRobotLabPerformance", archiveStart);
  const archiveBody = app.slice(archiveStart, archiveEnd);

  assert.match(moveBody, /nextLogicalStep\(totalMs - elapsed\)/);
  assert.match(moveBody, /advanceSimulationTime\(context, dt\)/);
  assert.match(moveBody, /samplePrimaryRoadRule\(dt\)/);
  assert.match(moveBody, /waitForSimulationPlayback\(dt, context\)/);
  assert.doesNotMatch(moveBody, /performance\.now/);
  assert.doesNotMatch(telemetryBody, /evaluateMissionProgress/);
  assert.match(archiveBody, /durationMs: logicalDurationMs/);
  assert.doesNotMatch(archiveBody, /Date\.now|performance\.now/);
  assert.match(app, /context\.playbackDelayBudgetMs = [\s\S]*?\+ delayMs/);
  assert.match(app, /playbackDelayBudgetMs \+ PHYSICS_EPSILON < BLOCKLY_SIMULATION_CLOCK\.STEP_MS/);
  assert.match(app, /const batchedDelayMs = context\.playbackDelayBudgetMs;[\s\S]*?sleepForRun\(batchedDelayMs, context\)/);
});

test("starting either run preserves the existing draft identity and archives the start snapshot", () => {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const runStart = app.indexOf("async function runProgram(");
  const runEnd = app.indexOf("function setStatus(", runStart);
  const runBody = app.slice(runStart, runEnd);

  assert.match(app, /const BLOCKLY_WORKSPACE_STORAGE_PREFIX = "chenlongBlocklyPrimaryWorkspace\.v2"/);
  assert.match(app, /payload = \{ schema: 3, taskId, workspace: workspaceValue, savedAt: Date\.now\(\), dirty: Boolean\(dirty\), baseSha256 \}/);
  assert.match(runBody, /savedWorkspaceSnapshot = captureBlocklyWorkspace\(workspaceTaskId\)[\s\S]*await flushBlocklyWorkspace\(workspaceTaskId\)/);
  assert.match(runBody, /runWorkspaceSnapshot = normalizeBlocklyWorkspaceSnapshot[\s\S]*workspaceSnapshot: runWorkspaceSnapshot/);
  assert.match(runBody, /await refreshPublishedPrimaryMaps\(\)[\s\S]*const runtimeCode = generateBlocklyCode\(true\)[\s\S]*activeRun = context/);
  assert.match(runBody, /runStartPending = true;[\s\S]*savedWorkspaceSnapshot = captureBlocklyWorkspace/);
  assert.match(runBody, /activeRun = context;[\s\S]*releaseStartLock\(\)/);
  assert.doesNotMatch(runBody, /workspace\.clear\(|applyBlocklyWorkspace\(/);
  assert.match(app, /context\.workspaceSnapshot \|\| Blockly\.serialization\.workspaces\.save\(workspace\)/);
});
