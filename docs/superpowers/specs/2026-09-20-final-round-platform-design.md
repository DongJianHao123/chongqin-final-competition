# 决赛平台改造设计

日期：2026-09-20
状态：已评审通过（待写实现计划）

## 目标

把「初赛」竞赛平台改造为「决赛」平台：

1. 完全去除赛题二（识物工坊），只保留赛题一。
2. 赛题一 Python 与 Blockly 都支持真实小车。
3. 3D 模拟器去掉任务选项，只保留任务 1 的地图；去掉「实时评测」，改为显示「程序执行时间」。
4. 评分模型从「任务 1/2/3 + 工坊」四项百分制改为**纯时间制**：程序执行总用时（从点击「运行」到程序执行结束），越快排名越高。

## 关键决策（已与用户确认）

- 评分/排名依据：**纯时间制**。用时 = 程序执行总时间（点击开始 → 程序执行结束），排名按用时升序。
- 计时口径：直接使用现有 `durationMs`（Blockly）/ `durationSeconds`（Python），沿用 10 分钟上限，超时/DNF 记为最大用时。
- 识物工坊去除范围：**连同 `projects/tmm/` 源码一起删除**。
- Python 真实小车范围：**与 Blockly 对齐**——真实模式支持运动/抓取/释放（HTTP 控制），感知/视觉类在真实模式抛错。
- 官方成绩导出（`packages/score-download.js`）：**本次不改**，仅改平台内排名（`STAGES` 暂不新增 `final`、CSV 暂不变）。

## 工作流 1：完全去除识物工坊

删除源码目录 `projects/tmm/`，并拆除所有接入点。

- `tools/start-platform.js`
  - 删除 `WORKSHOP_ROOT`（L15）与 `WORKSHOP_RUNTIME_CONFIG`（L21）。
  - PROJECTS 数组删除「识物工坊」项（L37-47）。
  - 删除 workshop 相关：`injectWorkshopRuntimeSecret`、`prepareProject` 里的 workshop 分支（`CHENLONG_WORKSHOP_SKIP_BUILD`）、`startAll` 里的 `skipWorkshop` 过滤（L337-343）、`federationProbe` 里的 workshop 分支（L161-174）。
- `server.js`（网关）
  - 删除 workshop upstream 默认值（L21）。
  - readiness 探针去掉 workshop（L522-537）。
  - scope 重写去掉 `workshop` 分支（L709-744）与 `services.workshop`（L1117）。
  - 删除 `workshopOverviewOrEmpty`（L1041-1046）及 `handleAdminOverview`/`handleAdminExport` 里的调用。
  - 删除 `handleAdminOverview` 的工坊权重/链接（L1204-1210、L1223）、`adminRowsCsv` 的工坊列（L1267、L1274）。
  - 删除路由表里 `/api/competition*`、`/workshop/*`、`/_next/`、`/models/` 的 workshop 代理（L1535-1583）。
  - 删除 `workshopDisabled` 选项（L1317）。
- `packages/platform-contract.js`
  - `signPrincipal` 的 audience 白名单去掉 `workshop`（L147）。
- `public/portal.html`
  - 删除赛题二卡片（L74-87）与 `score4` 工坊框（L44）。
- `public/platform-portal.js`
  - 删除 `workshopSubmissionLabel`（L31-38）与 `#score4` 渲染（L105-108）。
- `public/portal.css`
  - 删除 `workshop-entry` / `workshop-illustration` 样式（L154-182）及响应式引用（L284-285）。
- `public/admin.html`
  - 删除工坊表头列（L76）、标题文案（L66）、工坊系统卡片（L130-133）。
- `public/platform-admin.js`
  - 删除 `workshop` 的 readiness 标签（L20）、评测集 readiness（L100-113）、分数列里的 `workshopScore`（L274）。

## 工作流 2：真实小车（Python 对齐 Blockly）

Blockly 已支持真实小车（本工作区已放开 UI），无需改动。Python 新增同等能力：

- `projects/car-python/index.html`
  - 顶部工具区新增目标选择（3D 模拟器 / 真实小车）、协议切换、小车 IP 输入、摄像头视图，复用 Blockly `index.html` 的 `#targetSelect` / `#robotConnection` / `#cameraView` 结构。
- `projects/car-python/app.js`
  - 新增 `makeRealRobotApi()`、`sendRealRobotAction()`、`sendRealRobotStop()`、摄像头生命周期（`POST /api/camera/open|close`、`stream?fps=12`），协议与 Blockly `app.js` 一致：`GET {ip}/api/control?action=…&speed=50&time=…`（`no-cors`）。
  - 动作映射：forward/backward→up/down、turn/left/right→left/right、grab/release、wait。
  - `makeRobotApi()` 按目标分发：sim → `makeSimRobotApi()`，real → `makeRealRobotApi()`。
  - 感知/视觉（`sees`/`count`/`detect`/`near`/`centered`/`odometry`/`road_state`/`holding` 等）在真实模式抛错。
- `projects/car-python/python-worker.js`
  - `Robot` 桥接在真实模式转发到真实 API（运动/抓取/释放可用，感知/视觉抛错）。
- `projects/car-python/tests/static-contract.test.js`
  - 更新「保持纯模拟」断言（L298-311）：允许真实小车 UI/API，去掉 `真实小车|本地摄像头|/api/control` 等禁止串。

## 工作流 3：3D 模拟器改造（两个项目都改）

- 去掉任务选择器 `#sceneSelect`（Blockly `index.html` L109-116；Python `index.html` L187-193），只保留任务 1 地图（`guangyang1` / `GYI-PRIMARY-01`）。
- 去掉「实时评测」HUD：
  - Blockly：删除 `#primaryScoreHud` 及 0-100 分解（任务/规则/自主/效率，`index.html` L165-202），`app.js` 里 `renderPrimaryScore()` / `primaryScoreSnapshot()` 的实时分数渲染删除。
  - Python：删除 competition HUD 的分数分解（`index.html` L367-372、`app.js` L5660-5694）。
- 改为显示「程序执行时间」：复用现有计时器（Blockly `#primaryScoreTimer` / `logicalElapsedMs`；Python `#competitionTimer` / `durationSeconds`），把「评测中/最终成绩以后台计算为准」文案改为「程序执行时间」。

## 工作流 4：纯时间制评分

- 计时：点击「运行」→ 程序执行结束的用时（复用 `durationMs` / `durationSeconds`，10 分钟上限）。
- 成绩语义反转：从「0-100 越高越好」改为「用时越短越好」。
- `server.js`（网关）：
  - `combinedScore` / `buildAdminRows`：从「四项求和」改为按用时聚合（每队最优用时 = 各语言提交的最短用时）。
  - `handleAdminOverview` 的 `scoring` 权重字段改为时间制（去掉 25/25/25/25）。
  - `adminRowsCsv` 表头从「任务1/2/3/工坊/总分」改为「用时」（升序排名）。
- `public/portal.html` / `public/platform-portal.js`：分数条从任务 1/2/3 + 工坊改为「最优用时」。
- `public/admin.html` / `public/platform-admin.js`：表格列从分数改为用时。

## 数据模型说明

- 记录已存储 `durationMs`（Blockly）/ `durationSeconds`（Python）。时间制下以该字段为成绩，聚合取最短用时。
- 是否保留 0-100 `score` 字段、是否迁移历史记录，留待实现计划阶段依据记录 schema 具体确认；默认不改历史记录 schema，只调整聚合与展示层。

## 测试影响

需要更新的测试（实现计划阶段逐一确认断言）：

- `tests/server.test.js`：workshop 相关用例（跳过/优雅降级）、admin overview/export 的分数与 CSV 断言改为时间制。
- `tests/portal-ui.test.js`：portal 赛题二/工坊/分数条断言改为单赛题 + 用时。
- `projects/blockly-page3/tests/*`：模拟器任务选择、实时评测、ui-parity 等断言。
- `projects/car-python/tests/static-contract.test.js`、`backend-server.test.js`、`backend/guangyang-*` 相关：任务 2/3 地图、纯模拟断言、时间制记录。
- 新增：Python 真实小车回归测试、时间制排名测试。

## 非目标（本次不做）

- 官方成绩导出 `packages/score-download.js` 的 `final` 阶段与时间字段（`STAGES`、CSV 结构）。
- 真实小车的感知/视觉接入（决赛真实小车无感知，感知类在真实模式抛错）。
- 历史数据迁移。
