#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { URL } = require("node:url");

const { PlatformStore } = require("./packages/platform-store.js");
const { PlatformAuth, AUTH_COOKIE_NAME, AuthStoreError } = require("./packages/platform-auth.js");
const { createBlocklyApi, HttpError } = require("./packages/blockly-api.js");
const {
  OfficialSsoError,
  OfficialSsoReplayStore,
  verifySsoRequest,
  requireSsoSecret
} = require("./packages/official-sso.js");

const DATA_DIR = path.join(__dirname, "data");
const BLOCKLY_DIR = path.join(__dirname, "projects", "blockly-page3");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 6190;
const PLATFORM_SCHEMA_VERSION = "chenlong.competition-platform/v1";
const PLATFORM_READINESS_SCHEMA_VERSION = "chenlong.competition-platform-readiness/v1";
const ADMIN_OVERVIEW_SCHEMA_VERSION = "chenlong.platform-admin-overview/v1";
const PERSONAL_SCORES_SCHEMA_VERSION = "chenlong.platform-personal-scores/v1";
const AUTH_RESPONSE_SCHEMA_VERSION = "chenlong.auth/v1";
const TEAM_INVITE_SCHEMA_VERSION = "chenlong.team-invite/v1";
const ADMIN_USERS_SCHEMA_VERSION = "chenlong.platform-admin-users/v1";
const ADMIN_RECORDS_SCHEMA_VERSION = "chenlong.platform-admin-records/v1";
const ADMIN_JUDGMENT_SCHEMA_VERSION = "chenlong.platform-admin-judgment/v1";
const MAX_AUTH_BODY_BYTES = 16 * 1024;
const ADMIN_PAGE_SIZE = 15;
const MAX_DURATION_MS = 600_000;
const STATIC_STREAM_PATH_PATTERN = /\.(?:wasm|zip|onnx|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$/i;
const TEXT_STATIC_PATH_PATTERN = /\.(?:js|css)$/i;
const PARTICIPANT_GROUP_LABELS = Object.freeze({
  primary: "小学组",
  junior: "初中组",
  high: "高中组"
});
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// 单进程直连：一个 SQLite 库 + 一个 scrypt 认证 + 吸收的 Blockly API。
const store = new PlatformStore({ dataDir: DATA_DIR });
const auth = new PlatformAuth({ store });
const blocklyApi = createBlocklyApi({
  store,
  auth,
  publicOrigin: process.env.CHENLONG_PLATFORM_PUBLIC_ORIGIN || ""
});

// 外部 SSO：密钥缺失时整条跳转链路不可用，登录页仍走本地账号。
let officialSsoSecret = null;
try {
  const secretSource = process.env.CHENLONG_OFFICIAL_SSO_SECRET;
  if (typeof secretSource === "string" && secretSource !== "") {
    officialSsoSecret = requireSsoSecret(secretSource);
  }
} catch (_error) {
  officialSsoSecret = null;
}
const officialSsoReplayStore = officialSsoSecret === null
  ? null
  : new OfficialSsoReplayStore({ rootDir: path.join(DATA_DIR, "official-sso") });

class PlatformHttpError extends Error {
  constructor(statusCode, code, message, headers = {}) {
    super(message);
    this.name = "PlatformHttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

function positivePort(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("platform port must be an integer between 0 and 65535");
  }
  return port;
}

function normalizedPublicOrigin(value) {
  if (!value) return null;
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("platform public origin must be one HTTP(S) origin");
  }
  return parsed.origin;
}

function normalizedIp(value) {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  if (candidate.startsWith("[") && candidate.endsWith("]")) candidate = candidate.slice(1, -1);
  const zone = candidate.indexOf("%");
  if (zone >= 0) candidate = candidate.slice(0, zone);
  if (candidate.toLowerCase().startsWith("::ffff:") && net.isIP(candidate.slice(7)) === 4) {
    candidate = candidate.slice(7);
  }
  return net.isIP(candidate) ? candidate.toLowerCase() : null;
}

function normalizedTrustedProxyIps(value) {
  if (value === undefined || value === null || value === "") return new Set();
  const source = value instanceof Set
    ? [...value]
    : Array.isArray(value)
      ? value
      : String(value).split(",");
  const result = new Set();
  for (const item of source) {
    const ip = normalizedIp(String(item));
    if (!ip) throw new TypeError("trusted proxy list must contain exact IP addresses");
    result.add(ip);
  }
  return result;
}

function singleRequestHeader(request, name) {
  const lower = name.toLowerCase();
  if (Array.isArray(request.rawHeaders)) {
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (String(request.rawHeaders[index]).toLowerCase() === lower) count += 1;
    }
    if (count > 1) return null;
  }
  const value = request.headers?.[lower];
  return typeof value === "string" ? value.trim() : null;
}

function clientIpForRequest(request, trustedProxyIps) {
  const direct = normalizedIp(request.socket?.remoteAddress);
  if (!direct) return "unknown";
  if (!trustedProxyIps.has(direct)) return direct;
  const cloudflare = singleRequestHeader(request, "CF-Connecting-IP");
  const cloudflareIp = cloudflare && !cloudflare.includes(",") ? normalizedIp(cloudflare) : null;
  if (cloudflareIp) return cloudflareIp;
  const forwarded = singleRequestHeader(request, "X-Forwarded-For");
  const firstForwarded = forwarded ? normalizedIp(forwarded.split(",", 1)[0]) : null;
  return firstForwarded || direct;
}

function jsonBody(response, statusCode, payload, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(body);
}

function safePathname(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    throw new PlatformHttpError(400, "INVALID_PATH", "请求路径编码无效。");
  }
}

function requestExternalOrigin(request, configuredOrigin = null) {
  if (configuredOrigin) return configuredOrigin;
  const host = request.headers.host;
  if (!host) throw new PlatformHttpError(400, "INVALID_HOST", "请求主机信息不完整。");
  const forwarded = String(request.headers["x-forwarded-proto"] || "").split(",", 1)[0].trim();
  const protocol = forwarded === "https" ? "https:" : "http:";
  try {
    return new URL(`${protocol}//${host}`).origin;
  } catch (_error) {
    throw new PlatformHttpError(400, "INVALID_HOST", "请求主机信息无效。");
  }
}

function assertSameOrigin(request, configuredOrigin = null) {
  if (!WRITE_METHODS.has(request.method || "GET")) return;
  const supplied = request.headers.origin;
  if (supplied === undefined) return;
  let normalized;
  try {
    normalized = new URL(String(supplied)).origin;
  } catch (_error) {
    throw new PlatformHttpError(403, "CROSS_ORIGIN_REQUEST", "请求来源不受信任，请刷新页面后重试。");
  }
  if (normalized !== requestExternalOrigin(request, configuredOrigin)) {
    throw new PlatformHttpError(403, "CROSS_ORIGIN_REQUEST", "请求来源不受信任，请刷新页面后重试。");
  }
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png"
  })[extension] || "application/octet-stream";
}

function textAssetCacheControl(pathname, searchParams) {
  if (!TEXT_STATIC_PATH_PATTERN.test(pathname)) return "no-store, max-age=0";
  return searchParams?.get("v")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=3600, must-revalidate";
}

function assetEtag(data) {
  return `"${crypto.createHash("sha256").update(data).digest("base64url")}"`;
}

function servePublic(request, response, publicDir, pathname) {
  const routes = new Map([
    ["/", "portal.html"],
    ["/portal.html", "portal.html"],
    ["/login.html", "login.html"],
    ["/admin.html", "admin.html"],
    ["/platform.css", "platform.css"],
    ["/portal.css", "portal.css"],
    ["/admin.css", "admin.css"],
    ["/platform-login.js", "platform-login.js"],
    ["/platform-portal.js", "platform-portal.js"],
    ["/platform-admin.js", "platform-admin.js"],
    ["/leaderboard.html", "leaderboard.html"],
    ["/leaderboard.css", "leaderboard.css"],
    ["/leaderboard.js", "leaderboard.js"]
  ]);
  const relative = routes.get(pathname);
  if (!relative) return false;
  const filePath = path.join(publicDir, relative);
  const data = fs.readFileSync(filePath);
  const cacheControl = TEXT_STATIC_PATH_PATTERN.test(pathname)
    ? "public, max-age=300, must-revalidate"
    : "no-store, max-age=0";
  const etag = assetEtag(data);
  const headers = {
    "Content-Type": mimeType(filePath),
    "Content-Length": data.length,
    "Cache-Control": cacheControl,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'"
  };
  if (request.headers["if-none-match"] === etag && ["GET", "HEAD"].includes(request.method || "GET")) {
    delete headers["Content-Length"];
    response.writeHead(304, headers);
    response.end();
    return true;
  }
  response.writeHead(200, headers);
  if (request.method === "HEAD") response.end();
  else response.end(data);
  return true;
}

const BLOCKLY_STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/login.html", "login.html"],
  ["/auth.js", "auth.js"],
  ["/admin.html", "admin.html"],
  ["/admin-team-scores.js", "admin-team-scores.js"],
  ["/admin.js", "admin.js"],
  ["/app.js", "app.js"],
  ["/lane-follow.js", "lane-follow.js"],
  ["/simulation-clock.js", "simulation-clock.js"],
  ["/blockly-navigation-core.js", "blockly-navigation-core.js"],
  ["/guangyang-scoring.js", "guangyang-scoring.js"],
  ["/guangyang-map-config.js", "guangyang-map-config.js"],
  ["/admin.css", "admin.css"],
  ["/debug-run.css", "debug-run.css"],
  ["/styles.css", "styles.css"],
  ["/favicon.svg", "favicon.svg"],
  ["/vendor/blockly/blockly_compressed.js", path.join("vendor", "blockly", "blockly_compressed.js")],
  ["/vendor/blockly/blocks_compressed.js", path.join("vendor", "blockly", "blocks_compressed.js")],
  ["/vendor/blockly/javascript_compressed.js", path.join("vendor", "blockly", "javascript_compressed.js")],
  ["/vendor/blockly/msg/zh-hans.js", path.join("vendor", "blockly", "msg", "zh-hans.js")],
  ["/vendor/three/three.min.js", path.join("vendor", "three", "three.min.js")],
  ["/vendor/lucide/lucide.min.js", path.join("vendor", "lucide", "lucide.min.js")],
  ["/assets/guangyang-island.png", path.join("assets", "guangyang-island.png")]
]);

function rewriteBlocklyText(buffer, contentType) {
  let text = buffer.toString("utf8");
  text = text.replace(/(["'`])\/api\//g, "$1/blockly/api/")
    .replace(/(["'`])\/(admin|index)\.html/g, "$1/blockly/$2.html");
  if (contentType.includes("text/html")) {
    text = text.replace(
      /(<(?:script|link|img|a|form)[^>]+(?:src|href|action)=(["']))(?!\/|blockly\/)/gi,
      (match, prefix) => `${prefix}/blockly/`
    );
    text = text.replace(/\/blockly\/(login|portal)\.html/g, "/$1.html");
  }
  return Buffer.from(text, "utf8");
}

function serveBlockly(request, response, pathname, searchParams) {
  const relative = BLOCKLY_STATIC_FILES.get(pathname);
  if (!relative) return false;
  const filePath = path.join(BLOCKLY_DIR, relative);
  const data = fs.readFileSync(filePath);
  const contentType = mimeType(filePath);
  const isText = TEXT_STATIC_PATH_PATTERN.test(pathname) || pathname.endsWith(".html");
  const body = isText ? rewriteBlocklyText(data, contentType) : data;
  const cacheControl = isText
    ? textAssetCacheControl(pathname, searchParams)
    : (STATIC_STREAM_PATH_PATTERN.test(pathname) ? "public, max-age=3600" : "no-store, max-age=0");
  const etag = isText ? assetEtag(body) : null;
  const headers = {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };
  if (etag) headers.ETag = etag;
  if (etag && request.headers["if-none-match"] === etag && ["GET", "HEAD"].includes(request.method || "GET")) {
    delete headers["Content-Length"];
    response.writeHead(304, headers);
    response.end();
    return true;
  }
  response.writeHead(200, headers);
  if (request.method === "HEAD") response.end();
  else response.end(body);
  return true;
}

// ---- 认证与当前用户 ----

function readCookie(request, name) {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;
  for (const component of header.split(";")) {
    const separator = component.indexOf("=");
    if (separator < 1) continue;
    if (component.slice(0, separator).trim() === name) {
      return component.slice(separator + 1).trim();
    }
  }
  return null;
}

function authCookie(token, maxAgeSeconds, { clear = false, sameSite = "Lax" } = {}) {
  const attributes = [
    `${AUTH_COOKIE_NAME}=${clear ? "" : token}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${clear ? 0 : Math.max(1, Math.floor(maxAgeSeconds))}`
  ];
  if (clear) attributes.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  return attributes.join("; ");
}

function currentUser(request) {
  const token = readCookie(request, AUTH_COOKIE_NAME);
  if (!token) {
    throw new PlatformHttpError(401, "AUTHENTICATION_REQUIRED", "请先登录统一比赛平台。", {
      "WWW-Authenticate": "Cookie realm=\"chenlong\""
    });
  }
  let result;
  try {
    result = auth.authenticate(token);
  } catch (error) {
    throw toPlatformError(error);
  }
  const user = store.findUserById(result.user.id);
  if (!user) throw new PlatformHttpError(500, "AUTH_STORE_CORRUPTED", "登录账户数据不完整，请联系管理员。");
  return user;
}

function requireAdmin(user) {
  if (user.role !== "admin") throw new PlatformHttpError(403, "ADMIN_REQUIRED", "需要管理员权限。");
  return user;
}

function publicUser(user) {
  const isParticipant = user.role !== "admin";
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    teamName: isParticipant && typeof user.teamName === "string" ? user.teamName : null,
    group: isParticipant ? user.group : null,
    role: user.role,
    createdAt: user.createdAt
  };
}

function platformUser(user) {
  return {
    ...publicUser(user),
    teamId: user.role === "admin" ? null : (user.teamId || null),
    officialSso: Boolean(user.officialUserId)
  };
}

function adminUserSummary(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    teamId: user.role === "admin" ? null : (user.teamId || null),
    teamName: user.role === "admin" ? null : (user.teamName || null),
    group: user.role === "admin" ? null : user.group,
    role: user.role,
    createdAt: user.createdAt
  };
}

function toPlatformError(error) {
  if (error instanceof PlatformHttpError) return error;
  if (error && Number.isInteger(error.statusCode)) {
    return new PlatformHttpError(error.statusCode, error.code || "REQUEST_FAILED", error.message, error.headers || {});
  }
  return error;
}

// ---- 请求体 ----

function readJsonBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    request.on("data", chunk => {
      if (settled) return;
      length += chunk.length;
      if (length > maximumBytes) {
        settled = true;
        request.resume();
        reject(new PlatformHttpError(413, "REQUEST_TOO_LARGE", "请求内容过大。"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks, length).toString("utf8");
      if (!text.trim()) {
        reject(new PlatformHttpError(400, "INVALID_JSON", "请求内容不能为空。"));
        return;
      }
      let value;
      try {
        value = JSON.parse(text);
      } catch (_error) {
        reject(new PlatformHttpError(400, "INVALID_JSON", "请求内容不是有效 JSON。"));
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        reject(new PlatformHttpError(400, "INVALID_JSON", "请求内容格式不正确。"));
        return;
      }
      resolve(value);
    });
    request.on("error", error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function assertAllowedFields(value, allowedFields, codePrefix) {
  const unknown = Object.keys(value).find(field => !allowedFields.has(field));
  if (unknown) {
    throw new PlatformHttpError(400, `${codePrefix}_UNKNOWN_FIELD`, `${codePrefix} 不接受字段：${unknown}。`);
  }
}

// ---- 认证路由 ----

function sendAuthResponse(response, statusCode, result, { teamInviteCode = null } = {}) {
  const payload = {
    schemaVersion: AUTH_RESPONSE_SCHEMA_VERSION,
    authenticated: true,
    user: result.user,
    session: result.session,
    bootstrapAdmin: Boolean(result.bootstrapAdmin),
    authoritative: false
  };
  if (typeof teamInviteCode === "string") payload.teamInviteCode = teamInviteCode;
  jsonBody(response, statusCode, payload, {
    "Set-Cookie": authCookie(result.token, auth.sessionTtlMs / 1000)
  });
}

async function handleAuthGuest(request, response) {
  assertSameOrigin(request);
  const body = await readJsonBody(request, MAX_AUTH_BODY_BYTES);
  assertAllowedFields(body, new Set(), "GUEST");
  const created = await auth.createGuest();
  sendAuthResponse(response, 201, created);
}

async function handleAuthLogin(request, response) {
  assertSameOrigin(request);
  const body = await readJsonBody(request, MAX_AUTH_BODY_BYTES);
  assertAllowedFields(body, new Set(["username", "password"]), "LOGIN");
  const result = await auth.login({ username: body.username, password: body.password });
  sendAuthResponse(response, 200, result);
}

async function handleAuthRegister(request, response) {
  assertSameOrigin(request);
  const body = await readJsonBody(request, MAX_AUTH_BODY_BYTES);
  assertAllowedFields(body, new Set(["username", "password", "displayName", "teamAction", "teamName", "inviteCode", "group"]), "REGISTER");
  const result = await auth.register(body);
  sendAuthResponse(response, 201, result, { teamInviteCode: result.teamInviteCode });
}

async function handleAuthLogout(request, response) {
  assertSameOrigin(request);
  await readJsonBody(request, MAX_AUTH_BODY_BYTES);
  const token = readCookie(request, AUTH_COOKIE_NAME);
  if (token) auth.logout(token);
  jsonBody(response, 200, {
    schemaVersion: AUTH_RESPONSE_SCHEMA_VERSION,
    authenticated: false,
    authoritative: false
  }, {
    "Set-Cookie": authCookie("", 0, { clear: true })
  });
}

function handleAuthMe(request, response) {
  const user = currentUser(request);
  jsonBody(response, 200, {
    schemaVersion: AUTH_RESPONSE_SCHEMA_VERSION,
    authenticated: true,
    user: publicUser(user),
    authoritative: false
  });
}

function handleAuthTeamInvite(request, response) {
  const user = currentUser(request);
  const invite = auth.getTeamInviteForUser(user.id);
  jsonBody(response, 200, {
    schemaVersion: TEAM_INVITE_SCHEMA_VERSION,
    teamName: invite.teamName,
    inviteCode: invite.inviteCode,
    authoritative: false
  });
}

// ---- 平台路由 ----

function handlePlatformMe(request, response) {
  const user = currentUser(request);
  jsonBody(response, 200, {
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    authenticated: true,
    user: platformUser(user),
    services: {
      blockly: "/blockly/",
      admin: user.role === "admin" ? "/admin.html" : null
    },
    authoritative: false
  });
}

function handlePlatformTeamInvite(request, response) {
  const user = currentUser(request);
  const invite = auth.getTeamInviteForUser(user.id);
  jsonBody(response, 200, {
    schemaVersion: TEAM_INVITE_SCHEMA_VERSION,
    teamName: invite.teamName,
    inviteCode: invite.inviteCode,
    authoritative: false
  });
}

function recordDurationMs(record) {
  const raw = Number.isFinite(record?.durationMs) ? record.durationMs : null;
  if (raw === null || raw <= 0) return null;
  const finished = typeof record?.completed === "boolean" ? record.completed
    : typeof record?.taskFinished === "boolean" ? record.taskFinished
      : null;
  if (finished === false || raw > MAX_DURATION_MS) return MAX_DURATION_MS;
  return Math.min(raw, MAX_DURATION_MS);
}

function userBestDurationMs(userId) {
  let best = null;
  for (const record of store.allRecords()) {
    if (record.target === "real") continue;
    if (record.ownerUserId !== userId) continue;
    const duration = recordDurationMs(record);
    if (duration === null) continue;
    if (best === null || duration < best) best = duration;
  }
  return best;
}

function handlePersonalScores(request, response) {
  const user = currentUser(request);
  const best = userBestDurationMs(user.id);
  jsonBody(response, 200, {
    schemaVersion: PERSONAL_SCORES_SCHEMA_VERSION,
    user: platformUser(user),
    bestDurationMs: best,
    sources: {
      blockly: { bestDurationMs: best }
    },
    authoritative: false
  });
}

function buildBlocklyAdminRows(users, records) {
  const teams = new Map();
  const ensureTeam = (key, teamName, group) => {
    if (!teams.has(key)) {
      teams.set(key, {
        teamId: key.startsWith("tea_") ? key : null,
        teamName,
        group,
        members: [],
        bestDurationMs: null
      });
    }
    return teams.get(key);
  };

  for (const user of users) {
    if (user.role === "admin") continue;
    const teamId = user.teamId || null;
    const teamName = user.teamName || "";
    if (!teamId && !teamName) continue;
    const team = ensureTeam(teamId || `name:${teamName}`, teamName, user.group || "primary");
    team.members.push({ id: user.id, username: user.username, displayName: user.displayName });
  }

  for (const record of records) {
    if (record.target === "real") continue;
    const duration = recordDurationMs(record);
    if (duration === null) continue;
    const teamId = typeof record.ownerTeamId === "string" && record.ownerTeamId ? record.ownerTeamId : null;
    const teamName = typeof record.ownerTeamName === "string" ? record.ownerTeamName : "";
    const group = record.ownerGroup == null ? "primary" : record.ownerGroup;
    let team = teams.get(teamId || (teamName ? `name:${teamName}` : `user:${record.ownerUserId}`));
    if (!team && teamName) {
      team = [...teams.values()].find(item => item.teamName === teamName) || null;
    }
    if (!team) {
      team = ensureTeam(
        teamId || (teamName ? `name:${teamName}` : `user:${record.ownerUserId}`),
        teamName || record.ownerDisplayName || record.ownerUsername || record.ownerUserId,
        group
      );
    }
    if (team.bestDurationMs === null || duration < team.bestDurationMs) team.bestDurationMs = duration;
  }

  return [...teams.values()]
    .map(team => ({
      teamId: team.teamId,
      teamName: team.teamName,
      group: team.group,
      members: team.members,
      bestDurationMs: team.bestDurationMs
    }))
    .sort((left, right) => {
      if (left.bestDurationMs === null && right.bestDurationMs === null) {
        return left.teamName.localeCompare(right.teamName, "zh-CN");
      }
      if (left.bestDurationMs === null) return 1;
      if (right.bestDurationMs === null) return -1;
      return left.bestDurationMs - right.bestDurationMs
        || left.teamName.localeCompare(right.teamName, "zh-CN");
    });
}

function realCarScoreRow(record, judgment, usernameById) {
  return {
    id: record.id,
    teamName: typeof record.ownerTeamName === "string" ? record.ownerTeamName : "",
    group: record.ownerGroup == null ? "primary" : record.ownerGroup,
    ownerUsername: record.ownerUsername || null,
    ownerDisplayName: record.ownerDisplayName || null,
    durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
    createdAt: record.createdAt || null,
    judgment: judgment ? {
      taskCompleted: judgment.taskCompleted,
      distractor1Cleared: judgment.distractor1Cleared,
      distractor2Cleared: judgment.distractor2Cleared,
      targetPicked: judgment.targetPicked,
      targetDelivered: judgment.targetDelivered,
      scoredAt: judgment.scoredAt,
      scoredByUsername: usernameById.get(judgment.scoredByUserId) || null
    } : null
  };
}

function buildRealCarScoreRows() {
  const users = store.listUsers();
  const usernameById = new Map(users.map(user => [user.id, user.username]));
  const judgments = store.listRecordJudgments();
  const rows = store.allRecords()
    .filter(record => record.target === "real")
    .map(record => realCarScoreRow(record, judgments.get(record.id) || null, usernameById));
  rows.sort((left, right) => {
    if (left.durationMs === null && right.durationMs === null) return 0;
    if (left.durationMs === null) return 1;
    if (right.durationMs === null) return -1;
    return left.durationMs - right.durationMs
      || left.teamName.localeCompare(right.teamName, "zh-CN");
  });
  return rows;
}

function paginate(items, requestedPage, pageSize = ADMIN_PAGE_SIZE) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Number.isSafeInteger(requestedPage) ? requestedPage : 1, 1), totalPages);
  const start = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    total,
    totalPages,
    items: items.slice(start, start + pageSize)
  };
}

function handleAdminOverview(request, response, url) {
  requireAdmin(currentUser(request));
  const rows = buildRealCarScoreRows();
  const requestedGroup = url.searchParams.get("group");
  const group = requestedGroup === "primary" || requestedGroup === "junior" || requestedGroup === "high"
    ? requestedGroup
    : null;
  const filteredRows = group ? rows.filter(record => record.group === group) : rows;
  const pageValue = Number(url.searchParams.get("page") || 1);
  const page = paginate(filteredRows, Number.isSafeInteger(pageValue) ? pageValue : 1);
  const teamNames = new Set(rows.map(record => record.teamName).filter(Boolean));
  jsonBody(response, 200, {
    schemaVersion: ADMIN_OVERVIEW_SCHEMA_VERSION,
    scoring: {
      metric: "manual",
      description: "手动打分：逐条标注真实小车运行的任务完成、混淆物清除、目标物夹起与运送等 5 项完成情况；扣分规则待定。"
    },
    pagination: {
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
      totalPages: page.totalPages,
      unfilteredTotal: rows.length
    },
    records: page.items,
    summary: {
      teamCount: teamNames.size,
      bestDurationMs: rows.length ? rows[0].durationMs : null,
      bestTeamName: rows.length ? rows[0].teamName : null
    },
    authoritative: false
  });
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function formatDurationSeconds(ms) {
  if (!Number.isFinite(ms)) return "";
  return (ms / 1000).toFixed(1);
}

function judgmentBoolLabel(value) {
  return value === true ? "是" : value === false ? "否" : "";
}

function realCarRowsCsv(rows) {
  const header = ["队伍名称", "分组", "学员", "用时(秒)", "完成任务", "混淆物1清除", "混淆物2清除", "目标物夹起", "目标物运送到终点", "打分时间"];
  const data = rows.map(record => {
    const judgment = record.judgment;
    return [
      record.teamName,
      PARTICIPANT_GROUP_LABELS[record.group] || "",
      record.ownerDisplayName || record.ownerUsername || "",
      formatDurationSeconds(record.durationMs),
      judgmentBoolLabel(judgment?.taskCompleted),
      judgmentBoolLabel(judgment?.distractor1Cleared),
      judgmentBoolLabel(judgment?.distractor2Cleared),
      judgmentBoolLabel(judgment?.targetPicked),
      judgmentBoolLabel(judgment?.targetDelivered),
      judgment?.scoredAt ? String(judgment.scoredAt).slice(0, 19).replace("T", " ") : ""
    ];
  });
  return `\uFEFF${[header, ...data].map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function handleAdminExport(request, response) {
  requireAdmin(currentUser(request));
  const rows = buildRealCarScoreRows();
  const body = Buffer.from(realCarRowsCsv(rows), "utf8");
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Length": body.length,
    "Content-Disposition": `attachment; filename="competition-overview-${new Date().toISOString().slice(0, 10)}.csv"`,
    "Cache-Control": "no-store, max-age=0"
  });
  response.end(body);
}

function handleAdminUsers(request, response) {
  requireAdmin(currentUser(request));
  jsonBody(response, 200, {
    schemaVersion: ADMIN_USERS_SCHEMA_VERSION,
    users: store.listUsers().map(adminUserSummary),
    authoritative: false
  });
}

async function handleAdminUserUpdate(request, response, userId) {
  requireAdmin(currentUser(request));
  const body = await readJsonBody(request, MAX_AUTH_BODY_BYTES);
  assertAllowedFields(body, new Set(["teamName", "group"]), "USER_UPDATE");
  const result = auth.updateManagedUser(userId, { teamName: body.teamName, group: body.group });
  const updated = store.findUserById(userId);
  jsonBody(response, 200, {
    schemaVersion: ADMIN_USERS_SCHEMA_VERSION,
    user: adminUserSummary(updated),
    changed: result.changed,
    authoritative: false
  });
}

function adminRecordRow(record) {
  return {
    id: record.id,
    target: record.target === "real" ? "real" : "sim",
    taskName: record.taskName || null,
    durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
    completed: typeof record.completed === "boolean" ? record.completed : null,
    goalReached: typeof record.goalReached === "boolean" ? record.goalReached : null,
    checkpointCount: Number.isInteger(record.checkpointCount) ? record.checkpointCount : null,
    checkpointTotal: Number.isInteger(record.checkpointTotal) ? record.checkpointTotal : null,
    targetDeliveredCount: Number.isInteger(record.targetDeliveredCount) ? record.targetDeliveredCount : null,
    distractorClearedCount: Number.isInteger(record.distractorClearedCount) ? record.distractorClearedCount : null,
    failedObstacleCount: Number.isInteger(record.failedObstacleCount) ? record.failedObstacleCount : null,
    recordState: record.recordState || null,
    createdAt: record.createdAt || null,
    submittedAt: record.submittedAt || null,
    ownerUsername: record.ownerUsername || null,
    ownerDisplayName: record.ownerDisplayName || null,
    ownerTeamName: record.ownerTeamName || null,
    ownerGroup: record.ownerGroup == null ? null : record.ownerGroup
  };
}

function handleAdminRecords(request, response, url) {
  requireAdmin(currentUser(request));
  const pageValue = Number(url.searchParams.get("page") || 1);
  const page = paginate(store.allRecords(), Number.isSafeInteger(pageValue) ? pageValue : 1);
  jsonBody(response, 200, {
    schemaVersion: ADMIN_RECORDS_SCHEMA_VERSION,
    records: page.items.map(adminRecordRow),
    pagination: {
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
      totalPages: page.totalPages
    },
    authoritative: false
  });
}

async function handleAdminRecordJudgment(request, response, recordId) {
  const admin = requireAdmin(currentUser(request));
  const body = await readJsonBody(request, MAX_AUTH_BODY_BYTES);
  const criteria = ["taskCompleted", "distractor1Cleared", "distractor2Cleared", "targetPicked", "targetDelivered"];
  assertAllowedFields(body, new Set(criteria), "JUDGMENT");
  for (const field of criteria) {
    if (typeof body[field] !== "boolean") {
      throw new PlatformHttpError(400, "INVALID_JUDGMENT", "打分项必须为布尔值。");
    }
  }
  const record = store.findRecordById(recordId);
  if (!record || record.target !== "real") {
    throw new PlatformHttpError(404, "RECORD_NOT_FOUND", "未找到对应的真实小车运行记录。");
  }
  const judgment = store.upsertRecordJudgment(recordId, {
    taskCompleted: body.taskCompleted,
    distractor1Cleared: body.distractor1Cleared,
    distractor2Cleared: body.distractor2Cleared,
    targetPicked: body.targetPicked,
    targetDelivered: body.targetDelivered,
    scoredAt: new Date().toISOString(),
    scoredByUserId: admin.id
  });
  jsonBody(response, 200, {
    schemaVersion: ADMIN_JUDGMENT_SCHEMA_VERSION,
    judgment: {
      taskCompleted: judgment.taskCompleted,
      distractor1Cleared: judgment.distractor1Cleared,
      distractor2Cleared: judgment.distractor2Cleared,
      targetPicked: judgment.targetPicked,
      targetDelivered: judgment.targetDelivered,
      scoredAt: judgment.scoredAt
    },
    authoritative: false
  });
}

// ---- 外部 SSO ----

const SSO_RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_SSO_ATTEMPTS = 4_000;
const MAX_SSO_ATTEMPTS_PER_IP = 1_000;
let ssoAttempts = { count: 0, resetAt: 0 };
const ssoAttemptsByIp = new Map();

function enforceSsoRateLimit(ip, now) {
  if (!Number.isFinite(now)) throw new TypeError("official SSO rate-limit clock is invalid");
  if (ssoAttempts.resetAt <= now) {
    ssoAttempts = { count: 0, resetAt: now + SSO_RATE_WINDOW_MS };
    ssoAttemptsByIp.clear();
  }
  const key = String(ip || "unknown").slice(0, 128);
  let entry = ssoAttemptsByIp.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + SSO_RATE_WINDOW_MS };
    ssoAttemptsByIp.set(key, entry);
  }
  if (ssoAttempts.count >= MAX_SSO_ATTEMPTS || entry.count >= MAX_SSO_ATTEMPTS_PER_IP) {
    const retryAt = Math.min(ssoAttempts.resetAt, entry.resetAt);
    const limited = new OfficialSsoError(1004, "official SSO rate limit exceeded");
    limited.statusCode = 429;
    limited.retryAfter = Math.max(1, Math.ceil((retryAt - now) / 1000));
    limited.rateLimited = true;
    throw limited;
  }
  ssoAttempts.count += 1;
  entry.count += 1;
}

function writeOfficialSsoErrorPage(response, error) {
  const normalized = error instanceof OfficialSsoError ? error : new OfficialSsoError(1004);
  const body = Buffer.from([
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<title>无法进入比赛平台</title></head><body>",
    "<main><h1>无法进入比赛平台</h1>",
    `<p>${normalized.message}</p><p>错误码：${normalized.code}</p>`,
    "<p><a href=\"/login.html\">返回登录页</a></p></main></body></html>"
  ].join(""), "utf8");
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
  if (Number.isSafeInteger(normalized.retryAfter) && normalized.retryAfter > 0) {
    headers["Retry-After"] = String(normalized.retryAfter);
  }
  response.writeHead(normalized.statusCode, headers);
  response.end(body);
}

async function handleSsoJump(request, response, trustedProxyIps) {
  if (request.method !== "GET") {
    writeOfficialSsoErrorPage(response, new OfficialSsoError(1001, "SSO endpoint only accepts GET"));
    return;
  }
  const ip = clientIpForRequest(request, trustedProxyIps);
  let parameters = null;
  try {
    enforceSsoRateLimit(ip, Date.now());
    if (officialSsoSecret === null || officialSsoReplayStore === null) {
      throw new OfficialSsoError(1004, "official SSO is not configured");
    }
    parameters = verifySsoRequest(request.url, officialSsoSecret, Date.now());
    const authenticated = await officialSsoReplayStore.consume(parameters, () => (
      auth.loginExternalIdentity({
        officialUserId: parameters.user_id,
        officialTeamId: parameters.team_id,
        group: parameters.group_type,
        teamName: parameters.team_name
      })
    ));
    await officialSsoReplayStore.audit({
      userId: parameters.user_id,
      sourceTimestamp: parameters.timestamp,
      ip,
      result: "success"
    }).catch(() => {});
    response.writeHead(302, {
      Location: "/portal.html",
      "Set-Cookie": authCookie(authenticated.token, auth.sessionTtlMs / 1000, { sameSite: "Lax" }),
      "Cache-Control": "no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    });
    response.end();
  } catch (error) {
    const publicError = error instanceof OfficialSsoError
      ? error
      : new OfficialSsoError(1004, error instanceof AuthStoreError ? error.code : "SSO processing failed");
    if (officialSsoReplayStore !== null && !publicError.rateLimited) {
      await officialSsoReplayStore.audit({
        userId: parameters?.user_id || null,
        sourceTimestamp: parameters?.timestamp || null,
        ip,
        result: "failure",
        code: publicError.code,
        detail: publicError.detail
      }).catch(() => {});
    }
    writeOfficialSsoErrorPage(response, publicError);
  }
}

// ---- 健康检查 ----

function handleHealth(request, response) {
  jsonBody(response, 200, {
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    status: "ok",
    service: "chenlong-competition-platform",
    port: DEFAULT_PORT,
    capacity: {
      maxAccounts: auth.maxUsers,
      plannedConcurrentUsers: 500,
      adminTeamPageSize: ADMIN_PAGE_SIZE
    },
    competition: {
      authoritative: false
    },
    authoritative: false
  });
}

function handleReadiness(request, response, options) {
  jsonBody(response, 200, {
    schemaVersion: PLATFORM_READINESS_SCHEMA_VERSION,
    status: "ok",
    service: "chenlong-competition-platform",
    checks: {
      gateway: { status: "ok" },
      blockly: { status: "ok" }
    },
    configuration: {
      trustedProxyConfigured: options.trustedProxyIps.size > 0,
      publicOriginConfigured: Boolean(options.publicOrigin),
      officialSsoConfigured: officialSsoSecret !== null
    },
    authoritative: false
  });
}

// ---- 错误处理 ----

function errorInfo(error) {
  if (error instanceof PlatformHttpError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message, headers: error.headers || {} };
  }
  if (error instanceof HttpError) {
    return { statusCode: error.status, code: error.code, message: error.message, headers: {} };
  }
  if (error instanceof AuthStoreError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message, headers: error.headers || {} };
  }
  if (error && Number.isInteger(error.statusCode) && typeof error.code === "string") {
    return { statusCode: error.statusCode, code: error.code, message: error.message, headers: error.headers || {} };
  }
  return { statusCode: 500, code: "PLATFORM_ERROR", message: "统一平台暂时无法完成请求。", headers: {} };
}

// ---- 服务入口 ----

function createServer(config = {}) {
  const options = {
    publicOrigin: normalizedPublicOrigin(config.publicOrigin || process.env.CHENLONG_PLATFORM_PUBLIC_ORIGIN),
    publicDir: path.resolve(config.publicDir || path.join(__dirname, "public")),
    trustedProxyIps: normalizedTrustedProxyIps(
      config.trustedProxyIps ?? process.env.CHENLONG_PLATFORM_TRUSTED_PROXIES
    )
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, requestExternalOrigin(request, options.publicOrigin));
      const pathname = safePathname(url.pathname);

      if (pathname === "/sso/jump") {
        await handleSsoJump(request, response, options.trustedProxyIps);
        return;
      }

      if (request.method === "GET" || request.method === "HEAD") {
        if (servePublic(request, response, options.publicDir, pathname)) return;
      }

      if (pathname === "/api/health" && ["GET", "HEAD"].includes(request.method)) {
        handleHealth(request, response);
        return;
      }
      if (pathname === "/api/readiness" && ["GET", "HEAD"].includes(request.method)) {
        handleReadiness(request, response, options);
        return;
      }

      if (pathname === "/api/v1/auth/guest" && request.method === "POST") {
        await handleAuthGuest(request, response);
        return;
      }
      if (pathname === "/api/v1/auth/login" && request.method === "POST") {
        await handleAuthLogin(request, response);
        return;
      }
      if (pathname === "/api/v1/auth/register" && request.method === "POST") {
        await handleAuthRegister(request, response);
        return;
      }
      if (pathname === "/api/v1/auth/logout" && request.method === "POST") {
        await handleAuthLogout(request, response);
        return;
      }
      if (pathname === "/api/v1/auth/me" && request.method === "GET") {
        handleAuthMe(request, response);
        return;
      }
      if (pathname === "/api/v1/auth/team-invite" && request.method === "GET") {
        handleAuthTeamInvite(request, response);
        return;
      }

      if (pathname === "/api/platform/me" && request.method === "GET") {
        handlePlatformMe(request, response);
        return;
      }
      if (pathname === "/api/platform/team-invite" && request.method === "GET") {
        handlePlatformTeamInvite(request, response);
        return;
      }
      if (pathname === "/api/platform/scores/me" && request.method === "GET") {
        handlePersonalScores(request, response);
        return;
      }
      if (pathname === "/api/platform/admin/overview" && request.method === "GET") {
        handleAdminOverview(request, response, url);
        return;
      }
      if (pathname === "/api/platform/admin/export" && request.method === "GET") {
        handleAdminExport(request, response);
        return;
      }
      if (pathname === "/api/platform/admin/users" && request.method === "GET") {
        handleAdminUsers(request, response);
        return;
      }
      if (pathname === "/api/platform/admin/records" && request.method === "GET") {
        handleAdminRecords(request, response, url);
        return;
      }
      const adminUserMatch = pathname.match(/^\/api\/platform\/admin\/users\/(usr_[a-f0-9]{32})$/);
      if (adminUserMatch && request.method === "PATCH") {
        await handleAdminUserUpdate(request, response, adminUserMatch[1]);
        return;
      }
      const adminRecordJudgmentMatch = pathname.match(/^\/api\/platform\/admin\/records\/(run_[a-f0-9]{32})\/judgment$/);
      if (adminRecordJudgmentMatch && request.method === "POST") {
        await handleAdminRecordJudgment(request, response, adminRecordJudgmentMatch[1]);
        return;
      }

      if (pathname === "/blockly/login.html" && ["GET", "HEAD"].includes(request.method)) {
        response.writeHead(302, {
          Location: "/login.html?returnTo=%2Fblockly%2F",
          "Cache-Control": "no-store, max-age=0"
        });
        response.end();
        return;
      }
      if (pathname.startsWith("/blockly/api/")) {
        const blocklyUrl = new URL(
          pathname.slice("/blockly".length) + url.search,
          requestExternalOrigin(request, options.publicOrigin)
        );
        await blocklyApi.handle(request, response, blocklyUrl);
        return;
      }
      if (pathname.startsWith("/blockly/")) {
        const relativePath = pathname.slice("/blockly".length) || "/";
        if (serveBlockly(request, response, relativePath, url.searchParams)) return;
        throw new PlatformHttpError(404, "NOT_FOUND", "页面不存在。");
      }

      throw new PlatformHttpError(404, "NOT_FOUND", "页面或接口不存在。");
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      const info = errorInfo(error);
      jsonBody(response, info.statusCode, {
        schemaVersion: PLATFORM_SCHEMA_VERSION,
        authoritative: false,
        error: { code: info.code, message: info.message }
      }, info.headers);
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 125_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

function startServer(config = {}) {
  const host = config.host || process.env.HOST || DEFAULT_HOST;
  const port = positivePort(config.port ?? process.env.PORT, DEFAULT_PORT);
  const server = createServer(config);
  server.listen({ port, host, backlog: 2048 }, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    process.stdout.write(`${JSON.stringify({
      status: "listening",
      url: `http://${host}:${actualPort}/`,
      authoritative: false
    })}\n`);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = {
  PLATFORM_SCHEMA_VERSION,
  PLATFORM_READINESS_SCHEMA_VERSION,
  ADMIN_OVERVIEW_SCHEMA_VERSION,
  PERSONAL_SCORES_SCHEMA_VERSION,
  DEFAULT_HOST,
  DEFAULT_PORT,
  ADMIN_PAGE_SIZE,
  MAX_DURATION_MS,
  PlatformHttpError,
  normalizedIp,
  normalizedTrustedProxyIps,
  clientIpForRequest,
  recordDurationMs,
  buildBlocklyAdminRows,
  paginate,
  createServer,
  startServer
};
