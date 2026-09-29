"use strict";

// Keep editable Blockly state physically separate from scored run records.  A
// workspace write must never lock, migrate, or make the score database fail.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_error) {
  throw new Error("Blockly 工作区快照需要 Node.js 22.5 或更高版本（内置 node:sqlite）。");
}

const WORKSPACE_DATABASE_SCHEMA_VERSION = "chenlong.blockly-workspace-database/v1";
const WORKSPACE_DATABASE_FILE_NAME = "primary-blockly-workspaces.sqlite";
const USER_ID_PATTERN = /^usr_[a-f0-9]{32}$/;
const DEFAULT_MAX_WORKSPACE_BYTES = 128 * 1024;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validIsoTimestamp(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

class BlocklyWorkspaceStore {
  constructor({ dataDir, databasePath = null, taskIds, maxWorkspaceBytes = DEFAULT_MAX_WORKSPACE_BYTES, now = Date.now } = {}) {
    if (typeof dataDir !== "string" || !dataDir) throw new TypeError("Blockly 工作区数据目录不能为空。");
    if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.some(taskId => typeof taskId !== "string" || !taskId)) {
      throw new TypeError("Blockly 工作区任务列表不能为空。");
    }
    if (!Number.isSafeInteger(maxWorkspaceBytes) || maxWorkspaceBytes < 1) {
      throw new TypeError("Blockly 工作区最大字节数无效。");
    }
    if (typeof now !== "function") throw new TypeError("Blockly 工作区时钟无效。");
    this.taskIds = new Set(taskIds);
    this.maxWorkspaceBytes = maxWorkspaceBytes;
    this.now = now;
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.databasePath = path.resolve(databasePath || path.join(this.dataDir, WORKSPACE_DATABASE_FILE_NAME));
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    const metadataTable = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata' LIMIT 1"
    ).get();
    const workspaceTable = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces' LIMIT 1"
    ).get();
    if (workspaceTable && !metadataTable) {
      this.database.close();
      throw new Error("Blockly 工作区数据库缺少版本信息。");
    }
    if (metadataTable) {
      const version = this.database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion' LIMIT 1").get();
      if (!version || version.value !== WORKSPACE_DATABASE_SCHEMA_VERSION) {
        this.database.close();
        throw new Error("Blockly 工作区数据库版本不兼容。");
      }
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workspaces (
        owner_user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        workspace_json TEXT NOT NULL,
        workspace_sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (owner_user_id, task_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS workspaces_owner_updated_idx
        ON workspaces(owner_user_id, updated_at_ms DESC);
    `);
    this.database.prepare(`
      INSERT INTO metadata (key, value) VALUES ('schemaVersion', ?)
      ON CONFLICT(key) DO NOTHING
    `).run(WORKSPACE_DATABASE_SCHEMA_VERSION);
    this.statements = {
      getAll: this.database.prepare(`
        SELECT task_id, workspace_json, workspace_sha256, updated_at
        FROM workspaces WHERE owner_user_id = ? ORDER BY task_id ASC
      `),
      casUpdate: this.database.prepare(`
        UPDATE workspaces SET workspace_json = ?, workspace_sha256 = ?, updated_at = ?, updated_at_ms = ?
        WHERE owner_user_id = ? AND task_id = ? AND workspace_sha256 = ?
      `),
      upsert: this.database.prepare(`
        INSERT INTO workspaces (
          owner_user_id, task_id, workspace_json, workspace_sha256, updated_at, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_user_id, task_id) DO UPDATE SET
          workspace_json = excluded.workspace_json,
          workspace_sha256 = excluded.workspace_sha256,
          updated_at = excluded.updated_at,
          updated_at_ms = excluded.updated_at_ms
      `)
    };
  }

  assertOwnerUserId(ownerUserId) {
    if (typeof ownerUserId !== "string" || !USER_ID_PATTERN.test(ownerUserId)) {
      throw new TypeError("Blockly 工作区用户身份无效。");
    }
    return ownerUserId;
  }

  assertTaskId(taskId) {
    if (typeof taskId !== "string" || !this.taskIds.has(taskId)) {
      throw new TypeError("Blockly 工作区任务无效。");
    }
    return taskId;
  }

  normalizeWorkspace(workspace) {
    if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
      throw new TypeError("Blockly 工作区内容无效。");
    }
    let serialized;
    try {
      serialized = JSON.stringify(workspace);
    } catch (_error) {
      throw new TypeError("Blockly 工作区无法序列化。");
    }
    if (Buffer.byteLength(serialized, "utf8") > this.maxWorkspaceBytes) {
      throw new RangeError("Blockly 工作区内容过大。");
    }
    return { workspace: JSON.parse(serialized), serialized };
  }

  parsedWorkspace(row) {
    if (!row || typeof row.task_id !== "string" || !this.taskIds.has(row.task_id)
      || typeof row.workspace_json !== "string" || typeof row.workspace_sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(row.workspace_sha256) || !validIsoTimestamp(row.updated_at)) {
      throw new Error("Blockly 工作区存档已损坏。");
    }
    if (Buffer.byteLength(row.workspace_json, "utf8") > this.maxWorkspaceBytes
      || sha256(row.workspace_json) !== row.workspace_sha256) {
      throw new Error("Blockly 工作区存档校验失败。");
    }
    let workspace;
    try { workspace = JSON.parse(row.workspace_json); } catch (_error) {
      throw new Error("Blockly 工作区存档不是有效 JSON。");
    }
    if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
      throw new Error("Blockly 工作区存档格式无效。");
    }
    return Object.freeze({ taskId: row.task_id, workspace, updatedAt: row.updated_at, sha256: row.workspace_sha256 });
  }

  getAll(ownerUserId) {
    const owner = this.assertOwnerUserId(ownerUserId);
    const result = new Map();
    for (const row of this.statements.getAll.all(owner)) {
      const item = this.parsedWorkspace(row);
      result.set(item.taskId, item);
    }
    return result;
  }

  save(ownerUserId, taskId, workspace) {
    const owner = this.assertOwnerUserId(ownerUserId);
    const task = this.assertTaskId(taskId);
    const normalized = this.normalizeWorkspace(workspace);
    const updatedAt = new Date(Number(this.now())).toISOString();
    this.statements.upsert.run(
      owner,
      task,
      normalized.serialized,
      sha256(normalized.serialized),
      updatedAt,
      Date.parse(updatedAt)
    );
    return Object.freeze({ taskId: task, workspace: normalized.workspace, updatedAt });
  }

  saveIfMatch(ownerUserId, taskId, workspace, expectedSha256) {
    const owner = this.assertOwnerUserId(ownerUserId);
    const task = this.assertTaskId(taskId);
    if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new TypeError("Blockly 工作区版本无效。 ");
    }
    const normalized = this.normalizeWorkspace(workspace);
    const updatedAt = new Date(Number(this.now())).toISOString();
    const nextSha256 = sha256(normalized.serialized);
    const result = this.statements.casUpdate.run(
      normalized.serialized, nextSha256, updatedAt, Date.parse(updatedAt), owner, task, expectedSha256
    );
    if (result.changes !== 1) {
      const error = new Error("Blockly 工作区版本已过期。 ");
      error.code = "WORKSPACE_STALE";
      throw error;
    }
    return Object.freeze({ taskId: task, workspace: normalized.workspace, updatedAt, sha256: nextSha256 });
  }

  close() {
    if (!this.database) return;
    this.database.close();
    this.database = null;
  }
}

module.exports = Object.freeze({
  WORKSPACE_DATABASE_SCHEMA_VERSION,
  WORKSPACE_DATABASE_FILE_NAME,
  DEFAULT_MAX_WORKSPACE_BYTES,
  BlocklyWorkspaceStore
});
