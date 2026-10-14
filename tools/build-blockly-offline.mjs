// 离线决赛版 Blockly 单文件打包脚本。
//
// 把 projects/blockly-page3/ 的所有资源（CSS/JS/图片/巡线 SDK）内联进一个
// 自包含 HTML，产出 dist/blockly-final.html，可直接双击 file:// 打开：
//   - 不需要登录、不依赖云端（代码上传/地图同步/成绩上传全部去掉）
//   - 支持全部现有积木：真实小车控制、3D 模拟器、巡线
//   - 防作弊加固：app.js 经 terser 混淆，并对 app.js / 评分 / 地图配置做完整性自校验
//
// 用法（需先 npm install 以取得 terser）：node tools/build-blockly-offline.mjs
//
// 不影响在线部署：app.js / lane-follow.js 里新增的 __CHENLONG_OFFLINE__ 守卫
// 只在打包产物（window.__CHENLONG_OFFLINE__ === true）中生效，在线页面无此变量。
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const blocklyDir = join(projectRoot, "projects", "blockly-page3");
const distDir = join(projectRoot, "dist");

// 测试版本号：基础版本手动维护（发布时递增），日期自动取构建当天。
const VERSION_BASE = "v0.0.1";

function buildDateStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

// 页面左上角显示的版本号：v0.0.1-2026/10/14
function versionDisplay() {
  return `${VERSION_BASE}-${buildDateStamp()}`;
}

// 文件名里的版本号（斜杠不能出现在文件名中，替换为短横线）：v0.0.1-2026-10-14
function versionFileName() {
  return versionDisplay().replace(/\//g, "-");
}

// 主线程巡线 SDK 内核，按依赖顺序（被依赖者在前）。注意 junction_policy.mjs
// 依赖 lane.mjs 的 speeds()，lane.mjs 又依赖 branch.mjs / intersection.mjs，
// 所以必须把 lane.mjs 及其依赖一并内联（共 8 个模块）。
const MAIN_MODULE_NAMES = [
  "follow_config.mjs", "camera_geometry.mjs", "runtime_config.mjs",
  "branch.mjs", "intersection.mjs", "lane.mjs",
  "junction_policy.mjs", "junction_follower.mjs"
];
// 巡线检测 worker 内核，与 lane-follow.js 的 WORKER_MODULE_NAMES 保持一致。
const WORKER_MODULE_NAMES = [
  "follow_config.mjs", "branch.mjs", "intersection.mjs", "crossing_stop.mjs",
  "lane.mjs", "worker.mjs"
];

function readText(absPath) {
  return readFileSync(absPath, "utf8");
}

function pngDataUrl(absPath) {
  const bytes = readFileSync(absPath);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function svgDataUrl(absPath) {
  const svg = readFileSync(absPath);
  return `data:image/svg+xml;base64,${svg.toString("base64")}`;
}

// 内联前的最后一步处理：
//   1) 归一化换行为 LF：浏览器 HTML 解析器会把 \r\n / \r 都归一化成 \n，若构建期
//      直接对含 \r\n 的源码算哈希，浏览器端 textContent 是 \n，会导致完整性自校验
//      误报「文件被修改」。这里提前统一成 \n，保证构建期哈希与浏览器 textContent 一致。
//   2) 防止内联 JS 里的字面 </script> / <!-- 提前破坏 HTML 解析（当前源文件均不含，
//      此处仅作防御）。
function escapeInlineScript(code) {
  return code
    .replace(/\r\n?/g, "\n")
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<!--/g, "<\\!--");
}

// FNV-1a 32 位哈希（Math.imul 保证 32 位整数乘法）。构建期与浏览器内联校验脚本
// 使用完全相同的实现，确保对同一段代码文本算出同一哈希。
function fnv1aHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// 生成浏览器端完整性自校验脚本：对带 id 的内联 <script> 逐一重算 FNV-1a，
// 与构建期写入的期望值比对；任一不一致即标记 window.__CHENLONG_TAMPERED__ 并
// 显示醒目横幅（app.js 的计时运行入口据此停用计时成绩）。
function buildIntegrityScript(targets) {
  const pairs = targets.map(t => `[${JSON.stringify(t.id)},${JSON.stringify(t.hash)}]`).join(",");
  return `(function () {
  "use strict";
  function fnv1a(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  var targets = [${pairs}];
  var tampered = false;
  for (var j = 0; j < targets.length; j++) {
    var el = document.getElementById(targets[j][0]);
    if (!el || fnv1a(el.textContent) !== targets[j][1]) { tampered = true; break; }
  }
  if (tampered) {
    window.__CHENLONG_TAMPERED__ = true;
    var banner = document.createElement("div");
    banner.setAttribute("style", "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b91c1c;color:#ffffff;font:600 14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:10px 16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3);");
    banner.textContent = "文件完整性校验失败：检测到代码被修改，计时成绩无效，请使用原始分发的文件。";
    document.documentElement.appendChild(banner);
  }
})();`;
}

// 把 ES module 剥离成可内联的经典脚本片段：
//   1) 删除 import 行
//   2) 整行删除 export {X} from './y.mjs' 再导出（dropReExportFrom 时）
//   3) 剥离 export 前缀（export function/const/class -> function/const/class）
//   4) import.meta.url -> undefined（classic script 里 import.meta 是语法错误；离线版
//      总是经 options.workerUrl 提供 worker，该回退分支不会执行）
function stripModule(code, { dropReExportFrom }) {
  let out = code.replace(/^import\b[^\n]*$/gm, "");
  if (dropReExportFrom) {
    out = out.replace(/^[ \t]*export\s*\{[^}]*\}\s*from\s*['"][^'"]*['"]\s*;?[ \t]*$/gm, "");
  }
  out = out.replace(/^([ \t]*)export\s+/gm, "$1");
  out = out.replace(/\bimport\.meta\.url\b/g, "undefined");
  return out;
}

function readLaneModule(name) {
  return readText(join(blocklyDir, "lane", "src", name));
}

function buildMainSdkCode() {
  const parts = MAIN_MODULE_NAMES.map(name =>
    `/* ==== ${name} ==== */\n${stripModule(readLaneModule(name), { dropReExportFrom: true })}`
  );
  return `(function (global) {\n  "use strict";\n${parts.join("\n")}\n  global.__chenlongLaneSdk = { createJunctionFollower, DETECTION_WIDTH, DETECTION_HEIGHT, supportedCameraSize, DEFAULT_FOLLOW_PARAMS };\n})(window);`;
}

function buildWorkerSrc() {
  return WORKER_MODULE_NAMES.map(name =>
    `/* ==== ${name} ==== */\n${stripModule(readLaneModule(name), { dropReExportFrom: false })}`
  ).join("\n");
}

// 读取本地 SQLite 里当前发布的任务地图（管理员在后台保存的 layout），生成一段脚本
// 挂到 window.__CHENLONG_OFFLINE_MAPS__，供离线版 app.js 在创建任务时使用，使打包版
// 模拟器任务与线上当前任务一致。数据库缺失或读不到时返回空串，离线包回退到内置默认布局。
async function buildOfflineMapsScript() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = join(projectRoot, "data", "platform.sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT task_id, current_revision FROM map_configs ORDER BY task_id ASC").all();
      const maps = {};
      for (const row of rows) {
        const version = db.prepare(
          "SELECT revision, digest, layout_json FROM map_config_versions WHERE task_id = ? AND revision = ?"
        ).get(row.task_id, row.current_revision);
        if (!version) continue;
        let layout;
        try { layout = JSON.parse(version.layout_json); } catch { continue; }
        maps[row.task_id] = { revision: version.revision, digest: version.digest, layout };
      }
      if (!Object.keys(maps).length) return "";
      return `<script>window.__CHENLONG_OFFLINE_MAPS__ = ${JSON.stringify(maps)};</script>`;
    } finally {
      db.close();
    }
  } catch (error) {
    console.warn("未读取到线上发布地图，离线包将使用内置默认布局：", error?.message || error);
    return "";
  }
}

async function build() {
  let html = readText(join(blocklyDir, "index.html"));

  const mapDataUrl = pngDataUrl(join(blocklyDir, "assets", "guangyang-island.png"));
  const faviconDataUrl = svgDataUrl(join(blocklyDir, "favicon.svg"));

  // 混淆 app.js（计时/评分核心）：重命名顶层标识符 + 压缩 + 去注释，抬高选手
  // 定位并篡改计时逻辑的门槛。仅混淆 app.js；guangyang-scoring / map-config 通过
  // globalThis 暴露对象，顶层混淆可能破坏对外的属性名契约，故只做完整性校验。
  const { minify } = await import("terser");
  const appSource = readText(join(blocklyDir, "app.js"));
  const appMinified = (await minify(appSource, {
    compress: true,
    mangle: { toplevel: true, reserved: ["getRobotLabPerformance"] },
    format: { comments: false }
  })).code;
  if (!appMinified) throw new Error("app.js 混淆失败");

  // 内联 <link rel="stylesheet">；favicon 转 data URL。
  html = html.replace(/<link\b[^>]*>/g, tag => {
    const href = /href=["']([^"']+)["']/.exec(tag)?.[1];
    const rel = /rel=["']([^"']+)["']/.exec(tag)?.[1];
    if (rel === "stylesheet" && href) {
      const cleanPath = href.split("?")[0].replace(/^\.\//, "");
      let css = readText(join(blocklyDir, cleanPath));
      css = css.replace(/url\(['"]?\.\/assets\/guangyang-island\.png['"]?\)/g, `url("${mapDataUrl}")`);
      return `<style>\n${css}\n</style>`;
    }
    if (href && /favicon/i.test(href)) {
      return tag.replace(href, faviconDataUrl);
    }
    return tag;
  });

  const mainSdkCode = buildMainSdkCode();
  const workerSrc = buildWorkerSrc();
  const laneSdkScript = `<script>\n${escapeInlineScript(mainSdkCode)}\n</script>`;
  const laneWorkerScript = `<script>\nwindow.__chenlongLaneWorkerSrc = ${JSON.stringify(workerSrc)};\n</script>`;

  // 内联 <script src>，保持顺序；在 lane-follow.js 之前插入巡线 SDK 内核。
  // 对计时/评分相关的三个脚本打上 id 并记录哈希，供浏览器端完整性自校验使用。
  const INTEGRITY_IDS = {
    "guangyang-scoring.js": "chenlong-scoring",
    "guangyang-map-config.js": "chenlong-mapconfig",
    "simulation-clock.js": "chenlong-clock",
    "app.js": "chenlong-app"
  };
  const integrityTargets = [];
  html = html.replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/g, (fullMatch, srcPath) => {
    const cleanPath = srcPath.split("?")[0].replace(/^\.\//, "");
    const fileName = cleanPath.split("/").pop();
    let code = fileName === "app.js" ? appMinified : readText(join(blocklyDir, cleanPath));
    code = code.replace(/\.\/assets\/guangyang-island\.png/g, mapDataUrl);
    code = escapeInlineScript(code);
    const integrityId = INTEGRITY_IDS[fileName];
    if (integrityId) integrityTargets.push({ id: integrityId, hash: fnv1aHex(code) });
    const idAttr = integrityId ? ` id="${integrityId}"` : "";
    const inline = `<script${idAttr}>${code}</script>`;
    if (fileName === "lane-follow.js") {
      return `${laneSdkScript}\n${laneWorkerScript}\n${inline}`;
    }
    return inline;
  });

  // 删除 file:// 下无意义的 Service Worker 注册脚本。
  html = html.replace(/[\t ]*<script>\s*if \("serviceWorker" in navigator\)[\s\S]*?<\/script>\n?/, "");

  // 在其它脚本之前声明离线标志，驱动 app.js / lane-follow.js 的离线分支；并把线上
  // 当前发布的任务地图一并固化，使打包版模拟器任务与线上一致。
  const offlineMapsScript = await buildOfflineMapsScript();
  html = html.replace(
    /<meta charset="utf-8">/,
    `<meta charset="utf-8">\n  <script>window.__CHENLONG_OFFLINE__ = true;</script>${offlineMapsScript ? `\n  ${offlineMapsScript}` : ""}`
  );

  // 在 </body> 之前插入完整性自校验脚本（紧跟最后一个内联脚本，此时所有带 id 的
  // 脚本元素均已解析进 DOM，可同步读 textContent 重算哈希）。
  const integrityScript = `<script>${escapeInlineScript(buildIntegrityScript(integrityTargets))}</script>`;
  html = html.replace(/<\/body>/, `${integrityScript}\n</body>`);

  // 顶部栏左上角空余处注入版本号徽标。margin-right:auto 让它紧贴左侧品牌区，
  // 并把右侧运行控制区推到最右，徽标落在两者之间的空余位置。
  html = html.replace(
    /<div class="topbar-actions" aria-label="运行控制">/,
    `<div class="version-badge" style="margin-left:16px;margin-right:auto;align-self:center;font:600 12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#8ea3bf;white-space:nowrap;">测试版本：${versionDisplay()}</div>\n      <div class="topbar-actions" aria-label="运行控制">`
  );

  const outFile = join(distDir, `blockly-final-${versionFileName()}.html`);
  mkdirSync(distDir, { recursive: true });
  writeFileSync(outFile, html);

  const bytes = statSync(outFile).size;
  const kb = (bytes / 1024).toFixed(1);
  console.log(`已生成 ${outFile}`);
  console.log(`版本：${versionDisplay()}`);
  console.log(`大小：${bytes} 字节（${kb} KB）`);
}

build().catch(error => {
  console.error(error);
  process.exit(1);
});
