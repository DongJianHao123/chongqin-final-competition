#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { SubmissionStore } = require("../backend/submission-store.js");
const { RecordSummaryIndex } = require("../backend/record-summary-index.js");

async function main() {
  const archiveRoot = path.resolve(process.argv[2] || "");
  const outputPath = path.resolve(process.argv[3] || "");
  if (process.argv.length !== 4 || !fs.statSync(archiveRoot).isDirectory()
    || !fs.statSync(path.dirname(outputPath)).isDirectory()) {
    throw new Error("usage: build-record-index.js <archive-root> <new-index-path>");
  }
  // The builder uses the store's validated read methods without constructing
  // another writer or running retention cleanup against the live archive.
  const view = Object.create(SubmissionStore.prototype);
  view.rootDir = archiveRoot;
  view.sessionsDir = path.join(archiveRoot, "sessions");
  view.ready = Promise.resolve();
  view.now = () => Date.now();
  view.capabilityUsageCache = new Map();
  view.maxSubmissionsPerSession = 100;
  const index = new RecordSummaryIndex(outputPath, { create: true });
  const counts = { records: 0, saved: 0, submitted: 0, scored: 0 };
  const started = Date.now();
  try {
    index.beginBatch();
    for await (const { summary, adminSummary } of view.archiveSummaryRows()) {
      index.upsert(summary, "single", adminSummary);
      counts.records += 1;
      counts[summary.recordState] += 1;
      if (summary.score !== null) counts.scored += 1;
      if (counts.records % 1_000 === 0) {
        index.commitBatch();
        index.beginBatch();
      }
    }
    index.commitBatch();
    if (index.count() !== counts.records) throw new Error("record index row count changed during build");
    index.completeBuild();
  } catch (error) {
    index.rollbackBatch();
    throw error;
  } finally {
    index.close();
  }
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex");
  console.log(JSON.stringify({
    schemaVersion: "chenlong.python-record-index-build/v1",
    archiveRoot, outputPath, ...counts,
    elapsedMs: Date.now() - started, sha256
  }));
}

main().catch(error => {
  process.stderr.write(`record index build failed: ${error.message}\n`);
  process.exitCode = 1;
});
