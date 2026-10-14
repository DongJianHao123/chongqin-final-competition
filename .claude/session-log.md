
## 2026-09-20 15:30
放开 Blockly 真实小车入口：index.html 中 targetSelect 去掉 primary-hidden 并新增「真实小车」选项，robotConnection/cameraView 移除 primary-hidden；is-real-target 的 CSS 显隐联动本已完整，无需改 JS/逻辑。验证：相关 6 个测试 43 通过，5 个失败为预先存在（与本次改动无关，已用 git stash 对照确认）。

## 2026-09-20 15:44
支持跳过识物工坊启动：start-platform.js 加 CHENLONG_WORKSHOP_DISABLED=true 跳过识物工坊项目；server.js 加 workshopDisabled 开关 + workshopOverviewOrEmpty 辅助，仅显式禁用时后台总览/CSV 才把识物成绩视为空，保持默认『失败关闭』语义。新增 1 个回归测试，根层 108 测试全通过。

## 2026-09-20 15:52
暂时恢复注册登录：public/login.html 去掉注册标签的 hidden、把「管理员登录」改回「登录」、移除「报名官网入口」提示，恢复本地注册/登录入口（后端 registrationOpen 默认开启，无需改）。108 根测试全通过。

## 2026-09-21 09:52
修复登录入口仅限管理员的问题：projects/car-python/server.js 的 /api/v1/auth/login 去掉 administratorsOnly:true，允许普通参赛用户登录（之前非管理员登录会报 LOCAL_LOGIN_ADMIN_ONLY「此登录入口仅供管理员使用」）。auth-access.test.js 由 17/20 恢复到 20/20 通过。

## 2026-09-21 17:16
Blockly 真实小车接入 detect/sees/approach 感知积木：新增「识别模型」「框宽」输入框（localStorage），queryRealRobotVision 调 /api/detect、approachRealRobotVisionTarget 调 /api/demo/init+status 轮询，生成器改为 await，从 REAL_ROBOT_UNSUPPORTED_METHODS 移除这三条；更新指导书.md 与 block-catalog.test.js 断言。86 测试 75 通过（11 个为预先存在失败，与本次无关）。

## 2026-09-23 16:09
完成游客登录与排行榜：登录页未登录自动以游客进入（?mode=login 显示手动表单，admin 路径不自动游客），新增排行榜页面 public/leaderboard.{html,js,css} + server.js 路由 + portal 入口，调用 /blockly/api/leaderboard 展示排名/用时/积木数/代码行数；退出按钮改为跳 ?mode=login。

## 2026-09-23 17:03
真实小车动作时序调整：小车接口改为动作完成才返回，前端去掉按标定速度换算的等待，移动指令（前进/后退/转向/按距离）统一等 1s，抓取由 7s 改为 3s（松开仍 2s）；删除 realDistanceDelayMs/realAngleDelayMs 及 REAL_CM/DEGREES/MIN/EXTRA 常量。app.js node --check 通过。

## 2026-09-24 15:28
lane-follow.js 对齐 lane-lab(1) 路口识别：findBranches 加 connectedFork 返回 fork point，detectIntersection 加 nearTracks 近T型茎采样，detect 统一 intersection(带kind fork/transverse)并移除 bottomCrossbar，renderFrame 兼容 fork 型交点。停车流程仍保持 /api/motor/direct 直控不变。node --check 通过。

## 2026-09-24 15:29
HUD「路口」项改为显示路口类型：分叉(fork)/横杆(transverse)/否，便于肉眼区分循迹停靠的路口类型。改 app.js updateLaneFollowHud。node --check 通过。

## 2026-09-24 15:57
真实小车(real)模式运行时显示墙钟计时：primaryRunStartedAt 对 real 也记录 Date.now()，primaryScoreSnapshot 在 real 用 Date.now()-startedAt 实时计时，运行结束 finally 冻结到 primaryRunElapsedMs 并刷新显示。real 本来就不入库，仅供测试看计时。改 app.js。node --check 通过。

## 2026-09-24 18:43
隐藏 Python 编程入口：public/portal.html 的 Python mode-card 加 hidden，只保留 Blockly 入口；计时功能用户已确认可用。

## 2026-09-24 18:49
Blockly 卡片撑满整行：portal.css 加 .mode-card:not([hidden]){grid-column:1/-1}，隐藏 Python 后 Blockly 入口占满整行。

## 2026-09-24 18:50
移除首页红色截止提示：删除 portal.html 的 #submissionDeadlineNotice 及 platform-portal.js 中对应截止判定逻辑。

## 2026-09-28 10:13
云端保存代码改到执行完毕后再同步：runProgram 开头不再 await flushBlocklyWorkspace（保留本地 capture 快照作回退），改为在 finally 执行结束、activeRun 清空后调用 flushBlocklyWorkspace。改 app.js。node --check 通过。

## 2026-09-28 10:13
云端保存改为不阻塞：finally 末尾 flushBlocklyWorkspace 用 void + .catch 触发，不 await，避免占用启动锁阻塞下一次运行。改 app.js。

## 2026-09-29 14:16
调整登录流程：去掉自动游客登录（platform-login.js 删除 shouldAutoGuest 自动 enterAsGuest，未登录停留在登录页），保留登录/注册表单，「以游客身份进入」按钮手动触发；platform-portal.js 退出按钮对所有人显示（不再仅管理员），portal.html 的 platform-portal.js 版本号 bump。node --check 通过。

## 2026-09-29 14:21
重置管理员账号：auth-store.json 中 djh 管理员改名为 admin（username/usernameKey/displayName），密码设为 CwSru9YQgupTXX3D9UMd（scrypt 哈希已生成并验证通过），revision 16→17，已备份 auth-store.json.bak。需重启 car-python 后端生效（AuthStore 启动时读盘进内存、无热重载）。

## 2026-09-30 17:35
统一SQLite迁移 Task2 完成：新建 packages/platform-auth.js（scrypt 认证：register/login/loginExternalIdentity/createGuest/authenticate/logout + 团队邀请/用户队伍管理），store 补 listSessionsByUserId/countSessions/countUsers；丢弃原 mutation 队列改用简单 scrypt 并发信号量。已验证 admin 密码 CwSru9YQgupTXX3D9UMd 匹配存储哈希。node --check + 冒烟测试通过。

## 2026-09-30 17:41
统一SQLite迁移 Task3/4 完成：official-sso.js 原样迁到 packages/（platform-service-auth.js 是联邦HMAC，随Python删除不迁移）；新建 tools/migrate-db.js（幂等建表+种子3地图+迁移admin，GYI-PRIMARY-01 digest 与旧store一致验证通过）；data/.gitignore 忽略 sqlite 文件。

## 2026-09-30 18:18
完成统一 SQLite 单进程改造：重写根 server.js（接 PlatformStore/Auth/blockly-api/official-sso，删代理与联邦）、删除 projects/car-python/ 与 blockly 独立 server.js 及多进程交付/联调工具、清理 platform-contract/score-download/live-score-source/internal-service-auth 等联邦与 Python 成绩模块；package.json 收敛为单进程 start + migrate-db。node --check 全通过，migrate-db 种子 3 地图+admin，6399 端口冒烟验证 health/blockly-api/unified-auth 正常。

## 2026-10-09 10:18
验证统一单进程系统已接入外部 SSO：分析 generate_test_jump.py（与 packages/official-sso.js 签名算法逐条对齐，含硬编码密钥泄露风险）；实测 /sso/jump 全链路（设 CHENLONG_OFFICIAL_SSO_SECRET 后 302 登录+种 cookie、replay 409、SSO 用户落库 users/teams/sessions，password_hash=null），清理测试数据后重启 6190 并启用 SSO（officialSsoConfigured=true）

## 2026-10-09 10:25
命令行部署接入 SSO 密钥：弃用 docker.env，改建 .env（gitignore 覆盖）写入 CHENLONG_OFFICIAL_SSO_SECRET；package.json start 改为 node --env-file-if-exists=.env server.js，npm start 自动加载；.gitignore 增 generate_test_jump.py、data/.gitignore 增 official-sso/

## 2026-10-09 11:20
修复计时运行用时不在后台显示：管理端概览/导出/个人成绩改读全部记录(去掉 recordState=submitted 过滤)，并新增「运行记录」tab(/api/platform/admin/records 接口 + admin.html/platform-admin.js/admin.css)，按页展示每次计时运行的实际运行时间、是否到达终点、任务完成情况(检查点进度)。

## 2026-10-09 11:32
运行记录区分真实小车/模拟器：给真实小车开放「计时运行」(移除禁用、runMode 允许 real scored)，archivePrimaryRun 按 target 分支(real 只记墙钟用时+代码，sim 保留任务评分)，后端 /api/records 新增 real 分支存 target 字段且 score/completed 等为 null；管理端运行记录加「运行环境」列(真实小车/模拟器)，真实小车的到达终点/任务完成显示「不适用」；排行榜/队伍总成绩/个人成绩排除 real 记录不计入排名。

## 2026-10-09 11:52
「队伍总成绩」改版为真实小车手动打分：platform-store.js 新增 record_judgments 表（5 项布尔打分 + scored_at/by）+ findRecordJudgment/upsertRecordJudgment/listRecordJudgments；server.js overview/export 改为 buildRealCarScoreRows() 只读 real 记录并附 judgment，新增 POST /api/platform/admin/records/:id/judgment 打分接口；admin.html 成绩表改 6 列 + scoreDialog 弹窗，platform-admin.js 用 scoreRecordRow/openScoreDialog 渲染并提交打分。扣分规则留待后续。

## 2026-10-09 12:12
真实小车「小车状态」面板改为显示有意义的连接/地址/夹爪状态：app.js 新增 realGripperState 跟踪夹爪指令，updateRobotState 真实分支把位置/朝向/夹爪/前方改标为 连接/地址/夹爪/前方（连接=需重发停止/正常、地址=IP、夹爪=抓着/松开/未操作、前方=无距离传感器），index.html 给四个 label 加 id 并 bump app.js 缓存版本

## 2026-10-09 15:12
后台地图编辑支持调整点数量：guangyang-map-config.js 加 QUANTITY_RANGES/findVacantPoint、移除 TASKS 固定数量；blockly-api.js 记录提交流程改从 runMapVersion.layout 派生 checkpointTotal/targetTotal 等；admin.js/admin.html 增点数量控件（增点自动找空位、减点截断）并 bump 缓存版本

## 2026-10-09 15:37
后台地图编辑新增「白框」容器：guangyang-map-config.js 加 bins 字段(0-6)、app.js 网球(混淆物)改为放进白框交付逻辑并新增白框 3D 渲染、admin.js/admin.html 增白框数量控件+标记+图例，bump 缓存版本

## 2026-10-09 16:26
修复后台保存地图报「地图配置字段不正确」：根因是后端服务进程(12:02 启动)早于白框功能，内存里 guangyang-map-config.js 旧版 allowedKeys 无 bins 字段；重启服务加载新代码后恢复正常，测试保存离路坐标成功并已回滚恢复原地图

## 2026-10-10 09:44
修复巡线(follow_line)在曲线「走到一半提前停在路口前」：根因是 driveBlocklyNavigationPath 的 max_distance 上限只按沿路里程算，未计入小车起点偏离中心线/从路口前12cm起步的横向偏差，导致 movedWorld 提前触顶而停在路口前。改为把 path[0] 到当前小车的初始偏移计入 maximumWorld；同样惠及 follow_road 与 take_exit。app.js 改 + index.html bump 缓存为 20261010-sim-follow-initial-offset-001。

## 2026-10-10 10:44
后台管理重构：去掉子系统管理与平台运行状态，系统管理tab直接改为地图编辑（iframe 嵌入 /blockly/admin.html?maps=1）；platform-admin.js 移除全部 readiness 代码，admin.css 增 iframe 样式，blockly admin.js 增 mapsOnly 模式 + admin.css 隐藏 chrome，两处 admin.html bump 缓存版本

## 2026-10-10 11:34
Blockly 增加全选/复制/粘贴：index.html 新增全选/复制/粘贴三个工具栏按钮（check-square/copy/clipboard-paste 图标，置于删除按钮前保持删除为末位分隔样式），app.js 新增 selectAllBlocklyBlocks/copyBlocklySelection/pasteBlocklySelection（用 Blockly.serialization.blocks.save/load + 自维护 blocklyClipboardStates 剪贴板，粘贴按 index 偏移 24px 防重叠）并接入 Ctrl+A/C/V 快捷键与点击事件；app.js 缓存 bump 到 blockly-selectall-copy-paste-001。node --check 通过。

## 2026-10-10 11:37
Blockly 全选/复制/粘贴成功提示改为弹出 toast：app.js 新增 showToast 浮层（顶部居中淡入、1.6s 后淡出，复用单例 DOM），三个成功分支由 setStatus 改为 showToast（✓ 前缀）；styles.css 新增 .blockly-toast 样式并 bump 缓存到 blockly-toast-001。node --check 通过。

## 2026-10-10 11:44
修复 Blockly 复制/粘贴无反应：根因是粘贴用了不存在的 Blockly.serialization.blocks.load（9.3.3 该模块只有 save/append），改为 append(state, workspace, {recordUndo:true})；同时把全选/复制/粘贴的失败提示也由状态栏 setStatus 改为 showToast 弹出，避免「没反应」误判。node --check 通过。

## 2026-10-10 13:22
Blockly 复制/粘贴支持跨浏览器（系统剪贴板）：app.js 新增 serializeClipboard/parseClipboard（带 __CHENLONG_BLOCKLY_CLIPBOARD_V1__ 前缀标识）+ writeClipboardText/readClipboardText（navigator.clipboard，带 try-catch 与可用性检测），复制时同时写内存与系统剪贴板（成功提示「可跨页面粘贴」），粘贴时优先读系统剪贴板、解析失败回退内存剪贴板；pasteBlocklySelection 改 async。app.js 缓存 bump 到 blockly-clipboard-cross-001。node --check 通过。

## 2026-10-10 13:26
Blockly 全选改为选中所有连贯积木集合（不分主函数内外）：重写 orderedTopLevelBlockIds，新增 collectChain 沿 next 连接完整展开语句链；非 robot_start 顶级块此前只取链头、漏掉 next 后续块，现与主函数 DO 槽链一致展开；robot_start 自身的 next 链也一并收集。app.js 缓存 bump 到 blockly-selectall-chain-001。node --check 通过。

## 2026-10-10 13:33
修复地图同步失败：任务一化后（PRIMARY_TASKS 只剩 1 个），前端/后台仍硬编码校验 maps.length!==3，导致返回 1 个地图时报「地图列表回执不完整」。app.js refreshPublishedPrimaryMaps 与 admin.js loadMaps 改为用 Object.keys(TASKS).length 动态期望数量。app.js/admin.js 缓存 bump 到 blockly-maps-count-fix-001。node --check 通过。

## 2026-10-10 15:50
移植优化后巡线 SDK（10 个 .mjs 模块 + lane-follow.js 适配器）到统一项目：server.js 增加 .mjs MIME 与 10 条 /lane/src/*.mjs 静态白名单；app.js 集成新巡线（laneFollowUsesCamera 互斥标志、startRealCameraPreview 守卫、followLineToJunction 重写含 reachedLineEnd/恢复预览、updateLaneFollowHud 交点文案+Number.isFinite 轮速）；index.html 缓存 bump 到 lane-sdk-001。node --check 全部通过。

## 2026-10-10 16:27
修复线上「地图数据格式不正确」：根因是 guangyang-map-config.js/guangyang-scoring.js 内容改了（移除任务二/三、去掉终点条件）但 index.html/admin.html 的 ?v= 缓存版本没 bump，服务端对带 ?v= 的静态资源返回 immutable 一年缓存，浏览器一直用旧 3 任务版本导致 expectedMapCount=3 而后端返回 1。已把两个文件的 ?v= bump 到 20261010-single-task-001（并同步 admin.html 的 styles.css）。

## 2026-10-10 16:27
模拟器巡线(followLine)改为行驶到路口后再停：followBlocklyLine 去掉 STOP_BEFORE_JUNCTION_CM=12 的提前停，直接开到道路端点（路口节点）再停，日志文案由「路口前停车」改为「到达路口并停车」；node --check 通过。

## 2026-10-10 16:57
真实小车单积木出错不中断：app.js 新增 guardRealRobotBlock + REAL_ROBOT_BLOCK_METHODS，把 forward/backward/turn/wait/grab/release/sees/detect/approach/followLine 包一层 try/catch，出错等 3s 后继续下一条积木；sendRealRobotAction 连接失败由 abort 改为抛普通 Error。同时完成模拟器自动靠近框宽与实车对齐（网球280/橙子310→16cm）。index.html app.js ?v= bump 到 real-error-continue-001。node --check 通过。

## 2026-10-10 17:06
server.js textAssetCacheControl 改为文本资源统一 no-cache + ETag 条件请求(304)，去掉 ?v= 的一年 immutable 强缓存，根治「改了内容漏 bump ?v= 导致线上旧代码」。node --check 通过。

## 2026-10-10 17:49
修复巡线摄像头 open 失败阻断循迹：worker.mjs 对 /api/camera/open 的冗余“确保开启”改为非致命（open 失败如 mixed-content 拦截/摄像头已开不 fail 整条循迹，继续拉流）；app.js followLineToJunction 的 finally 里 lane.stop() 二次报错改为仅记日志不外抛。根因是 HTTPS 页面请求 HTTP 小车接口被浏览器 mixed-content 拦截，真实小车场景应走 HTTP 访问。

## 2026-10-10 18:16
巡线重构：把摄像头流拉取从小车 worker 移到浏览器主线程，复用页面已开启的 <img> 预览流做采样。worker.mjs 改为仅做检测（接收 320x240 RGBA 帧，去掉 fetch/stream/camera-open 网络 I/O）；junction_follower.mjs 增加 pushFrame + 重导出 camera_geometry；lane-follow.js 增加 startFrameSampler 采样循环；app.js followLineToJunction 不再 stopRealCameraPreview、传入 cameraElement，show/hide 画布不再隐藏 .camera-view；index.html <img> 加 crossorigin=anonymous。根治 HTTPS 页面 mixed-content 拦截导致 Failed to fetch。

## 2026-10-12 16:28
顶部栏协议切换：index.html 给 protocolToggle 补上 HTTPS 按钮（HTTP|HTTPS 分段控件，复用已有 setRobotProtocol/点击 handler，点击即切换 chenlongRobotProtocol 并重启真实小车预览）。

## 2026-10-12 16:54
新增 3 分钟比赛时间上限：app.js 加 PROGRAM_TIME_LIMIT_MS=3*60*1000 常量与 enforceProgramTimeLimit()（在 animate 渲染循环每 100ms 检查，超时 abortRunContext('time-limit') 中断小车与代码，提示「时间已到」）。真实小车/模拟器通用：模拟器用逻辑用时、实车用墙钟用时。

## 2026-10-12 17:07
Blockly 增加积木代码导入/导出（JSON 文件）：index.html 工具栏新增导出(download)/导入(upload)按钮 + 隐藏 file input；app.js 新增 exportBlocklyProgram/importBlocklyProgramFile/triggerBlocklyProgramImport，导出带 format/version 信封的 workspace JSON，导入兼容信封或纯 workspaces.save 快照并走 workspace.clear+load+updateCode+center。node --check 通过。

## 2026-10-13 09:56
修复断网后巡线积木 Failed to fetch dynamically imported module：根因是巡线 SDK(lane/src/*.mjs) 在「执行巡线积木」时才动态 import + new Worker 拉取，且这些 .mjs 服务端返回 no-store 不缓存，连接小车断网即失败。方案：新增 sw.js（Service Worker，install 预缓存 10 个 .mjs、cache-first 接管 /blockly/lane/、skipWaiting+clients.claim 立即生效）；lane-follow.js 打开页面即预热（逐条 fetch 给进度 + import 入口进模块图）；index.html 加加载遮罩进度条 + 注册 SW；server.js 注册 /sw.js 路由。node --check 通过。

## 2026-10-13 10:13
把 Blockly 导入/导出按钮从工具栏移到「保存快照」旁边并统一风格：index.html 导出/导入按钮从 .blockly-controls 移到 .blockly-editor-actions（保存快照之后），改为 pill 带文字样式；styles.css 新增 .snapshot-tool-button 类（复用 snapshot 按钮基础样式，中性灰配色）。

## 2026-10-13 10:46
修复快照预览「无法预览该快照」：createRobotLabBlocklyTheme 改为缓存主题只注册一次（Blockly.defineTheme 重名会抛 already registered），renderSnapshotPreview 拆开 catch 并 console.error 暴露真实错误

## 2026-10-13 10:50
快照「查看」改为卡片内联下拉展开（手风琴式），移除独立预览跳转页；renderSnapshotList 生成 .snapshot-item+内嵌 .snapshot-card-preview，toggleSnapshotPreview 切换展开/收起，删除 openSnapshotViewer/closeSnapshotViewer 及对应 HTML/CSS

## 2026-10-13 10:56
快照支持命名：saveBlocklySnapshot 增加 name 字段，列表卡片主标题改为可点击重命名（点击名称→输入框，Enter/失焦保存、Esc 取消），新增 renameBlocklySnapshot/beginRenameSnapshot

## 2026-10-13 11:00
快照名称后加编辑（铅笔）图标引导重命名：renderSnapshotList 生成 name-row（名称+图标），图标与名称点击均触发重命名，渲染后调用 lucide.createIcons 生成图标

## 2026-10-13 11:09
暂时去掉 HTTPS 协议按钮：index.html 协议分段控件只保留 HTTP 按钮（data-protocol=http），app.js setRobotProtocol 遍历逻辑无需改动

## 2026-10-13 11:17
修复模拟器巡线第二次命令卡住：根因是巡线到达路口后 progressCm 已在道路端点，remainingToEndCm≈0 直接判定已到路口停车。改为循环沿路行驶，命令一开始停在分叉路口时经 lineContinuationExit 选直行出口继续下一段路

## 2026-10-13 11:39
模拟器巡线第二次命令继续下一段路（followBlocklyLine 改循环+lineContinuationExit 选直行出口）；目标物交付改放到离存放点最近白框（nearestBinTo）；任务一去掉末尾回起点（goal:null、guidePath 去尾部 start、slice(1,-1)改slice(1)）

## 2026-10-13 11:48
修复模拟器巡线遇到路口不停车：followBlocklyLine 的循环在到达端点后 continue 会重算 roadState 选中续行道路而穿过路口。改为单次行驶到端点即停，仅命令一开始已压路口时才经 lineContinuationExit 转入直行出口；lineContinuationExit 增加 endStoppedBy 返回远端节点类型

## 2026-10-13 15:45
程序计时精确到毫秒：formatPrimaryElapsedTime 改为 MM:SS.mmm（padStart 3 位），index.html 占位 00:00.0→00:00.000，animate 渲染间隔 100ms→33ms 使毫秒位实时刷新

## 2026-10-13 16:00
HTTP 巡线黑屏：根因是摄像头 img crossorigin=anonymous 跨域 CORS 致 getImageData 污染。改：1) 覆盖层 lane-follow-canvas 背景改透明，采不到帧时露出原始画面不再黑屏；2) startFrameSampler 静默 catch 改为上报一次 onSamplerError，app.js 提示「跨域受限」

## 2026-10-13 16:07
HTTP 页面巡线黑屏修复（方案B）：把小车请求默认协议从 http 改为 https（getRobotProtocol 默认 https），并在 index.html 恢复 HTTP|HTTPS 分段按钮、默认选中 HTTPS，使 HTTP 页面也走 https://192.168.4.1 拿带 CORS 的摄像头流

## 2026-10-13 16:31
修复 HTTP 页面断网巡线加载 worker.mjs 失败：根因是 HTTP 明文非安全上下文无法注册 SW（无 Cache Storage 离线缓存）+ lane/src/*.mjs 被 serve 为 no-store（无 HTTP 缓存）；改为对 lane/src/*.mjs 单独给 public,max-age=86400 强缓存且不重写内容（server.js serveBlockly）

## 2026-10-13 16:54
HTTP 断网巡线彻底修复（Blob worker 方案）：HTTP 明文无法注册 SW 且 HTTP 强缓存对 module worker 动态加载不可靠，改为 lane-follow.js 预热阶段 fetch worker.mjs 6 个依赖源码、剥离 import/export 合并成自包含 classic worker 脚本用 Blob URL 加载；junction_follower.mjs 支持 options.workerUrl；sw.js VERSION、lane-follow.js ?v= 均已 bump

## 2026-10-13 18:03
离线决赛版单文件打包：新增 tools/build-blockly-offline.mjs，把 blockly-page3 全资源（CSS/JS/图片/巡线SDK）内联成 dist/blockly-final.html（file:// 双击即用，无登录无云端）。app.js/lane-follow.js 加 __CHENLONG_OFFLINE__ 离线守卫（已提交）。关键点：主线程巡线 SDK 需 8 个模块（junction_policy 依赖 lane/branch/intersection），junction_follower.mjs 的 import.meta.url 在 classic script 非法需替换为 undefined

## 2026-10-14 09:38
离线决赛版防作弊加固：计时基准改 performance.now()（app.js 3 处）；构建脚本引入 terser 混淆 app.js（toplevel mangle + compress，仅保留 window.getRobotLabPerformance），并对 app.js/评分/地图配置/模拟时钟 4 个脚本做 FNV-1a 完整性自校验（篡改则 window.__CHENLONG_TAMPERED__ 置位、顶部红横幅、runProgram 停用计时运行）。产出 dist/blockly-final.html 8.2MB。package.json 新增 terser devDependency。

## 2026-10-14 09:44
修复离线版完整性校验误报：根因是源文件为 Windows CRLF，浏览器 HTML 解析器会把 \r\n/\r 归一化成 \n，导致 textContent 与构建期对 CRLF 源码算出的哈希不一致。改为 escapeInlineScript 里先把换行统一成 LF 再算哈希/内联，重构建后 4 个脚本哈希与浏览器 textContent 一致。

## 2026-10-14 09:55
修复右侧日志控制台不随拖动增高：根因是 .state-panel-content 和 .robot-state 缺少 display:flex 容器，导致 #codeOutput/.robot-state/.action-log 的 flex 属性（flex:1/flex-shrink:0）全部失效，action-log 停在 height:62px 写死高度。styles.css 补上两个 flex 容器后，收起代码时拖动分隔条日志区会撑开；重打包 dist/blockly-final.html。

## 2026-10-14 10:20
打包产物加版本号：tools/build-blockly-offline.mjs 新增 VERSION_BASE/日期戳/versionDisplay/versionFileName 三函数，顶部栏左上角注入「测试版本：v0.0.1-2026/10/14」徽标，输出文件名带版本 blockly-final-v0.0.1-2026-10-14.html；重构建成功 8.2MB

## 2026-10-14 10:40
修复变量积木 is not defined：根因是运行时 new Function('"use strict"') 包裹生成代码，而内置 variables_set/controls_for/controls_forEach 生成裸赋值(x=1)在严格模式抛错。app.js 覆盖 variables_set 改 var 声明，controls_for/controls_forEach 循环变量改 var 声明

## 2026-10-14 10:51
离线包固化线上任务一地图：build-blockly-offline.mjs 用 node:sqlite 读 data/platform.sqlite 当前发布 layout 注入 window.__CHENLONG_OFFLINE_MAPS__，app.js createPrimaryGuangyangMission 离线分支优先用它构建任务，使打包版模拟器任务与线上一致（任务一 revision 26）。重构建 dist/blockly-final-v0.0.1-2026-10-14.html
