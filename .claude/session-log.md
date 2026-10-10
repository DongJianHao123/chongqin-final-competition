
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
