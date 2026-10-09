"use strict";
(() => {
  const $ = selector => document.querySelector(selector);
  const status = $("#status");
  const params = new URLSearchParams(location.search);
  const requestedReturnTo = params.get("returnTo") || "";
  function destination(user) {
    const fallback = user?.role === "admin" ? "/admin.html" : "/portal.html";
    if (!requestedReturnTo.startsWith("/") || requestedReturnTo.startsWith("//")) return fallback;
    const adminOnlyPath = requestedReturnTo.startsWith("/blockly/admin")
      || requestedReturnTo.startsWith("/admin.html");
    if (adminOnlyPath) return user?.role === "admin" ? requestedReturnTo : fallback;
    const safeParticipantPath = requestedReturnTo.startsWith("/blockly/")
      || requestedReturnTo === "/leaderboard.html";
    if (safeParticipantPath) return requestedReturnTo;
    return fallback;
  }
  const show = (message, kind = "error") => { status.textContent = message; status.dataset.kind = kind; status.hidden = !message; };
  async function request(path, body) {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || "请求失败，请稍后重试。");
    return payload;
  }
  async function enterAsGuest() {
    show("正在以游客身份进入…", "normal");
    try {
      const payload = await request("/api/v1/auth/guest", {});
      location.replace(destination(payload.user));
    } catch (error) { show(error.message); }
  }
  $("#guestButton").onclick = enterAsGuest;
  $("#loginForm").onsubmit = async event => {
    event.preventDefault(); show("正在登录…", "normal");
    try {
      const payload = await request("/api/v1/auth/login", { username: $("#loginUsername").value.trim(), password: $("#loginPassword").value });
      location.replace(destination(payload.user));
    } catch (error) { show(error.message); }
  };
  fetch("/api/platform/me", { credentials: "same-origin", cache: "no-store" }).then(response => response.ok ? response.json() : null).then(payload => {
    if (payload?.user) {
      // 已登录：直接进入目标页。
      location.replace(destination(payload.user));
    }
    // 未登录：停留在登录页，由用户选择登录 / 以游客身份进入。
  }).catch(() => {});
})();
