
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
