# 统一到单一 SQLite 并去除 Python 赛题 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把三进程三存储收敛为「根网关单进程 + 单一 `data/platform.sqlite`」，删除 Python 赛题，后台只负责用户/登录、成绩、Blockly（含地图编辑）。

**Architecture:** 单进程根 `server.js` 直连一个 SQLite 库；新建 `packages/platform-store.js`（统一库访问）、`packages/platform-auth.js`（scrypt 认证）、迁入 SSO 模块；Blockly 的 API 逻辑吸收进根进程，`projects/blockly-page3/` 降为纯前端静态资源。

**Tech Stack:** Node.js ≥22.5（内置 `node:sqlite` `DatabaseSync`）、SQLite WAL、scrypt（`node:crypto`）、纯 `node:http`（无框架）。

**项目约定（覆盖默认 TDD 流程）：** 本仓库不写自动化测试，改代码后仅做 `node --check` 语法校验，功能验证由用户在浏览器完成。因此每个任务以「语法校验 + 浏览器功能验证」收尾，不含测试编写步骤。

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|------|------|------|
| `packages/platform-store.js` | 新建 | 统一库 schema + 8 张表的类型化读写 |
| `packages/platform-auth.js` | 新建 | scrypt 密码哈希 + register/login/logout/me/team-invite + 外部 SSO 身份登录 |
| `packages/official-sso.js` | 新建（迁移） | SSO 跳转/回调（从 car-python/backend 迁入） |
| `packages/platform-service-auth.js` | 新建（迁移） | SSO 服务端校验（从 car-python/backend 迁入） |
| `packages/blockly-api.js` | 新建 | 吸收 blockly server.js 的 records/workspaces/maps/admin/leaderboard handler |
| `tools/migrate-db.js` | 新建 | 幂等建表 + 种子地图 + 迁移 admin |
| `server.js` | 修改 | 接库、挂 blockly-api、静服 `/blockly/*`、删代理/联邦 |
| `projects/blockly-page3/server.js` | 删除 | 逻辑已吸收 |
| `projects/car-python/` | 删除 | 整个目录 |
| `tools/start-platform.js` | 删除 | 多进程启动器不再需要 |

---

## Task 1: 新建 `packages/platform-store.js`（统一库访问层）

**Files:**
- Create: `packages/platform-store.js`
- Reference: `projects/blockly-page3/blockly-record-store.js`（records 表 DDL 与索引）
- Reference: `projects/blockly-page3/blockly-workspace-store.js`（workspaces 表 DDL）

- [ ] **Step 1: 创建统一库模块骨架**

新建 `packages/platform-store.js`，顶部引入依赖并定义常量：

```js
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
const RECORD_ID_PATTERN = /^run_[a-f0-9]{32}$/;
const RECORD_STATES = new Set(["saved", "submitted"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
```

- [ ] **Step 2: 定义建表 DDL**

在模块内定义 `SCHEMA_SQL` 常量（8 张表，DDL 直接复用 spec 第 4 节）：

```js
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
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY NOT NULL,
    team_name TEXT NOT NULL,
    team_name_key TEXT NOT NULL,
    invite_code TEXT NOT NULL,
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
```

- [ ] **Step 3: 实现 `PlatformStore` 类（open/close/PRAGMA/schema 校验）**

```js
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
    const version = this.database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion' LIMIT 1").get();
    if (!version) {
      this.database.prepare("INSERT INTO metadata (key, value) VALUES ('schemaVersion', ?)").run(STORE_SCHEMA_VERSION);
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
}
```

- [ ] **Step 4: 实现 users/teams/sessions 的读写方法**

在 `PlatformStore` 内追加（字段名与 spec 4.2–4.4 一致）：

```js
  insertUser(user) {
    this.database.prepare(`
      INSERT INTO users (id, username, username_key, display_name, team_id, team_name, group_name, role, password_hash, official_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, user.username, user.usernameKey, user.displayName, user.teamId, user.teamName,
      user.group, user.role, user.passwordHash ? JSON.stringify(user.passwordHash) : null,
      user.officialUserId || null, user.createdAt);
    return user;
  }
  findUserById(id) {
    const row = this.database.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").get(id);
    return row ? rowToUser(row) : null;
  }
  findUserByUsernameKey(key) {
    const row = this.database.prepare("SELECT * FROM users WHERE username_key = ? LIMIT 1").get(key);
    return row ? rowToUser(row) : null;
  }
  listUsers() {
    return this.database.prepare("SELECT * FROM users ORDER BY created_at ASC").all().map(rowToUser);
  }
```

并定义 `rowToUser(row)`，把 `password_hash` JSON 字符串解析回对象、`group_name` 映射回 `group`：

```js
function rowToUser(row) {
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
    createdAt: row.created_at
  };
}
```

同样实现 `insertTeam` / `findTeamById` / `findTeamByNameKey` / `listTeams`（teams 表），以及 `insertSession` / `findSessionByTokenHash` / `deleteExpiredSessions`（sessions 表）。字段映射：`team_name`/`team_name_key`/`invite_code` 与 `teamName`/`teamNameKey`/`inviteCode`。

- [ ] **Step 5: 实现 records/workspaces/map_configs 的读写方法**

records 与 workspaces 的读写方法**逐字照搬** `blockly-record-store.js` 的 `insert/submit/page/all/submittedStatsByOwner/bestSubmittedTeamTaskScores/queryByTeamTaskState` 与 `blockly-workspace-store.js` 的 `getAll/save/saveIfMatch`，仅把 `this.database` 换成当前统一库连接、把 `serializedRecord/parsedRecord` 等辅助函数复制进本模块。map_configs 方法：

```js
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
    return this.database.prepare("SELECT task_id FROM map_configs ORDER BY task_id").all()
      .map(row => this.getMapConfig(row.task_id));
  }
```

定义 `rowToMapVersion(row)` 返回 `{ revision, digest, updatedAt, updatedByUserId, layout: JSON.parse(row.layout_json) }`。

- [ ] **Step 6: 导出模块**

```js
module.exports = Object.freeze({
  PlatformStore, STORE_SCHEMA_VERSION, DB_FILE_NAME, sha256,
  USER_ID_PATTERN, TEAM_ID_PATTERN, RECORD_ID_PATTERN, RECORD_STATES
});
```

- [ ] **Step 7: 语法校验**

Run: `node --check packages/platform-store.js`
Expected: 无输出（通过）

- [ ] **Step 8: Commit**

```bash
git add packages/platform-store.js
git commit -m "feat(platform): 新增统一 SQLite 存储访问层"
```

---

## Task 2: 新建 `packages/platform-auth.js`（scrypt 认证）

**Files:**
- Create: `packages/platform-auth.js`
- Reference: `projects/car-python/backend/auth-store.js:80`（SCRYPT_PARAMETERS）、`:348-376`（scryptPassword/createPasswordHash）、`:1094-1145`（login 含哈希升级）、`:1021-1092`（register）

- [ ] **Step 1: 创建模块并定义 scrypt 常量与函数**

```js
"use strict";
const crypto = require("node:crypto");

const SCRYPT_PARAMETERS = Object.freeze({ algorithm: "scrypt", N: 32768, r: 8, p: 1, keyLength: 32 });
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}
function randomSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}
function scryptPassword(password, salt, parameters = SCRYPT_PARAMETERS) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, parameters.keyLength, {
      N: parameters.N, r: parameters.r, p: parameters.p, maxmem: 128 * 1024 * 1024
    }, (error, derived) => error ? reject(error) : resolve(derived));
  });
}
async function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = await scryptPassword(password, salt);
  return { ...SCRYPT_PARAMETERS, salt, hash: hash.toString("base64url") };
}
async function passwordMatches(password, storedHash) {
  const salt = Buffer.from(storedHash.salt, "base64url");
  const expected = Buffer.from(storedHash.hash, "base64url");
  const actual = await scryptPassword(password, salt, storedHash);
  return crypto.timingSafeEqual(actual, expected);
}
```

- [ ] **Step 2: 实现会话 token 生成/校验**

```js
function sessionRecord(user, token) {
  return {
    id: randomId("ase"),
    tokenHash: sha256(token),
    userId: user.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  };
}
```

- [ ] **Step 3: 实现 `PlatformAuth` 类（依赖 PlatformStore 实例）**

```js
class PlatformAuth {
  constructor(store) {
    if (!store || typeof store.insertUser !== "function") throw new TypeError("PlatformAuth 需要 PlatformStore 实例。");
    this.store = store;
  }
  async register({ username, password, displayName, teamName, group, teamAction, inviteCode }) {
    // 校验字段后调用 createPasswordHash，再构造用户+队伍，写入 store。
    // 逻辑照搬 auth-store.js AuthStore#register（1021-1092），字段名用 camelCase 落库前转 snake_case。
  }
  async login({ username, password, administratorsOnly = false }) {
    // 照搬 auth-store.js AuthStore#login（1094-1145）：查用户→passwordMatches→可选哈希升级→建会话。
  }
  async loginExternalIdentity({ officialUserId, officialTeamId, group, teamName }) {
    // 照搬 auth-store.js AuthStore#loginExternalIdentity（1146-1216）。
  }
  async logout(tokenHash) { /* 删除对应 session */ }
  async principalFromRequest(request) { /* 从 Cookie 或 SSO 头解析当前用户 */ }
}
```

- [ ] **Step 4: 导出**

```js
module.exports = Object.freeze({ PlatformAuth, SCRYPT_PARAMETERS, createPasswordHash, passwordMatches, sha256, randomId, randomSessionToken });
```

- [ ] **Step 5: 语法校验**

Run: `node --check packages/platform-auth.js`
Expected: 无输出

- [ ] **Step 6: Commit**

```bash
git add packages/platform-auth.js
git commit -m "feat(platform): 新增 scrypt 认证模块"
```

---

## Task 3: 迁移 SSO 模块到 `packages/`

**Files:**
- Create: `packages/official-sso.js`（复制自 `projects/car-python/backend/official-sso.js`）
- Create: `packages/platform-service-auth.js`（复制自 `projects/car-python/backend/platform-service-auth.js`）
- Modify: 两个文件内的 `require` 路径（原相对 car-python/backend 的引用改为相对 packages/）

- [ ] **Step 1: 复制两个文件到 packages/**

```bash
cp projects/car-python/backend/official-sso.js packages/official-sso.js
cp projects/car-python/backend/platform-service-auth.js packages/platform-service-auth.js
```

- [ ] **Step 2: 修正 require 路径**

用 Grep 检查这两个文件里 `require("./` 或 `require("../` 的引用，改为 packages 目录下的正确相对路径（若它们原来依赖 car-python 内的其他文件，需要一并迁移或改为引用 packages/platform-auth.js）。

- [ ] **Step 3: 语法校验**

Run: `node --check packages/official-sso.js && node --check packages/platform-service-auth.js`
Expected: 无输出

- [ ] **Step 4: Commit**

```bash
git add packages/official-sso.js packages/platform-service-auth.js
git commit -m "feat(platform): 迁移官方 SSO 模块到 packages/"
```

---

## Task 4: 新建 `tools/migrate-db.js`（建表 + 种子 + 迁移 admin）

**Files:**
- Create: `tools/migrate-db.js`
- Reference: `projects/blockly-page3/guangyang-map-config.js`（DEFAULT_LAYOUTS/normalizeLayout）
- Reference: `projects/car-python/.runtime/auth/auth-store.json`（admin 用户与队伍数据）

- [ ] **Step 1: 创建脚本，定位数据目录与库**

```js
"use strict";
const path = require("node:path");
const { PlatformStore, sha256 } = require("../packages/platform-store.js");
const primaryGuangyangMaps = require("../projects/blockly-page3/guangyang-map-config.js");

const DATA_DIR = path.resolve(__dirname, "..", "data");
const store = new PlatformStore({ dataDir: DATA_DIR });
```

- [ ] **Step 2: 种子 3 个默认地图**

```js
function seedMaps() {
  const timestamp = new Date().toISOString();
  for (const taskId of Object.keys(primaryGuangyangMaps.TASKS)) {
    if (store.getMapConfig(taskId)) continue; // 幂等
    const layout = primaryGuangyangMaps.normalizeLayout(taskId, primaryGuangyangMaps.defaultLayout(taskId));
    const revision = 1;
    const digest = sha256(JSON.stringify({ taskId, revision, layout }));
    store.upsertMapConfig(taskId, revision, digest, timestamp, null, layout);
  }
}
```

- [ ] **Step 3: 迁移 admin 用户及其队伍（幂等）**

```js
function seedAdmin() {
  const now = new Date().toISOString();
  const adminId = "usr_5348eb246c974055b000aa405aed424b";
  const teamId = "tea_36b96a1031414b5c98fa5bda24610121";
  if (!store.findTeamById(teamId)) {
    store.insertTeam({
      id: teamId, teamName: "测试队伍", teamNameKey: "测试队伍",
      inviteCode: "5G6H36R2", createdAt: "2026-09-20T07:53:00.186Z"
    });
  }
  if (!store.findUserById(adminId)) {
    store.insertUser({
      id: adminId, username: "admin", usernameKey: "admin", displayName: "admin",
      teamId, teamName: "测试队伍", group: "primary", role: "admin",
      passwordHash: {
        algorithm: "scrypt", N: 32768, r: 8, p: 1, keyLength: 32,
        salt: "z7YXGpT98ingXmw9KHMf-w",
        hash: "hmv8-X_DGjM7UsWN5wReKyyIxyCxnZpKLXRQ_2BP3UY"
      },
      officialUserId: null, createdAt: "2026-09-20T07:53:00.186Z"
    });
  }
  void now;
}
```

- [ ] **Step 4: 执行入口**

```js
seedMaps();
seedAdmin();
store.close();
console.log("统一平台数据库已就绪：", store.databasePath);
```

- [ ] **Step 5: 语法校验并试运行**

Run: `node --check tools/migrate-db.js && node tools/migrate-db.js`
Expected: 无报错；`data/platform.sqlite` 生成，再次运行不重复种子（幂等）。

- [ ] **Step 6: Commit**

```bash
git add tools/migrate-db.js
git commit -m "feat(platform): 新增统一库建表与种子脚本"
```

---

## Task 5: 新建 `packages/blockly-api.js`（吸收 Blockly API 逻辑）

**Files:**
- Create: `packages/blockly-api.js`
- Reference: `projects/blockly-page3/server.js:1153-1650`（handleApi 及被调用的 handler 函数）

- [ ] **Step 1: 创建模块骨架，接收 PlatformStore/PlatformAuth 依赖**

```js
"use strict";
const primaryGuangyangScoring = require("../projects/blockly-page3/guangyang-scoring.js");
const primaryGuangyangMaps = require("../projects/blockly-page3/guangyang-map-config.js");

function createBlocklyApi({ store, auth }) {
  // 返回 { handle(request, response, url) }
}
module.exports = { createBlocklyApi };
```

- [ ] **Step 2: 移植地图/成绩相关纯函数**

从 `projects/blockly-page3/server.js` 复制并改用 store：`mapDigest`(270)、`createInitialMapConfig`(274)、`allCurrentMapConfigs`(926)、`publicMapConfig`(914)、`mapVersion`(906)、`scoreRun`(884)、`recordSummary`(1025)、`adminUserSummary`(1087)、`adminRecordSummary`(1119)、`adminRecordDetail`(1143)。数据来源从「内存 store.json / blockly-record-store」改为 `store` 参数。

- [ ] **Step 3: 移植路由处理**

复制 `handleApi`（1153）的各个 `if (url.pathname === ...)` 分支，覆盖这些路由（路径保持 `/api/...` 不变，由根网关挂载时加 `/blockly` 前缀）：

`/api/health`、`/api/auth/me`、`/api/auth/team-invite`、`/api/workspaces`、`/api/maps`、`/api/admin/maps`、`/api/admin/users`、`/api/admin/records`、`/api/admin/team-task-scores`、`/api/admin/export/users`、`/api/admin/export/records`、`/api/records`（GET/POST）、`/api/leaderboard`。

auth 相关分支（register/login/logout）**不移植**——这些由 `platform-auth.js` 在平台层处理；`/api/auth/me`、`/api/auth/team-invite` 改为调用 `auth.principalFromRequest` 与 `auth` 的 team-invite 逻辑。

- [ ] **Step 4: 语法校验**

Run: `node --check packages/blockly-api.js`
Expected: 无输出

- [ ] **Step 5: Commit**

```bash
git add packages/blockly-api.js
git commit -m "feat(platform): 吸收 Blockly API 逻辑为独立模块"
```

---

## Task 6: 改造根 `server.js`（接库 + 挂载 + 删代理）

**Files:**
- Modify: `server.js`

- [ ] **Step 1: 顶部引入新模块，移除 upstreams/代理相关常量**

删除 `DEFAULT_UPSTREAMS`(18-25)、`DEFAULT_AUTH_STORE`(26)、`MAX_PROXY_BODY_BYTES`(32)、`MAX_AUTH_PROXY_BODY_BYTES`(33)、`MAX_AUTH_STORE_BYTES`(34) 及 `readAuthStore`/`authStoreCache`/`authStoreUserIndex`/`enrichPrincipal`（315-360 附近）等代理/文件读 auth 逻辑。

新增引入与初始化：

```js
const { PlatformStore } = require("./packages/platform-store.js");
const { PlatformAuth } = require("./packages/platform-auth.js");
const { createBlocklyApi } = require("./packages/blockly-api.js");
const DATA_DIR = path.join(__dirname, "data");
const store = new PlatformStore({ dataDir: DATA_DIR });
const auth = new PlatformAuth(store);
const blocklyApi = createBlocklyApi({ store, auth });
```

- [ ] **Step 2: 实现本地 auth 路由（替换 proxyPythonAuth）**

把 `/api/v1/auth/register|login|logout|me|team-invite` 从 `proxyPythonAuth` 转发改为直接调用 `auth.register/login/logout/principalFromRequest`，响应体沿用现有 schema（`chenlong.*` 版本字符串保留）。`/sso/jump` 与 `/api/v1/auth/sso/*` 改为调用 `packages/official-sso.js` 直接实现。

- [ ] **Step 3: 挂载 Blockly 静态资源与 API**

把 `/blockly/` 分支从「代理到 6180」改为：
- `/blockly/api/*`：剥掉 `/blockly` 前缀，调用 `blocklyApi.handle(request, response, url)`。
- 其余 `/blockly/*`：直接 serve `projects/blockly-page3/` 下的静态文件，保留现有的路径重写逻辑（把 JS 里的 `/api/` 重写为 `/blockly/api/`）。

- [ ] **Step 4: 删除联邦/代理残留**

删除 `signedPrincipal`、`verifyPrincipal` 的使用、`probeReadiness` 的 python/blockly 上游探测（503-530）、`buildAdminRows` 中 python 记录合并逻辑（只保留 blockly 记录）、`blocklyMapsForRequest` 跨服务取图（改为直读 store）。

- [ ] **Step 5: 成绩口径改为仅 blockly**

`/api/platform/scores/me`、`/api/platform/admin/overview`、`/api/platform/admin/export` 等处的排行榜/成绩数据源，从「python + blockly 合并」改为只读 blockly `records` 表（通过 store 的 `bestSubmittedTeamTaskScores` 等）。

- [ ] **Step 6: 语法校验**

Run: `node --check server.js`
Expected: 无输出

- [ ] **Step 7: 浏览器功能验证（用户执行）**

启动 `node server.js`，验证：登录页可用（admin 原密码登录）、Blockly 页面加载、地图编辑、成绩/排行榜只显示 blockly 记录、SSO 跳转流程。

- [ ] **Step 8: Commit**

```bash
git add server.js
git commit -m "refactor(platform): 根网关接入统一库并移除代理与联邦"
```

---

## Task 7: 删除旧进程与旧数据

**Files:**
- Delete: `projects/car-python/`（整个目录）
- Delete: `projects/blockly-page3/server.js`
- Delete: `tools/start-platform.js`

- [ ] **Step 1: 确认无残留引用**

用 Grep 全仓库搜 `car-python`、`6180`、`proxyPythonAuth`、`start-platform`，确认根 server.js 与 packages 内已无引用（`package.json` 的 `start:all` 脚本一并清理）。

- [ ] **Step 2: 删除目录与文件**

```bash
git rm -r projects/car-python
git rm projects/blockly-page3/server.js tools/start-platform.js
```

- [ ] **Step 3: 更新 `package.json` 脚本**

删除 `start:all`（多进程启动器已删），保留/调整 `start`、`migrate` 指向 `tools/migrate-db.js`。

- [ ] **Step 4: 语法校验**

Run: `node --check server.js && node --check packages/platform-store.js && node --check packages/platform-auth.js && node --check packages/blockly-api.js && node --check tools/migrate-db.js`
Expected: 全部无输出

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(platform): 删除 Python 赛题与多进程启动器"
```

---

## Task 8: 收尾清理 `packages/platform-contract.js`

**Files:**
- Modify: `packages/platform-contract.js`

- [ ] **Step 1: 删除联邦签名相关导出**

`signPrincipal`、`verifyPrincipal`、`PLATFORM_TO_BLOCKLY_TASK` 在单进程下不再使用，删除；确认 `packages/score-download.js`、`packages/live-score-source.js` 不依赖它们后一并清理。

- [ ] **Step 2: 语法校验**

Run: `node --check packages/platform-contract.js && node --check server.js`
Expected: 无输出

- [ ] **Step 3: Commit**

```bash
git add packages/platform-contract.js
git commit -m "refactor(platform): 清理单进程下不再使用的联邦签名逻辑"
```

---

## 最终验证（整体）

- [ ] 全量语法校验：`node --check server.js` + 所有 `packages/*.js` + `tools/migrate-db.js`
- [ ] 冷启动：删除旧 `data/platform.sqlite`、`.blockly-data/`、`.runtime/` 后，运行 `node tools/migrate-db.js` + `node server.js`，确认 admin 可登录、3 个默认地图可见、blockly 页面与地图编辑正常、成绩/排行榜只显示 blockly 记录、SSO 流程可走通。
