
## 2026-09-21 11:08
修复 Blockly 真实小车控制/视频失败：根因是 projects/blockly-page3/server.js 的 CSP 比 Python 更严格（img-src/connect-src 仅 'self' data:），浏览器直连小车 http://192.168.4.1 的 fetch 控制接口(connect-src)和摄像头 <img> 流(img-src)被拦截。已在 SECURITY_HEADERS 的 CSP 加上 blob: http: https:（对齐 car-python/server.js），并补 media-src/worker-src。record-submission-flow 测试的 403 为预先存在，与本改动无关。
