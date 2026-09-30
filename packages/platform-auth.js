"use strict";

const crypto = require("node:crypto");

const { sha256 } = require("./platform-store");

const AUTH_RESPONSE_SCHEMA_VERSION = "chenlong.auth/v1";
const AUTH_COOKIE_NAME = "chenlong_session";
const DEFAULT_AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_USERS = 2_000;
const MAX_USERS = 10_000;
const DEFAULT_MAX_AUTH_SESSIONS = 8_000;
const MAX_AUTH_SESSIONS = 10_000;
const DEFAULT_MAX_SESSIONS_PER_USER = 20;
const MAX_SESSIONS_PER_USER = 100;
const DEFAULT_MAX_PASSWORD_OPERATIONS = 2;
const MAX_PASSWORD_OPERATIONS = 8;

const SCRYPT_PARAMETERS = Object.freeze({
  algorithm: "scrypt",
  N: 32768,
  r: 8,
  p: 1,
  keyLength: 32,
  saltBytes: 16,
  maxmem: 64 * 1024 * 1024
});
// Blockly v6 使用 Node 默认 scrypt 工作因子。统一平台迁移保留这些哈希可登录，
// 并在首次成功登录后升级，而不是要求选手重置密码。
const LEGACY_BLOCKLY_SCRYPT_N = 16384;

const USER_ID_PATTERN = /^usr_[a-f0-9]{32}$/;
const TEAM_ID_PATTERN = /^tea_[a-f0-9]{32}$/;
const AUTH_SESSION_ID_PATTERN = /^ase_[a-f0-9]{32}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const OFFICIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TEAM_INVITE_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
const ROLE_VALUES = new Set(["user", "admin"]);
const PARTICIPANT_GROUP_VALUES = Object.freeze(["primary", "junior", "high"]);
const PARTICIPANT_GROUP_VALUE_SET = new Set(PARTICIPANT_GROUP_VALUES);
const DEFAULT_PARTICIPANT_GROUP = "primary";
const LEGACY_PARTICIPANT_GROUP_ALIASES = new Map([
  ["primary", "primary"],
  ["primary_school", "primary"],
  ["primary_low", "primary"],
  ["primary_high", "primary"],
  ["小学组", "primary"],
  ["小学", "primary"],
  ["小学组（1-3年级）", "primary"],
  ["小学组(1-3年级)", "primary"],
  ["小学低年级组", "primary"],
  ["小学低年级", "primary"],
  ["小学组（4-6年级）", "primary"],
  ["小学组(4-6年级)", "primary"],
  ["小学高年级组", "primary"],
  ["小学高年级", "primary"],
  ["junior", "junior"],
  ["middle_school", "junior"],
  ["初中组", "junior"],
  ["初中", "junior"],
  ["high", "high"],
  ["high_school", "high"],
  ["senior", "high"],
  ["高中组", "high"],
  ["高中", "high"]
]);

class AuthStoreError extends Error {
  constructor(statusCode, code, message, headers = {}) {
    super(message);
    this.name = "AuthStoreError";
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

function normalizeUsername(value) {
  if (typeof value !== "string") {
    throw new AuthStoreError(400, "INVALID_USERNAME", "username must be a string");
  }
  const username = value.trim().normalize("NFC");
  if (!USERNAME_PATTERN.test(username)) {
    throw new AuthStoreError(
      400,
      "INVALID_USERNAME",
      "username must contain 3-32 ASCII letters, numbers, '.', '_' or '-', and start with a letter or number"
    );
  }
  return { username, usernameKey: username.toLowerCase() };
}

function normalizeDisplayName(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") {
    throw new AuthStoreError(400, "INVALID_DISPLAY_NAME", "displayName must be a string");
  }
  const displayName = value.trim().normalize("NFC");
  const length = [...displayName].length;
  if (length < 1 || length > 64 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(displayName)) {
    throw new AuthStoreError(400, "INVALID_DISPLAY_NAME", "displayName must contain 1-64 visible characters");
  }
  return displayName;
}

function normalizeTeamName(value) {
  if (typeof value !== "string") {
    throw new AuthStoreError(400, "INVALID_TEAM_NAME", "teamName must be a string");
  }
  const teamName = value.trim().normalize("NFC");
  const length = [...teamName].length;
  if (length < 1 || length > 64 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(teamName)) {
    throw new AuthStoreError(400, "INVALID_TEAM_NAME", "teamName must contain 1-64 visible characters");
  }
  return teamName;
}

function teamNameKey(teamName) {
  return normalizeTeamName(teamName).toLowerCase();
}

function normalizeTeamInviteCode(value) {
  if (typeof value !== "string") {
    throw new AuthStoreError(400, "INVALID_TEAM_INVITE_CODE", "team invite code must be a string");
  }
  const inviteCode = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!TEAM_INVITE_CODE_PATTERN.test(inviteCode)) {
    throw new AuthStoreError(400, "INVALID_TEAM_INVITE_CODE", "team invite code is invalid");
  }
  return inviteCode;
}

function normalizeTeamAction(value) {
  if (value === undefined) return "create";
  if (value !== "create" && value !== "join") {
    throw new AuthStoreError(400, "INVALID_TEAM_ACTION", "team action must be create or join");
  }
  return value;
}

function randomTeamInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  while (result.length < 8) {
    const bytes = crypto.randomBytes(12);
    for (const byte of bytes) {
      if (byte >= 248) continue;
      result += alphabet[byte % alphabet.length];
      if (result.length === 8) return result;
    }
  }
  return result;
}

function normalizeOfficialId(value, name) {
  if (typeof value !== "string" || !OFFICIAL_ID_PATTERN.test(value)) {
    throw new AuthStoreError(400, "INVALID_OFFICIAL_ID", `${name} is invalid`);
  }
  return value;
}

function officialUsername(officialUserId) {
  return `sso_${sha256(officialUserId).slice(0, 20)}`;
}

function normalizeCompatibleParticipantGroup(value) {
  if (typeof value !== "string") {
    throw new AuthStoreError(400, "INVALID_GROUP", "stored participant group is invalid");
  }
  const key = value.normalize("NFKC").trim().toLowerCase();
  const normalized = LEGACY_PARTICIPANT_GROUP_ALIASES.get(key);
  if (!normalized) {
    throw new AuthStoreError(400, "INVALID_GROUP", "stored participant group is invalid");
  }
  return normalized;
}

function normalizeParticipantGroup(value) {
  if (typeof value !== "string" || !PARTICIPANT_GROUP_VALUE_SET.has(value)) {
    throw new AuthStoreError(
      400,
      "INVALID_GROUP",
      `group must be one of: ${PARTICIPANT_GROUP_VALUES.join(", ")}`
    );
  }
  return value;
}

function validatePassword(value) {
  if (typeof value !== "string") {
    throw new AuthStoreError(400, "INVALID_PASSWORD", "password must be a string");
  }
  const length = [...value].length;
  const byteLength = Buffer.byteLength(value, "utf8");
  if (length < 10 || length > 128 || byteLength > 512 || value.includes("\0")) {
    throw new AuthStoreError(400, "INVALID_PASSWORD", "password must contain 10-128 characters and at most 512 UTF-8 bytes");
  }
  return value;
}

function validateUserId(value, { allowNull = false } = {}) {
  if (allowNull && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || !USER_ID_PATTERN.test(value)) {
    throw new AuthStoreError(400, "INVALID_USER_ID", "user id is invalid");
  }
  return value;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function randomSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function scryptPassword(password, salt, parameters = SCRYPT_PARAMETERS) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, parameters.keyLength, {
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
      maxmem: SCRYPT_PARAMETERS.maxmem
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(Buffer.from(derivedKey));
    });
  });
}

async function createPasswordHash(password) {
  const salt = crypto.randomBytes(SCRYPT_PARAMETERS.saltBytes);
  const hash = await scryptPassword(password, salt);
  return {
    algorithm: SCRYPT_PARAMETERS.algorithm,
    N: SCRYPT_PARAMETERS.N,
    r: SCRYPT_PARAMETERS.r,
    p: SCRYPT_PARAMETERS.p,
    keyLength: SCRYPT_PARAMETERS.keyLength,
    salt: salt.toString("base64url"),
    hash: hash.toString("base64url")
  };
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

function adminUser(user) {
  return {
    ...publicUser(user),
    officialUserId: user.officialUserId || null,
    officialTeamId: user.officialTeamId || null
  };
}

function publicSession(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt
  };
}

// scrypt 是 CPU/内存密集操作，用简单信号量限制并发，避免被恶意请求打满。
class PasswordOperationLimiter {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    this.waiters = [];
  }

  async run(operation) {
    if (this.active >= this.maxConcurrent) {
      await new Promise((resolve) => { this.waiters.push(resolve); });
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

class PlatformAuth {
  constructor({ store, sessionTtlMs, maxUsers, maxSessions, maxSessionsPerUser, maxPasswordOperations, registrationOpen, now } = {}) {
    if (!store) throw new TypeError("PlatformAuth 需要 PlatformStore 实例。");
    this.store = store;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.sessionTtlMs = Math.min(Number(sessionTtlMs) || DEFAULT_AUTH_SESSION_TTL_MS, MAX_AUTH_SESSION_TTL_MS);
    this.maxUsers = Math.min(Number(maxUsers) || DEFAULT_MAX_USERS, MAX_USERS);
    this.maxSessions = Math.min(Number(maxSessions) || DEFAULT_MAX_AUTH_SESSIONS, MAX_AUTH_SESSIONS);
    this.maxSessionsPerUser = Math.min(Number(maxSessionsPerUser) || DEFAULT_MAX_SESSIONS_PER_USER, MAX_SESSIONS_PER_USER);
    this.maxPasswordOperations = Math.min(Number(maxPasswordOperations) || DEFAULT_MAX_PASSWORD_OPERATIONS, MAX_PASSWORD_OPERATIONS);
    this.registrationOpen = registrationOpen !== false;
    this.passwordLimiter = new PasswordOperationLimiter(this.maxPasswordOperations);
    this.dummySalt = crypto.randomBytes(SCRYPT_PARAMETERS.saltBytes);
    this.dummyHash = crypto.randomBytes(SCRYPT_PARAMETERS.keyLength);
  }

  timestamp() {
    const milliseconds = Number(this.now());
    if (!Number.isFinite(milliseconds)) throw new TypeError("now() must return a finite timestamp");
    return milliseconds;
  }

  withPasswordOperation(operation) {
    return this.passwordLimiter.run(operation);
  }

  createTeam(teamName, now, { allowDuplicateName = false } = {}) {
    const normalizedTeamName = normalizeTeamName(teamName);
    const nameKey = teamNameKey(normalizedTeamName);
    if (!allowDuplicateName && this.store.findTeamByNameKey(nameKey)) {
      throw new AuthStoreError(409, "TEAM_NAME_TAKEN", "team name is already registered");
    }
    let inviteCode;
    do {
      inviteCode = randomTeamInviteCode();
    } while (this.store.findTeamByInviteCode(inviteCode));
    const team = {
      id: randomId("tea"),
      teamName: normalizedTeamName,
      teamNameKey: nameKey,
      inviteCode,
      createdAt: new Date(now).toISOString()
    };
    this.store.insertTeam(team);
    return team;
  }

  createSession(user, nowMs) {
    const sessions = this.store.listSessionsByUserId(user.id);
    while (sessions.length >= this.maxSessionsPerUser) {
      const oldest = sessions.shift();
      this.store.deleteSession(oldest.id);
    }
    if (this.store.countSessions() >= this.maxSessions) {
      throw new AuthStoreError(503, "AUTH_SESSION_LIMIT", "authentication session capacity is full", { "Retry-After": "1" });
    }
    const token = randomSessionToken();
    const session = {
      id: randomId("ase"),
      tokenHash: sha256(token),
      userId: user.id,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.sessionTtlMs).toISOString()
    };
    this.store.insertSession(session);
    return { token, session };
  }

  assertRegistrationAllowed({ usernameKey, teamAction, normalizedTeamName, normalizedInviteCode }) {
    if (!this.registrationOpen && this.store.countUsers() > 0) {
      throw new AuthStoreError(403, "REGISTRATION_CLOSED", "participant registration is closed");
    }
    if (this.store.findUserByUsernameKey(usernameKey)) {
      throw new AuthStoreError(409, "USERNAME_TAKEN", "username is already registered");
    }
    if (this.store.countUsers() >= this.maxUsers) {
      throw new AuthStoreError(429, "USER_LIMIT_REACHED", "local user limit reached");
    }
    if (teamAction === "create") {
      if (this.store.findTeamByNameKey(teamNameKey(normalizedTeamName))) {
        throw new AuthStoreError(409, "TEAM_NAME_TAKEN", "team name is already registered");
      }
    } else if (!this.store.findTeamByInviteCode(normalizedInviteCode)) {
      throw new AuthStoreError(404, "TEAM_INVITE_NOT_FOUND", "team invite code does not match a team");
    }
  }

  async register({ username, password, displayName, teamName, group, teamAction, inviteCode }) {
    const normalized = normalizeUsername(username);
    const validatedPassword = validatePassword(password);
    const normalizedDisplayName = normalizeDisplayName(displayName, normalized.username);
    const normalizedGroup = normalizeParticipantGroup(group);
    const normalizedTeamAction = normalizeTeamAction(teamAction);
    if (normalizedTeamAction === "join" && teamName !== undefined) {
      throw new AuthStoreError(400, "TEAM_JOIN_NAME_NOT_ALLOWED", "joining a team only accepts an invite code");
    }
    if (normalizedTeamAction === "create" && inviteCode !== undefined) {
      throw new AuthStoreError(400, "TEAM_CREATE_INVITE_NOT_ALLOWED", "creating a team does not accept an invite code");
    }
    const normalizedTeamName = normalizedTeamAction === "create" ? normalizeTeamName(teamName) : null;
    const normalizedInviteCode = normalizedTeamAction === "join" ? normalizeTeamInviteCode(inviteCode) : null;
    this.assertRegistrationAllowed({
      usernameKey: normalized.usernameKey,
      teamAction: normalizedTeamAction,
      normalizedTeamName,
      normalizedInviteCode
    });
    const passwordHash = await this.withPasswordOperation(() => createPasswordHash(validatedPassword));
    // scrypt 让出了事件循环，这里在同步块里重新校验并写入，避免并发注册竞态。
    this.assertRegistrationAllowed({
      usernameKey: normalized.usernameKey,
      teamAction: normalizedTeamAction,
      normalizedTeamName,
      normalizedInviteCode
    });
    const now = this.timestamp();
    let team;
    let createdTeam = false;
    if (normalizedTeamAction === "create") {
      team = this.createTeam(normalizedTeamName, now);
      createdTeam = true;
    } else {
      team = this.store.findTeamByInviteCode(normalizedInviteCode);
      if (!team) {
        throw new AuthStoreError(404, "TEAM_INVITE_NOT_FOUND", "team invite code does not match a team");
      }
      if (team.officialTeamId) {
        throw new AuthStoreError(403, "TEAM_INVITE_UNAVAILABLE", "official teams do not accept local registrations");
      }
    }
    const existingParticipant = normalizedTeamAction === "join"
      ? this.store.listUsersByTeamId(team.id).find(item => item.role !== "admin")
      : null;
    const effectiveGroup = existingParticipant?.group || normalizedGroup;
    const bootstrapAdmin = this.store.countUsers() === 0;
    const user = {
      id: randomId("usr"),
      username: normalized.username,
      usernameKey: normalized.usernameKey,
      displayName: normalizedDisplayName,
      teamId: team.id,
      teamName: team.teamName,
      group: effectiveGroup,
      role: bootstrapAdmin ? "admin" : "user",
      passwordHash,
      createdAt: new Date(now).toISOString()
    };
    this.store.insertUser(user);
    const { token, session } = this.createSession(user, now);
    return {
      user: publicUser(user),
      session: publicSession(session),
      token,
      bootstrapAdmin,
      teamInviteCode: createdTeam ? team.inviteCode : null
    };
  }

  async login({ username, password, administratorsOnly = false }) {
    let normalized = null;
    try {
      normalized = normalizeUsername(username);
    } catch (_error) {
      // 保持公共错误信息通用，同时在下面仍执行一次密码哈希以对齐时序。
    }
    let validatedPassword = null;
    try {
      validatedPassword = validatePassword(password);
    } catch (error) {
      if (typeof password !== "string" || Buffer.byteLength(String(password), "utf8") > 512) throw error;
      validatedPassword = String(password);
    }
    const candidate = normalized
      ? this.store.findUserByUsernameKey(normalized.usernameKey)
      : null;
    const passwordCandidate = candidate?.passwordHash ? candidate : null;
    const salt = passwordCandidate ? Buffer.from(passwordCandidate.passwordHash.salt, "base64url") : this.dummySalt;
    const expected = passwordCandidate ? Buffer.from(passwordCandidate.passwordHash.hash, "base64url") : this.dummyHash;
    const actual = await this.withPasswordOperation(() => scryptPassword(
      validatedPassword,
      salt,
      passwordCandidate?.passwordHash || SCRYPT_PARAMETERS
    ));
    const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!passwordCandidate || !matches) {
      throw new AuthStoreError(401, "INVALID_CREDENTIALS", "username or password is incorrect", {
        "WWW-Authenticate": "Cookie realm=\"chenlong\""
      });
    }
    if (administratorsOnly && candidate.role !== "admin") {
      throw new AuthStoreError(403, "LOCAL_LOGIN_ADMIN_ONLY", "此登录入口仅供管理员使用。");
    }
    if (candidate.passwordHash.N !== SCRYPT_PARAMETERS.N) {
      const upgradedPasswordHash = await this.withPasswordOperation(() => createPasswordHash(validatedPassword));
      this.store.updateUserPasswordHash(candidate.id, upgradedPasswordHash);
    }
    const { token, session } = this.createSession(candidate, this.timestamp());
    return {
      user: publicUser(candidate),
      session: publicSession(session),
      token,
      bootstrapAdmin: false
    };
  }

  async loginExternalIdentity({ officialUserId, officialTeamId, group, teamName }) {
    const normalizedOfficialUserId = normalizeOfficialId(officialUserId, "officialUserId");
    const normalizedOfficialTeamId = normalizeOfficialId(officialTeamId, "officialTeamId");
    const normalizedGroup = normalizeCompatibleParticipantGroup(group);
    const normalizedTeamName = normalizeTeamName(teamName);
    const username = officialUsername(normalizedOfficialUserId);
    const usernameKey = username.toLowerCase();
    const now = this.timestamp();
    if (!this.store.listUsers().some(item => item.role === "admin")) {
      throw new AuthStoreError(403, "EXTERNAL_ADMIN_REQUIRED", "an administrator must initialize the platform first");
    }
    let user = this.store.findUserByOfficialId(normalizedOfficialUserId);
    const usernameConflict = this.store.findUserByUsernameKey(usernameKey);
    if (usernameConflict && (!user || usernameConflict.id !== user.id)) {
      throw new AuthStoreError(409, "EXTERNAL_IDENTITY_CONFLICT", "official identity conflicts with a local account");
    }
    if (user && user.usernameKey !== usernameKey) {
      throw new AuthStoreError(409, "EXTERNAL_IDENTITY_CONFLICT", "official identity mapping is inconsistent");
    }
    if (user && user.officialTeamId !== normalizedOfficialTeamId) {
      throw new AuthStoreError(
        403,
        "OFFICIAL_TEAM_REASSIGNMENT_REQUIRES_ADMIN",
        "official user team binding cannot be changed by browser SSO"
      );
    }

    let team = this.store.findTeamByOfficialId(normalizedOfficialTeamId);
    if (!team) {
      if (this.store.countUsers() >= this.maxUsers) {
        throw new AuthStoreError(429, "USER_LIMIT_REACHED", "local user limit reached");
      }
      team = this.createTeam(normalizedTeamName, now, { allowDuplicateName: true });
      team = this.store.updateTeam(team.id, { officialTeamId: normalizedOfficialTeamId });
    } else if (team.teamName !== normalizedTeamName) {
      this.store.updateTeam(team.id, {
        teamName: normalizedTeamName,
        teamNameKey: teamNameKey(normalizedTeamName)
      });
      for (const member of this.store.listUsersByTeamId(team.id)) {
        this.store.updateUserTeam(member.id, team.id, normalizedTeamName);
      }
      team = this.store.findTeamById(team.id);
    }

    if (!user) {
      if (this.store.countUsers() >= this.maxUsers) {
        throw new AuthStoreError(429, "USER_LIMIT_REACHED", "local user limit reached");
      }
      user = {
        id: randomId("usr"),
        username,
        usernameKey,
        displayName: `官网选手-${sha256(normalizedOfficialUserId).slice(0, 8)}`,
        teamId: team.id,
        teamName: team.teamName,
        group: normalizedGroup,
        role: "user",
        officialUserId: normalizedOfficialUserId,
        officialTeamId: normalizedOfficialTeamId,
        createdAt: new Date(now).toISOString()
      };
      this.store.insertUser(user);
    } else {
      this.store.updateUser(user.id, {
        teamId: team.id,
        teamName: team.teamName,
        group: normalizedGroup,
        officialTeamId: normalizedOfficialTeamId
      });
    }
    for (const member of this.store.listUsers()) {
      if (member.officialTeamId === normalizedOfficialTeamId && member.group !== normalizedGroup) {
        this.store.updateUser(member.id, { group: normalizedGroup });
      }
    }
    user = this.store.findUserById(user.id);
    const { token, session } = this.createSession(user, now);
    return {
      user: publicUser(user),
      session: publicSession(session),
      token,
      bootstrapAdmin: false
    };
  }

  async createGuest() {
    const randomPassword = crypto.randomBytes(24).toString("base64url");
    const passwordHash = await this.withPasswordOperation(() => createPasswordHash(randomPassword));
    if (this.store.countUsers() >= this.maxUsers) {
      throw new AuthStoreError(429, "USER_LIMIT_REACHED", "local user limit reached");
    }
    const suffix = crypto.randomBytes(4).toString("hex");
    const username = `guest-${suffix}`;
    const now = this.timestamp();
    const team = this.createTeam(`游客-${suffix}`, now, { allowDuplicateName: true });
    const user = {
      id: randomId("usr"),
      username,
      usernameKey: username.toLowerCase(),
      displayName: `游客-${suffix}`,
      teamId: team.id,
      teamName: team.teamName,
      group: DEFAULT_PARTICIPANT_GROUP,
      role: "user",
      passwordHash,
      createdAt: new Date(now).toISOString()
    };
    this.store.insertUser(user);
    const { token, session } = this.createSession(user, now);
    return {
      user: publicUser(user),
      session: publicSession(session),
      token,
      bootstrapAdmin: false
    };
  }

  authenticate(token) {
    if (typeof token !== "string" || !SESSION_TOKEN_PATTERN.test(token)) {
      throw new AuthStoreError(401, "AUTHENTICATION_REQUIRED", "a valid login session is required", {
        "WWW-Authenticate": "Cookie realm=\"chenlong\""
      });
    }
    const tokenHash = sha256(token);
    const session = this.store.findSessionByTokenHash(tokenHash);
    const now = this.timestamp();
    if (!session || Date.parse(session.expiresAt) <= now) {
      if (session) this.store.deleteSession(session.id);
      throw new AuthStoreError(401, "AUTHENTICATION_REQUIRED", "login session is missing or expired", {
        "WWW-Authenticate": "Cookie realm=\"chenlong\""
      });
    }
    const user = this.store.findUserById(session.userId);
    if (!user) throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "login session references an unknown user");
    return { user: publicUser(user), session: publicSession(session), tokenHash, teamId: user.teamId };
  }

  logout(token) {
    if (typeof token !== "string" || !SESSION_TOKEN_PATTERN.test(token)) return false;
    const session = this.store.findSessionByTokenHash(sha256(token));
    if (!session) return false;
    this.store.deleteSession(session.id);
    return true;
  }

  getPublicUser(userId) {
    const normalized = validateUserId(userId, { allowNull: true });
    if (!normalized) return null;
    const user = this.store.findUserById(normalized);
    return user ? publicUser(user) : null;
  }

  getTeamInviteForUser(userId) {
    const normalizedUserId = validateUserId(userId);
    const user = this.store.findUserById(normalizedUserId);
    if (!user) throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "authenticated user is missing");
    if (user.role === "admin") {
      throw new AuthStoreError(403, "TEAM_INVITE_UNAVAILABLE", "administrator accounts do not participate in teams");
    }
    if (user.officialUserId) {
      throw new AuthStoreError(403, "TEAM_INVITE_UNAVAILABLE", "official teams do not use local invite codes");
    }
    const team = this.store.findTeamById(user.teamId);
    if (!team) throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "authenticated user references an unknown team");
    return Object.freeze({ teamName: team.teamName, inviteCode: team.inviteCode });
  }

  listPublicUsers() {
    return this.store.listUsers().map(publicUser);
  }

  listAdminUsers() {
    return this.store.listUsers().map(adminUser);
  }

  listTeamsForAdmin() {
    return this.store.listTeams()
      .map(team => {
        const members = this.store.listUsersByTeamId(team.id)
          .filter(user => user.role !== "admin")
          .map(user => ({
            userId: user.id,
            username: user.username,
            displayName: user.displayName
          }))
          .sort((left, right) => left.username.localeCompare(right.username, "zh-CN"));
        return { teamId: team.id, teamName: team.teamName, members };
      })
      .filter(team => team.members.length > 0)
      .sort((left, right) => left.teamName.localeCompare(right.teamName, "zh-CN"));
  }

  updateManagedUser(userId, { teamName, group }) {
    const normalizedUserId = validateUserId(userId);
    const normalizedTeamName = normalizeTeamName(teamName);
    const normalizedGroup = normalizeParticipantGroup(group);
    const current = this.store.findUserById(normalizedUserId);
    if (!current) {
      throw new AuthStoreError(404, "USER_NOT_FOUND", "user does not exist");
    }
    if (current.role === "admin") {
      throw new AuthStoreError(409, "ADMIN_ACCOUNT_NOT_PARTICIPANT", "administrator accounts do not have a team or participant group");
    }
    if (current.officialUserId) {
      throw new AuthStoreError(409, "OFFICIAL_IDENTITY_MANAGED_EXTERNALLY", "official participant data is managed by SSO");
    }
    const currentTeam = this.store.findTeamById(current.teamId);
    if (!currentTeam) throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "user references an unknown team");
    const changingTeamName = currentTeam.teamName !== normalizedTeamName;
    if (changingTeamName) {
      const conflict = this.store.findTeamByNameKey(teamNameKey(normalizedTeamName));
      if (conflict && conflict.id !== currentTeam.id) {
        throw new AuthStoreError(409, "TEAM_NAME_TAKEN", "team name is already registered");
      }
    }
    const members = this.store.listUsersByTeamId(currentTeam.id);
    const changingTeamGroup = members.some(member => (
      member.role !== "admin" && member.group !== normalizedGroup
    ));
    if (!changingTeamName && !changingTeamGroup) {
      return { user: publicUser(current), changed: false };
    }
    if (changingTeamName) {
      this.store.updateTeam(currentTeam.id, {
        teamName: normalizedTeamName,
        teamNameKey: teamNameKey(normalizedTeamName)
      });
      for (const member of members) {
        this.store.updateUserTeam(member.id, currentTeam.id, normalizedTeamName);
      }
    }
    if (changingTeamGroup) {
      for (const member of members) {
        if (member.role !== "admin") this.store.updateUser(member.id, { group: normalizedGroup });
      }
    }
    return { user: publicUser(this.store.findUserById(normalizedUserId)), changed: true };
  }
}

module.exports = Object.freeze({
  AUTH_RESPONSE_SCHEMA_VERSION,
  AUTH_COOKIE_NAME,
  DEFAULT_AUTH_SESSION_TTL_MS,
  MAX_AUTH_SESSION_TTL_MS,
  SCRYPT_PARAMETERS,
  LEGACY_BLOCKLY_SCRYPT_N,
  PARTICIPANT_GROUP_VALUES,
  DEFAULT_PARTICIPANT_GROUP,
  AuthStoreError,
  PlatformAuth,
  normalizeUsername,
  normalizeDisplayName,
  normalizeTeamName,
  normalizeTeamInviteCode,
  normalizeParticipantGroup,
  validatePassword,
  validateUserId
});
