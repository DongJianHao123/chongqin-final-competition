# 统一到单一 SQLite 并去除 Python 赛题 — 设计文档

日期：2026-09-30
状态：待评审

## 1. 背景与目标

当前平台是「三进程 + 三套分散存储」：根网关（6190）、Python 赛题（6178）、Blockly 赛题（6180），数据散落在 JSON 文件、两个 SQLite 文件、按 session/用户哈希的文件里，schema 版本号混杂（v1/v6/v8/v2），不好维护。

本次改造的目标：

1. **去除整个 Python 赛题**（`projects/car-python/`），连同其提交评测、批量评测、视觉识别、地图池等全部删除。
2. **合并为单一进程 + 单一 SQLite**：根网关吸收一切，`data/platform.sqlite` 一张库。
3. **后台职责收敛**为三件事：用户（含登录/SSO）、成绩、Blockly（含地图编辑）。
4. `projects/blockly-page3/` 降级为**纯前端静态资源**，由根网关在 `/blockly/` 路径直接 serve，前端零改动。

## 2. 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 统一范围 | 全平台共享一个 SQLite |
| 2 | 迁移策略 | 丢弃数据空库重建，**仅迁移现有 `admin` 一条用户及其队伍** |
| 3 | 架构 | 三进程合并为单进程，删除 Python |
| 4 | 后端落点 | 根网关 `server.js` 吸收一切 |
| 5 | 外部 SSO | 保留（参数由用户提供），SSO 逻辑从 car-python 迁入根侧 |

## 3. 目标架构

```
                浏览器
                  │
        ┌─────────┴─────────┐
        │  根 server.js (6190) │  单进程
        │  ├ 平台 portal / login / admin / leaderboard
        │  ├ 外部 SSO（从 car-python 迁入）
        │  ├ 本地 auth（scrypt，从 car-python 迁入）
        │  ├ Blockly 竞赛 + 地图编辑（从 blockly server 迁入）
        │  └ 静态资源 /blockly/*（blockly-page3 降为纯前端）
        └─────────┬─────────┘
                  │ node:sqlite (WAL)
        ┌─────────┴─────────┐
        │ data/platform.sqlite │
        └────────────────────┘
```

- 单进程，无代理、无联邦签名、无跨服务取数。
- SQLite 采用 WAL + `synchronous=FULL` + `busy_timeout=5000`（沿用现有 blockly store 的 PRAGMA 设置）。

## 4. 数据模型（单库 8 张表）

统一 schema 版本：`chenlong.platform-store/v1`，存于 `metadata` 表。

### 4.1 metadata
```sql
CREATE TABLE metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;
```
存放 `schemaVersion`、`databaseId`、迁移标记等。

### 4.2 users（来源：car-python auth-store users + blockly store users）
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  team_id TEXT,
  team_name TEXT,
  group_name TEXT,
  role TEXT NOT NULL,
  password_hash TEXT,          -- JSON: {algorithm,N,r,p,keyLength,salt,hash}
  official_user_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
```

### 4.3 teams（来源：car-python auth-store teams）
```sql
CREATE TABLE teams (
  id TEXT PRIMARY KEY NOT NULL,
  team_name TEXT NOT NULL,
  team_name_key TEXT NOT NULL,
  invite_code TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
```

### 4.4 sessions（来源：car-python auth-store sessions）
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX sessions_user_idx ON sessions(user_id);
```

### 4.5 records（来源：blockly-record-store，表结构原样复用）
```sql
CREATE TABLE records (
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
CREATE INDEX records_owner_created_idx ON records(owner_user_id, created_at_ms DESC, id DESC);
CREATE INDEX records_owner_state_submitted_idx ON records(owner_user_id, record_state, submitted_at_ms DESC, id DESC);
CREATE INDEX records_team_task_state_submitted_idx ON records(owner_team_id, task_id, record_state, submitted_at_ms DESC, id DESC);
CREATE INDEX records_state_submitted_idx ON records(record_state, submitted_at_ms DESC, id DESC);
```

### 4.6 workspaces（来源：blockly-workspace-store，表结构原样复用）
```sql
CREATE TABLE workspaces (
  owner_user_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workspace_json TEXT NOT NULL,
  workspace_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, task_id)
) STRICT;
CREATE INDEX workspaces_owner_updated_idx ON workspaces(owner_user_id, updated_at_ms DESC);
```

### 4.7 map_configs + map_config_versions（来源：blockly store.json mapConfigs）
地图编辑是版本化的，拆成「当前版本指针」+「版本链」两张表，保留 `revision` + `digest` 完整性。
```sql
CREATE TABLE map_configs (
  task_id TEXT PRIMARY KEY NOT NULL,
  current_revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE map_config_versions (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT,
  layout_json TEXT NOT NULL,   -- chenlong.guangyang-map-layout/v2
  PRIMARY KEY (task_id, revision)
) STRICT;
```

### 数据来源映射

| 旧存储 | 新表 |
|--------|------|
| `car-python/.runtime/auth/auth-store.json` (v6) | `users` / `teams` / `sessions` |
| `blockly-page3/.blockly-data/primary-blockly-store.json` (v8) 的 mapConfigs | `map_configs` / `map_config_versions` |
| `blockly-page3/.blockly-data/primary-blockly-records.sqlite` | `records` |
| `blockly-page3/.blockly-data/primary-blockly-workspaces.sqlite` | `workspaces` |
| car-python sessions/ workspace-sources/ batches/ ranked-evaluations/ | **删除，不迁移** |

## 5. 代码落点

| 模块 | 位置 | 职责 |
|------|------|------|
| 统一库访问层 | `packages/platform-store.js`（新） | schema DDL + users/teams/sessions/records/workspaces/map_configs 的类型化读写 |
| 本地 auth | `packages/platform-auth.js`（新） | scrypt 密码哈希、register/login/logout/me/team-invite（从 auth-store.js 提炼） |
| 外部 SSO | `packages/official-sso.js` + `packages/platform-service-auth.js`（从 car-python/backend 迁入） | SSO 跳转/回调/换发 token |
| 地图规则 | 复用 `projects/blockly-page3/guangyang-map-config.js` + `guangyang-scoring.js` | 根网关 server 端 `require` 这两个 UMD 模块做 normalizeLayout / roadMatch |
| 主服务 | 根 `server.js`（改造） | 平台 + auth + blockly 全部路由，直读 SQLite |
| 建库种子 | `tools/migrate-db.js`（新） | 幂等建表 + 种子地图 + 迁移 admin |

## 6. 接口面（前端零改动）

保留 `/blockly/` 命名空间 + 现有路径重写机制（把 blockly 前端 JS 里的 `/api/` 重写为 `/blockly/api/`），`/blockly/api/*` 直接落到内部 handler，不再代理。

| 命名空间 | 路由 | 实现 |
|----------|------|------|
| 平台 | `/api/health` `/api/platform/*` `/api/v1/auth/*` | 直读 SQLite，SSO 直接实现 |
| Blockly | `/blockly/api/records` `/workspaces` `/maps` `/auth/*` `/admin/*` `/leaderboard` | 吸收 blockly server.js 的 handler 逻辑 |
| 静态 | `/`（portal）`/login.html` `/admin.html` `/leaderboard.html` | 根 `public/` |
| 静态 | `/blockly/*` | serve `projects/blockly-page3/`（index/app/styles/lane-follow/guangyang-*/vendor/assets） |

## 7. Auth 与 SSO 迁移

- **登录入口统一**：所有登录走平台 `/login.html` + `/api/v1/auth/*`。Blockly 侧 `/blockly/login.html` 保留现有「重定向到平台登录页」行为，`/blockly/api/auth/me`、`/blockly/api/auth/logout`、`/blockly/api/auth/team-invite` 变成对统一 auth 的薄适配（返回同一份 principal），不再有独立的 blockly 本地用户表。
- **本地 auth**：scrypt 参数固定沿用现有 `{algorithm:"scrypt", N:32768, r:8, p:1, keyLength:32}`。`password_hash` 列存该 JSON。register/login/logout/me/team-invite 的校验逻辑从 `car-python/backend/auth-store.js`（1471 行）提炼为 `packages/platform-auth.js`。
- **外部 SSO**：`official-sso.js` + `platform-service-auth.js` 从 car-python 迁到 `packages/`。根网关 `/sso/jump`、`/api/v1/auth/sso/*` 直接调用，删除 `proxyPythonAuth`。SSO 环境变量（client id/secret/回调 URL）搬到根进程环境，参数由用户提供。

## 8. 种子数据与 admin 迁移

空库重建，只迁移一条数据：

- **admin 用户**（从 `auth-store.json` 迁入，保留原 scrypt 哈希，登录密码不变）：
  - id `usr_5348eb246c974055b000aa405aed424b`，username `admin`，role `admin`，group `primary`
  - passwordHash: scrypt salt `z7YXGpT98ingXmw9KHMf-w`，hash `hmv8-X_DGjM7UsWN5wReKyyIxyCxnZpKLXRQ_2BP3UY`
  - createdAt `2026-09-20T07:53:00.186Z`
- **admin 所属队伍**：
  - id `tea_36b96a1031414b5c98fa5bda24610121`，teamName `测试队伍`，inviteCode `5G6H36R2`
- **不迁移**：其余用户、所有 sessions（过期后重新登录）、records、workspaces。
- **地图**：用 `guangyang-map-config.js` 的 `DEFAULT_LAYOUTS` 经 `normalizeLayout` 种入 3 个默认地图（GYI-PRIMARY-01/02/03），revision=1。

## 9. 删除清单

- `projects/car-python/` 整个目录。
- 根 `server.js`：`proxyPythonAuth` / `proxyBuffered` / `proxyStreamed` / `signedPrincipal` / `buildAdminRows`（python+blockly 合并逻辑）/ `blocklyMapsForRequest`（跨服务取图）/ 所有 Python、Blockly 上游探测与代理路由。
- `projects/blockly-page3/server.js`（逻辑已并入根）。
- `tools/start-platform.js`：简化为单进程启动（或删除，直接 `node server.js`）。
- `packages/platform-contract.js`：联邦签名相关函数（`signPrincipal`/`verifyPrincipal`/`PLATFORM_TO_BLOCKLY_TASK`）在单进程下不再使用，验证后精简。
- `.blockly-data/`、`.runtime/` 旧数据目录随迁移弃用（保留一份备份由用户决定）。

## 10. 迁移步骤

1. 新建 `packages/platform-store.js`、`packages/platform-auth.js`，迁移 SSO 模块到 `packages/`。
2. 新建 `tools/migrate-db.js`：建表 + 种子地图 + 迁移 admin。
3. 改造根 `server.js`：接入统一库，吸收 blockly 路由，删除代理与联邦。
4. 静态资源：`/blockly/*` 指向 `projects/blockly-page3/`。
5. 删除 `projects/car-python/`、blockly `server.js`、旧启动器。
6. 全量 `node --check` 校验，浏览器功能测试（登录、blockly 竞赛、地图编辑、成绩）。

## 11. 风险与验证

| 风险 | 缓解 |
|------|------|
| SSO 迁移正确性 | 端到端验证 `/sso/jump` → 回调 → 登录态 |
| scrypt 逻辑迁移错误 | 用 admin 原哈希做登录回归（原密码能登录即通过） |
| 前端路径重写遗漏 | 回归 blockly 页面所有 fetch 请求 |
| 成绩口径变化（原 python+blockly 合并 → 仅 blockly） | 确认排行榜/成绩页只展示 blockly 记录 |
| 地图版本化丢失 | `map_config_versions` 保留 revision+digest，地图编辑接口沿用 |

## 12. 范围外（YAGNI）

- 不做双写灰度、不做回滚开关（数据已决定丢弃）。
- 不引入 MySQL / 任何外部数据库。
- 不改动 Blockly 前端业务逻辑（积木定义、循迹、3D 模拟器）。
- 不合并 `public/` 与 `projects/blockly-page3/` 的静态目录（仅由根统一 serve）。
