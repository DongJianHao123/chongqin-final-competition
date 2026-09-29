"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const start = app.indexOf("async function animateBlocklyRoadSegment(");
const end = app.indexOf("async function followBlocklyRoad(", start);
assert.ok(start >= 0 && end > start, "road control implementation is available");
const roadFunctions = app.slice(start, end);

async function driveAtSetting(speedSetting) {
  let clockMs = 0;
  const pose = { x: 0, z: 0, heading: -Math.PI / 2 };
  const group = { position: { set() {} }, rotation: { y: 0 } };
  const sandbox = {
    robotPose: pose,
    robotGroup: group,
    PRIMARY_DRIVE_WORLD_UNITS_PER_SECOND: 1.25,
    PHYSICS_EPSILON: 1e-7,
    MOVE_COLLISION_SKIN: 0.1,
    THREE: { MathUtils: { degToRad: degrees => degrees * Math.PI / 180 } },
    performance: { now: () => clockMs },
    primaryCmToWorldUnits: cm => cm / 12.5,
    normalizeSignedRadians: angle => angle,
    waitForRunCheckpoint: async () => false,
    sleepForRun: async ms => { clockMs += ms; },
    markSceneShadowDirty() {},
    spinDriveWheels() {},
    spinTurnWheels() {},
    syncRobot() {},
    samplePrimaryRoadRule() {},
    robotClearanceInfoAlongRay: () => ({ distance: Infinity, shape: null }),
    addTrajectoryPoint() {},
    evaluateMissionProgress() {},
    primaryBlockedMoveCount: 0,
    blockedMoveCount: 0,
    lastMoveBlocked: false,
    missionAttempt: null
  };
  vm.runInNewContext(`${roadFunctions}\nglobalThis.drive = driveBlocklyNavigationPath;`, sandbox);
  const context = { distanceWorld: 0 };
  const result = await sandbox.drive(context, [[8, 0]], speedSetting, 100);
  return { milliseconds: clockMs, centimeters: pose.x * 12.5, result, context };
}

test("both road speed settings move at the centimeter block's fixed 15.625 cm/s", async () => {
  const slowSetting = await driveAtSetting(10);
  const fastSetting = await driveAtSetting(100);
  for (const run of [slowSetting, fastSetting]) {
    assert.ok(run.centimeters > 99.8 && run.centimeters <= 100.01);
    assert.ok(run.milliseconds >= 6380 && run.milliseconds <= 6420);
    assert.ok(Math.abs(run.context.distanceWorld * 12.5 - run.centimeters) < 0.01);
  }
  assert.ok(Math.abs(slowSetting.milliseconds - fastSetting.milliseconds) < 20);
});
