
## 2026-09-21 15:26
Blockly 与 Python 真实小车控制替换为 car-blockly 方式：sendRealRobotAction 改为 distance(mm)/angle(deg)/time(ms) 参数，新增标定常量(20cm/s、90°/s、grab 7000ms、MIN 100、EXTRA 1000)，realMoveCentimeters/realTurnAngle 按速度计算延时并叠加 EXTRA，makeRealRobotApi 接入可配置执行/转弯速度(0-50 默认30、localStorage chenlongRobotMoveSpeed/chenlongRobotTurnSpeed)，两处 index.html+styles.css 增加执行/转弯速度输入。测试：blockly 75/86(11 预存失败)、car-python static-contract 60/60，全量失败均为预先存在的 auth/records/SSO/build/scoring 无关项。
