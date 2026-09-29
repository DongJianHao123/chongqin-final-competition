"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function functionSource(name) {
  const start = app.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = app.indexOf("\nasync function ", start + 1);
  return app.slice(start, next < 0 ? app.length : next);
}

function pageLoader(requestVerificationEndpoint) {
  return Function("requestVerificationEndpoint", `
    "use strict";
    const PERSONAL_RECORDS_ENDPOINT = "/api/v1/records";
    const PERSONAL_RECORDS_PREVIEW_PAGE_SIZE = 100;
    const PERSONAL_RECORDS_PREVIEW_LIMIT = 1000;
    const RUN_RECORD_VERIFICATION_TIMEOUT_MS = 120000;
    ${functionSource("loadCompetitionRecordPages")}
    return loadCompetitionRecordPages;
  `)(requestVerificationEndpoint);
}

function pageResponse(page, total) {
  const pageSize = 100;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const count = Math.max(0, Math.min(pageSize, total - ((page - 1) * pageSize)));
  return {
    response: { ok: true, status: 200 },
    payload: {
      schemaVersion: "chenlong.records/v1",
      authoritative: false,
      records: Array.from({ length: count }, (_, index) => ({ id: ((page - 1) * pageSize) + index })),
      pagination: { page, pageSize, total, totalPages, hasNext: page < totalPages },
    },
  };
}

test("records preview reads 700+ records through bounded one-hundred-row responses", async () => {
  const urls = [];
  const load = pageLoader(async (url) => {
    urls.push(url);
    const page = Number(new URL(url, "http://records.test").searchParams.get("page"));
    return pageResponse(page, 750);
  });
  const records = await load(new AbortController().signal);

  assert.equal(records.length, 750);
  assert.equal(urls.length, 8);
  assert.equal(urls[0], "/api/v1/records?page=1&pageSize=100");
  assert.equal(urls.at(-1), "/api/v1/records?page=8&pageSize=100");
  assert.deepEqual(records.map(({ id }) => id), Array.from({ length: 750 }, (_, index) => index));
});

test("records preview preserves the previous one-thousand-record upper bound", async () => {
  let requests = 0;
  const load = pageLoader(async (url) => {
    requests += 1;
    const page = Number(new URL(url, "http://records.test").searchParams.get("page"));
    return pageResponse(page, 1250);
  });
  const records = await load(new AbortController().signal);

  assert.equal(records.length, 1000);
  assert.equal(requests, 10);
  assert.equal(records.at(-1).id, 999);
});

test("records preview rejects a repeated or incompatible page", async () => {
  const load = pageLoader(async () => ({
    ...pageResponse(1, 200),
    payload: {
      ...pageResponse(1, 200).payload,
      pagination: { page: 2, pageSize: 100, total: 200, totalPages: 2, hasNext: false },
    },
  }));
  await assert.rejects(load(new AbortController().signal), /分页响应不兼容/);
});
