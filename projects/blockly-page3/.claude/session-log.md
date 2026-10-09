
## 2026-09-21 14:52
Blockly 决赛页：把「计分运行」改为「计时运行」（保留内部 runMode:scored 与 archivePrimaryRun 保存 durationMs 执行时间），并移除「我的比赛记录」入口（recordsButton/recordsDialog 及其函数、PRIMARY_SCORE_SUMMARIES 全局、index.html 的 admin-team-scores.js 脚本）。同步更新 debug-run/record-pagination-capacity/ui-parity/advanced-block-contract 四个测试。blockly 86 测试 75 通过，11 失败均为预先存在（导航/移动/评分 HUD/SSO/提交截止/版本号等，与本次改动无关）。

## 2026-09-21 18:12
修复真实小车板载接口被网关错误加 /blockly 前缀的问题：fetchRealBoardJson 改为拼接 ${baseUrl}/api${path}，detect/demo init/status/stop 四个调用点去掉 /api 前缀，避免 rewriteTextBody 的 /api→/blockly/api 重写。app.js node --check 通过。

## 2026-09-22 12:21
循迹接口修正：lane-follow.js 由 /api/lane/* token 协议改为 /api/motor/direct?left=&right= 持续轮速直控（移除 laneStart 握手），speeds/toPwm 改为 wheelSpeeds（0-100 量程，对齐 lane-lab examples/direct）；app.js normalizeFollowLineParams 默认改为 speed 30/kp 1/kd 0；循迹画布改为绝对定位覆盖舞台并隐藏 .camera-view 容器修复不可见；同步更新 index.html/catalog 默认值与 block-catalog.test.js 断言。blockly 87 测试 76 通过，11 失败均为预先存在。

## 2026-09-22 14:40
调整 Blockly 工具箱与真实小车感知：index.html 移除基础传感/导航传感/道路控制三类，自动靠近积木由物品下拉改为模型名文本输入并新增直行速度/转弯速度/目标框宽参数；同步移除页面顶部识别/框宽输入及其 app.js 存储、事件与样式。app.js/blockly-toolbox-catalog.js/styles.css 同步更新，node --check 通过。

## 2026-09-22 15:25
循迹对齐 lane-lab 纯前端直驱实现：lane-follow.js 重写 renderFrame（绿框#45ff85/红点#ff4848/蓝色路口线#00dfff）与 start()（detect→wheelSpeeds→motorDirect 连续循环，CrossingStop 路口停车，3 参数 base/kp/maxCorrection）；app.js/index.html/blockly-toolbox-catalog.js 的 robot_follow_line 改为 基础速度%24/KP0.05/最大修正%2。

## 2026-09-22 15:37
循迹画布增加数据叠层：renderFrame 顶部显示三行——路径识别状态、偏差/中心点/路口信息、左右轮驱动值；renderFrame 增加 wheels 参数并同步 start() 调用。

## 2026-09-22 15:38
页面默认目标改为真实小车：index.html targetSelect 选项顺序 real 在前，app.js 初始化 targetSelect.value='real' + setRunTarget('real')。

## 2026-09-22 15:43
巡线信息 UI 改为 HTML 卡片叠层（参考程序执行时间 HUD）：index.html 新增 lane-follow-hud 面板，styles.css 新增绿色主题卡片样式，app.js 新增元素引用与 updateLaneFollowHud，lane-follow.js 移除 canvas 文字叠层并新增 onFrame 回调。

## 2026-09-22 15:50
巡线路线改为蓝色渐变近大远小导航带：lane-follow.js 新增 drawNavRibbon（沿 centers 法线扩展成宽度随距离渐变的多边形带+中心亮线），替换原红点标注。

## 2026-09-22 15:55
巡线视觉调整：去掉绿框 ROI；导航带渐变更实/中心亮线加粗至 2.5px 更清晰；路口判定线由蓝色 #00dfff 改为红色 #ff2d55。

## 2026-09-22 16:20
导航带优化：去掉中心白线；左右边界改用 Catmull-Rom 贝塞尔平滑过渡（不再折线）；整体增加透明度（渐变 alpha 降低为 0.25/0.55/0.7）。

## 2026-09-22 16:25
巡线卡顿优化：motorDirect 改 fire-and-forget（不 await fetch）；控制指令加 90ms 节流（画面每帧渲染、指令按时间限频）；mjpegFrames 请求加 ?fps=12 限流。

## 2026-09-22 16:39
导航带去抖动：drawNavRibbon 对中心点做移动平均平滑（radius=3，覆盖约±15px），保持直路笔直、转弯平滑过渡，不再七拐八拐。

## 2026-09-22 17:25
去掉自动靠近速度下限：realBoardSpeedPercent 移除 Math.max(10,...) 下限，速度百分比按 speed*70/50 从 0 起算，不再强制最低 10%。

## 2026-09-23 11:28
自动靠近积木去掉「停止距离」「最多控制步数」两个参数：app.js 积木定义/生成器、approachRealRobotVisionTarget 签名与校验、makeRealRobotApi.approach、index.html XML、blockly-toolbox-catalog.js 同步移除 DISTANCE_CM/MAX_STEPS。

## 2026-09-23 11:48
新增积木快照保存/恢复功能（参考 car-blockly）：index.html 加保存快照/历史按钮 + 快照列表/预览两个 dialog；styles.css 加快照按钮与对话框深色样式；app.js 加 read/save/restore/delete 快照逻辑（localStorage chenlongBlocklySnapshots.v1 最多20条、按任务 taskId 隔离、Ctrl+S 保存、预览用只读 Blockly workspace + zoomToFit）

## 2026-09-23 15:17
修复快照预览（dialog 嵌套注入尺寸失效）：查看改为单 dialog 内列表/预览视图切换，预览画布给显式高度 min(62vh,560px) 同步注入只读 Blockly；真实小车模式隐藏调试倍数/暂停/单步/计时运行/重置按钮（沿用 .app-shell.is-real-target CSS 隐藏模式）

## 2026-09-28 16:21
新增「开始执行」容器块：robot_start 默认存在且唯一（ensureStartExecutionBlock 在 init/恢复时注入），runProgram 只执行其内部代码；generateBlocklyCode/generateCodeForRoots 改为手动 init+statementToCode/blockToCode 并带上函数定义，inspectProgramStructure 重写为校验容器内程序。新增 Shift/Ctrl 多选（Windows 风格，点选/范围/切换/Esc 清除）与批量删除/禁用/运行选中块，工具栏加禁用、运行两个按钮。改 app.js/index.html/styles.css，node --check 通过。

## 2026-09-28 17:06
新增「主函数」工具箱分类：index.html 工具箱 XML 顶部加 category 主函数(robot_start)；app.js 加 dedupeStartExecutionBlock 在拖出新开始执行时替换旧的保持唯一；blockly-toolbox-catalog.js 同步 blocks.robot_start 定义与 categories 顶部主函数分类。node --check 通过。

## 2026-09-28 17:27
修复「主函数」分类积木不显示与多选失效：根因是 index.html 里 app.js/styles.css 带 ?v= 版本号走 immutable 缓存，旧 JS 无 robot_start 定义与多选逻辑。已更新 app.js/lane-follow.js/styles.css 版本号为 20260928-start-multiselect-001；同时 robot_start 加 setNextStatement(true) 助 flyout 显示，重写 multiSelectableRoot/orderedTopLevelBlockIds 支持「开始执行」内部积木多选。

## 2026-09-28 17:50
完成多选右键批量操作：Ctrl 点选在集合为空时先把之前单选 anchor 并入集合（单选A+Ctrl点B → {A,B}），新增 installMultiSelectContextMenu 注册「运行/禁用启用/删除选中 N 个积木」三个右键菜单（多选时 enabled、否则 hidden），initBlockly 调用，index.html app.js 版本号 bump 至 20260928-start-multiselect-002。node --check 通过。

## 2026-09-29 17:23
Blockly 后台地图编辑器新增物品外观配置：目标物/混淆物样式可选 box/orange/tennis（默认橙子/网球）。改 guangyang-map-config.js（normalizeLayout 兼容带样式与旧版 key、DEFAULT_LAYOUTS 加样式）、admin.js（地图编辑加样式下拉）、app.js（normalizePackageRecords 保留 style、createPrimaryGuangyangMission 传入样式、getPackageAssets/createPackageModel 按样式渲染橙子球体+叶子与网球球体+白缝）。视觉识别仍按 role 分类，不受外观影响。node --check 通过。

## 2026-09-30 15:26
重配任务一地图：取消途径点、障碍物，改为 1 目标物 + 2 混淆物 + 1 目标点。改 guangyang-map-config.js（TASKS 用 targets/distractors/obstacles 显式计数、任务一 checkpoints 0/targets 1/distractors 2/obstacles 0、DEFAULT_LAYOUTS 同步、normalizeLayout 改点列表计数）、server.js（PRIMARY_TASKS 同结构、提交校验与 compositeTaskProgress 用新计数）、app.js（任务描述文案适配 0 途径点/0 障碍物、完成提示改通用）、admin.js（空「途径点」分组隐藏）。node --check 通过。

## 2026-09-30 15:31
决赛只保留 Blockly：地图编辑移入 Blockly 管理后台。admin.js 移除 platformMode 对地图页签/面板的隐藏并始终加载地图；server.js 让 /api/maps 与提交记录的地图版本核对一律使用本地地图存储(allCurrentMapConfigs/mapVersion)，不再走平台 SSO 地图包(platformMaps/platformMapVersion)。node --check 通过。

## 2026-09-30 15:43
修复后台地图数据与前台模拟器不一致：根因是磁盘 store(primary-blockly-store.json) 里任务一仍是旧布局(4途径点/1目标/1混淆/1障碍)，与代码新 TASKS(0途径点/1目标/2混淆/0障碍)不兼容，normalizeLayout 直接抛错。server.js 新增 createInitialMapConfig + reconcileMapConfigs，启动时对与当前 TASKS 不兼容的地图配置重新播种(从 defaultLayout 重建)。node --check 通过，需重启服务生效。
