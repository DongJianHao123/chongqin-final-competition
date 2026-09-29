"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const window = require("../competition-window.js");

const RUN_ID = `run_${"a".repeat(32)}`;
const SUBMISSION_ID = `sub_${"b".repeat(32)}`;
const SESSION_ID = `ses_${"c".repeat(32)}`;
const BATCH_ID = `bat_${"d".repeat(32)}`;

test("the Beijing deadline includes all of September 20 and closes exactly at September 21", () => {
  assert.equal(window.SUBMISSION_CLOSES_AT_ISO, "2026-09-20T16:00:00.000Z");
  assert.equal(new Date(window.SUBMISSION_CLOSES_AT_MS).toISOString(), window.SUBMISSION_CLOSES_AT_ISO);
  assert.equal(window.submissionsOpen(window.SUBMISSION_CLOSES_AT_MS - 1), true);
  assert.equal(window.submissionsOpen(window.SUBMISSION_CLOSES_AT_MS), false);
  assert.equal(window.submissionsOpen(window.SUBMISSION_CLOSES_AT_MS + 1), false);
});

test("all public and direct score-submission routes share the deadline gate", () => {
  const cases = [
    ["/blockly/api/records/" + RUN_ID + "/submit", "blockly-record"],
    ["/api/records/" + RUN_ID + "/submit", "blockly-record"],
    ["/python/api/v1/records/" + SUBMISSION_ID + "/submit", "python-record"],
    ["/api/v1/sessions/" + SESSION_ID + "/submissions", "python-single-session"],
    [
      "/python/api/v1/evaluation-batches/" + BATCH_ID + "/slots/5/sessions/" + SESSION_ID + "/submissions",
      "python-practice-slot"
    ],
    [
      "/python/api/v1/competitions/2026-r2-gyi-local-screening.1/ranked-evaluation/"
        + BATCH_ID + "/slots/1/sessions/" + SESSION_ID + "/submissions",
      "python-ranked-slot"
    ],
    ["/python/api/v1/evaluation-batches/" + BATCH_ID + "/close", "python-practice-close"],
    [
      "/python/api/v1/competitions/2026-r2-gyi-local-screening.1/ranked-evaluation/"
        + BATCH_ID + "/close",
      "python-ranked-close"
    ],
    ["/api/competition/submissions", "workshop-model"]
  ];
  for (const [pathname, kind] of cases) {
    assert.equal(window.submissionRequestKind(pathname, "POST"), kind, pathname);
  }
});

test("draft saving, score previews, authentication, reads, and malformed lookalikes remain outside the gate", () => {
  for (const [pathname, method] of [
    ["/blockly/api/records", "POST"],
    ["/python/api/v1/sessions/" + SESSION_ID + "/drafts", "POST"],
    ["/python/api/v1/records/" + SUBMISSION_ID + "/submit", "GET"],
    ["/api/competition/logout", "POST"],
    ["/api/v1/auth/logout", "POST"],
    ["/api/records/run_invalid/submit", "POST"],
    ["/api/competition/submissions/extra", "POST"]
  ]) {
    assert.equal(window.submissionRequestKind(pathname, method), null, `${method} ${pathname}`);
  }
});

test("the public window state uses an exclusive UTC instant and a stable Chinese label", () => {
  assert.deepEqual(window.publicSubmissionWindow(window.SUBMISSION_CLOSES_AT_MS - 1), {
    schemaVersion: "chenlong.competition-submission-window/v1",
    timeZone: "Asia/Shanghai",
    deadlineLabel: "2026年9月20日 23:59（北京时间）",
    closesAt: "2026-09-20T16:00:00.000Z",
    submissionsOpen: true
  });
  assert.equal(window.publicSubmissionWindow(window.SUBMISSION_CLOSES_AT_MS).submissionsOpen, false);
  assert.throws(() => window.submissionsOpen(Number.NaN), /finite millisecond timestamp/);
});

test("the gateway and Blockly writer enforce the shared server-side window", () => {
  const platformServer = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const blocklyServer = fs.readFileSync(
    path.join(__dirname, "..", "projects", "blockly-page3", "server.js"),
    "utf8"
  );
  const dockerfile = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.match(platformServer, /assertCompetitionSubmissionOpen\(request, options, pathname\)/);
  assert.match(platformServer, /await readIncomingBody[\s\S]*assertCompetitionSubmissionOpen\(request, options\)/);
  assert.match(blocklyServer, /submitMatch[\s\S]*assertCompetitionSubmissionOpen\(request\)[\s\S]*recordStore\.submit/);
  assert.match(dockerfile, /COPY \. \./);
  assert.match(dockerfile, /CMD \["node", "tools\/start-platform\.js"\]/);
});
