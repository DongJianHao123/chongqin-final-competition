"use strict";

(() => {
  const $ = selector => document.querySelector(selector);
  const groups = { primary: "小学组", junior: "初中组", high: "高中组" };
  const PAGE_SIZE = 15;
  let scorePage = 1;
  let scoreTotalPages = 1;
  let scoreGroup = "";
  let userPage = 1;
  let users = [];
  let bestTeam = null;
  let recordPage = 1;
  let recordTotalPages = 1;
  let recordsLoaded = false;
  let scoreDialogRecord = null;

  function fail(message) {
    $("#notice").hidden = false;
    $("#notice").textContent = message;
    $("#notice").dataset.kind = "error";
  }

  async function jsonRequest(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
    const payload = await response.json().catch(() => null);
    if (response.status === 401) {
      location.replace(`/login.html?returnTo=${encodeURIComponent("/admin.html")}`);
      throw new Error("请先登录。");
    }
    if (response.status === 403) {
      location.replace("/portal.html");
      throw new Error("需要管理员权限。");
    }
    if (!response.ok) throw new Error(payload?.error?.message || "后台数据读取失败。");
    return payload;
  }

  function textElement(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    return element;
  }

  function formatDurationMs(ms) {
    if (!Number.isFinite(ms)) return "—";
    const totalSeconds = ms / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = (totalSeconds % 60).toFixed(1);
    return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
  }

  function formatDateTime(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    const pad = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function updateMetrics() {
    $("#metricUsers").textContent = String(users.length);
    $("#metricParticipants").textContent = String(users.filter(user => user.role !== "admin").length);
    if (bestTeam) {
      $("#metricBest").textContent = formatDurationMs(bestTeam.bestDurationMs);
      $("#metricBestTeam").textContent = bestTeam.teamName;
    } else {
      $("#metricBest").textContent = "—";
      $("#metricBestTeam").textContent = "等待成绩";
    }
    $("#metrics").hidden = false;
  }

  function renderUsers() {
    const query = $("#userSearch").value.trim().toLocaleLowerCase("zh-CN");
    const group = $("#groupFilter").value;
    const role = $("#roleFilter").value;
    const filtered = users.filter(user => {
      const searchable = `${user.username} ${user.displayName || ""} ${user.teamName || ""}`.toLocaleLowerCase("zh-CN");
      return (!query || searchable.includes(query)) && (!group || user.group === group) && (!role || user.role === role);
    });
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    userPage = Math.min(Math.max(userPage, 1), totalPages);
    const visible = filtered.slice((userPage - 1) * PAGE_SIZE, userPage * PAGE_SIZE);

    $("#userRows").replaceChildren(...visible.map(user => {
      const row = document.createElement("tr");
      const identity = document.createElement("td");
      identity.className = "identity-cell";
      identity.append(textElement("strong", "", user.username), textElement("small", "", user.displayName || user.username));
      row.append(identity);

      if (user.role === "admin") {
        row.append(textElement("td", "", "—"), textElement("td", "", "—"));
      } else {
        const teamCell = document.createElement("td");
        const teamInput = document.createElement("input");
        teamInput.value = user.teamName || "";
        teamInput.maxLength = 64;
        teamInput.dataset.field = "team";
        teamInput.setAttribute("aria-label", `${user.username} 的队伍名称`);
        teamCell.append(teamInput);
        row.append(teamCell);

        const groupCell = document.createElement("td");
        const groupSelect = document.createElement("select");
        groupSelect.dataset.field = "group";
        groupSelect.setAttribute("aria-label", `${user.username} 的小组`);
        Object.entries(groups).forEach(([value, label]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          groupSelect.append(option);
        });
        groupSelect.value = user.group;
        groupCell.append(groupSelect);
        row.append(groupCell);
      }

      const roleCell = document.createElement("td");
      const badge = textElement("span", "role-badge", user.role === "admin" ? "管理员" : "普通用户");
      badge.dataset.role = user.role;
      roleCell.append(badge);
      row.append(roleCell);

      const action = document.createElement("td");
      action.className = "save-cell";
      if (user.role === "admin") {
        action.textContent = "—";
      } else {
        const button = textElement("button", "", "保存修改");
        button.type = "button";
        const status = textElement("span", "save-status", "");
        button.addEventListener("click", async () => {
          button.disabled = true;
          status.dataset.kind = "";
          status.textContent = "保存中…";
          try {
            const requestedTeamName = row.querySelector('[data-field="team"]').value.trim();
            const requestedGroup = row.querySelector('[data-field="group"]').value;
            const updated = await jsonRequest(`/api/platform/admin/users/${encodeURIComponent(user.id)}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ teamName: requestedTeamName, group: requestedGroup })
            });
            const fresh = updated.user || updated;
            const teamName = fresh.teamName || requestedTeamName;
            const newGroup = fresh.group || requestedGroup;
            users.forEach(member => {
              if (member.teamId && member.teamId === user.teamId) {
                member.teamName = teamName;
                member.group = newGroup;
              }
            });
            user.teamName = teamName;
            user.group = newGroup;
            renderUsers();
            await loadScores({ preservePage: true });
          } catch (error) {
            status.dataset.kind = "error";
            status.textContent = error.message;
          } finally {
            button.disabled = false;
          }
        });
        action.append(button, status);
      }
      row.append(action);
      return row;
    }));

    const start = filtered.length ? (userPage - 1) * PAGE_SIZE + 1 : 0;
    const end = Math.min(userPage * PAGE_SIZE, filtered.length);
    $("#userPageInfo").textContent = `第 ${start}–${end} 个，共 ${filtered.length} 个用户 · 第 ${userPage}/${totalPages} 页`;
    $("#userPrev").disabled = userPage <= 1;
    $("#userNext").disabled = userPage >= totalPages;
  }

  async function loadUsers() {
    const payload = await jsonRequest("/api/platform/admin/users");
    users = payload.users || [];
    renderUsers();
    updateMetrics();
  }

  function judgmentBadge(label, value) {
    const badge = textElement("span", "judgment-badge", label);
    badge.dataset.ok = value === true ? "true" : value === false ? "false" : "unknown";
    return badge;
  }

  function scoreRecordRow(record, index) {
    const row = document.createElement("tr");
    const rank = (scorePage - 1) * PAGE_SIZE + index + 1;
    const rankCell = textElement("td", "rank-cell", String(rank));
    if (rank <= 3) rankCell.dataset.medal = String(rank);
    row.append(rankCell);

    const teamCell = document.createElement("td");
    teamCell.className = "team-cell";
    teamCell.append(textElement("strong", "", record.teamName || "—"), textElement("small", "", groups[record.group] || record.group || "未设置小组"));
    row.append(teamCell);

    const userCell = document.createElement("td");
    userCell.className = "identity-cell";
    userCell.append(textElement("strong", "", record.ownerDisplayName || record.ownerUsername || "—"), textElement("small", "", record.ownerUsername || ""));
    row.append(userCell);

    const durationCell = document.createElement("td");
    durationCell.append(textElement("strong", "total-score", formatDurationMs(record.durationMs)));
    row.append(durationCell);

    const judgmentCell = document.createElement("td");
    judgmentCell.className = "judgment-cell";
    const judgment = record.judgment;
    if (judgment) {
      judgmentCell.append(
        judgmentBadge("完成任务", judgment.taskCompleted),
        judgmentBadge("混淆物1", judgment.distractor1Cleared),
        judgmentBadge("混淆物2", judgment.distractor2Cleared),
        judgmentBadge("目标夹起", judgment.targetPicked),
        judgmentBadge("运送到终点", judgment.targetDelivered)
      );
    } else {
      judgmentCell.append(textElement("span", "record-meta", "未打分"));
    }
    row.append(judgmentCell);

    const action = document.createElement("td");
    action.className = "save-cell";
    const button = textElement("button", "", judgment ? "重新打分" : "打分");
    button.type = "button";
    button.addEventListener("click", () => openScoreDialog(record));
    action.append(button);
    row.append(action);

    return row;
  }

  function openScoreDialog(record) {
    scoreDialogRecord = record;
    $("#scoreDialogMeta").textContent = `${record.teamName || "未命名队伍"} · ${record.ownerDisplayName || record.ownerUsername || ""} · ${formatDurationMs(record.durationMs)}`;
    const judgment = record.judgment;
    $("#judgeTaskCompleted").checked = judgment?.taskCompleted === true;
    $("#judgeDistractor1").checked = judgment?.distractor1Cleared === true;
    $("#judgeDistractor2").checked = judgment?.distractor2Cleared === true;
    $("#judgeTargetPicked").checked = judgment?.targetPicked === true;
    $("#judgeTargetDelivered").checked = judgment?.targetDelivered === true;
    $("#scoreDialog").showModal();
  }

  async function loadScores({ preservePage = false } = {}) {
    if (!preservePage) scorePage = Math.max(1, scorePage);
    const query = new URLSearchParams({ page: String(scorePage) });
    if (scoreGroup) query.set("group", scoreGroup);
    const payload = await jsonRequest(`/api/platform/admin/overview?${query}`);
    scorePage = payload.pagination.page;
    scoreTotalPages = payload.pagination.totalPages;
    $("#rows").replaceChildren(...(payload.records || []).map(scoreRecordRow));
    if (scorePage === 1) {
      const summary = payload.summary || {};
      bestTeam = summary.bestDurationMs != null
        ? { bestDurationMs: summary.bestDurationMs, teamName: summary.bestTeamName || "—" }
        : null;
      $("#metricTeams").textContent = String(summary.teamCount ?? 0);
    }
    updateMetrics();
    const start = payload.pagination.total ? (scorePage - 1) * PAGE_SIZE + 1 : 0;
    const end = Math.min(scorePage * PAGE_SIZE, payload.pagination.total);
    $("#pageInfo").textContent = `第 ${start}–${end} 条，共 ${payload.pagination.total} 条 · 第 ${scorePage}/${scoreTotalPages} 页`;
    $("#prev").disabled = scorePage <= 1;
    $("#next").disabled = scorePage >= scoreTotalPages;
  }

  function recordStatusBadge(value, trueLabel, falseLabel) {
    const badge = textElement("span", "record-badge", value === true ? trueLabel : value === false ? falseLabel : "—");
    badge.dataset.ok = value === true ? "true" : value === false ? "false" : "unknown";
    return badge;
  }

  function recordRow(record) {
    const row = document.createElement("tr");
    const isReal = record.target === "real";

    row.append(textElement("td", "record-time", formatDateTime(record.createdAt)));

    const teamCell = document.createElement("td");
    teamCell.className = "team-cell";
    teamCell.append(textElement("strong", "", record.ownerTeamName || "—"));
    row.append(teamCell);

    const identity = document.createElement("td");
    identity.className = "identity-cell";
    identity.append(
      textElement("strong", "", record.ownerDisplayName || record.ownerUsername || "—"),
      textElement("small", "", record.ownerUsername || "")
    );
    row.append(identity);

    const envCell = document.createElement("td");
    const envBadge = textElement("span", "record-badge", isReal ? "真实小车" : "模拟器");
    envBadge.dataset.env = isReal ? "real" : "sim";
    envCell.append(envBadge);
    row.append(envCell);

    const durationCell = document.createElement("td");
    durationCell.append(textElement("strong", "total-score", formatDurationMs(record.durationMs)));
    row.append(durationCell);

    const goalCell = document.createElement("td");
    goalCell.append(isReal ? textElement("span", "record-meta", "不适用") : recordStatusBadge(record.goalReached, "到达", "未到达"));
    row.append(goalCell);

    const taskCell = document.createElement("td");
    if (isReal) {
      taskCell.append(textElement("span", "record-meta", "不适用"));
    } else {
      taskCell.append(recordStatusBadge(record.completed, "已完成", "未完成"));
      taskCell.append(textElement("small", "record-meta", `检查点 ${record.checkpointCount ?? 0}/${record.checkpointTotal ?? 0}`));
    }
    row.append(taskCell);

    return row;
  }

  async function loadRecords({ preservePage = false } = {}) {
    if (!preservePage) recordPage = 1;
    const query = new URLSearchParams({ page: String(recordPage) });
    const payload = await jsonRequest(`/api/platform/admin/records?${query}`);
    recordPage = payload.pagination.page;
    recordTotalPages = payload.pagination.totalPages;
    $("#recordRows").replaceChildren(...(payload.records || []).map(recordRow));
    const start = payload.pagination.total ? (recordPage - 1) * PAGE_SIZE + 1 : 0;
    const end = Math.min(recordPage * PAGE_SIZE, payload.pagination.total);
    $("#recordPageInfo").textContent = `第 ${start}–${end} 条，共 ${payload.pagination.total} 条 · 第 ${recordPage}/${recordTotalPages} 页`;
    $("#recordPrev").disabled = recordPage <= 1;
    $("#recordNext").disabled = recordPage >= recordTotalPages;
    recordsLoaded = true;
  }

  function activateTab(name, { updateHash = true } = {}) {
    const selected = ["scores", "records", "users", "systems"].includes(name) ? name : "scores";
    document.querySelectorAll("[data-admin-tab]").forEach(button => {
      const active = button.dataset.adminTab === selected;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll("[data-admin-panel]").forEach(panel => {
      panel.hidden = panel.dataset.adminPanel !== selected;
    });
    if (selected === "records" && !recordsLoaded) {
      loadRecords().catch(error => fail(error.message));
    }
    if (updateHash) history.replaceState(null, "", `#${selected}`);
  }

  async function refresh(button, loader) {
    button.disabled = true;
    try { await loader(); }
    catch (error) { fail(error.message); }
    finally { button.disabled = false; }
  }

  document.querySelectorAll("[data-admin-tab]").forEach(button => {
    button.addEventListener("click", () => activateTab(button.dataset.adminTab));
  });
  $("#userSearch").addEventListener("input", () => { userPage = 1; renderUsers(); });
  $("#groupFilter").addEventListener("change", () => { userPage = 1; renderUsers(); });
  $("#roleFilter").addEventListener("change", () => { userPage = 1; renderUsers(); });
  $("#scoreGroupFilter").addEventListener("change", event => {
    scoreGroup = event.currentTarget.value;
    scorePage = 1;
    loadScores().catch(error => fail(error.message));
  });
  $("#userPrev").addEventListener("click", () => { userPage -= 1; renderUsers(); });
  $("#userNext").addEventListener("click", () => { userPage += 1; renderUsers(); });
  $("#prev").addEventListener("click", () => { scorePage -= 1; loadScores().catch(error => fail(error.message)); });
  $("#next").addEventListener("click", () => { scorePage += 1; loadScores().catch(error => fail(error.message)); });
  $("#recordPrev").addEventListener("click", () => { recordPage -= 1; loadRecords().catch(error => fail(error.message)); });
  $("#recordNext").addEventListener("click", () => { recordPage += 1; loadRecords().catch(error => fail(error.message)); });
  $("#refreshRecords").addEventListener("click", event => refresh(event.currentTarget, () => loadRecords({ preservePage: true })));
  $("#refreshUsers").addEventListener("click", event => refresh(event.currentTarget, loadUsers));
  $("#refreshScores").addEventListener("click", event => refresh(event.currentTarget, () => loadScores({ preservePage: true })));
  $("#scoreForm").addEventListener("submit", async event => {
    event.preventDefault();
    const record = scoreDialogRecord;
    if (!record) return;
    const saveButton = $("#scoreDialogSave");
    saveButton.disabled = true;
    try {
      await jsonRequest(`/api/platform/admin/records/${encodeURIComponent(record.id)}/judgment`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          taskCompleted: $("#judgeTaskCompleted").checked,
          distractor1Cleared: $("#judgeDistractor1").checked,
          distractor2Cleared: $("#judgeDistractor2").checked,
          targetPicked: $("#judgeTargetPicked").checked,
          targetDelivered: $("#judgeTargetDelivered").checked
        })
      });
      $("#scoreDialog").close();
      await loadScores({ preservePage: true });
    } catch (error) {
      fail(error.message);
    } finally {
      saveButton.disabled = false;
    }
  });
  $("#scoreDialogCancel").addEventListener("click", () => $("#scoreDialog").close());
  $("#scoreDialogClose").addEventListener("click", () => $("#scoreDialog").close());
  $("#logoutButton").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await jsonRequest("/api/v1/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}"
      });
      location.replace("/login.html?mode=login");
    } catch (error) {
      fail(error.message);
      button.disabled = false;
    }
  });

  activateTab(location.hash.slice(1), { updateHash: false });
  Promise.all([
    jsonRequest("/api/platform/me").then(payload => { $("#currentAdminName").textContent = payload.user.displayName || payload.user.username; }),
    loadUsers(),
    loadScores()
  ]).then(() => {
    $("#notice").hidden = true;
  }).catch(error => fail(error.message));
})();
