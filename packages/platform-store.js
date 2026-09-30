"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_error) {
  throw new Error("统一平台存储需要 Node.js 22.5 或更高版本（内置 node:sqlite）。");
}

const STORE_SCHEMA_VERSION = "chenlong.platform-store/v1";
const DB_FILE_NAME = "platform.sqlite";
const USER_ID_PATTERN = /^usr_[a-f0-9]{32}$/;
const TEAM_ID_PATTERN = /^tea_[a-f0-9]{32}$/;
const SESSION_ID_PATTERN = /^ase_[a-f0-9]{32}$/;
const RECORD_ID_PATTERN = /^run_[a-f0-9]{32}$/;
const RECORD_STATES = new Set(["saved", "submitted"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timestampMilliseconds(value, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError("记录时间格式无效。");
  return Math.trunc(result);
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    team_id TEXT,
    team_name TEXT,
    group_name TEXT,
    role TEXT NOT NULL,
    password_hash TEXT,
    official_user_id TEXT,
    official_team_id TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY NOT NULL,
    team_name TEXT NOT NULL,
    team_name_key TEXT NOT NULL,
    invite_code TEXT NOT NULL,
    official_team_id TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    token_hash TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY NOT NULL,
    owner_user_id TEXT NOT NULL,
    owner_team_id TEXT,
    task_id TEXT NOT NULL,
    record_state TEXT NOT NULL CHECK (record_state IN ('saved', 'submitted')),
    score REAL,
    submitted_at TEXT,
    submitted_at_ms INTEGER,
    created_at TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS records_owner_created_idx ON records(owner_user_id, created_at_ms DESC, id DESC);
  CREATE INDEX IF NOT EXISTS records_owner_state_submitted_idx ON records(owner_user_id, record_state, submitted_at_ms DESC, id DESC);
  CREATE INDEX IF NOT EXISTS records_team_task_state_submitted_idx ON records(owner_team_id, task_id, record_state, submitted_at_ms DESC, id DESC);
  CREATE INDEX IF NOT EXISTS records_state_submitted_idx ON records(record_state, submitted_at_ms DESC, id DESC);

  CREATE TABLE IF NOT EXISTS workspaces (
    owner_user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    workspace_json TEXT NOT NULL,
    workspace_sha256 TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (owner_user_id, task_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS workspaces_owner_updated_idx ON workspaces(owner_user_id, updated_at_ms DESC);

  CREATE TABLE IF NOT EXISTS map_configs (
    task_id TEXT PRIMARY KEY NOT NULL,
    current_revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS map_config_versions (
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    digest TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_user_id TEXT,
    layout_json TEXT NOT NULL,
    PRIMARY KEY (task_id, revision)
  ) STRICT;
`;

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    usernameKey: row.username_key,
    displayName: row.display_name,
    teamId: row.team_id,
    teamName: row.team_name,
    group: row.group_name,
    role: row.role,
    passwordHash: row.password_hash ? JSON.parse(row.password_hash) : null,
    officialUserId: row.official_user_id,
    officialTeamId: row.official_team_id,
    createdAt: row.created_at
  };
}

function rowToTeam(row) {
  if (!row) return null;
  return {
    id: row.id,
    teamName: row.team_name,
    teamNameKey: row.team_name_key,
    inviteCode: row.invite_code,
    officialTeamId: row.official_team_id,
    createdAt: row.created_at
  };
}

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    tokenHash: row.token_hash,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function rowToMapVersion(row) {
  if (!row) return null;
  return {
    revision: row.revision,
    digest: row.digest,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
    layout: JSON.parse(row.layout_json)
  };
}

function serializedRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || !RECORD_ID_PATTERN.test(record.id)
    || typeof record.ownerUserId !== "string" || !record.ownerUserId
    || typeof record.taskId !== "string" || !record.taskId
    || !RECORD_STATES.has(record.recordState)) {
    throw new TypeError("记录格式无效，无法写入记录表。");
  }
  const payload = JSON.stringify(record);
  return {
    id: record.id,
    ownerUserId: record.ownerUserId,
    ownerTeamId: typeof record.ownerTeamId === "string" && record.ownerTeamId ? record.ownerTeamId : null,
    taskId: record.taskId,
    recordState: record.recordState,
    score: Number.isFinite(record.score) ? record.score : null,
    submittedAt: record.recordState === "submitted" ? record.submittedAt : null,
    submittedAtMs: record.recordState === "submitted"
      ? timestampMilliseconds(record.submittedAt || record.createdAt)
      : null,
    createdAt: record.createdAt,
    createdAtMs: timestampMilliseconds(record.createdAt),
    payload,
    payloadSha256: sha256(payload)
  };
}

function parsedRecord(row) {
  if (!row || typeof row.payload_json !== "string") return null;
  const value = JSON.parse(row.payload_json);
  if (!value || typeof value !== "object" || value.id !== row.id) {
    throw new Error("记录表包含损坏的数据。");
  }
  return value;
}

class PlatformStore {
  constructor({ dataDir, databasePath = null } = {}) {
    if (typeof dataDir !== "string" || !dataDir) throw new TypeError("数据目录不能为空。");
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.databasePath = path.resolve(databasePath || path.join(this.dataDir, DB_FILE_NAME));
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(SCHEMA_SQL);
    const version = this.database.prepare(
      "SELECT value FROM metadata WHERE key = 'schemaVersion' LIMIT 1"
    ).get();
    if (!version) {
      this.database.prepare(
        "INSERT INTO metadata (key, value) VALUES ('schemaVersion', ?)"
      ).run(STORE_SCHEMA_VERSION);
    } else if (version.value !== STORE_SCHEMA_VERSION) {
      this.database.close();
      throw new Error("统一平台数据库版本不兼容，服务已停止以避免错误迁移。");
    }
  }

  close() {
    if (!this.database) return;
    this.database.close();
    this.database = null;
  }

  // ---- users ----
  insertUser(user) {
    this.database.prepare(`
      INSERT INTO users (id, username, username_key, display_name, team_id, team_name, group_name, role, password_hash, official_user_id, official_team_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id, user.username, user.usernameKey, user.displayName,
      user.teamId || null, user.teamName || null, user.group || null, user.role,
      user.passwordHash ? JSON.stringify(user.passwordHash) : null,
      user.officialUserId || null, user.officialTeamId || null, user.createdAt
    );
    return user;
  }

  findUserById(id) {
    return rowToUser(this.database.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").get(id));
  }

  findUserByUsernameKey(key) {
    return rowToUser(this.database.prepare("SELECT * FROM users WHERE username_key = ? LIMIT 1").get(key));
  }

  findUserByOfficialId(officialUserId) {
    return rowToUser(this.database.prepare("SELECT * FROM users WHERE official_user_id = ? LIMIT 1").get(officialUserId));
  }

  listUsers() {
    return this.database.prepare("SELECT * FROM users ORDER BY created_at ASC").all().map(rowToUser);
  }

  updateUserPasswordHash(id, passwordHash) {
    const value = passwordHash ? JSON.stringify(passwordHash) : null;
    this.database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(value, id);
  }

  updateUserTeam(id, teamId, teamName) {
    this.database.prepare("UPDATE users SET team_id = ?, team_name = ? WHERE id = ?").run(teamId, teamName, id);
  }

  // ---- teams ----
  insertTeam(team) {
    this.database.prepare(`
      INSERT INTO teams (id, team_name, team_name_key, invite_code, official_team_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(team.id, team.teamName, team.teamNameKey, team.inviteCode, team.officialTeamId || null, team.createdAt);
    return team;
  }

  findTeamById(id) {
    return rowToTeam(this.database.prepare("SELECT * FROM teams WHERE id = ? LIMIT 1").get(id));
  }

  findTeamByOfficialId(officialTeamId) {
    return rowToTeam(this.database.prepare("SELECT * FROM teams WHERE official_team_id = ? LIMIT 1").get(officialTeamId));
  }

  findTeamByNameKey(key) {
    return rowToTeam(this.database.prepare("SELECT * FROM teams WHERE team_name_key = ? LIMIT 1").get(key));
  }

  findTeamByInviteCode(inviteCode) {
    return rowToTeam(this.database.prepare("SELECT * FROM teams WHERE invite_code = ? LIMIT 1").get(inviteCode));
  }

  listTeams() {
    return this.database.prepare("SELECT * FROM teams ORDER BY created_at ASC").all().map(rowToTeam);
  }

  listUsersByTeamId(teamId) {
    return this.database.prepare("SELECT * FROM users WHERE team_id = ? ORDER BY created_at ASC").all(teamId).map(rowToUser);
  }

  updateUser(id, patch) {
    const current = this.findUserById(id);
    if (!current) return false;
    const next = { ...current, ...patch };
    this.database.prepare(`
      UPDATE users SET username = ?, username_key = ?, display_name = ?, team_id = ?, team_name = ?,
        group_name = ?, role = ?, password_hash = ?, official_user_id = ?, official_team_id = ?
      WHERE id = ?
    `).run(
      next.username, next.usernameKey, next.displayName, next.teamId || null, next.teamName || null,
      next.group || null, next.role, next.passwordHash ? JSON.stringify(next.passwordHash) : null,
      next.officialUserId || null, next.officialTeamId || null, id
    );
    return this.findUserById(id);
  }

  updateTeam(id, patch) {
    const current = this.findTeamById(id);
    if (!current) return false;
    const next = { ...current, ...patch };
    this.database.prepare(`
      UPDATE teams SET team_name = ?, team_name_key = ?, invite_code = ?, official_team_id = ?
      WHERE id = ?
    `).run(next.teamName, next.teamNameKey, next.inviteCode, next.officialTeamId || null, id);
    return this.findTeamById(id);
  }

  // ---- sessions ----
  insertSession(session) {
    this.database.prepare(`
      INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(session.id, session.tokenHash, session.userId, session.createdAt, session.expiresAt);
    return session;
  }

  findSessionByTokenHash(tokenHash) {
    return rowToSession(this.database.prepare("SELECT * FROM sessions WHERE token_hash = ? LIMIT 1").get(tokenHash));
  }

  deleteSession(id) {
    this.database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  deleteExpiredSessions(nowIso) {
    this.database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso);
  }

  listSessionsByUserId(userId) {
    return this.database.prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at ASC")
      .all(userId).map(rowToSession);
  }

  countSessions() {
    return Number(this.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count);
  }

  countUsers() {
    return Number(this.database.prepare("SELECT COUNT(*) AS count FROM users").get().count);
  }

  // ---- records ----
  insertRecord(record) {
    const value = serializedRecord(record);
    this.database.prepare(`
      INSERT INTO records (id, owner_user_id, owner_team_id, task_id, record_state, score,
        submitted_at, submitted_at_ms, created_at, created_at_ms, payload_json, payload_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.id, value.ownerUserId, value.ownerTeamId, value.taskId, value.recordState,
      value.score, value.submittedAt, value.submittedAtMs, value.createdAt,
      value.createdAtMs, value.payload, value.payloadSha256
    );
    return record;
  }

  findRecordById(id, { ownerUserId = null, submittedOnly = false } = {}) {
    const row = this.database.prepare("SELECT id, payload_json FROM records WHERE id = ? LIMIT 1").get(id);
    const record = parsedRecord(row);
    if (!record || (ownerUserId && record.ownerUserId !== ownerUserId)
      || (submittedOnly && record.recordState !== "submitted")) return null;
    return record;
  }

  submitRecord(id, ownerUserId, submittedAt) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const record = this.findRecordById(id, { ownerUserId });
      if (!record) {
        this.database.exec("ROLLBACK");
        return null;
      }
      if (record.recordState === "submitted") {
        this.database.exec("COMMIT");
        return { record, duplicate: true };
      }
      record.recordState = "submitted";
      record.submittedAt = submittedAt;
      const payload = JSON.stringify(record);
      const result = this.database.prepare(`
        UPDATE records SET record_state = 'submitted', submitted_at = ?, submitted_at_ms = ?,
          payload_json = ?, payload_sha256 = ?
        WHERE id = ? AND owner_user_id = ? AND record_state = 'saved'
      `).run(submittedAt, timestampMilliseconds(submittedAt), payload, sha256(payload), id, ownerUserId);
      if (Number(result.changes) !== 1) throw new Error("记录提交状态更新冲突。");
      this.database.exec("COMMIT");
      return { record, duplicate: false };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch (_e) {}
      throw error;
    }
  }

  recordCount() {
    return Number(this.database.prepare("SELECT COUNT(*) AS count FROM records").get().count);
  }

  recordPage({ ownerUserId = null, recordState = null, page = 1, pageSize = 250 } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new RangeError("记录分页参数无效。");
    }
    const clauses = [];
    const parameters = [];
    if (ownerUserId) { clauses.push("owner_user_id = ?"); parameters.push(ownerUserId); }
    if (recordState) {
      if (!RECORD_STATES.has(recordState)) throw new TypeError("记录状态无效。");
      clauses.push("record_state = ?");
      parameters.push(recordState);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = Number(this.database.prepare(`SELECT COUNT(*) AS count FROM records ${where}`).get(...parameters).count);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;
    const order = recordState === "submitted" && !ownerUserId
      ? "submitted_at_ms DESC, id DESC"
      : "created_at_ms DESC, id DESC";
    const rows = offset >= total ? [] : this.database.prepare(`
      SELECT id, payload_json FROM records ${where}
      ORDER BY ${order} LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, offset);
    const records = rows.map(parsedRecord);
    return {
      records,
      pagination: {
        page, pageSize, total, totalPages,
        returned: records.length,
        hasPrevious: page > 1,
        hasNext: offset + records.length < total
      }
    };
  }

  allRecords({ recordState = null } = {}) {
    if (recordState && !RECORD_STATES.has(recordState)) throw new TypeError("记录状态无效。");
    const where = recordState ? "WHERE record_state = ?" : "";
    const parameters = recordState ? [recordState] : [];
    const order = recordState === "submitted" ? "submitted_at_ms DESC, id DESC" : "created_at_ms DESC, id DESC";
    return this.database.prepare(`SELECT id, payload_json FROM records ${where} ORDER BY ${order}`)
      .all(...parameters).map(parsedRecord);
  }

  submittedStatsByOwner() {
    const result = new Map();
    const rows = this.database.prepare(`
      SELECT owner_user_id, COUNT(*) AS count, MAX(score) AS highest_score
      FROM records WHERE record_state = 'submitted' GROUP BY owner_user_id
    `).all();
    for (const row of rows) {
      result.set(row.owner_user_id, {
        count: Number(row.count),
        highestScore: Number.isFinite(row.highest_score) ? row.highest_score : null
      });
    }
    return result;
  }

  bestSubmittedTeamTaskScores() {
    const rows = this.database.prepare(`
      SELECT id, owner_user_id, owner_team_id, task_id, score, submitted_at
      FROM (
        SELECT id, owner_user_id, owner_team_id, task_id, score, submitted_at,
          ROW_NUMBER() OVER (
            PARTITION BY
              CASE
                WHEN owner_team_id IS NULL THEN 'user:' || owner_user_id
                ELSE 'team:' || owner_team_id
              END,
              task_id
            ORDER BY score DESC, submitted_at_ms DESC, id ASC
          ) AS score_rank
        FROM records
        WHERE record_state = 'submitted'
          AND score IS NOT NULL AND score >= 0 AND score <= 100
      )
      WHERE score_rank = 1
      ORDER BY submitted_at DESC, id ASC
    `).all();
    return rows.map(row => Object.freeze({
      id: row.id,
      ownerUserId: row.owner_user_id,
      teamId: row.owner_team_id,
      taskId: row.task_id,
      score: Number(row.score),
      recordState: "submitted",
      submittedAt: row.submitted_at
    }));
  }

  queryByTeamTaskState({ ownerTeamId, taskId, recordState = "submitted", limit = 100 } = {}) {
    if (typeof ownerTeamId !== "string" || !ownerTeamId || typeof taskId !== "string" || !taskId
      || !RECORD_STATES.has(recordState) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("队伍任务记录查询参数无效。");
    }
    return this.database.prepare(`
      SELECT id, payload_json FROM records
      WHERE owner_team_id = ? AND task_id = ? AND record_state = ?
      ORDER BY submitted_at_ms DESC, created_at_ms DESC, id DESC LIMIT ?
    `).all(ownerTeamId, taskId, recordState, limit).map(parsedRecord);
  }

  latestWorkspaceByOwnerTask(ownerUserId, taskId, { limit = 100 } = {}) {
    if (typeof ownerUserId !== "string" || !ownerUserId || typeof taskId !== "string" || !taskId
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("工作区历史查询参数无效。");
    }
    const rows = this.database.prepare(`
      SELECT id, payload_json FROM records
      WHERE owner_user_id = ? AND task_id = ?
      ORDER BY created_at_ms DESC, id DESC LIMIT ?
    `).all(ownerUserId, taskId, limit);
    for (const row of rows) {
      let record;
      try { record = parsedRecord(row); } catch (_error) { continue; }
      if (typeof record.workspaceXml !== "string" || record.workspaceXml.length > 128 * 1024) continue;
      try {
        const workspace = JSON.parse(record.workspaceXml);
        if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) continue;
        return Object.freeze({ workspace, updatedAt: record.savedAt || record.createdAt, recordId: record.id });
      } catch (_error) {
        // 跳过损坏的历史工作区，不影响记录本身。
      }
    }
    return null;
  }

  latestOwnerSnapshots(excludedOwnerIds = new Set()) {
    const rows = this.database.prepare(`
      SELECT id, payload_json FROM (
        SELECT id, owner_user_id, payload_json,
          ROW_NUMBER() OVER (PARTITION BY owner_user_id ORDER BY created_at_ms DESC, id DESC) AS owner_row
        FROM records
      ) WHERE owner_row = 1
    `).all();
    return rows.map(parsedRecord).filter(record => !excludedOwnerIds.has(record.ownerUserId));
  }

  // ---- workspaces ----
  workspaceGetAll(ownerUserId) {
    const rows = this.database.prepare(`
      SELECT task_id, workspace_json, workspace_sha256, updated_at
      FROM workspaces WHERE owner_user_id = ? ORDER BY task_id ASC
    `).all(ownerUserId);
    const result = new Map();
    for (const row of rows) {
      let workspace;
      try { workspace = JSON.parse(row.workspace_json); } catch (_error) { continue; }
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) continue;
      result.set(row.task_id, {
        taskId: row.task_id, workspace, updatedAt: row.updated_at, sha256: row.workspace_sha256
      });
    }
    return result;
  }

  workspaceSave(ownerUserId, taskId, workspace, updatedAt, updatedAtMs) {
    const serialized = JSON.stringify(workspace);
    this.database.prepare(`
      INSERT INTO workspaces (owner_user_id, task_id, workspace_json, workspace_sha256, updated_at, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_user_id, task_id) DO UPDATE SET
        workspace_json = excluded.workspace_json,
        workspace_sha256 = excluded.workspace_sha256,
        updated_at = excluded.updated_at,
        updated_at_ms = excluded.updated_at_ms
    `).run(ownerUserId, taskId, serialized, sha256(serialized), updatedAt, updatedAtMs);
    return { taskId, workspace, updatedAt, sha256: sha256(serialized) };
  }

  workspaceSaveIfMatch(ownerUserId, taskId, workspace, expectedSha256, updatedAt, updatedAtMs) {
    const serialized = JSON.stringify(workspace);
    const nextSha256 = sha256(serialized);
    const result = this.database.prepare(`
      UPDATE workspaces SET workspace_json = ?, workspace_sha256 = ?, updated_at = ?, updated_at_ms = ?
      WHERE owner_user_id = ? AND task_id = ? AND workspace_sha256 = ?
    `).run(serialized, nextSha256, updatedAt, updatedAtMs, ownerUserId, taskId, expectedSha256);
    if (result.changes !== 1) {
      const error = new Error("工作区版本已过期。");
      error.code = "WORKSPACE_STALE";
      throw error;
    }
    return { taskId, workspace, updatedAt, sha256: nextSha256 };
  }

  // ---- map configs ----
  upsertMapConfig(taskId, revision, digest, updatedAt, updatedByUserId, layout) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO map_config_versions (task_id, revision, digest, updated_at, updated_by_user_id, layout_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, revision) DO UPDATE SET
          digest = excluded.digest, updated_at = excluded.updated_at,
          updated_by_user_id = excluded.updated_by_user_id, layout_json = excluded.layout_json
      `).run(taskId, revision, digest, updatedAt, updatedByUserId, JSON.stringify(layout));
      this.database.prepare(`
        INSERT INTO map_configs (task_id, current_revision, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET current_revision = excluded.current_revision, updated_at = excluded.updated_at
      `).run(taskId, revision, updatedAt);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch (_e) {}
      throw error;
    }
  }

  getMapConfig(taskId) {
    const current = this.database.prepare("SELECT * FROM map_configs WHERE task_id = ? LIMIT 1").get(taskId);
    if (!current) return null;
    const version = this.database.prepare(
      "SELECT * FROM map_config_versions WHERE task_id = ? AND revision = ? LIMIT 1"
    ).get(taskId, current.current_revision);
    return { taskId, currentRevision: current.current_revision, version: rowToMapVersion(version) };
  }

  listMapConfigs() {
    return this.database.prepare("SELECT task_id FROM map_configs ORDER BY task_id ASC").all()
      .map(row => this.getMapConfig(row.task_id));
  }
}

module.exports = Object.freeze({
  PlatformStore,
  STORE_SCHEMA_VERSION,
  DB_FILE_NAME,
  sha256,
  timestampMilliseconds,
  USER_ID_PATTERN,
  TEAM_ID_PATTERN,
  SESSION_ID_PATTERN,
  RECORD_ID_PATTERN,
  RECORD_STATES
});
