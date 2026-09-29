"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BlocklyWorkspaceStore,
  WORKSPACE_DATABASE_FILE_NAME
} = require("../blockly-workspace-store.js");

const TASKS = ["GYI-PRIMARY-01", "GYI-PRIMARY-02", "GYI-PRIMARY-03"];
const USER_A = "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("Blockly workspace snapshots are owner/task isolated and survive reopening their separate database", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-workspace-store-"));
  let timestamp = Date.parse("2026-09-12T00:00:00.000Z");
  let store = null;
  try {
    store = new BlocklyWorkspaceStore({ dataDir, taskIds: TASKS, now: () => timestamp });
    const aTaskOne = { blocks: { blocks: [{ id: "a-1", type: "robot_move_cm" }] } };
    const aTaskTwo = { blocks: { blocks: [{ id: "a-2", type: "robot_turn" }] } };
    const bTaskOne = { blocks: { blocks: [{ id: "b-1", type: "robot_wait" }] } };
    store.save(USER_A, TASKS[0], aTaskOne);
    timestamp += 1000;
    store.save(USER_A, TASKS[1], aTaskTwo);
    timestamp += 1000;
    store.save(USER_B, TASKS[0], bTaskOne);

    assert.deepEqual(store.getAll(USER_A).get(TASKS[0]).workspace, aTaskOne);
    assert.deepEqual(store.getAll(USER_A).get(TASKS[1]).workspace, aTaskTwo);
    assert.equal(store.getAll(USER_A).get(TASKS[2]), undefined);
    assert.deepEqual(store.getAll(USER_B).get(TASKS[0]).workspace, bTaskOne);

    store.close();
    store = new BlocklyWorkspaceStore({ dataDir, taskIds: TASKS });
    assert.ok(fs.existsSync(path.join(dataDir, WORKSPACE_DATABASE_FILE_NAME)));
    assert.deepEqual(store.getAll(USER_A).get(TASKS[0]).workspace, aTaskOne);
    assert.deepEqual(store.getAll(USER_A).get(TASKS[1]).workspace, aTaskTwo);
    assert.deepEqual(store.getAll(USER_B).get(TASKS[0]).workspace, bTaskOne);
  } finally {
    store?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Blockly workspace snapshots reject unregistered tasks and excessive content", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-workspace-store-"));
  const store = new BlocklyWorkspaceStore({ dataDir, taskIds: TASKS });
  try {
    assert.throws(() => store.save(USER_A, "GYI-PRIMARY-99", { blocks: {} }), /任务无效/);
    assert.throws(
      () => store.save(USER_A, TASKS[0], { blocks: { text: "x".repeat(128 * 1024 + 1) } }),
      /内容过大/
    );
  } finally {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Blockly task switching records the rendered task before the asynchronous mission change", () => {
  const parentApp = path.join(__dirname, "..", "app.js");
  const app = fs.readFileSync(
    fs.existsSync(parentApp) ? parentApp : path.join(__dirname, "..", "..", "app.js"),
    "utf8"
  );
  assert.match(app, /let blocklyWorkspaceDisplayedTaskId = "GYI-PRIMARY-01"/);
  assert.match(
    app,
    /const previousTaskId = blocklyWorkspaceDisplayedTaskId \|\| activeBlocklyWorkspaceTaskId\(\)[\s\S]*?captureBlocklyWorkspace\(previousTaskId\)[\s\S]*?await flushBlocklyWorkspace\(previousTaskId\)/
  );
  assert.match(
    app,
    /await restoreBlocklyWorkspaceForTask\(targetTaskId\)[\s\S]*?blocklyWorkspaceDisplayedTaskId = targetTaskId \|\| activeBlocklyWorkspaceTaskId\(\)/
  );
});
