"use strict";
(() => {
  const $ = selector => document.querySelector(selector);
  const groups = { primary: "小学组", junior: "初中组", high: "高中组" };
  const notice = $("#notice");
  const tbody = $("#leaderboardBody");
  const emptyState = $("#emptyState");

  function show(message, kind = "error") {
    notice.textContent = message;
    notice.dataset.kind = kind;
    notice.hidden = !message;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return "—";
    const totalSeconds = ms / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = (totalSeconds % 60).toFixed(1);
    return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
  }

  function textCell(text, className) {
    const td = document.createElement("td");
    td.className = className || "";
    td.textContent = text;
    return td;
  }

  function renderEntry(entry) {
    const tr = document.createElement("tr");

    const rankTd = document.createElement("td");
    rankTd.className = "col-rank";
    const badge = document.createElement("span");
    badge.className = "rank-badge";
    if (entry.rank === 1) badge.classList.add("rank-1");
    if (entry.rank === 2) badge.classList.add("rank-2");
    if (entry.rank === 3) badge.classList.add("rank-3");
    badge.textContent = String(entry.rank);
    rankTd.appendChild(badge);
    tr.appendChild(rankTd);

    const nameTd = document.createElement("td");
    nameTd.className = "col-name";
    const strong = document.createElement("strong");
    strong.textContent = entry.ownerDisplayName || entry.ownerUsername || "未知选手";
    nameTd.appendChild(strong);
    if (entry.ownerTeamName) {
      const small = document.createElement("small");
      small.textContent = entry.ownerTeamName;
      nameTd.appendChild(small);
    }
    tr.appendChild(nameTd);

    tr.appendChild(textCell(groups[entry.ownerGroup] || "—", "col-group"));
    tr.appendChild(textCell(formatDuration(entry.durationMs), "col-time"));
    tr.appendChild(textCell(Number.isInteger(entry.blockCount) ? String(entry.blockCount) : "—", "col-blocks"));
    tr.appendChild(textCell(Number.isInteger(entry.codeLineCount) ? String(entry.codeLineCount) : "—", "col-lines"));
    return tr;
  }

  async function load() {
    let response;
    try {
      response = await fetch("/blockly/api/leaderboard", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
    } catch (error) {
      show("无法连接排行榜服务，请稍后重试。");
      return;
    }
    if (response.status === 401) {
      location.replace(`/login.html?returnTo=${encodeURIComponent("/leaderboard.html")}`);
      return;
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      show(payload?.error?.message || "排行榜读取失败。");
      return;
    }
    const payload = await response.json().catch(() => null);
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    if (entries.length === 0) {
      emptyState.hidden = false;
      show("");
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const entry of entries) fragment.appendChild(renderEntry(entry));
    tbody.appendChild(fragment);
    show("");
  }

  load();
})();
