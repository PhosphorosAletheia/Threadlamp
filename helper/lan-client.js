/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
(() => {
  "use strict";
  async function sendMessage(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);
    try {
      const response = await fetch("/rpc", {method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"},
        body:JSON.stringify(request), signal:controller.signal});
      if (response.status === 401) {
        document.getElementById("connection").textContent = "Signed out";
        const link = document.getElementById("lan-sign-in");
        if (link) link.hidden = false;
        throw new Error("LAN session expired. Save any unsent dashboard drafts, then open Settings to sign in again.");
      }
      return await response.json();
    } catch (error) {
      if (error.name === "AbortError" || error instanceof TypeError) throw new Error("LAN request interrupted. A command may have been attempted; inspect the agent before retrying.");
      throw error;
    } finally { clearTimeout(timer); }
  }
  const target = agent => ({tabId:agent.tabId, url:agent.url, instanceId:agent.instanceId, revision:agent.revision});
  async function checked(request) {
    const result = await sendMessage(request);
    if (!result?.ok) throw new Error(result?.error || "The browser did not acknowledge this action.");
    return result;
  }
  globalThis.LanDashboardAPI = {
    sendMessage,
    reloadDashboard: options => globalThis.ThreadlampReloadDashboard(options),
    requestLoopbackPermission: async () => (await checked({type:"LAN_LOOPBACK_PERMISSION"})).granted,
    openChat: agent => checked({type:"LAN_OPEN_CHAT",target:target(agent)}),
    openSettings: () => checked({type:"LAN_OPEN_OPTIONS"})
  };
  document.addEventListener("DOMContentLoaded", () => {
    const reload = document.getElementById("refresh");
    reload.textContent = "Reload"; reload.classList.remove("icon-button");
    reload.title = "Reload dashboard"; reload.setAttribute("aria-label", "Reload dashboard");
    document.getElementById("settings").textContent = "Open settings on host";
    document.getElementById("open-chat").textContent = "Open chat on host ↗";
    document.querySelector(".brand").setAttribute("aria-label", "Threadlamp Agent workspace");
    const logout = document.createElement("button"); logout.id = "lan-sign-out"; logout.type = "button"; logout.textContent = "Sign out";
    logout.addEventListener("click", async () => {
      try {
        const response = await fetch("/logout", {method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
        if (!response.ok) throw new Error("Sign out failed.");
        location.href = "/login";
      } catch (error) { document.getElementById("notice").textContent = error.message; }
    });
    const login = Object.assign(document.createElement("a"), {id:"lan-sign-in",href:"/login",textContent:"Sign in again",hidden:true});
    const session = document.createElement("section"); session.className = "lan-install";
    const heading = document.createElement("h3"); heading.textContent = "LAN session";
    session.append(heading, login, logout);
    document.querySelector(".preferences-body").append(session);
  });
})();
