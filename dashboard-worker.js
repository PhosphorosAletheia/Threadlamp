/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
/* Transport-independent dashboard routing. Only trusted extension pages can control agents. */
(() => {
  "use strict";
  const KEY = "logicDashboardHistory";
  const RECEIPTS = "logicDashboardCommands";
  const locks = new Set();
  let historyQueue = Promise.resolve();
  const pageActions = new Set(["start_loop", "stop", "start_logic", "resume_logic", "pause", "resume",
    "next_cycle", "queue", "queue_append", "remove_queue", "cancel_queue", "continue", "status", "reply", "approve"]);
  const limit = (value, size) => String(value || "").slice(0, size);
  const projectName = value => {
    const name = limit(value, 200).replace(/\s+/g, " ").trim();
    return /^skip to (?:main )?content$/i.test(name) ? "" : name;
  };
  const cleanUrl = value => {
    try { const url = new URL(value); return isChatGptUrl(url.href) && url.protocol === "https:" ? url.origin + url.pathname : ""; }
    catch { return ""; }
  };
  function labels(data, agent) {
    const projectId = ServerLink.projectId(agent.url);
    const chatTitle = limit(agent.chatTitle || agent.title, 200) || "Untitled chat";
    let projectTitle = projectName(data.projectTitles?.[projectId]) || projectName(agent.projectTitle);
    if (projectId && !projectTitle) {
      // Older/unavailable content scripts can still supply a readable project slug.
      const segment = new URL(agent.url).pathname.split("/")[2];
      const slug = segment.slice(projectId.length).replace(/^-/, "");
      try { projectTitle = decodeURIComponent(slug).replace(/-/g, " ").trim(); } catch { /* Fall back below. */ }
      projectTitle = limit(projectTitle, 200) || "Project (name unavailable)";
    }
    return { title: projectTitle || chatTitle, chatTitle, projectTitle };
  }
  async function send(tabId, message, timeout = 5000) {
    let timer;
    try {
      return await Promise.race([chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The chat did not respond. Refresh dashboard status before trying again.")), timeout); })]);
    } finally { clearTimeout(timer); }
  }
  async function verifyTarget(target) {
    if (!Number.isInteger(target?.tabId) || !target.instanceId || !target.revision || !cleanUrl(target.url)) throw new Error("Select a connected agent first.");
    const tab = await chrome.tabs.get(target.tabId);
    if (cleanUrl(tab.url) !== target.url) throw new Error("This tab changed conversations. Refresh dashboard status.");
    const snapshot = await send(tab.id, { type: "DB_SNAPSHOT" });
    if (!snapshot || snapshot.instanceId !== target.instanceId || snapshot.url !== target.url
      || snapshot.revision !== target.revision) throw new Error("The agent changed since these controls were loaded. Refresh and review its status.");
    return snapshot;
  }
  function history(work) {
    const result = historyQueue.then(async () => {
      await initializationPromise;
      const data = (await chrome.storage.local.get(KEY))[KEY] || { agents: {}, events: [] };
      const before = JSON.stringify(data);
      // Repair names saved by older content scripts, including offline history.
      for (const [id, title] of Object.entries(data.projectTitles || {})) {
        if (!projectName(title)) delete data.projectTitles[id];
      }
      for (const entry of [...Object.values(data.agents || {}), ...(data.events || [])]) {
        if (entry.projectTitle && !projectName(entry.projectTitle)) {
          entry.projectTitle = "";
          if (!projectName(entry.title)) entry.title = entry.chatTitle || "";
        }
      }
      const value = await work(data);
      if (JSON.stringify(data) !== before) await chrome.storage.local.set({ [KEY]: data });
      return value;
    });
    historyQueue = result.catch(() => {});
    return result;
  }
  async function record(snapshot, tab) {
    return history(data => {
      const key = `${tab.id}:${snapshot.instanceId}:${snapshot.url}`;
      const previous = data.agents[key];
      const projectId = ServerLink.projectId(snapshot.url);
      const projectTitle = projectName(snapshot.projectTitle);
      if (projectId && projectTitle && data.projectTitles?.[projectId] !== projectTitle) {
        data.projectTitles = Object.fromEntries([
          ...Object.entries(data.projectTitles || {}).filter(([id]) => id !== projectId),
          [projectId, projectTitle]
        ].slice(-100));
      }
      const agent = { key, tabId: tab.id, instanceId: snapshot.instanceId, url: snapshot.url,
        ...labels(data, { url: snapshot.url, chatTitle: tab.title, projectTitle }), lastSeen: Date.now(),
        mode: limit(snapshot.mode, 40), logicPhase: limit(snapshot.logicPhase, 50),
        running: Boolean(snapshot.running), paused: Boolean(snapshot.paused), error: Boolean(snapshot.error),
        detail: limit(snapshot.detail, 1000), userInputBrief: limit(snapshot.userInputBrief, 240) };
      const changed = !previous || ["title", "chatTitle", "detail", "logicPhase", "mode", "running", "error", "paused", "userInputBrief"].some(field => previous[field] !== agent[field]);
      if (!changed && agent.lastSeen - previous.lastSeen < 30000) return;
      data.agents[key] = agent;
      if (changed) {
        data.events.push({ id: crypto.randomUUID(), at: agent.lastSeen, agentKey: key, tabId: tab.id, url: agent.url,
          title: agent.title, projectTitle: agent.projectTitle,
          kind: agent.error ? "error" : agent.logicPhase === "waiting_user" ? "input" : "status",
          detail: agent.detail, dismissed: false });
      }
      data.events = data.events.slice(-300);
      data.agents = Object.fromEntries(Object.entries(data.agents).sort((a, b) => b[1].lastSeen - a[1].lastSeen).slice(0, 100));
    });
  }
  async function notification(request, tab) {
    return history(data => {
      const agent = Object.values(data.agents).filter(a => a.tabId === tab.id && a.url === cleanUrl(tab.url))
        .sort((a, b) => b.lastSeen - a.lastSeen)[0];
      const detail = limit(request.brief || request.detail || "The agent needs your input. Review its request in ChatGPT.", 1000);
      const last = data.events.at(-1);
      if (last?.tabId === tab.id && last.detail === detail && Date.now() - last.at < 5000) return;
      data.events.push({ id: crypto.randomUUID(), at: Date.now(), agentKey: agent?.key || "", tabId: tab.id,
        url: cleanUrl(tab.url), projectTitle: agent?.projectTitle,
        title: labels(data, { url: cleanUrl(tab.url), projectTitle: agent?.projectTitle,
          chatTitle: tab.title || request.chatTitle || request.previousTitle }).title,
        kind: request.type === "HA_NOTIFY_USER_INPUT" ? "input" : "error", detail, dismissed: false });
      data.events = data.events.slice(-300);
    });
  }
  async function list() {
    await initializationPromise;
    const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
    const agents = await Promise.all(tabs.map(async tab => {
      try {
        const snapshot = await send(tab.id, { type: "DB_SNAPSHOT" });
        if (!snapshot?.instanceId || snapshot.url !== cleanUrl(tab.url)) throw new Error("This tab needs the current extension content script.");
        await record(snapshot, tab);
        return { ...snapshot, tabId: tab.id, chatTitle: limit(tab.title, 200), online: true, lastSeen: Date.now() };
      } catch {
        return { tabId: tab.id, url: cleanUrl(tab.url), chatTitle: limit(tab.title, 200), online: false,
          detail: "Unavailable. This tab may be loading, discarded, or using an older extension. Refresh it only when safe." };
      }
    }));
    const data = await history(data => ({ agents: data.agents, events: data.events, projectTitles: data.projectTitles }));
    const summaries = globalThis.SummaryWorker ? await SummaryWorker.list() : {};
    const current = new Set(agents.map(a => `${a.tabId}:${a.instanceId}:${a.url}`));
    const offline = Object.values(data.agents).filter(a => !current.has(a.key)
      && !agents.some(live => live.tabId === a.tabId && live.url === a.url));
    return { ok: true, agents: [...agents, ...offline.map(a => ({ ...a, online: false, detail: "Previously seen agent. Its page is no longer connected." }))]
      .map(agent => ({ ...agent, ...labels(data, agent), summary: summaries[agent.url] || null })),
      events: data.events.map(event => {
        const agent = data.agents[event.agentKey];
        return { ...event, title: labels(data, { ...event, url: event.url || agent?.url,
          projectTitle: event.projectTitle || agent?.projectTitle }).title };
      }), version: chrome.runtime.getManifest?.().version || "1.9.10" };
  }
  async function inspect(target, sender) {
    await verifyTarget(target);
    const schedule = Heartbeat.canonicalUrl(target.url)
      ? await HeartbeatScheduler.dashboard({ type: "HB_GET", tabId: target.tabId, target }, sender) : null;
    const connection = ServerLink.projectId(target.url) && Heartbeat.canonicalUrl(target.url)
      ? await ServerLinkWorker.dashboard({ type: "SL_GET", tabId: target.tabId, target }, sender) : null;
    return { ok: true, schedule: schedule?.schedule || null, connection: connection?.connection || null,
      defaultPrompt: Heartbeat.DEFAULT_PROMPT };
  }
  async function command(request, sender) {
    const { target, action, commandId } = request;
    if (typeof commandId !== "string" || !/^[\w-]{8,100}$/.test(commandId)) throw new Error("Invalid command identity.");
    const known = (await chrome.storage.session.get(RECEIPTS))[RECEIPTS] || {};
    if (known[commandId]) return known[commandId];
    if (locks.has(target?.tabId)) throw new Error("Another dashboard command is in progress for this agent.");
    locks.add(target?.tabId);
    const saveReceipt = result => history(async () => {
      const receipts = (await chrome.storage.session.get(RECEIPTS))[RECEIPTS] || {};
      receipts[commandId] = result;
      await chrome.storage.session.set({ [RECEIPTS]: Object.fromEntries(Object.entries(receipts).slice(-200)) });
    });
    let attempted = false;
    try {
      await verifyTarget(target);
      await saveReceipt({ ok: false, uncertain: true, error: "Command may already have been attempted. Inspect the agent before repeating it." });
      const payload = request.payload || {};
      let result;
      if (action === "approve" && payload.text !== publicSettings().approvalMessage) throw new Error("The configured approval message changed. Refresh the dashboard and review it before approving.");
      attempted = true;
      if (pageActions.has(action)) {
        result = await send(target.tabId, { type: "DB_EXECUTE", target, action,
          payload: action === "approve" ? { text: publicSettings().approvalMessage } : payload, commandId }, 25000);
      } else if (["heartbeat_save", "heartbeat_run", "heartbeat_pause", "heartbeat_resume", "heartbeat_disable"].includes(action)) {
        result = await HeartbeatScheduler.dashboard({ type: action === "heartbeat_save" ? "HB_SAVE" : "HB_CONTROL",
          tabId: target.tabId, target, action: action.slice(10), configuration: payload.configuration }, sender);
      } else if (["server_setup", "server_recover", "server_assign", "server_enable", "server_disable", "server_resolve"].includes(action)) {
        result = await ServerLinkWorker.dashboard({ type: action === "server_setup" ? "SL_SETUP" : action === "server_recover" ? "SL_RECOVER" : "SL_CONTROL",
          tabId: target.tabId, target, action: action.slice(7), eventId: payload.eventId, resolution: payload.resolution }, sender);
      } else throw new Error("Unsupported dashboard action.");
      const response = result?.ok === false ? result : { ok: true, ...result };
      await saveReceipt(response);
      return response;
    } catch (error) {
      const response = { ok: false, uncertain: attempted, error: error.message };
      await saveReceipt(response);
      return response;
    } finally { locks.delete(target?.tabId); }
  }
  async function handle(request, sender) {
    if (request.type === "DB_RECORD") {
      if (!(await isTrustedChatSender(sender)) || sender.frameId !== 0 || !request.snapshot?.instanceId
        || cleanUrl(sender.tab.url) !== request.snapshot.url) throw new Error("Untrusted agent status.");
      await record(request.snapshot, sender.tab);
      return { ok: true };
    }
    if (!isTrustedExtensionPage(sender)) throw new Error("Only an extension page can access the dashboard.");
    if (request.type === "DB_LIST") return list();
    if (request.type === "DB_INSPECT") return inspect(request.target, sender);
    if (request.type === "DB_COMMAND") return command(request, sender);
    if (request.type === "DB_DISMISS") return history(data => {
      const event = data.events.find(e => e.id === request.eventId);
      if (event) event.dismissed = true;
      return { ok: true };
    });
    if (request.type === "DB_CLEAR_HISTORY") return history(data => {
      data.events = []; data.agents = {}; data.projectTitles = {}; return { ok: true };
    });
    throw new Error("Unknown dashboard request.");
  }
  async function remote(request) {
    if (!LanProtocol.allowed(request)) throw new Error("This operation is unavailable through the LAN dashboard.");
    await initializationPromise;
    // Only the paired bridge calls this internal capability. Content-script and
    // extension message listeners retain their original sender checks.
    const sender = {id:chrome.runtime.id, url:chrome.runtime.getURL("dashboard.html")};
    if (request.type.startsWith("DB_")) return handle(request, sender);
    if (request.type === "HA_GET_SETTINGS") {
      const settings = publicSettings();
      return {enabled:settings.enabled, approvalMessage:settings.approvalMessage, connection:{phase:settings.connection?.phase}};
    }
    if (request.type === "ALERT_GET_SETTINGS") return {...alertSettings};
    if (request.type === "ALERT_SET_SETTINGS") return saveAlertSettings({soundEnabled:request.settings?.soundEnabled});
    if (request.type === "ALERT_TEST_SOUND") return playWorkstationAlert(true);
    if (request.type === "LAN_LOOPBACK_PERMISSION") return {ok:true, granted:await chrome.permissions.contains({origins:["http://localhost/*", "http://127.0.0.1/*"]})};
    if (request.type === "LAN_OPEN_OPTIONS") { await chrome.runtime.openOptionsPage(); return {ok:true}; }
    if (request.type === "LAN_OPEN_CHAT") {
      await verifyTarget(request.target);
      const tab = await chrome.tabs.update(request.target.tabId, {active:true});
      await chrome.windows.update(tab.windowId, {focused:true});
      return {ok:true};
    }
    throw new Error("Unsupported LAN dashboard operation.");
  }
  globalThis.DashboardWorker = { verifyTarget, notification, remote };
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (!String(request?.type || "").startsWith("DB_")) return false;
    handle(request, sender).then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  });
})();
