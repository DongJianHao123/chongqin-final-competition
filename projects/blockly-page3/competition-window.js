"use strict";

const SUBMISSION_WINDOW_SCHEMA_VERSION = "chenlong.competition-submission-window/v1";
const SUBMISSION_TIME_ZONE = "Asia/Shanghai";
const SUBMISSION_DEADLINE_LABEL = "2026年9月20日 23:59（北京时间）";
// The deadline includes the whole 23:59 minute.  This exclusive instant is
// 2026-09-21 00:00:00 in China Standard Time (UTC+08:00).
const SUBMISSION_CLOSES_AT_ISO = "2026-09-20T16:00:00.000Z";
const SUBMISSION_CLOSES_AT_MS = Date.parse(SUBMISSION_CLOSES_AT_ISO);
const SUBMISSION_CLOSED_CODE = "COMPETITION_SUBMISSION_CLOSED";
const SUBMISSION_CLOSED_MESSAGE =
  "比赛提交已于2026年9月20日23:59（北京时间）截止，2026年9月21日起不能再提交成绩。";

const ID = Object.freeze({
  run: "run_[a-f0-9]{32}",
  submission: "sub_[a-f0-9]{32}",
  session: "ses_[a-f0-9]{32}",
  batch: "bat_[a-f0-9]{32}",
  competition: "[A-Za-z0-9._-]{1,128}"
});

const SUBMISSION_PATHS = Object.freeze([
  Object.freeze({
    kind: "blockly-record",
    pattern: new RegExp(`^/api/records/${ID.run}/submit/?$`)
  }),
  Object.freeze({
    kind: "python-record",
    pattern: new RegExp(`^/api/v1/records/${ID.submission}/submit/?$`)
  }),
  Object.freeze({
    kind: "python-single-session",
    pattern: new RegExp(`^/api/v1/sessions/${ID.session}/submissions/?$`)
  }),
  Object.freeze({
    kind: "python-practice-slot",
    pattern: new RegExp(
      `^/api/v1/evaluation-batches/${ID.batch}/slots/[1-5]/sessions/${ID.session}/submissions/?$`
    )
  }),
  Object.freeze({
    kind: "python-ranked-slot",
    pattern: new RegExp(
      `^/api/v1/competitions/${ID.competition}/ranked-evaluation/${ID.batch}`
        + `/slots/[1-5]/sessions/${ID.session}/submissions/?$`
    )
  }),
  Object.freeze({
    kind: "python-practice-close",
    pattern: new RegExp(`^/api/v1/evaluation-batches/${ID.batch}/close/?$`)
  }),
  Object.freeze({
    kind: "python-ranked-close",
    pattern: new RegExp(
      `^/api/v1/competitions/${ID.competition}/ranked-evaluation/${ID.batch}/close/?$`
    )
  })
]);

function normalizedSubmissionPath(pathname) {
  const value = String(pathname || "");
  if (value.startsWith("/python/api/")) return value.slice("/python".length);
  if (value.startsWith("/blockly/api/")) return value.slice("/blockly".length);
  return value;
}

function submissionRequestKind(pathname, method = "POST") {
  if (String(method || "GET").toUpperCase() !== "POST") return null;
  const normalized = normalizedSubmissionPath(pathname);
  return SUBMISSION_PATHS.find(item => item.pattern.test(normalized))?.kind || null;
}

function normalizedNow(nowMs) {
  const value = Number(nowMs);
  if (!Number.isFinite(value)) throw new TypeError("competition clock must be a finite millisecond timestamp");
  return value;
}

function submissionsOpen(nowMs = Date.now()) {
  return normalizedNow(nowMs) < SUBMISSION_CLOSES_AT_MS;
}

function publicSubmissionWindow(nowMs = Date.now()) {
  return Object.freeze({
    schemaVersion: SUBMISSION_WINDOW_SCHEMA_VERSION,
    timeZone: SUBMISSION_TIME_ZONE,
    deadlineLabel: SUBMISSION_DEADLINE_LABEL,
    closesAt: SUBMISSION_CLOSES_AT_ISO,
    submissionsOpen: submissionsOpen(nowMs)
  });
}

module.exports = Object.freeze({
  SUBMISSION_WINDOW_SCHEMA_VERSION,
  SUBMISSION_TIME_ZONE,
  SUBMISSION_DEADLINE_LABEL,
  SUBMISSION_CLOSES_AT_ISO,
  SUBMISSION_CLOSES_AT_MS,
  SUBMISSION_CLOSED_CODE,
  SUBMISSION_CLOSED_MESSAGE,
  normalizedSubmissionPath,
  submissionRequestKind,
  submissionsOpen,
  publicSubmissionWindow
});
