"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_MAX_SOURCE_BYTES,
  WorkspaceSourceStore,
  WorkspaceSourceStoreError
} = require("../backend/workspace-source-store.js");

const TASKS = ["R2-GYI-MVP-01", "R2-GYI-MVP-02", "R2-GYI-MVP-03"];
const USER_A = "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-workspace-source-test-"));
}

test("workspace source snapshots are isolated by authenticated owner and task across a restart", async () => {
  const rootDir = temporaryDirectory();
  let timestamp = Date.parse("2026-09-11T10:00:00.000Z");
  try {
    const store = new WorkspaceSourceStore({ rootDir, taskIds: TASKS, now: () => timestamp });
    await store.save(USER_A, TASKS[0], "# A task 1");
    timestamp += 1000;
    await store.save(USER_A, TASKS[1], "# A task 2");
    timestamp += 1000;
    await store.save(USER_B, TASKS[0], "# B task 1");

    assert.deepEqual(await store.read(USER_A, TASKS[0]), {
      source: "# A task 1", updatedAt: "2026-09-11T10:00:00.000Z"
    });
    assert.deepEqual(await store.read(USER_A, TASKS[1]), {
      source: "# A task 2", updatedAt: "2026-09-11T10:00:01.000Z"
    });
    assert.deepEqual(await store.read(USER_B, TASKS[0]), {
      source: "# B task 1", updatedAt: "2026-09-11T10:00:02.000Z"
    });
    assert.equal(await store.read(USER_B, TASKS[2]), null);

    const restartedStore = new WorkspaceSourceStore({ rootDir, taskIds: TASKS });
    assert.equal((await restartedStore.read(USER_A, TASKS[0])).source, "# A task 1");
    assert.equal((await restartedStore.read(USER_A, TASKS[1])).source, "# A task 2");
    assert.equal((await restartedStore.read(USER_B, TASKS[0])).source, "# B task 1");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("workspace source snapshots reject unknown tasks and oversized payloads", async () => {
  const rootDir = temporaryDirectory();
  try {
    const store = new WorkspaceSourceStore({ rootDir, taskIds: TASKS });
    await assert.rejects(
      store.save(USER_A, "R2-GYI-MVP-99", "x"),
      error => error instanceof WorkspaceSourceStoreError && error.code === "INVALID_TASK"
    );
    await assert.rejects(
      store.save(USER_A, TASKS[0], "x".repeat(DEFAULT_MAX_SOURCE_BYTES + 1)),
      error => error instanceof WorkspaceSourceStoreError && error.code === "SOURCE_TOO_LARGE"
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
