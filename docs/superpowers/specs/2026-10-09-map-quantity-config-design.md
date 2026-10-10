# 后台地图编辑支持调整「点数量」设计文档

日期：2026-10-09
状态：待评审

## 1. 背景与目标

后台「地图设置」页（`projects/blockly-page3/admin.html` 的「地图设置」tab）目前只能编辑现有点的坐标和物品样式，无法增删点。目标物、混淆物、途径点、障碍物的数量被硬编码在配置里。

本次需求：允许后台管理员调整每个任务的点数量，设置保存后体现在地图中（后台编辑画布 + 学员端 3D 模拟器同步生效）。

## 2. 现状

- `projects/blockly-page3/guangyang-map-config.js`
  - `TASKS` 硬编码每个任务的数量：`checkpoints/targets/distractors/obstacles`。
  - `DEFAULT_LAYOUTS` 定义每个任务的默认坐标数组（数组长度即数量）。
  - `normalizeLayout` 用 `task.checkpoints` 等**固定数量**校验 `pointList`，数量一变即报错。
- `packages/blockly-api.js`
  - 独立一份 `PRIMARY_TASKS`（含同样的固定数量），用于记录提交校验（`body.checkpointCount > task.checkpoints` 等）和统计（`checkpointTotal`）。
- `projects/blockly-page3/admin.html` + `admin.js`
  - 字段区只渲染「坐标」与「样式」，没有数量控件。
- `projects/blockly-page3/app.js`
  - `createPrimaryGuangyangMission` 从 `publishedMap.layout` 的数组长度**动态**生成地图元素与任务文本。
  - 进度/评分从 `checkpointPoints.length`、`targetPackageIds.size`、`distractorPackageIds.size` 动态派生。
  - `checkpointLabels` 在 `TASKS` 里（任务 2 有 6 个地名、任务 3 有 8 个地名），导航传感器读取时有 `checkpoint-${index+1}` 兜底。

结论：学员端渲染与评分已经是「数量从 layout 数组派生」，本次改动集中在「校验放开 + 后台增加数量控件」。

## 3. 方案

采用**数量完全从 layout 数组派生**的单一数据源方案：

- `normalizeLayout` 用「范围校验」替代「固定数量校验」。
- 后端统计与提交校验从 `runMapVersion.layout` 的数组长度派生。
- 后台增加数量输入控件；增点用「自动找合法空位」补点，减点从尾部截断。

不引入独立的 count 字段（避免双数据源不一致）。

## 4. 数量范围

| 类型 | 字段 | 最小 | 最大 |
|------|------|------|------|
| 途径点 | `checkpoints` | 0 | 12 |
| 目标物 | `targets` | 1 | 6 |
| 混淆物 | `distractors` | 0 | 6 |
| 障碍物 | `obstacles` | 0 | 6 |

## 5. 模块改动

### 5.1 `guangyang-map-config.js`

1. 新增 `QUANTITY_RANGES`（上表），`Object.freeze`。
2. `pointList(value, range, label)` 改为校验 `value.length` 在 `[range.min, range.max]` 内。
3. `normalizeLayout` 的四处 `pointList` 调用改用 `QUANTITY_RANGES.*`。
4. `TASKS` 移除固定数量字段（`checkpoints/targets/distractors/obstacles`），保留 `key/level/name/checkpointLabels`。数量真相变为 `DEFAULT_LAYOUTS` / 实际 layout 数组（`normalizeLayout` 不再读 `task.checkpoints` 等）。
5. 新增 `findVacantPoint(layout, kind)`：
   - 复用 `scoring.roadMatch`，在 `MAP` 范围内按固定步长（0.5）扫描网格；
   - 命中「在道路 + 与 layout 内所有点间距 ≥ 0.7 + 离 START ≥ 0.9」的第一个点返回；
   - 找不到返回 `null`（前端据此提示管理员手动放置）。
6. 对外导出 `QUANTITY_RANGES`、`findVacantPoint`。

### 5.2 `packages/blockly-api.js`

1. 记录提交流程（`/api/records` 的 sim 分支）：**先取 `runMapVersion`**，再用 `runMapVersion.layout` 的数组长度做上限校验与 `total`，替代 `PRIMARY_TASKS` 的固定数量。
2. `scoreRun` 的 `checkpointTotal` 从 layout 数组长度传入。
3. `PRIMARY_TASKS` 移除固定数量字段（`checkpoints/targets/distractors/obstacles`），仅保留 `name`（用于 `publicMapConfig` 的 `taskName` 与记录 `taskName`）。任务存在性检查仍用 `PRIMARY_TASKS[taskId]` 判空。
4. 校验顺序调整：`mapVersion` 调用提前到数量校验之前。

### 5.3 `admin.html`

1. 「地图设置」字段区顶部新增「点数量」`fieldset`，4 个数字输入框（目标物/混淆物/途径点/障碍物），带 `min`/`max` 与当前值。
2. 版本号 bump `admin.css` / `admin.js` 的 `?v=`（缓存失效）。

### 5.4 `admin.js`

1. 渲染数量输入框（当前值来自 `config.layout[kind].length`）。
2. 数量变化处理：
   - 增加：循环调用 `findVacantPoint` 补齐新点；找不到则提示「无可用空位」并回滚。
   - 减少：`config.layout[kind].splice(newCount)` 截断。
   - 置 `state.mapDirty = true`，重渲染字段与标记。
3. 保存仍走 `mapRules.normalizeLayout` + `PUT /api/admin/maps/:taskId`（后端范围校验兜底）。

### 5.5 `app.js`

- 基本无需改动（已动态派生）。
- 仅确认：新增途径点的 `checkpointLabels` 用现有 `checkpoint-${index+1}` 兜底，行为可接受，不改。

## 6. 数据流与校验

- 后台「保存并发布」→ `normalizeLayout`（范围 + 道路 + 间距 + 离起点校验）→ `PUT` → `store.upsertMapConfig` → 学员端下次运行 `GET /api/maps` 拿到新 layout → `createPrimaryGuangyangMission` 动态渲染。
- 提交记录时后端用 `runMapVersion.layout` 校验 `checkpointCount` 等不超过数组长度，保证旧版本/新版本一致。

## 7. 错误处理

- 增点找不到合法空位：前端提示并回滚，不进入保存。
- 范围外数量：前端输入框 `min/max` 限制 + 后端 `pointList` 抛 `RangeError` 兜底。
- 间距/道路/离起点校验：沿用现有 `point` / `assertSpacing`，错误信息不变。

## 8. 验证

- 改代码后 `node --check` 校验 `guangyang-map-config.js`、`blockly-api.js`、`admin.js`。
- 浏览器手动验证（不做自动化测试）：
  1. 后台地图设置：调大/调小四种数量，观察画布标记增减、字段区同步；
  2. 保存后刷新，确认数量持久化；
  3. 学员端切换对应任务，确认 3D 地图目标物/混淆物/途径点/障碍物数量与任务文本一致；
  4. 增点到无空位场景，确认前端提示不崩溃。
