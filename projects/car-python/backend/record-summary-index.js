"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA_VERSION = "chenlong.python-record-summary-index/v1";
const SESSION_ID = /^ses_[a-f0-9]{32}$/;
const RECORD_ID = /^sub_[a-f0-9]{32}$/;
const OWNER_ID = /^usr_[a-f0-9]{32}$/;
const INDEX_FILENAME = "record-summary-index.sqlite";
const DIRTY_FILENAME = "record-summary-index.dirty";
const PENDING_FILENAME = "record-summary-index.pending";

function archivePosition(sessionId, recordId, recordState) {
  if (!SESSION_ID.test(sessionId) || !RECORD_ID.test(recordId)
    || !["saved", "submitted"].includes(recordState)) {
    throw new TypeError("record index archive position is invalid");
  }
  return `sessions/${sessionId}/${recordState === "saved" ? "drafts" : "submissions"}/${recordId}`;
}

function validateEntry(summary, scope, adminSummary = null) {
  if (!summary || typeof summary !== "object" || !RECORD_ID.test(summary.id)
    || !SESSION_ID.test(summary.sessionId)
    || (summary.ownerUserId !== null && !OWNER_ID.test(summary.ownerUserId))
    || scope !== "single"
    || !["saved", "submitted"].includes(summary.recordState)
    || typeof summary.taskId !== "string" || !summary.taskId
    || typeof summary.savedAt !== "string"
    || !Number.isFinite(Date.parse(summary.savedAt))
    || (summary.score !== null && (!Number.isFinite(summary.score) || summary.score < 0))
    || typeof summary.status !== "string") {
    throw new TypeError("record index summary is invalid");
  }
  if (summary.recordState === "submitted") {
    if (!adminSummary || adminSummary.id !== summary.id
      || adminSummary.sessionId !== summary.sessionId
      || adminSummary.recordState !== "submitted") {
      throw new TypeError("record index administrator summary is missing");
    }
  } else if (adminSummary !== null) {
    throw new TypeError("saved record cannot have an administrator summary");
  }
  return archivePosition(summary.sessionId, summary.id, summary.recordState);
}

class RecordSummaryIndex {
  constructor(filePath, { create = false } = {}) {
    this.filePath = path.resolve(filePath);
    const existing = fs.existsSync(this.filePath);
    if (create && existing) throw new Error("record index build path already exists");
    if (!create && !existing) throw new Error("record index does not exist");
    if (existing) {
      const stat = fs.lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("record index path is unsafe");
    }
    this.database = new DatabaseSync(this.filePath, { timeout: 5_000 });
    if (create) fs.chmodSync(this.filePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT,
        session_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        task_id TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        submitted_at TEXT,
        score REAL,
        status TEXT NOT NULL,
        record_state TEXT NOT NULL,
        file_position TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        admin_summary_json TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS records_owner_time
        ON records(owner_user_id, scope, saved_at DESC, session_id, id);
      CREATE INDEX IF NOT EXISTS records_scope_state_time
        ON records(scope, record_state, saved_at DESC, session_id, id);
    `);
    const schema = this.database.prepare("SELECT value FROM metadata WHERE key='schema'").get()?.value;
    const state = this.database.prepare("SELECT value FROM metadata WHERE key='state'").get()?.value;
    if (create) {
      if (schema || state) throw new Error("record index build path is not empty");
      this.database.prepare("INSERT INTO metadata(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      this.database.prepare("INSERT INTO metadata(key,value) VALUES('state','building')").run();
    } else if (schema !== SCHEMA_VERSION || state !== "complete") {
      this.database.close();
      throw new Error("record index is incomplete or has an unknown schema");
    }
  }

  static openForRuntime(rootDir) {
    const dirty = path.join(rootDir, DIRTY_FILENAME);
    if (fs.existsSync(dirty)) return null;
    const filePath = path.join(rootDir, INDEX_FILENAME);
    if (!fs.existsSync(filePath)) return null;
    return new RecordSummaryIndex(filePath);
  }

  upsert(summary, scope = "single", adminSummary = null) {
    const filePosition = validateEntry(summary, scope, adminSummary);
    const old = this.database.prepare(
      "SELECT session_id,record_state FROM records WHERE id=?"
    ).get(summary.id);
    if (old && (old.session_id !== summary.sessionId
      || (old.record_state === "submitted" && summary.recordState === "saved"))) {
      throw new Error("record index identity or state collision");
    }
    this.database.prepare(`
      INSERT INTO records(id,owner_user_id,session_id,scope,task_id,saved_at,
        submitted_at,score,status,record_state,file_position,summary_json,admin_summary_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        owner_user_id=excluded.owner_user_id,
        scope=excluded.scope,task_id=excluded.task_id,saved_at=excluded.saved_at,
        submitted_at=excluded.submitted_at,score=excluded.score,status=excluded.status,
        record_state=excluded.record_state,file_position=excluded.file_position,
        summary_json=excluded.summary_json,admin_summary_json=excluded.admin_summary_json
    `).run(
      summary.id, summary.ownerUserId, summary.sessionId, scope, summary.taskId,
      summary.savedAt, summary.submittedAt, summary.score, summary.status,
      summary.recordState, filePosition, JSON.stringify(summary),
      adminSummary === null ? null : JSON.stringify(adminSummary)
    );
  }

  deleteSaved(recordId, sessionId) {
    archivePosition(sessionId, recordId, "saved");
    this.database.prepare(
      "DELETE FROM records WHERE id=? AND session_id=? AND record_state='saved'"
    ).run(recordId, sessionId);
  }

  lookup(recordId) {
    if (!RECORD_ID.test(recordId)) throw new TypeError("record index id is invalid");
    const row = this.database.prepare(`
      SELECT session_id,owner_user_id,scope,record_state,file_position
      FROM records WHERE id=?
    `).get(recordId);
    if (!row) return null;
    if (row.file_position !== archivePosition(row.session_id, recordId, row.record_state)) {
      throw new Error("record index archive position is inconsistent");
    }
    return {
      sessionId: row.session_id,
      ownerUserId: row.owner_user_id,
      scope: row.scope,
      recordState: row.record_state,
      filePosition: row.file_position
    };
  }

  query({ ownerUserId = null, includeAll = false, expectedScope = null,
    recordState = null, limit = null, page = null, pageSize = null,
    admin = false } = {}) {
    if (!includeAll && !OWNER_ID.test(ownerUserId || "")) {
      throw new TypeError("record index owner is invalid");
    }
    if (expectedScope !== "single") {
      return null;
    }
    if (recordState !== null && !["saved", "submitted"].includes(recordState)) {
      throw new TypeError("record index state is invalid");
    }
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new TypeError("record index limit is invalid");
    }
    const conditions = ["scope='single'"];
    const parameters = [];
    if (!includeAll) {
      conditions.push("owner_user_id=?");
      parameters.push(ownerUserId);
    }
    if (recordState !== null) {
      conditions.push("record_state=?");
      parameters.push(recordState);
    }
    const where = conditions.join(" AND ");
    const actualTotal = this.database.prepare(
      `SELECT COUNT(*) AS total FROM records WHERE ${where}`
    ).get(...parameters).total;
    const total = limit === null ? actualTotal : Math.min(actualTotal, limit);
    let offset = 0;
    let requested = total;
    let pagination = null;
    if (page !== null) {
      if (!Number.isSafeInteger(page) || page < 1
        || !Number.isSafeInteger(pageSize) || pageSize < 1) {
        throw new TypeError("record index page is invalid");
      }
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const selectedPage = Math.min(page, totalPages);
      offset = (selectedPage - 1) * pageSize;
      requested = Math.min(pageSize, Math.max(0, total - offset));
      pagination = {
        page: selectedPage, pageSize, total, totalPages,
        hasNext: selectedPage < totalPages
      };
    }
    const column = admin ? "COALESCE(admin_summary_json,summary_json)" : "summary_json";
    const rows = this.database.prepare(`
      SELECT ${column} AS payload FROM records WHERE ${where}
      ORDER BY saved_at DESC,session_id ASC,id ASC LIMIT ? OFFSET ?
    `).all(...parameters, requested, offset);
    return { records: rows.map(row => JSON.parse(row.payload)), pagination };
  }

  allSubmittedSummaries() {
    return this.database.prepare(`
      SELECT summary_json FROM records
      WHERE scope='single' AND record_state='submitted'
    `).all().map(row => JSON.parse(row.summary_json));
  }

  count() {
    return this.database.prepare("SELECT COUNT(*) AS count FROM records").get().count;
  }

  beginBatch() {
    this.database.exec("BEGIN IMMEDIATE");
  }

  commitBatch() {
    this.database.exec("COMMIT");
  }

  rollbackBatch() {
    if (this.database.isTransaction) this.database.exec("ROLLBACK");
  }

  completeBuild() {
    if (this.database.prepare("SELECT value FROM metadata WHERE key='state'").get()?.value !== "building") {
      throw new Error("record index is not being built");
    }
    if (this.database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
      throw new Error("record index failed SQLite integrity check");
    }
    this.database.prepare("UPDATE metadata SET value='complete' WHERE key='state'").run();
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close() {
    this.database.close();
  }
}

module.exports = { RecordSummaryIndex, INDEX_FILENAME, DIRTY_FILENAME, PENDING_FILENAME };
