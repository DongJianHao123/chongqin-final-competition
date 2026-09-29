"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WorkspaceSourceStore } = require("../backend/workspace-source-store.js");
const { backfillWorkspaceSources, sourceFromArchivedRecord, parseArguments } = require("../tools/backfill-workspace-sources.js");

const USER_A = "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("workspace backfill keeps newest run per user/task without touching existing snapshots", async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-backfill-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const workspaceSourceStore = new WorkspaceSourceStore({
    rootDir,
    taskIds: ["R2-GYI-MVP-01", "R2-GYI-MVP-02", "R2-GYI-MVP-03"]
  });
  await workspaceSourceStore.save(USER_B, "R2-GYI-MVP-01", "existing B");

  const records = [
    { id: "rec-new-a", sessionId: "ses-new-a", recordState: "submitted", ownerUserId: USER_A, taskId: "R2-GYI-MVP-01", savedAt: "2026-09-12T02:00:00.000Z" },
    { id: "rec-old-a", sessionId: "ses-old-a", recordState: "submitted", ownerUserId: USER_A, taskId: "R2-GYI-MVP-01", savedAt: "2026-09-12T01:00:00.000Z" },
    { id: "rec-b", sessionId: "ses-b", recordState: "submitted", ownerUserId: USER_B, taskId: "R2-GYI-MVP-01", savedAt: "2026-09-12T00:00:00.000Z" },
    { id: "rec-task2", sessionId: "ses-task2", recordState: "submitted", ownerUserId: USER_A, taskId: "R2-GYI-MVP-02", savedAt: "2026-09-11T23:00:00.000Z" }
  ];
  const sources = new Map([
    ["rec-new-a", "new A"],
    ["rec-old-a", "old A"],
    ["rec-b", "new B"],
    ["rec-task2", "task two A"]
  ]);
  const submissionStore = {
    async listRecords() { return records; },
    async readRecord(_sessionId, id) {
      return { buffer: Buffer.from(JSON.stringify({ sourceCode: sources.get(id) })) };
    }
  };

  const result = await backfillWorkspaceSources({ submissionStore, workspaceSourceStore });
  assert.deepEqual(result, {
    scannedRecords: 4,
    createdSnapshots: 2,
    keptExistingSnapshots: 1,
    skippedOlderRecords: 1,
    skippedInvalidRecords: 0
  });
  assert.equal((await workspaceSourceStore.read(USER_A, "R2-GYI-MVP-01")).source, "new A");
  assert.equal((await workspaceSourceStore.read(USER_A, "R2-GYI-MVP-02")).source, "task two A");
  assert.equal((await workspaceSourceStore.read(USER_B, "R2-GYI-MVP-01")).source, "existing B");
});

test("workspace backfill parser rejects corrupt archived sources and accepts explicit arguments", () => {
  assert.equal(sourceFromArchivedRecord({ buffer: Buffer.from("not json") }), null);
  assert.equal(sourceFromArchivedRecord({ buffer: Buffer.from(JSON.stringify({ sourceCode: 3 })) }), null);
  assert.deepEqual(parseArguments(["--data-root", "runtime", "--force"]), {
    dataRoot: path.resolve("runtime"),
    force: true
  });
  assert.throws(() => parseArguments(["--unknown"]), /Usage/);
});
