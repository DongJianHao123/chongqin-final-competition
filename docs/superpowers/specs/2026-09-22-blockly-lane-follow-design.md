# Blockly「沿线循迹」积木设计

日期：2026-09-22
状态：待评审

## 目标

在 Blockly 真实小车模式新增一个「沿线循迹」移动积木：执行时让小车沿黄色主线行驶、识别到下一个路口（横线）时自动停车。识别在浏览器端完成（参考 `E:\Project\工作空间\ai\zheng\lane-lab` 的前端实现），板子只负责执行轮速与输出摄像头流。执行该积木时，摄像头切换到「循迹模式」——用一块独立循迹画布展示线路识别结果。

## 关键决策（已与用户确认）

- 循迹行为：**到下一个路口停车**（对应 lane-lab 的 `follow` 动作，正常结束记为 `arrived_at_junction`）。
- 摄像头「循迹模式」：**独立循迹画布**——新增一块单独的 `<canvas>`，显示 letterbox 后的摄像头帧 + 黄色主线/支路/路口识别叠加，不占用原摄像头预览。
- 实现方式：**方案 B**——新建独立经典脚本 `lane-follow.js`（暴露 `window.BlocklyLaneFollow`），与既有 `blockly-navigation-core.js` 同构；检测算法从 lane-lab 前端逐行移植。
- 检测运行位置：**主线程异步**（`createImageBitmap` 异步解码；`detect` 每帧约 3–6ms，单次「循迹到路口」足够，暂不引入 Worker）。
- 循迹参数**在积木块中作为输入**，共 4 个：速度、超时（秒）、kp、kd（见下表）。`maxCorrection` 固定为 7（对齐 lane-lab `follow` 阶段，不暴露）。

## 积木与生成代码

- 新积木类型 `robot_follow_line`，放入「小车移动」分类（颜色 `#1177cc`），文案「沿线循迹」。
- 4 个输入字段（均为 Number 输入，带 `math_number` shadow）：

| 字段名 | 文案 | 默认值 | 范围 | 含义 |
| --- | --- | ---: | --- | --- |
| `SPEED` | 速度 | 8 | 0–50 | 循迹基准速度（lane-lab `follow` 的 intent base） |
| `TIMEOUT_S` | 超时 | 30 | 1–120 | 最多循迹秒数，到点未到路口即报超时 |
| `KP` | 比例增益 | 0.045 | 0–1 | 转向响应强度，越大越激进 |
| `KD` | 微分增益 | 0.03 | 0–1 | 抑制震荡 |

- 生成代码：`await robot.followLine(${SPEED}, ${TIMEOUT_S}, ${KP}, ${KD});`
- `index.html` toolbox 的小车移动分类加入该积木。
- 不把 `followLine` 加入 `REAL_ROBOT_UNSUPPORTED_METHODS`（实车支持它）。

## Robot API（app.js）

- `makeRealRobotApi` 新增 `followLine: (speed, timeoutS, kp, kd) => followLineToJunction(context, speed, timeoutS, kp, kd)`。
- `makeSimRobotApi` 新增 `followLine: () => { throw new Error("沿线循迹只在真实小车模式可用"); }`。
- 新增 `followLineToJunction(context, speed, timeoutS, kp, kd)`：
  1. `await waitForRunCheckpoint(context)`；
  2. 校验并规范化 `speed`/`timeoutS`/`kp`/`kd`（越界用默认或报错）；
  3. `actionCount++`，`addLog(...)`；
  4. 解析 `baseUrl = context.robotBaseUrl || getValidatedRobotBaseUrl()`；
  5. 显示循迹画布、隐藏原 `<img id="cameraStream">` 预览；
  6. `const lane = BlocklyLaneFollow.start({ baseUrl, canvas, speed, timeoutMs: timeoutS * 1000, kp, kd, onState, onResult })`；
  7. `await lane.run()`，期间按 `context.signal` 可取消；
  8. `finally { await lane.stop(); 隐藏循迹画布、恢复原预览; }`。

## 新模块 `lane-follow.js`

独立经典脚本，暴露 `window.BlocklyLaneFollow`。从 lane-lab 前端逐行移植以下纯函数（不改算法、不转录偏差）：

| 来源 | 移植内容 |
| --- | --- |
| `src/lane.mjs` | `detect(rgba)`（HSV 黄色主线识别 + 中心点追踪）、`speeds(error, prev, dt, params)`（PD 轮速） |
| `src/branch.mjs` | `findBranches(mask)`、`bottomCrossbar(rgba)` |
| `src/intersection.mjs` | `detectIntersection(mask, observedCenters, alternativeTracks)` |
| `src/crossing_stop.mjs` | `CrossingStop`（滑动窗口确认路口） |
| `src/action_policy.mjs` | 简化版 `follow` 状态机（`approach` → 路口确认 → 前移 120mm 居中 → 完成） |

对外接口：

```js
BlocklyLaneFollow.start({ baseUrl, canvas, speed, timeoutMs, kp, kd, onState, onResult })
  // → { run(): Promise<{reachedJunction, reason}>, stop(): Promise<void> }
```

其中 `speed`/`kp`/`kd` 直接传入移植后的 `speeds(error, prev, dt, { base: speed, kp, kd, maxCorrection: 7 })`；`timeoutMs` 为整个循迹的硬超时。

内部流程：

1. `POST ${baseUrl}/api/camera/open` 打开采集；
2. `fetch(${baseUrl}/api/camera/stream)` 抓 MJPEG，逐帧解 JPEG；
3. letterbox 缩放到 320×240（对齐 lane-lab `worker.mjs`，放宽其严格 320×240 校验）；
4. `detect` 计算误差与路口标志，`speeds` 计算左右轮速；
5. `${baseUrl}/api/lane/start` 取 token，`${baseUrl}/api/lane/command` 逐帧下发 `{token, sequence, left, right}`，完成/停止时 `${baseUrl}/api/lane/stop` + `${baseUrl}/api/motor/direct?left=0&right=0` 回零；
6. 每帧把解码帧 + 识别叠加（中心点折线、左右支路、路口横线高亮）+ 偏差/轮速文本画到 `canvas`。

**防网关重写**：所有板载 URL 一律 `` `${baseUrl}/api/...` `` 拼接（`/api` 前是 `}` 而非引号），避免根 `server.js` 的 `rewriteTextBody` 把 `/api/` 错改成 `/blockly/api/`。

## 循迹画布与「摄像头切换」

- `index.html` 在摄像头区域新增 `<canvas id="laneFollowCanvas" hidden>`。
- 执行「沿线循迹」时隐藏原 `<img id="cameraStream">` 预览、显示循迹画布；结束后恢复。
- 画布内容：letterbox 摄像头帧 + 黄色主线识别叠加 + 当前偏差/轮速文本。

## 服务端与静态资源

- `projects/blockly-page3/server.js` 的 `STATIC_FILES` 增加 `["/lane-follow.js", "lane-follow.js"]`。
- `index.html` 在 app.js 之前加 `<script src="./lane-follow.js?v=..."></script>`。

## 错误处理与停止

- 摄像头不可用 / 流断开 / 5 秒无完整帧 → 停止并抛可读错误。
- 超时（按积木「超时」参数，默认 30 秒）未到路口 → 停止报「沿线循迹超时」。
- `/api/lane/*` 被拒 / 电机掉线 → 报错。
- 用户点「停止」：`context.signal` 中止 → `lane.stop()` 发送 `/api/lane/stop` + 回零；`cancelActiveRun` 仍走既有 `sendRealRobotStop` 兜底。

## 测试与文档

- `tests/block-catalog.test.js`：断言 `robot_follow_line` 积木存在、toolbox 含「沿线循迹」、指导书含「沿线循迹」说明。
- `node --check lane-follow.js` 与 `node --check app.js` 通过。
- 若可行，给 `detect`/`speeds` 加纯函数单测（构造已知 RGBA 输入验证输出）。
- `指导书.md` 小车移动一节补「沿线循迹」说明。
