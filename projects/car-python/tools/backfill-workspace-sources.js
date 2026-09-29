#!/usr/bin/env node
"use strict";

// One-time, opt-in migration for the editing snapshots introduced after run
// records already existed.  It reads the archive and writes only the separate
// workspace-sources directory; score reports, submissions, and drafts are never
// changed.  Normal server startup does not invoke this program.

const path = require("node:path");
const {
  WorkspaceSourceStore,
  DEFAULT_MAX_SOURCE_BYTES
} = require("../backend/workspace-source-store.js");

const USER_ID_PATTERN = /^usr_[a-f0-9]{32}$/;
const TASK_IDS = new Set(["R2-GYI-MVP-01", "R2-GYI-MVP-02", "R2-GYI-MVP-03"]);
const MAX_WORKSPACE_SOURCE_BYTES = DEFAULT_MAX_SOURCE_BYTES;

function isUsableSource(value) {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= MAX_WORKSPACE_SOURCE_BYTES;
}

function sourceFromArchivedRecord(stored) {
  if (!Buffer.isBuffer(stored?.buffer)) return null;
  try {
    const record = JSON.parse(stored.buffer.toString("utf8"));
    return isUsableSource(record?.sourceCode) ? record.sourceCode : null;
  } catch (_error) {
    return null;
  }
}

function recordKey(ownerUserId, taskId) {
  return `${ownerUserId}\u0000${taskId}`;
}

async function readArchivedRecordForBackfill(submissionStore, record) {
  if (record?.recordState === "saved") {
    return submissionStore.readDraft(record.sessionId, record.id, null, { skipAuthorization: true });
  }
  return submissionStore.readRecord(record.sessionId, record.id, null, undefined, {
    skipAuthorization: true
  });
}

async function backfillWorkspaceSources({ submissionStore, workspaceSourceStore, force = false }) {
  const records = await submissionStore.listRecords({
    includeAll: true,
    expectedScope: "single",
    maximum: 10_000
  });
  const newestFirst = [...records].sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt)));
  const seen = new Set();
  const summary = {
    scannedRecords: newestFirst.length,
    createdSnapshots: 0,
    keptExistingSnapshots: 0,
    skippedOlderRecords: 0,
    skippedInvalidRecords: 0
  };

  for (const record of newestFirst) {
    const ownerUserId = String(record?.ownerUserId || "");
    const taskId = String(record?.taskId || "");
    if (!USER_ID_PATTERN.test(ownerUserId) || !TASK_IDS.has(taskId) || typeof record?.id !== "string") {
      summary.skippedInvalidRecords += 1;
      continue;
    }
    const key = recordKey(ownerUserId, taskId);
    if (seen.has(key)) {
      summary.skippedOlderRecords += 1;
      continue;
    }
    seen.add(key);

    if (!force && await workspaceSourceStore.read(ownerUserId, taskId)) {
      summary.keptExistingSnapshots += 1;
      continue;
    }
    try {
      const stored = await readArchivedRecordForBackfill(submissionStore, record);
      const source = sourceFromArchivedRecord(stored);
      if (source === null) {
        summary.skippedInvalidRecords += 1;
        continue;
      }
      await workspaceSourceStore.save(ownerUserId, taskId, source);
      summary.createdSnapshots += 1;
    } catch (_error) {
      // A broken historic record must not block restoration for every other
      // participant.  It is not altered and remains available for normal audit.
      summary.skippedInvalidRecords += 1;
    }
  }
  return summary;
}

function parseArguments(argv) {
  const options = { dataRoot: path.join(__dirname, "..", ".runtime"), force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--data-root" && typeof argv[index + 1] === "string") {
      options.dataRoot = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error("Usage: node tools/backfill-workspace-sources.js [--data-root <path>] [--force]");
  }
  return { ...options, dataRoot: path.resolve(options.dataRoot) };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { SubmissionStore } = require("../backend/submission-store.js");
  const configuredArchiveLimit = Number(process.env.CHENLONG_RUN_ARCHIVE_MAX_BYTES);
  const submissionStore = new SubmissionStore({
    rootDir: options.dataRoot,
    ...(Number.isSafeInteger(configuredArchiveLimit) && configuredArchiveLimit > 0
      ? { maxStorageBytes: configuredArchiveLimit } : {})
  });
  await submissionStore.ready;
  const workspaceSourceStore = new WorkspaceSourceStore({
    rootDir: path.join(options.dataRoot, "workspace-sources"),
    taskIds: [...TASK_IDS]
  });
  const summary = await backfillWorkspaceSources({
    submissionStore,
    workspaceSourceStore,
    force: options.force
  });
  process.stdout.write(`${JSON.stringify({ ...summary, force: options.force })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Workspace snapshot backfill failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  backfillWorkspaceSources,
  readArchivedRecordForBackfill,
  sourceFromArchivedRecord,
  parseArguments
};
