/* 巡线 SDK 离线缓存 Service Worker。
 *
 * 背景：巡线 SDK（lane/src/*.mjs）是在「执行巡线积木」时才动态 import + new Worker
 * 拉取的；而连接小车后往往已脱离互联网，导致 "Failed to fetch dynamically imported
 * module"。本 SW 在页面首次打开（在线）时预缓存这些模块，之后断网也能从缓存加载。
 *
 * 注意：改动 lane/src/ 下任一 .mjs 后，请递增下方 VERSION，否则浏览器会继续用旧缓存。
 */
const VERSION = "20261013-002";
const CACHE_NAME = "chenlong-blockly-lane-" + VERSION;

const LANE_MODULES = [
  "/blockly/lane/src/branch.mjs",
  "/blockly/lane/src/camera_geometry.mjs",
  "/blockly/lane/src/crossing_stop.mjs",
  "/blockly/lane/src/follow_config.mjs",
  "/blockly/lane/src/intersection.mjs",
  "/blockly/lane/src/junction_follower.mjs",
  "/blockly/lane/src/junction_policy.mjs",
  "/blockly/lane/src/lane.mjs",
  "/blockly/lane/src/runtime_config.mjs",
  "/blockly/lane/src/worker.mjs"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(LANE_MODULES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith("chenlong-blockly-lane-") && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // 只接管本域名下巡线 SDK 模块；API、跨域小车请求等一律放行。
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/blockly/lane/")) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
