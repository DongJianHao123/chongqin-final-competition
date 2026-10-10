"use strict";

// Blockly 竞赛 API 逻辑，吸收自 projects/blockly-page3/server.js 的 handleApi。
// 由根网关 server.js 挂载在 /blockly/api/* 下：剥掉 /blockly 前缀后传入 url，
// 因此本模块的 url.pathname 均以 /api/ 开头。
//
// 认证改为统一 auth：/api/auth/me、/api/auth/team-invite、/api/auth/logout 是
// 对 PlatformAuth 的薄适配；本地的 register/login 已随「登录统一到平台页」移除。
// 联邦签名（platform-contract）与 Blockly 本地用户表不再需要。
const crypto = require("node:crypto");
const primaryGuangyangScoring = require("../projects/blockly-page3/guangyang-scoring.js");
const primaryGuangyangMaps = require("../projects/blockly-page3/guangyang-map-config.js");
const competitionWindow = require("../projects/blockly-page3/competition-window.js");
const { STORE_SCHEMA_VERSION } = require("./platform-store.js");

const AUTH_COOKIE_NAME = "chenlong_session";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PROGRAM_CHARS = 128 * 1024;
const MAX_WORKSPACE_BYTES = 128 * 1024;
const DEFAULT_RECORD_PAGE_SIZE = 250;
const MAX_RECORD_PAGE_SIZE = 1_000;
const LEGACY_RECORD_PAGE_SIZE = 1_000;
const MAX_RECORD_PAGE_NUMBER = 1_000_000;
const MAX_EXECUTION_TRACE_ENTRIES = 64;
const CAPABILITY_USAGE_SCHEMA_VERSION = "chenlong.blockly-runtime-capability-usage/v1";
const CAPABILITY_USAGE_SOURCE = "runtime_reported";
const NAVIGATION_SENSOR_METHODS = Object.freeze([
  "odometry", "road_state", "map_graph", "mission", "task_state", "release_preview"
]);
const ROAD_CONTROL_METHODS = Object.freeze(["follow_road", "take_exit"]);
const VISION_METHODS = Object.freeze([
  "sees", "count", "detect", "near", "centered", "direction", "distance_to", "approach", "observe"
]);
const EXECUTION_METHODS = Object.freeze([
  ...NAVIGATION_SENSOR_METHODS,
  ...ROAD_CONTROL_METHODS,
  ...VISION_METHODS
]);
const EXECUTION_METHOD_SET = new Set(EXECUTION_METHODS);
const PRIMARY_TASKS = Object.freeze({
  "GYI-PRIMARY-01": Object.freeze({ name: "广阳岛综合任务1" })
});
const DEFAULT_PARTICIPANT_GROUP = "primary";
const PARTICIPANT_GROUP_ALIASES = Object.freeze({
  primary: "primary", primary_low: "primary", primary_high: "primary", primary_school: "primary",
  "小学组": "primary", "小学组（1-3年级）": "primary", "小学组(1-3年级)": "primary",
  "小学组（4-6年级）": "primary", "小学组(4-6年级)": "primary",
  junior: "junior", middle_school: "junior", "初中组": "junior",
  high: "high", high_school: "high", senior: "high", "高中组": "high"
});
const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; "
    + "script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data: blob: http: https:; media-src 'self' blob: http: https:; "
    + "connect-src 'self' blob: http: https:; worker-src 'self' blob:",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()"
});

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

function canonicalParticipantGroup(value) {
  const key = String(value || DEFAULT_PARTICIPANT_GROUP).normalize("NFKC").trim().toLowerCase();
  return PARTICIPANT_GROUP_ALIASES[key] || DEFAULT_PARTICIPANT_GROUP;
}

function mapDigest(taskId, revision, layout) {
  return sha256(JSON.stringify({ taskId, revision, layout }));
}

function readCookie(request, name) {
  const pairs = String(request.headers.cookie || "").split(";");
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return null;
}

function normalizeOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

function requestHostOrigin(request) {
  const host = String(request.headers.host || "").trim().toLowerCase();
  if (!host) return "";
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const protocol = ["http", "https"].includes(forwardedProtocol)
    ? forwardedProtocol
    : request.socket.encrypted ? "https" : "http";
  return normalizeOrigin(`${protocol}://${host}`);
}

function sendJson(response, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store, max-age=0",
    ...SECURITY_HEADERS,
    ...headers
  });
  response.end(body);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new HttpError(413, "REQUEST_TOO_LARGE", "请求内容过大。"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        reject(new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "请求格式必须是 JSON。"));
        return;
      }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (_error) {
        reject(new HttpError(400, "INVALID_JSON", "请求内容不是有效 JSON。"));
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        reject(new HttpError(400, "INVALID_REQUEST", "请求内容格式不正确。"));
        return;
      }
      resolve(value);
    });
  });
}

function normalizeExecutionTrace(value) {
  if (!Array.isArray(value) || value.length > MAX_EXECUTION_TRACE_ENTRIES) {
    throw new HttpError(400, "INVALID_EXECUTION_TRACE", "运行时能力调用记录格式不正确。 ");
  }
  const methods = new Set();
  for (const method of value) {
    if (typeof method !== "string" || !EXECUTION_METHOD_SET.has(method)) {
      throw new HttpError(400, "INVALID_EXECUTION_TRACE", "运行时能力调用记录包含不支持的方法。 ");
    }
    methods.add(method);
  }
  return EXECUTION_METHODS.filter(method => methods.has(method));
}

function storedExecutionTrace(value) {
  if (value === undefined) return [];
  try {
    return normalizeExecutionTrace(value);
  } catch (_error) {
    return [];
  }
}

function deriveCapabilityUsage(executionTrace) {
  const methods = new Set(executionTrace);
  return {
    schemaVersion: CAPABILITY_USAGE_SCHEMA_VERSION,
    source: CAPABILITY_USAGE_SOURCE,
    navigationSensorMethods: NAVIGATION_SENSOR_METHODS.filter(method => methods.has(method)),
    roadControlMethods: ROAD_CONTROL_METHODS.filter(method => methods.has(method)),
    visionMethods: VISION_METHODS.filter(method => methods.has(method))
  };
}

function runtimeCapabilityForRecord(record) {
  const executionTrace = storedExecutionTrace(record?.executionTrace);
  return { executionTrace, capabilityUsage: deriveCapabilityUsage(executionTrace) };
}

function strictPositiveIntegerQuery(url, name, fallback, maximum) {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return fallback;
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) {
    throw new HttpError(400, "INVALID_PAGINATION", `${name} 必须是正整数。`);
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new HttpError(400, "INVALID_PAGINATION", `${name} 超出允许范围。`);
  }
  return value;
}

function recordPagination(url) {
  const legacy = !url.searchParams.has("page") && !url.searchParams.has("pageSize");
  return {
    legacy,
    page: strictPositiveIntegerQuery(url, "page", 1, MAX_RECORD_PAGE_NUMBER),
    pageSize: strictPositiveIntegerQuery(
      url,
      "pageSize",
      legacy ? LEGACY_RECORD_PAGE_SIZE : DEFAULT_RECORD_PAGE_SIZE,
      MAX_RECORD_PAGE_SIZE
    )
  };
}

function createBlocklyApi({ store, auth, publicOrigin = "" }) {
  if (!store || typeof store.findRecordById !== "function") {
    throw new TypeError("createBlocklyApi 需要 PlatformStore 实例。");
  }
  if (!auth || typeof auth.authenticate !== "function") {
    throw new TypeError("createBlocklyApi 需要 PlatformAuth 实例。");
  }
  const PUBLIC_ORIGIN = String(publicOrigin).replace(/\/$/, "");

  function toHttpError(error) {
    if (error instanceof HttpError) return error;
    if (error && Number.isInteger(error.statusCode)) {
      return new HttpError(error.statusCode, error.code || "REQUEST_FAILED", error.message);
    }
    return error;
  }

  function assertSameOrigin(request) {
    const origin = normalizeOrigin(request.headers.origin);
    if (!origin) return;
    const trusted = new Set([
      normalizeOrigin(PUBLIC_ORIGIN),
      requestHostOrigin(request)
    ].filter(Boolean));
    if (!trusted.has(origin)) {
      throw new HttpError(403, "CROSS_ORIGIN_REQUEST", "请求来源不受信任，请刷新页面后重试。");
    }
  }

  function assertCompetitionSubmissionOpen(request = null) {
    if (competitionWindow.submissionsOpen()) return;
    request?.resume?.();
    throw new HttpError(
      403,
      competitionWindow.SUBMISSION_CLOSED_CODE,
      competitionWindow.SUBMISSION_CLOSED_MESSAGE
    );
  }

  function principal(request) {
    const token = readCookie(request, AUTH_COOKIE_NAME);
    let result;
    try {
      result = auth.authenticate(token);
    } catch (error) {
      throw toHttpError(error);
    }
    const user = store.findUserById(result.user.id);
    if (!user) throw new HttpError(500, "AUTH_STORE_CORRUPTED", "登录账户数据不完整，请联系管理员。");
    return { user, session: result.session };
  }

  function requireAdmin(request) {
    const account = principal(request);
    if (account.user.role !== "admin") throw new HttpError(403, "ADMIN_REQUIRED", "需要管理员权限。 ");
    return account;
  }

  function teamForUser(user) {
    if (user.role === "admin") return null;
    return Object.freeze({ id: user.teamId, teamName: user.teamName });
  }

  function publicUser(user) {
    const team = teamForUser(user);
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      teamId: team?.id || null,
      teamName: team?.teamName || null,
      group: user.role === "admin" ? null : canonicalParticipantGroup(user.group),
      role: user.role === "admin" ? "admin" : "user",
      createdAt: user.createdAt
    };
  }

  function ownerSnapshot(user) {
    const team = teamForUser(user);
    return {
      ownerUsername: user.username,
      ownerDisplayName: user.displayName,
      ownerTeamId: team?.id || null,
      ownerTeamName: team?.teamName || null,
      ownerGroup: user.role === "admin" ? null : canonicalParticipantGroup(user.group)
    };
  }

  function scoreRun({ completed, taskProgress, checkpointCount, blockedMoves, offRoadEpisodes, offRoadDurationMs, durationMs, checkpointTotal }) {
    return primaryGuangyangScoring.scoreRun({
      completed,
      checkpointCount,
      checkpointTotal,
      taskCompleted: taskProgress.completed,
      taskTotal: taskProgress.total,
      collisionCount: blockedMoves,
      offRoadEpisodes,
      offRoadDurationMs,
      durationMs
    });
  }

  function currentMapVersion(taskId) {
    const config = store.getMapConfig(taskId);
    if (!config || !Number.isInteger(config.currentRevision) || !config.version) {
      throw new HttpError(500, "MAP_DATA_CORRUPTED", "比赛地图配置不完整，请联系管理员处理。 ");
    }
    return config.version;
  }

  function mapVersion(taskId, revision = null, digest = null) {
    const version = revision === null
      ? currentMapVersion(taskId)
      : store.getMapVersion(taskId, revision);
    if (!version || (digest !== null && version.digest !== digest)) {
      throw new HttpError(409, "MAP_VERSION_NOT_FOUND", "本次运行使用的地图版本已无法核对，请刷新任务后重新运行。 ");
    }
    return version;
  }

  function publicMapConfig(taskId, version = mapVersion(taskId)) {
    const task = PRIMARY_TASKS[taskId];
    return {
      taskId,
      taskName: task.name,
      revision: version.revision,
      digest: version.digest,
      updatedAt: version.updatedAt,
      layout: primaryGuangyangMaps.clone(version.layout)
    };
  }

  function allCurrentMapConfigs() {
    return Object.keys(PRIMARY_TASKS).map(taskId => publicMapConfig(taskId));
  }

  function recordSummary(record) {
    const runtimeCapability = runtimeCapabilityForRecord(record);
    return {
      id: record.id,
      taskId: record.taskId,
      score: record.score,
      scoreMaximum: 100,
      durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
      completed: record.completed,
      checkpointCount: record.checkpointCount,
      checkpointTotal: record.checkpointTotal,
      taskCompleted: Number.isInteger(record.taskCompleted) ? record.taskCompleted : null,
      taskTotal: Number.isInteger(record.taskTotal) ? record.taskTotal : null,
      targetDeliveredCount: Number.isInteger(record.targetDeliveredCount) ? record.targetDeliveredCount : null,
      distractorClearedCount: Number.isInteger(record.distractorClearedCount) ? record.distractorClearedCount : null,
      failedObstacleCount: Number.isInteger(record.failedObstacleCount) ? record.failedObstacleCount : null,
      goalReached: typeof record.goalReached === "boolean" ? record.goalReached : null,
      mapRevision: Number.isInteger(record.mapRevision) ? record.mapRevision : null,
      mapDigest: record.mapDigest || null,
      recordState: record.recordState,
      savedAt: record.savedAt,
      submittedAt: record.submittedAt,
      createdAt: record.createdAt,
      executionTrace: runtimeCapability.executionTrace,
      capabilityUsage: runtimeCapability.capabilityUsage,
      blockCount: Number.isInteger(record.blockCount) ? record.blockCount : null,
      codeLineCount: Number.isInteger(record.codeLineCount) ? record.codeLineCount : null,
      authoritative: false
    };
  }

  function adminUserSummary(user, submittedStats) {
    const stats = submittedStats.get(user.id) || { count: 0, highestScore: null };
    return {
      ...publicUser(user),
      recordCount: stats.count,
      highestScore: stats.highestScore
    };
  }

  function allAdminUserSummaries() {
    const submittedStats = store.submittedStatsByOwner();
    const summaries = store.listUsers().map(user => adminUserSummary(user, submittedStats));
    const known = new Set(summaries.map(user => user.id));
    for (const record of store.latestOwnerSnapshots(known)) {
      if (typeof record.ownerUsername !== "string") continue;
      const stats = submittedStats.get(record.ownerUserId) || { count: 0, highestScore: null };
      summaries.push({
        id: record.ownerUserId,
        username: record.ownerUsername,
        displayName: record.ownerDisplayName || record.ownerUsername,
        teamId: record.ownerTeamId || null,
        teamName: record.ownerTeamName || null,
        group: record.ownerGroup == null ? null : canonicalParticipantGroup(record.ownerGroup),
        role: "user",
        createdAt: record.createdAt,
        recordCount: stats.count,
        highestScore: stats.highestScore
      });
    }
    return summaries.sort((left, right) => left.username.localeCompare(right.username, "zh-CN"));
  }

  function adminRecordSummary(record, usersById = null) {
    const owner = usersById
      ? usersById.get(record.ownerUserId)
      : store.findUserById(record.ownerUserId);
    const ownerSnapshotUser = typeof record.ownerUsername === "string"
      ? {
          id: record.ownerUserId,
          username: record.ownerUsername,
          displayName: record.ownerDisplayName || record.ownerUsername,
          teamId: record.ownerTeamId || null,
          teamName: record.ownerTeamName || null,
          group: record.ownerGroup == null ? null : canonicalParticipantGroup(record.ownerGroup),
          role: "user",
          createdAt: record.createdAt
        }
      : null;
    return {
      ...recordSummary(record),
      taskName: record.taskName,
      durationMs: record.durationMs,
      user: ownerSnapshotUser || (owner ? publicUser(owner) : null)
    };
  }

  function adminRecordDetail(record) {
    return { ...adminRecordSummary(record), programCode: record.programCode, workspaceXml: record.workspaceXml, scoreBreakdown: record.scoreBreakdown };
  }

  async function handle(request, response, url) {
    if (url.pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-health/v1",
        status: "ok",
        capacity: {
          maxUsers: auth.maxUsers,
          storeWriteBatchMs: 0,
          users: store.countUsers(),
          records: store.recordCount(),
          recordStorage: STORE_SCHEMA_VERSION,
          workspaceStorage: STORE_SCHEMA_VERSION
        },
        authentication: { mode: "unified" },
        competition: competitionWindow.publicSubmissionWindow(),
        authoritative: false
      });
      return;
    }
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      const { user } = principal(request);
      sendJson(response, 200, { schemaVersion: "chenlong.blockly-auth/v1", authenticated: true, user: publicUser(user), authoritative: false });
      return;
    }
    if (url.pathname === "/api/auth/team-invite" && request.method === "GET") {
      const { user } = principal(request);
      const team = teamForUser(user);
      if (!team) throw new HttpError(403, "ADMIN_HAS_NO_TEAM", "管理员账户没有队伍邀请码。 ");
      const invite = auth.getTeamInviteForUser(user.id);
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-team-invite/v1",
        teamName: invite.teamName,
        inviteCode: invite.inviteCode,
        authoritative: false
      });
      return;
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      assertSameOrigin(request);
      const token = readCookie(request, AUTH_COOKIE_NAME);
      if (token) auth.logout(token);
      response.writeHead(204, {
        "Set-Cookie": `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        "Cache-Control": "no-store, max-age=0"
      });
      response.end();
      return;
    }
    if (url.pathname === "/api/workspaces" && request.method === "GET") {
      const { user } = principal(request);
      const stored = store.workspaceGetAll(user.id);
      const workspaces = {};
      for (const taskId of Object.keys(PRIMARY_TASKS)) {
        const draft = stored.get(taskId);
        if (draft) {
          workspaces[taskId] = {
            workspace: draft.workspace,
            updatedAt: draft.updatedAt,
            source: "draft",
            sha256: draft.sha256
          };
          continue;
        }
        const historical = store.latestWorkspaceByOwnerTask(user.id, taskId);
        workspaces[taskId] = historical
          ? { workspace: historical.workspace, updatedAt: historical.updatedAt, source: "run-record" }
          : null;
      }
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-workspaces/v1",
        workspaces,
        storageAvailable: true,
        authoritative: false
      });
      return;
    }
    const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/(GYI-PRIMARY-01)$/);
    if (workspaceMatch) {
      if (request.method !== "PUT") throw new HttpError(405, "METHOD_NOT_ALLOWED", "工作区接口只支持保存。 ");
      assertSameOrigin(request);
      const { user } = principal(request);
      const body = await parseJson(request);
      if (!exactKeys(body, ["workspace"])) {
        throw new HttpError(400, "INVALID_WORKSPACE", "工作区保存内容不正确。 ");
      }
      const workspace = body.workspace;
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
        throw new HttpError(400, "INVALID_WORKSPACE", "工作区保存内容不正确。 ");
      }
      let serialized;
      try {
        serialized = JSON.stringify(workspace);
      } catch (_error) {
        throw new HttpError(400, "INVALID_WORKSPACE", "工作区保存内容不正确。 ");
      }
      if (Buffer.byteLength(serialized, "utf8") > MAX_WORKSPACE_BYTES) {
        throw new HttpError(413, "WORKSPACE_TOO_LARGE", "工作区内容过大。 ");
      }
      const updatedAt = nowIso();
      const saved = store.workspaceSave(user.id, workspaceMatch[1], workspace, updatedAt, Date.parse(updatedAt));
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-workspace-save-receipt/v1",
        taskId: saved.taskId,
        updatedAt: saved.updatedAt,
        sha256: saved.sha256 || sha256(JSON.stringify(saved.workspace)),
        authoritative: false
      });
      return;
    }
    if (url.pathname === "/api/maps" && request.method === "GET") {
      principal(request);
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-maps/v1",
        maps: allCurrentMapConfigs(),
        authoritative: false
      });
      return;
    }
    if (url.pathname === "/api/admin/maps" && request.method === "GET") {
      requireAdmin(request);
      const maps = allCurrentMapConfigs().map(config => ({
        ...config,
        versionCount: store.countMapVersions(config.taskId)
      }));
      sendJson(response, 200, { schemaVersion: "chenlong.blockly-admin-maps/v1", maps, authoritative: false });
      return;
    }
    const adminMapMatch = url.pathname.match(/^\/api\/admin\/maps\/(GYI-PRIMARY-01)$/);
    if (adminMapMatch && request.method === "PUT") {
      const { user } = requireAdmin(request);
      assertSameOrigin(request);
      const body = await parseJson(request);
      if (!exactKeys(body, ["baseRevision", "layout"]) || !Number.isInteger(body.baseRevision) || body.baseRevision < 1) {
        throw new HttpError(400, "INVALID_MAP_CONFIG", "地图保存内容格式不正确。 ");
      }
      const taskId = adminMapMatch[1];
      const config = store.getMapConfig(taskId);
      if (!config || !Number.isInteger(config.currentRevision)) {
        throw new HttpError(500, "MAP_DATA_CORRUPTED", "比赛地图配置不完整，请联系管理员处理。 ");
      }
      if (body.baseRevision !== config.currentRevision) {
        throw new HttpError(409, "MAP_REVISION_CONFLICT", "地图已被其他管理员更新，请刷新后再保存。 ");
      }
      let layout;
      try {
        layout = primaryGuangyangMaps.normalizeLayout(taskId, body.layout);
      } catch (error) {
        throw new HttpError(400, "INVALID_MAP_CONFIG", `${error.message}。 `);
      }
      const revision = config.currentRevision + 1;
      const digest = mapDigest(taskId, revision, layout);
      const updatedAt = nowIso();
      store.upsertMapConfig(taskId, revision, digest, updatedAt, user.id, layout);
      const version = { revision, digest, updatedAt, updatedByUserId: user.id, layout };
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-admin-map-save-receipt/v1",
        map: publicMapConfig(taskId, version),
        authoritative: false
      });
      return;
    }
    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      requireAdmin(request);
      const users = allAdminUserSummaries();
      sendJson(response, 200, { schemaVersion: "chenlong.blockly-admin-users/v1", users, authoritative: false });
      return;
    }
    if (url.pathname === "/api/admin/records" && request.method === "GET") {
      requireAdmin(request);
      const pagination = recordPagination(url);
      const usersById = new Map(store.listUsers().map(user => [user.id, user]));
      const selected = store.recordPage({
        recordState: "submitted",
        page: pagination.page,
        pageSize: pagination.pageSize
      });
      const records = selected.records.map(record => adminRecordSummary(record, usersById));
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-admin-records/v1",
        records,
        pagination: {
          ...selected.pagination,
          truncated: pagination.legacy && selected.pagination.total > records.length
        },
        authoritative: false
      });
      return;
    }
    if (url.pathname === "/api/admin/team-task-scores" && request.method === "GET") {
      requireAdmin(request);
      if (url.search !== "") {
        throw new HttpError(400, "INVALID_TEAM_TASK_SCORE_QUERY", "队伍任务最高分接口不接受查询参数。 ");
      }
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-team-task-scores/v1",
        records: store.bestSubmittedTeamTaskScores(),
        authoritative: false
      });
      return;
    }
    const adminRecordDetailMatch = url.pathname.match(/^\/api\/admin\/records\/(run_[a-f0-9]{32})$/);
    if (adminRecordDetailMatch && request.method === "GET") {
      requireAdmin(request);
      const record = store.findRecordById(adminRecordDetailMatch[1], { submittedOnly: true });
      if (!record) throw new HttpError(404, "RECORD_NOT_FOUND", "没有找到这条正式提交记录。");
      sendJson(response, 200, { schemaVersion: "chenlong.blockly-admin-record-detail/v1", record: adminRecordDetail(record), authoritative: false });
      return;
    }
    if (url.pathname === "/api/admin/export/users" && request.method === "GET") {
      requireAdmin(request);
      const users = allAdminUserSummaries();
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-admin-users-export/v1",
        exportedAt: nowIso(),
        users,
        authoritative: false
      }, { "Content-Disposition": "attachment; filename=blockly-users.json" });
      return;
    }
    if (url.pathname === "/api/admin/export/records" && request.method === "GET") {
      requireAdmin(request);
      const usersById = new Map(store.listUsers().map(user => [user.id, user]));
      const records = store.allRecords({ recordState: "submitted" })
        .map(record => ({
          ...adminRecordSummary(record, usersById),
          programCode: record.programCode,
          workspaceXml: record.workspaceXml,
          scoreBreakdown: record.scoreBreakdown
        }));
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-admin-records-export/v1",
        exportedAt: nowIso(),
        records,
        authoritative: false
      }, { "Content-Disposition": "attachment; filename=blockly-records.json" });
      return;
    }
    if (url.pathname === "/api/records" && request.method === "GET") {
      const { user } = principal(request);
      const pagination = recordPagination(url);
      const selected = store.recordPage({
        ownerUserId: user.id,
        page: pagination.page,
        pageSize: pagination.pageSize
      });
      const records = selected.records.map(recordSummary);
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-records/v1",
        records,
        pagination: {
          ...selected.pagination,
          truncated: pagination.legacy && selected.pagination.total > records.length
        },
        authoritative: false
      });
      return;
    }
    const detailMatch = url.pathname.match(/^\/api\/records\/(run_[a-f0-9]{32})$/);
    if (detailMatch && request.method === "GET") {
      const { user } = principal(request);
      const record = store.findRecordById(detailMatch[1], { ownerUserId: user.id });
      if (!record) throw new HttpError(404, "RECORD_NOT_FOUND", "没有找到这条运行记录。");
      sendJson(response, 200, { schemaVersion: "chenlong.blockly-record-detail/v1", record: { ...record, authoritative: false }, authoritative: false });
      return;
    }
    const submitMatch = url.pathname.match(/^\/api\/records\/(run_[a-f0-9]{32})\/submit$/);
    if (submitMatch && request.method === "POST") {
      assertCompetitionSubmissionOpen(request);
      const { user } = principal(request);
      assertSameOrigin(request);
      const body = await parseJson(request);
      if (!exactKeys(body, [])) throw new HttpError(400, "INVALID_SUBMIT_REQUEST", "提交请求格式不正确。 ");
      assertCompetitionSubmissionOpen();
      const submission = store.submitRecord(submitMatch[1], user.id, nowIso());
      if (!submission) throw new HttpError(404, "RECORD_NOT_FOUND", "没有找到这条运行记录。 ");
      const { record, duplicate } = submission;
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-record-submit-receipt/v1",
        record: recordSummary(record),
        duplicate,
        authoritative: false
      });
      return;
    }
    if (url.pathname === "/api/records" && request.method === "POST") {
      const { user } = principal(request);
      assertSameOrigin(request);
      const body = await parseJson(request);

      if (body.target === "real") {
        if (!exactKeys(body, ["target", "taskId", "durationMs", "programCode", "workspaceXml", "blockCount", "codeLineCount"])) {
          throw new HttpError(400, "INVALID_RECORD", "运行记录格式不正确。 ");
        }
        const realTask = PRIMARY_TASKS[body.taskId] || null;
        if (!Number.isSafeInteger(body.durationMs) || body.durationMs < 0 || body.durationMs > 10 * 60 * 1000
          || typeof body.programCode !== "string" || body.programCode.length > MAX_PROGRAM_CHARS
          || typeof body.workspaceXml !== "string" || body.workspaceXml.length > MAX_PROGRAM_CHARS
          || !Number.isInteger(body.blockCount) || body.blockCount < 0 || body.blockCount > 10_000
          || !Number.isInteger(body.codeLineCount) || body.codeLineCount < 0 || body.codeLineCount > 100_000) {
          throw new HttpError(400, "INVALID_RECORD", "运行记录内容不正确。 ");
        }
        const realRecord = {
          id: randomId("run"),
          ownerUserId: user.id,
          taskId: body.taskId,
          taskName: realTask?.name || null,
          target: "real",
          completed: null,
          goalReached: null,
          checkpointCount: null,
          checkpointTotal: null,
          targetDeliveredCount: null,
          distractorClearedCount: null,
          failedObstacleCount: null,
          durationMs: body.durationMs,
          score: null,
          programCode: body.programCode,
          workspaceXml: body.workspaceXml,
          executionTrace: [],
          blockCount: body.blockCount,
          codeLineCount: body.codeLineCount,
          ...ownerSnapshot(user),
          recordState: "saved",
          savedAt: nowIso(),
          submittedAt: null,
          createdAt: nowIso()
        };
        store.insertRecord(realRecord);
        sendJson(response, 201, { schemaVersion: "chenlong.blockly-record-save-receipt/v1", record: recordSummary(realRecord), authoritative: false });
        return;
      }

      if (!exactKeys(body, ["target", "taskId", "mapRevision", "mapDigest", "completed", "checkpointCount", "targetDeliveredCount", "distractorClearedCount", "failedObstacleCount", "goalReached", "blockedMoves", "offRoadEpisodes", "offRoadDurationMs", "durationMs", "programCode", "workspaceXml", "executionTrace", "blockCount", "codeLineCount"])) {
        throw new HttpError(400, "INVALID_RECORD", "运行记录格式不正确。 ");
      }
      if (body.target !== "sim") {
        throw new HttpError(400, "INVALID_RECORD", "运行记录格式不正确。 ");
      }
      const executionTrace = normalizeExecutionTrace(body.executionTrace);
      const capabilityUsage = deriveCapabilityUsage(executionTrace);
      const task = PRIMARY_TASKS[body.taskId];
      const minimumMapRevision = 1;
      if (!task || typeof body.completed !== "boolean"
        || !Number.isInteger(body.mapRevision) || body.mapRevision < minimumMapRevision
        || typeof body.mapDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.mapDigest)
        || !Number.isInteger(body.checkpointCount) || body.checkpointCount < 0
        || !Number.isInteger(body.targetDeliveredCount) || body.targetDeliveredCount < 0
        || !Number.isInteger(body.distractorClearedCount) || body.distractorClearedCount < 0
        || !Number.isInteger(body.failedObstacleCount) || body.failedObstacleCount < 0
        || body.failedObstacleCount > body.blockedMoves
        || typeof body.goalReached !== "boolean"
        || !Number.isInteger(body.blockedMoves) || body.blockedMoves < 0 || body.blockedMoves > 99
        || !Number.isInteger(body.offRoadEpisodes) || body.offRoadEpisodes < 0 || body.offRoadEpisodes > 99
        || !Number.isSafeInteger(body.offRoadDurationMs) || body.offRoadDurationMs < 0 || body.offRoadDurationMs > body.durationMs
        || !Number.isSafeInteger(body.durationMs) || body.durationMs < 0 || body.durationMs > 10 * 60 * 1000
        || typeof body.programCode !== "string" || body.programCode.length > MAX_PROGRAM_CHARS
        || typeof body.workspaceXml !== "string" || body.workspaceXml.length > MAX_PROGRAM_CHARS
        || !Number.isInteger(body.blockCount) || body.blockCount < 0 || body.blockCount > 10_000
        || !Number.isInteger(body.codeLineCount) || body.codeLineCount < 0 || body.codeLineCount > 100_000) {
        throw new HttpError(400, "INVALID_RECORD", "运行记录内容不正确。 ");
      }
      const runMapVersion = mapVersion(body.taskId, body.mapRevision, body.mapDigest);
      const layout = runMapVersion.layout;
      const checkpointTotal = layout.checkpoints.length;
      const targetTotal = layout.targets.length;
      const distractorTotal = layout.distractors.length;
      const obstacleTotal = layout.obstacles.length;
      if (body.checkpointCount > checkpointTotal
        || body.targetDeliveredCount > targetTotal
        || body.distractorClearedCount > distractorTotal
        || body.failedObstacleCount > obstacleTotal) {
        throw new HttpError(400, "INVALID_RECORD", "运行记录的任务数量超出地图配置。 ");
      }
      const taskProgress = primaryGuangyangScoring.compositeTaskProgress({
        checkpointCount: body.checkpointCount,
        checkpointTotal,
        targetDeliveredCount: body.targetDeliveredCount,
        targetTotal,
        distractorClearedCount: body.distractorClearedCount,
        distractorTotal,
        failedObstacleCount: body.failedObstacleCount,
        obstacleTotal,
        goalReached: body.goalReached
      });
      if (body.completed !== taskProgress.finished) {
        throw new HttpError(400, "INVALID_RECORD", "运行记录的完成状态与任务证据不一致。 ");
      }
      const score = scoreRun({ ...body, taskProgress, checkpointTotal });
      const record = {
        id: randomId("run"),
        ownerUserId: user.id,
        taskId: body.taskId,
        taskName: task.name,
        target: "sim",
        completed: body.completed,
        checkpointCount: body.checkpointCount,
        checkpointTotal,
        taskCompleted: taskProgress.completed,
        taskTotal: taskProgress.total,
        targetDeliveredCount: taskProgress.targetDeliveredCount,
        distractorClearedCount: taskProgress.distractorClearedCount,
        failedObstacleCount: taskProgress.failedObstacleCount,
        goalReached: taskProgress.goalReached,
        mapRevision: runMapVersion.revision,
        mapDigest: runMapVersion.digest,
        mapLayout: primaryGuangyangMaps.clone(runMapVersion.layout),
        blockedMoves: body.blockedMoves,
        offRoadEpisodes: body.offRoadEpisodes,
        offRoadDurationMs: body.offRoadDurationMs,
        durationMs: body.durationMs,
        score: score.total,
        scoreBreakdown: score,
        programCode: body.programCode,
        workspaceXml: body.workspaceXml,
        executionTrace,
        capabilityUsage,
        blockCount: body.blockCount,
        codeLineCount: body.codeLineCount,
        ...ownerSnapshot(user),
        recordState: "saved",
        savedAt: nowIso(),
        submittedAt: null,
        createdAt: nowIso()
      };
      store.insertRecord(record);
      sendJson(response, 201, { schemaVersion: "chenlong.blockly-record-save-receipt/v1", record: recordSummary(record), authoritative: false });
      return;
    }
    if (url.pathname === "/api/leaderboard" && request.method === "GET") {
      principal(request);
      const bestByOwner = new Map();
      for (const record of store.allRecords()) {
        if (record.target === "real") continue;
        const durationMs = Number.isFinite(record.durationMs) && record.durationMs > 0 ? record.durationMs : null;
        if (durationMs === null) continue;
        const ownerId = record.ownerUserId;
        const existing = bestByOwner.get(ownerId);
        if (existing && durationMs >= existing.durationMs) continue;
        bestByOwner.set(ownerId, {
          ownerUserId: ownerId,
          ownerUsername: typeof record.ownerUsername === "string" ? record.ownerUsername : null,
          ownerDisplayName: typeof record.ownerDisplayName === "string" ? record.ownerDisplayName
            : (typeof record.ownerUsername === "string" ? record.ownerUsername : null),
          ownerGroup: record.ownerGroup == null ? null : canonicalParticipantGroup(record.ownerGroup),
          ownerTeamName: typeof record.ownerTeamName === "string" ? record.ownerTeamName : null,
          taskId: record.taskId,
          taskName: record.taskName,
          durationMs,
          blockCount: Number.isInteger(record.blockCount) ? record.blockCount : null,
          codeLineCount: Number.isInteger(record.codeLineCount) ? record.codeLineCount : null,
          submittedAt: record.submittedAt || record.createdAt || null
        });
      }
      const entries = [...bestByOwner.values()]
        .sort((left, right) => left.durationMs - right.durationMs)
        .map((entry, index) => ({ rank: index + 1, ...entry }));
      sendJson(response, 200, {
        schemaVersion: "chenlong.blockly-leaderboard/v1",
        entries,
        authoritative: false
      });
      return;
    }
    throw new HttpError(404, "NOT_FOUND", "请求的接口不存在。");
  }

  return Object.freeze({ handle });
}

module.exports = Object.freeze({ createBlocklyApi, HttpError });
