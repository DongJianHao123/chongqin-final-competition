"use strict";

// 统一平台建库种子脚本：幂等建表（由 PlatformStore 构造器完成）+ 种子地图
// + 迁移现有 admin 用户及其队伍。丢弃其余用户 / sessions / records / workspaces。
//
// 用法：node tools/migrate-db.js [dataDir]
// 默认 dataDir = 项目根下的 data/。

const path = require("node:path");

const { PlatformStore, sha256 } = require("../packages/platform-store");
const primaryGuangyangMaps = require("../projects/blockly-page3/guangyang-map-config.js");

const PRIMARY_TASKS = Object.freeze([
  "GYI-PRIMARY-01"
]);

// 迁移自 car-python/.runtime/auth/auth-store.json，仅保留 admin 一条用户及其队伍。
// 登录密码保持不变（scrypt 哈希原样迁入）。
const ADMIN_TEAM = Object.freeze({
  id: "tea_36b96a1031414b5c98fa5bda24610121",
  teamName: "测试队伍",
  teamNameKey: "测试队伍",
  inviteCode: "5G6H36R2",
  createdAt: "2026-09-20T07:53:00.186Z"
});

const ADMIN_USER = Object.freeze({
  id: "usr_5348eb246c974055b000aa405aed424b",
  username: "admin",
  usernameKey: "admin",
  displayName: "admin",
  teamId: "tea_36b96a1031414b5c98fa5bda24610121",
  teamName: "测试队伍",
  group: "primary",
  role: "admin",
  passwordHash: Object.freeze({
    algorithm: "scrypt",
    N: 32768,
    r: 8,
    p: 1,
    keyLength: 32,
    salt: "z7YXGpT98ingXmw9KHMf-w",
    hash: "hmv8-X_DGjM7UsWN5wReKyyIxyCxnZpKLXRQ_2BP3UY"
  }),
  createdAt: "2026-09-20T07:53:00.186Z"
});

function mapDigest(taskId, revision, layout) {
  return sha256(JSON.stringify({ taskId, revision, layout }));
}

function seedMaps(store, timestamp) {
  let seeded = 0;
  for (const taskId of PRIMARY_TASKS) {
    if (store.getMapConfig(taskId)) continue;
    const layout = primaryGuangyangMaps.normalizeLayout(taskId, primaryGuangyangMaps.defaultLayout(taskId));
    const revision = 1;
    const digest = mapDigest(taskId, revision, layout);
    store.upsertMapConfig(taskId, revision, digest, timestamp, null, layout);
    seeded += 1;
  }
  return seeded;
}

function migrateAdmin(store) {
  if (store.findUserById(ADMIN_USER.id)) return false;
  if (!store.findTeamById(ADMIN_TEAM.id)) {
    store.insertTeam({ ...ADMIN_TEAM });
  }
  store.insertUser({ ...ADMIN_USER, passwordHash: { ...ADMIN_USER.passwordHash } });
  return true;
}

function migrateDatabase(store, { now = () => Date.now() } = {}) {
  const timestamp = new Date(Number(now())).toISOString();
  const mapsSeeded = seedMaps(store, timestamp);
  const adminMigrated = migrateAdmin(store);
  return { mapsSeeded, adminMigrated };
}

function main() {
  const dataDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(process.cwd(), "data");
  const store = new PlatformStore({ dataDir });
  try {
    const result = migrateDatabase(store);
    console.log(`[migrate-db] 数据目录：${store.databasePath}`);
    console.log(`[migrate-db] 种子地图：${result.mapsSeeded} 个`);
    console.log(`[migrate-db] 迁移 admin：${result.adminMigrated ? "是" : "已存在，跳过"}`);
    console.log(`[migrate-db] 完成。`);
  } finally {
    store.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = Object.freeze({
  PRIMARY_TASKS,
  ADMIN_TEAM,
  ADMIN_USER,
  mapDigest,
  migrateDatabase
});
