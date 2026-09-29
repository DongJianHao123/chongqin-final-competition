"use strict";

// This store is deliberately independent from the run archive.  A participant
// has at most one editable source snapshot per task, so retaining it must never
// consume, evict, or otherwise affect evidence used for scoring/submission.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE_SOURCE_STORE_SCHEMA_VERSION = "chenlong.workspace-source-store/v1";
const USER_ID_PATTERN = /^usr_[a-f0-9]{32}$/;
const DEFAULT_MAX_SOURCE_BYTES = 128 * 1024;

class WorkspaceSourceStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceSourceStoreError";
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validIsoTimestamp(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

class WorkspaceSourceStore {
  constructor({ rootDir, taskIds, maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES, now = Date.now } = {}) {
    if (typeof rootDir !== "string" || !rootDir) {
      throw new TypeError("workspace source rootDir is required");
    }
    if (!Array.isArray(taskIds) || taskIds.length === 0
      || taskIds.some(taskId => typeof taskId !== "string" || !taskId)) {
      throw new TypeError("workspace source taskIds are required");
    }
    if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1) {
      throw new TypeError("workspace source maxSourceBytes must be a positive integer");
    }
    if (typeof now !== "function") throw new TypeError("workspace source now must be a function");
    this.rootDir = path.resolve(rootDir);
    this.taskIds = new Set(taskIds);
    this.maxSourceBytes = maxSourceBytes;
    this.now = now;
    this.writeTails = new Map();
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
  }

  assertOwnerUserId(ownerUserId) {
    if (typeof ownerUserId !== "string" || !USER_ID_PATTERN.test(ownerUserId)) {
      throw new WorkspaceSourceStoreError("INVALID_OWNER", "workspace source owner is invalid");
    }
    return ownerUserId;
  }

  assertTaskId(taskId) {
    if (typeof taskId !== "string" || !this.taskIds.has(taskId)) {
      throw new WorkspaceSourceStoreError("INVALID_TASK", "workspace source task is invalid");
    }
    return taskId;
  }

  normalizeSource(source) {
    if (typeof source !== "string") {
      throw new WorkspaceSourceStoreError("INVALID_SOURCE", "workspace source must be a string");
    }
    if (Buffer.byteLength(source, "utf8") > this.maxSourceBytes) {
      throw new WorkspaceSourceStoreError("SOURCE_TOO_LARGE", "workspace source exceeds the size limit");
    }
    return source;
  }

  filePath(ownerUserId, taskId) {
    this.assertOwnerUserId(ownerUserId);
    this.assertTaskId(taskId);
    // A digest keeps filenames portable and avoids exposing user identifiers in
    // ordinary directory listings. The authenticated owner is also embedded in
    // the validated JSON envelope below.
    return path.join(this.rootDir, `${sha256(`${ownerUserId}\u0000${taskId}`)}.json`);
  }

  parseStored(buffer, ownerUserId, taskId) {
    if (buffer.length > this.maxSourceBytes + 8 * 1024) {
      throw new WorkspaceSourceStoreError("STORED_SOURCE_INVALID", "stored workspace source is too large");
    }
    let value;
    try {
      value = JSON.parse(buffer.toString("utf8"));
    } catch (_error) {
      throw new WorkspaceSourceStoreError("STORED_SOURCE_INVALID", "stored workspace source is invalid JSON");
    }
    const expectedKeys = new Set([
      "schemaVersion", "ownerUserId", "taskId", "source", "sourceSha256", "updatedAt"
    ]);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== expectedKeys.size
      || Object.keys(value).some(key => !expectedKeys.has(key))
      || value.schemaVersion !== WORKSPACE_SOURCE_STORE_SCHEMA_VERSION
      || value.ownerUserId !== ownerUserId || value.taskId !== taskId
      || typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceSha256)
      || !validIsoTimestamp(value.updatedAt)) {
      throw new WorkspaceSourceStoreError("STORED_SOURCE_INVALID", "stored workspace source envelope is invalid");
    }
    const source = this.normalizeSource(value.source);
    if (sha256(source) !== value.sourceSha256) {
      throw new WorkspaceSourceStoreError("STORED_SOURCE_INVALID", "stored workspace source digest does not match");
    }
    return Object.freeze({ source, updatedAt: value.updatedAt });
  }

  async read(ownerUserId, taskId) {
    const filePath = this.filePath(ownerUserId, taskId);
    let buffer;
    try {
      buffer = await fs.promises.readFile(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    return this.parseStored(buffer, ownerUserId, taskId);
  }

  async save(ownerUserId, taskId, source) {
    const normalizedOwnerUserId = this.assertOwnerUserId(ownerUserId);
    const normalizedTaskId = this.assertTaskId(taskId);
    const normalizedSource = this.normalizeSource(source);
    const filePath = this.filePath(normalizedOwnerUserId, normalizedTaskId);
    const previous = this.writeTails.get(filePath) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const updatedAt = new Date(Number(this.now())).toISOString();
      const envelope = {
        schemaVersion: WORKSPACE_SOURCE_STORE_SCHEMA_VERSION,
        ownerUserId: normalizedOwnerUserId,
        taskId: normalizedTaskId,
        source: normalizedSource,
        sourceSha256: sha256(normalizedSource),
        updatedAt
      };
      const temporaryPath = path.join(
        this.rootDir,
        `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`
      );
      let handle = null;
      try {
        handle = await fs.promises.open(temporaryPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.promises.rename(temporaryPath, filePath);
      } finally {
        if (handle) {
          try { await handle.close(); } catch (_error) {}
        }
        try { await fs.promises.unlink(temporaryPath); } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      return Object.freeze({ source: normalizedSource, updatedAt });
    });
    this.writeTails.set(filePath, operation);
    try {
      return await operation;
    } finally {
      if (this.writeTails.get(filePath) === operation) this.writeTails.delete(filePath);
    }
  }
}

module.exports = Object.freeze({
  WORKSPACE_SOURCE_STORE_SCHEMA_VERSION,
  DEFAULT_MAX_SOURCE_BYTES,
  WorkspaceSourceStoreError,
  WorkspaceSourceStore
});
