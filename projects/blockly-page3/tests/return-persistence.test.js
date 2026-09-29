"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("the platform return path saves the currently displayed Blockly task first", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /const platformReturnButton = document\.querySelector\("#platformReturnButton"\)/);
  assert.match(
    app,
    /async function returnToPlatformAfterSavingBlocklyWorkspace\(event\)[\s\S]*?const taskId = blocklyWorkspaceDisplayedTaskId \|\| activeBlocklyWorkspaceTaskId\(\)[\s\S]*?captureBlocklyWorkspace\(taskId\)[\s\S]*?const saved = await flushBlocklyWorkspace\(taskId\)[\s\S]*?if \(!saved\) throw new Error[\s\S]*?window\.location\.assign\(platformReturnButton\.href\)/
  );
  assert.doesNotMatch(app, /BLOCKLY_WORKSPACE_RETURN_SAVE_TIMEOUT_MS/);
});

test("a hidden or closing Blockly page also makes a keepalive save attempt", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /document\.hidden\) persistBlocklyWorkspaceOnPageExit\(\)/);
  assert.match(app, /window\.addEventListener\("pagehide", \(\) => \{[\s\S]*?persistBlocklyWorkspaceOnPageExit\(\)/);
  assert.match(app, /keepalive: true/);
});

test("protected task-three recoveries discard stale browser drafts once and require compare-and-save", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const target = "usr_6a877f0ec7be48349f9b2c936472e872/GYI-PRIMARY-03";

  assert.match(app, new RegExp(target));
  assert.match(server, new RegExp(target));
  assert.match(app, /20260918-happy-task3-001/);
  assert.match(server, /20260918-happy-task3-001/);
  assert.match(app, /protectedRecovery\?\.marker[\s\S]*?previousDraft[\s\S]*?localStorage\.removeItem\(localKey\)/);
  assert.match(app, /local\.baseSha256 !== remote\.sha256[\s\S]*?staleDraft/);
  assert.match(server, /protectedRecoveryToken[\s\S]*?WORKSPACE_BASE_SHA_HEADER[\s\S]*?workspaceStore\.saveIfMatch/);
});

test("an unacknowledged local Blockly snapshot wins over an older remote clock", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /schema: 3, taskId, workspace: workspaceValue, savedAt: Date\.now\(\), dirty: Boolean\(dirty\)/);
  assert.match(app, /dirty: isLegacySnapshot \|\| value\.dirty/);
  assert.match(app, /if \(local\?\.dirty\) return \{ workspace: local\.workspace, fromLocal: true \}/);
  assert.match(app, /writeLocalBlocklyWorkspace\(userId, taskId, workspaceSnapshot, \{ dirty: false \}\)/);
});

test("a new task starts empty and initialization cannot suppress task-one workspace restoration", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /let blocklyWorkspaceInitialSignature = ""/);
  assert.match(app, /A brand-new task intentionally starts empty[\s\S]*?blocklyWorkspaceInitialSignature = currentBlocklyWorkspaceSignature\(\);/);
  assert.match(app, /if \(!primaryUser && currentBlocklyWorkspaceSignature\(\) !== blocklyWorkspaceInitialSignature\)/);
  assert.match(app, /updateCode\(\);\s*blocklyWorkspaceInitialSignature = currentBlocklyWorkspaceSignature\(\);/);
  assert.doesNotMatch(app, /function createStarterProgram\(/);
  assert.doesNotMatch(app, /function makeMoveCmBlock\(/);
});
