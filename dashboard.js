/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
/* Dashboard UI. Commands go through the worker; rendered strings never become HTML. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let agents = [], events = [], selectedKey = "", loading = false, busy = false, inspectedKey = "";
  let schedule = null, connection = null, lastInspection = 0, inspectionPending = false;
  let approvalMessage = "", lastSettings = 0;
  let cardsFingerprint = "", eventsFingerprint = "";
  let broadcastRecipients = [], broadcastAttempted = false;
  const drafts = new Map();
  const panels = new Map();
  const priority = agent => !agent.online ? 5 : agent.error ? 0 : agent.logicPhase === "waiting_user" ? 1
    : ["sleeping", "waiting_external"].includes(agent.logicPhase) ? 4 : agent.running && !agent.paused ? 2 : 3;
  const orderedAgents = () => [...agents].sort((a, b) => priority(a) - priority(b) || a.title.localeCompare(b.title) || a.tabId - b.tabId);
  const key = agent => `${agent.tabId}:${agent.instanceId || "offline"}:${agent.url}`;
  const selected = () => agents.find(agent => key(agent) === selectedKey);
  const target = agent => ({ tabId: agent.tabId, url: agent.url, instanceId: agent.instanceId, revision: agent.revision });
  const time = at => at ? new Date(at).toLocaleString() : "—";
  const notice = (message, error = false) => { $("notice").textContent = message; $("notice").classList.toggle("error", error); };
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  async function request(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...data });
    if (!response || response.ok === false) throw new Error(response?.error || "The extension did not respond.");
    return response;
  }
  function phase(agent) {
    if (!agent.online) return "Offline";
    if (agent.error) return "Needs attention";
    if (agent.paused) return "Paused";
    if (agent.logicPhase === "waiting_user") return "Needs input";
    if (agent.logicPhase === "sleeping") return "Sleeping";
    if (agent.logicPhase === "waiting_external") return "Waiting on operation";
    if (agent.mode === "setup") return "Server setup";
    if (agent.running) return agent.mode === "loop" ? "Loop running" : "Logic running";
    return "Stopped / idle";
  }
  function badge(agent) { return !agent.online ? "offline" : agent.error ? "error" : agent.logicPhase === "waiting_user" ? "waiting" : ""; }
  function matches(agent) {
    const query = $("search").value.toLowerCase();
    if (!`${agent.title} ${agent.chatTitle || ""} ${agent.url}`.toLowerCase().includes(query)) return false;
    switch ($("filter").value) {
      case "running": return agent.online && agent.running && !agent.paused && !["sleeping", "waiting_user"].includes(agent.logicPhase);
      case "waiting": return agent.online && agent.logicPhase === "waiting_user";
      case "sleeping": return agent.online && agent.logicPhase === "sleeping";
      case "paused": return agent.online && agent.paused;
      case "errors": return agent.online && agent.error;
      case "offline": return !agent.online;
      default: return true;
    }
  }
  function renderAgents() {
    $("broadcast-open").disabled = busy || (!broadcastAttempted && !agents.some(a => a.online));
    $("total").textContent = agents.filter(a => a.online).length;
    $("working").textContent = agents.filter(a => a.online && a.running && !a.paused && !a.error && !["sleeping", "waiting_user", "waiting_external"].includes(a.logicPhase)).length;
    $("waiting").textContent = agents.filter(a => a.online && a.logicPhase === "waiting_user").length;
    $("errors").textContent = agents.filter(a => a.online && a.error).length;
    $("agent-list-count").textContent = agents.filter(matches).length;
    for (const button of document.querySelectorAll("[data-filter]")) button.setAttribute("aria-pressed", String(button.dataset.filter === $("filter").value));
    const fingerprint = JSON.stringify([selectedKey, busy, $("search").value, $("filter").value,
      agents.map(a => [key(a), a.title, a.chatTitle, a.detail, a.online, a.mode, a.logicPhase, a.error, a.paused, a.running, a.count, a.limit, a.summary])]);
    if (cardsFingerprint === fingerprint) return;
    cardsFingerprint = fingerprint;
    const focusedKey = document.activeElement?.closest(".agent-select")?.dataset.agentKey;
    const nodes = orderedAgents().filter(matches).map(agent => {
      const card = el("article", undefined, `agent-card${key(agent) === selectedKey ? " selected" : ""}`);
      const choose = el("button", undefined, "agent-select");
      choose.dataset.agentKey = key(agent);
      choose.setAttribute("aria-pressed", String(key(agent) === selectedKey));
      const heading = el("div", undefined, "agent-name-row");
      const dot = el("span", undefined, `status-dot ${badge(agent)}`); dot.setAttribute("aria-hidden", "true");
      const title = el("strong", agent.title); title.title = agent.title;
      heading.append(dot, title);
      const description = el("p", agent.chatTitle && agent.chatTitle !== agent.title ? agent.chatTitle : agent.detail || "Ready.");
      description.title = agent.detail || description.textContent;
      choose.append(heading, description);
      if (agent.summary?.last?.text) choose.append(el("p", agent.summary.last.text, "summary-preview"));
      const bottom = el("div", undefined, "card-bottom");
      bottom.append(el("span", phase(agent), badge(agent)), el("span", agent.online ? `${agent.count || 0} / ${agent.limit || 0}` : "Unavailable"));
      choose.append(bottom); choose.addEventListener("click", () => selectAgent(agent)); card.append(choose);
      return card;
    });
    $("agents").replaceChildren(...(nodes.length ? nodes : [el("p", "No agents match this view.", "muted")]));
    if (focusedKey) [...document.querySelectorAll(".agent-select")].find(button => button.dataset.agentKey === focusedKey)?.focus({ preventScroll: true });
  }
  function showPanel(name, focus = false) {
    panels.set(selectedKey, name);
    for (const button of document.querySelectorAll("[role=tab]")) {
      const active = button.dataset.panel === name;
      button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
      $(button.getAttribute("aria-controls")).hidden = !active;
      if (active && focus) button.focus();
    }
    document.querySelector(".panel-scroll").scrollTop = 0;
  }
  function showWorkspace() {
    document.body.dataset.mobileView = "detail";
    if (matchMedia("(max-width: 720px)").matches) { $("agent-title").tabIndex = -1; $("agent-title").focus({ preventScroll: true }); }
  }
  function scheduleFields() {
    const daily = $("hb-kind").value === "daily";
    $("hb-interval-field").hidden = daily;
    $("hb-daily-fields").hidden = !daily;
  }
  function formState() {
    if (!drafts.has(selectedKey)) drafts.set(selectedKey, {});
    return drafts.get(selectedKey);
  }
  function selectAgent(agent, { navigate = true } = {}) {
    agent = agents.find(current => key(current) === key(agent)) || agent;
    if (selectedKey === key(agent)) { if (navigate) showWorkspace(); return; }
    selectedKey = key(agent); inspectedKey = ""; schedule = connection = null; lastInspection = 0;
    $("hb-status").textContent = $("server-status").textContent = agent.online ? "Loading…" : "This agent is offline.";
    $("uncertain").hidden = true;
    const state = formState();
    $("message").value = state["run-form"]?.values.message ?? agent.message ?? "Continue";
    $("limit").value = state["run-form"]?.values.limit ?? agent.limit ?? 5;
    $("rollover").checked = state["run-form"]?.values.rollover ?? agent.rolloverEnabled ?? true;
    $("queued").value = state["queue-form"]?.values.queued ?? agent.queuedPrompt ?? "";
    $("reply").value = state["reply-form"]?.values.reply ?? "";
    showPanel(panels.get(selectedKey) || (agent.logicPhase === "waiting_user" ? "reply" : "queue"));
    renderAgents(); renderDetail(); renderEvents(); void inspect();
    if (navigate) showWorkspace();
  }
  function renderDetail() {
    const agent = selected();
    $("empty").hidden = Boolean(agent); $("detail").hidden = !agent;
    if (!agent) return;
    $("agent-title").textContent = agent.title;
    $("agent-title").title = agent.title;
    $("chat-title").textContent = agent.chatTitle && agent.chatTitle !== agent.title ? agent.chatTitle : "ChatGPT conversation";
    $("chat-title").title = $("chat-title").textContent;
    $("agent-url").textContent = agent.url;
    $("agent-phase").textContent = phase(agent); $("agent-phase").className = `pill ${badge(agent)}`;
    $("agent-count").textContent = `${agent.count || 0} / ${agent.limit || 0} messages`;
    $("agent-detail").textContent = agent.detail || "Ready.";
    const summary = agent.summary, last = summary?.last;
    $("agent-summary").textContent = last?.text || "No summary yet. Enable summaries in Settings.";
    $("agent-summary-meta").textContent = last ? `Completed ${time(last.completedAt)} · ${last.model}${last.flag ? ` · ${last.flag.toUpperCase()}` : ""}` : "";
    $("agent-summary-status").textContent = summary?.status === "pending"
      ? "Summarizing latest output…" + (last ? " Previous summary shown above." : "")
      : summary?.status === "error" ? summary.error + (last ? " Previous summary shown above." : "") : "";
    $("agent-timing").textContent = agent.waitUntil ? `Status check at ${time(agent.waitUntil)} · ${Math.max(0, Math.ceil((agent.waitUntil - Date.now()) / 1000))}s remaining`
      : agent.heartbeat?.nextRunAt ? `Next heartbeat: ${time(agent.heartbeat.nextRunAt)}` : agent.lastSeen ? `Updated ${new Date(agent.lastSeen).toLocaleTimeString()}` : "";
    $("agent-guard").textContent = !agent.online ? "Controls are disabled until this page connects."
      : agent.hasDraft ? "A manual draft is present. It will be preserved."
      : agent.generating ? "ChatGPT is responding. Immediate sends are unavailable; you can queue instructions." : "";
    $("queue-state").textContent = agent.queuedPrompt ? "1 prompt queued for the next automatic send." : agent.queueNote || "No instructions queued. Your next prompt goes here.";
    $("queue-pending").textContent = agent.queuedPrompt || "";
    $("queue-preview").hidden = !agent.queuedPrompt;
    $("queue-badge").hidden = !agent.queuedPrompt;
    $("reply-badge").hidden = !(agent.online && agent.logicPhase === "waiting_user");
    $("review-input").hidden = $("reply-badge").hidden;
    $("input-brief").textContent = agent.logicPhase === "waiting_user" ? agent.userInputBrief || "The agent is waiting. Review its request in ChatGPT before replying." : "No active input request.";
    for (const button of document.querySelectorAll("#detail [data-action]")) {
      const action = button.dataset.action;
      let allowed = Boolean(agent.online);
      if (action.startsWith("heartbeat_")) allowed &&= Boolean(Heartbeat.canonicalUrl(agent.url)) && inspectedKey === selectedKey
        && (action === "heartbeat_save" || Boolean(schedule));
      else if (action.startsWith("server_")) allowed &&= /\/g\/g-p-/.test(agent.url) && Boolean(Heartbeat.canonicalUrl(agent.url)) && inspectedKey === selectedKey
        && (["server_setup", "server_recover"].includes(action) || Boolean(connection));
      else allowed &&= Boolean(agent.capabilities?.[action]);
      button.disabled = busy || !allowed;
      button.title = !allowed ? "Unavailable in the agent's current state. Review its status above." : "";
      if (button.closest(".run-actions")) button.hidden = action === "resume" ? !agent.paused
        : action === "pause" ? Boolean(agent.paused) : action === "next_cycle" ? !agent.capabilities?.next_cycle : false;
    }
    $("open-chat").disabled = !agent.online;
    const state = formState();
    if (!state["queue-form"] && document.activeElement !== $("queued")) $("queued").value = agent.queuedPrompt || "";
    $("queued-count").textContent = `${$("queued").value.length.toLocaleString()} / 8,000`;
  }
  async function inspect() {
    const agent = selected();
    if (!agent?.online || inspectionPending || busy) return;
    const requestedKey = selectedKey;
    inspectionPending = true;
    try {
      const result = await request("DB_INSPECT", { target: target(agent) });
      if (selectedKey !== requestedKey) return;
      schedule = result.schedule; connection = result.connection; inspectedKey = requestedKey; lastInspection = Date.now();
      $("hb-status").textContent = schedule ? `${schedule.phase}: ${schedule.detail} Next: ${time(schedule.nextRunAt)}` : "No heartbeat configured.";
      const saved = formState()["heartbeat-form"]?.values;
      const config = saved || { "hb-kind": schedule?.kind || "interval", "hb-interval": schedule?.intervalMinutes || 60,
        "hb-times": schedule?.times?.join(", ") || "09:00, 15:00", "hb-timezone": schedule?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        "hb-prompt": schedule?.prompt || result.defaultPrompt, "hb-limit": schedule?.limit || agent.limit || 5, days: schedule?.days?.length ? schedule.days : [1, 2, 3, 4, 5] };
      for (const id of ["hb-kind", "hb-interval", "hb-times", "hb-timezone", "hb-prompt", "hb-limit"]) $(id).value = config[id];
      for (const input of document.querySelectorAll("#hb-days input")) input.checked = config.days.includes(Number(input.value));
      scheduleFields();
      $("server-status").textContent = connection ? `${connection.phase}: ${connection.detail} ${connection.endpoint || ""} Pending events: ${connection.pending}.` : "No server connection configured.";
      const previousEvent = $("server-event").value;
      $("server-event").replaceChildren(...(connection?.uncertain || []).map(id => { const option = el("option", id); option.value = id; return option; }));
      if (connection?.uncertain.includes(previousEvent)) $("server-event").value = previousEvent;
      $("uncertain").hidden = !connection?.uncertain.length;
      renderDetail();
    } catch (error) {
      if (selectedKey === requestedKey) { $("hb-status").textContent = error.message; $("server-status").textContent = error.message; }
    } finally { inspectionPending = false; }
  }
  function renderEvents() {
    const alerts = events.filter(event => !event.dismissed && ["input", "error"].includes(event.kind)).length;
    $("activity-count").textContent = alerts; $("activity-count").hidden = !alerts;
    $("activity-toggle").setAttribute("aria-label", `Activity${alerts ? `, ${alerts} undismissed alerts` : ""}`);
    const visible = events.filter(event => (!event.dismissed || $("show-dismissed").checked)
      && ($("event-scope").value !== "selected" || event.agentKey === selectedKey)
      && ($("event-kind").value !== "attention" || ["input", "error"].includes(event.kind))).slice(-75).reverse();
    const fingerprint = JSON.stringify([visible, agents.map(key), selectedKey, $("event-scope").value, $("event-kind").value]);
    if (eventsFingerprint === fingerprint) return;
    eventsFingerprint = fingerprint;
    $("events").replaceChildren(...(visible.length ? visible.map(event => {
      const item = el("article", undefined, `event ${event.kind}${event.dismissed ? " dismissed" : ""}`);
      item.append(el("strong", event.title), el("p", event.detail), el("time", time(event.at)));
      const actions = el("div", undefined, "actions");
      const agent = agents.find(a => key(a) === event.agentKey);
      if (agent) { const view = el("button", "View agent", "text-button"); view.addEventListener("click", () => {
        $("activity-drawer").close(); selectAgent(agent);
        if (event.kind === "input") showPanel("reply");
        $("agent-title").tabIndex = -1; $("agent-title").focus({ preventScroll: true });
      }); actions.append(view); }
      if (!event.dismissed) {
        const dismiss = el("button", "Dismiss", "text-button");
        dismiss.addEventListener("click", async () => { try { await request("DB_DISMISS", { eventId: event.id }); await refresh(); } catch (error) { notice(error.message, true); } });
        actions.append(dismiss);
      }
      item.append(actions); return item;
    }) : [el("p", "No activity matches this view.", "muted")]));
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const result = await request("DB_LIST");
      agents = result.agents; events = result.events;
      $("connection").textContent = "● Live";
      $("version").textContent = `v${result.version} · This profile`;
      $("updated").textContent = new Date().toLocaleTimeString();
      if (!selectedKey && agents.length) selectAgent(orderedAgents()[0], { navigate: false });
      if (!selected()) document.body.dataset.mobileView = "agents";
      renderAgents(); renderDetail(); renderEvents();
      if (selected() && Date.now() - lastInspection > 10000) void inspect();
      if (Date.now() - lastSettings > 10000) void loadSettings();
    } catch (error) {
      agents = agents.map(agent => ({ ...agent, online: false })); renderAgents(); renderDetail();
      $("connection").textContent = "Disconnected"; notice(error.message, true);
    } finally { loading = false; }
  }
  async function act(agent, action, payload = {}, expected = null) {
    agent = agents.find(current => key(current) === key(agent)) || agent;
    if (busy || !agent?.online) return;
    busy = true; renderAgents(); renderDetail(); notice("Applying command…");
    try {
      const result = await request("DB_COMMAND", { target: expected || target(agent), action, payload, commandId: crypto.randomUUID() });
      notice(result.detail || "Command accepted. Live status will update.");
      return true;
    } catch (error) { notice(error.message, true); return false; }
    finally { busy = false; lastInspection = 0; await refresh(); renderDetail(); }
  }
  function prepareBroadcast(clear = false) {
    broadcastAttempted = false;
    broadcastRecipients = agents.filter(a => a.online).map(a => ({ ...target(a), title: a.title, chatTitle: a.chatTitle }));
    if (clear) $("broadcast-text").value = "";
    $("broadcast-text").readOnly = false;
    $("broadcast-submit").disabled = !broadcastRecipients.length;
    $("broadcast-new").hidden = true;
    $("broadcast-status").textContent = "";
    $("broadcast-results").replaceChildren();
    $("broadcast-scope").textContent = `${broadcastRecipients.length} connected agents, including those hidden by filters. Offline agents are excluded. Unavailable queues and duplicate conversation tabs will be listed as skipped.`;
  }
  $("broadcast-open").addEventListener("click", () => {
    if (busy) return;
    if (!broadcastAttempted) prepareBroadcast();
    $("broadcast-dialog").showModal();
    $("broadcast-open").setAttribute("aria-expanded", "true");
    if (!broadcastAttempted) $("broadcast-text").focus();
  });
  $("broadcast-dialog").addEventListener("close", () => $("broadcast-open").setAttribute("aria-expanded", "false"));
  $("broadcast-new").addEventListener("click", () => { if (!busy) { prepareBroadcast(true); $("broadcast-text").focus(); } });
  $("broadcast-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || broadcastAttempted) return;
    const text = $("broadcast-text").value.trim();
    if (!text || text.length > 8000) { $("broadcast-status").textContent = "Enter a message of 1–8,000 characters."; return; }
    broadcastAttempted = true; busy = true;
    $("broadcast-submit").disabled = true; $("broadcast-text").readOnly = true;
    $("broadcast-status").textContent = "Checking agents and adding to their queues…";
    renderAgents(); renderDetail();
    try {
      // Keep the recipients the user reviewed, but refresh their revisions just
      // before dispatch. A replacement page or new conversation is not a target.
      const current = (await request("DB_LIST")).agents;
      const seen = new Set();
      const work = broadcastRecipients.map(recipient => {
        const agent = current.find(a => key(a) === key(recipient) && a.online);
        let reason = !agent ? "Disconnected or changed conversation." : !agent.capabilities?.queue_append ? "Queue unavailable in this agent's current state or version." : "";
        const identity = agent && Heartbeat.chatKey(agent.url);
        if (!reason && identity && seen.has(identity)) reason = "Duplicate conversation; included through another tab.";
        if (!reason && (agent.queuedPrompt ? agent.queuedPrompt.length + 2 : 0) + text.length > 8000) reason = "Combined queue exceeds 8,000 characters; existing instructions preserved.";
        if (!reason && identity) seen.add(identity);
        return {recipient, agent, reason, commandId: crypto.randomUUID()};
      });
      const rows = work.map(item => {
        const row = el("li");
        const label = el("strong", item.recipient.title + (item.recipient.chatTitle && item.recipient.chatTitle !== item.recipient.title ? ` · ${item.recipient.chatTitle}` : ""));
        const status = el("span", item.reason ? ` — Skipped: ${item.reason}` : " — Queuing…");
        row.append(label, status); $("broadcast-results").append(row);
        return status;
      });
      const outcomes = await Promise.all(work.map(async (item, index) => {
        if (item.reason) return "skipped";
        let result;
        try {
          result = await chrome.runtime.sendMessage({type:"DB_COMMAND", action:"queue_append", target:target(item.agent), payload:{text}, commandId:item.commandId});
        } catch { /* Delivery may have happened; never retry automatically. */ }
        const outcome = result?.ok === true ? "queued" : !result || result.uncertain ? "unconfirmed" : "failed";
        rows[index].textContent = outcome === "queued" ? " — Queued for the next automatic send."
          : outcome === "unconfirmed" ? " — Unconfirmed: inspect this agent's queue before retrying."
          : ` — Not queued: ${result.error || "The agent rejected the message."}`;
        return outcome;
      }));
      const count = type => outcomes.filter(value => value === type).length;
      const summary = `Queued: ${count("queued")}. Skipped: ${count("skipped")}. Not queued: ${count("failed")}. Unconfirmed: ${count("unconfirmed")}.`;
      $("broadcast-status").textContent = summary;
      notice(summary, outcomes.some(value => value !== "queued"));
    } catch (error) {
      $("broadcast-status").textContent = `Could not check recipients. No messages were queued. ${error.message}`;
    } finally {
      busy = false; $("broadcast-new").hidden = false;
      await refresh(); renderAgents(); renderDetail();
    }
  });
  for (const form of document.querySelectorAll("#detail form")) {
    form.addEventListener("submit", event => event.preventDefault());
    form.addEventListener("input", () => {
      const agent = selected(); if (!agent) return;
      const values = {};
      for (const field of form.querySelectorAll("input[id], textarea[id], select[id]")) values[field.id] = field.type === "checkbox" ? field.checked : field.value;
      if (form.id === "heartbeat-form") values.days = [...document.querySelectorAll("#hb-days input:checked")].map(input => Number(input.value));
      const existing = formState()[form.id];
      formState()[form.id] = { target: existing?.target || target(agent), values };
    });
  }
  for (const button of document.querySelectorAll("#detail [data-action]")) {
    button.type = "button";
    button.addEventListener("click", async () => {
      const agent = selected(); if (!agent) return;
      const action = button.dataset.action, form = action === "approve" ? null : button.closest("form");
      const draft = form && formState()[form.id];
      const expected = draft?.target || target(agent);
      let payload = {};
      try {
        if (["start_loop", "start_logic", "resume_logic"].includes(action)) payload = { message: $("message").value, limit: Number($("limit").value), rolloverEnabled: $("rollover").checked };
        if (action === "queue") payload.text = $("queued").value;
        if (action === "reply") payload.text = $("reply").value;
        if (action === "approve") payload.text = approvalMessage;
        if (action === "heartbeat_save") payload.configuration = Heartbeat.normalize({ kind: $("hb-kind").value, intervalMinutes: $("hb-interval").value,
          times: $("hb-times").value, days: [...document.querySelectorAll("#hb-days input:checked")].map(input => Number(input.value)), timeZone: $("hb-timezone").value,
          prompt: $("hb-prompt").value, limit: $("hb-limit").value, message: $("message").value, rolloverEnabled: $("rollover").checked });
        if (action === "server_resolve") payload = { eventId: $("server-event").value, resolution: button.dataset.resolution };
        if (["server_setup", "server_recover"].includes(action)) {
          if (!await chrome.permissions.request({ origins: ["http://localhost/*", "http://127.0.0.1/*"] })) throw new Error("Local server permission was declined.");
        }
        const actionKey = selectedKey;
        const done = await act(agent, action, payload, expected);
        if (done) {
          const saved = drafts.get(actionKey);
          if (form && saved) delete saved[form.id];
          if (action === "cancel_queue" && saved) delete saved["queue-form"];
          if (action === "reply" && selectedKey === actionKey) $("reply").value = "";
          renderDetail();
        } else if (draft) {
          // Preserve text but require a conscious second attempt after reviewing
          // refreshed status; never automatically retry a rejected command.
          draft.target = target(agents.find(a => key(a) === actionKey) || agent);
        }
      } catch (error) { notice(error.message, true); }
    });
  }
  $("open-chat").addEventListener("click", async () => {
    const agent = selected(); if (!agent?.online) return;
    try {
      const tab = await chrome.tabs.get(agent.tabId);
      if (tab.url.split(/[?#]/)[0] !== agent.url) throw new Error("The tab changed. Refresh the dashboard.");
      await chrome.tabs.update(agent.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (error) { notice(error.message, true); }
  });
  $("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("sound").addEventListener("change", async () => {
    try { await request("ALERT_SET_SETTINGS", { settings: { soundEnabled: $("sound").checked } }); notice("Sound preference saved."); }
    catch (error) { notice(error.message, true); }
  });
  $("test-sound").addEventListener("click", async () => {
    try { await request("ALERT_TEST_SOUND"); notice("Sound test requested on this computer."); }
    catch (error) { notice(error.message, true); }
  });
  async function loadSettings() {
    lastSettings = Date.now();
    try {
      const [alerts, ha] = await Promise.all([request("ALERT_GET_SETTINGS"), request("HA_GET_SETTINGS")]);
      $("sound").checked = alerts.soundEnabled;
      $("ha-status").textContent = `Phone notifications: ${ha.enabled ? ha.connection?.phase || "configured" : "disabled"}`;
      approvalMessage = ha.approvalMessage;
      $("approval-preview").textContent = `Approval sends: ${approvalMessage}`;
    } catch (error) { notice(error.message, true); }
  }
  $("refresh").addEventListener("click", () => { lastInspection = 0; lastSettings = 0; void refresh(); });
  for (const button of document.querySelectorAll("[role=tab]")) {
    button.addEventListener("click", () => showPanel(button.dataset.panel));
    button.addEventListener("keydown", event => {
      const tabs = [...document.querySelectorAll("[role=tab]")];
      const index = tabs.indexOf(button);
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); showPanel(tabs[next].dataset.panel, true); }
    });
  }
  $("review-input").addEventListener("click", () => showPanel("reply", true));
  $("back-to-agents").addEventListener("click", () => {
    document.body.dataset.mobileView = "agents";
    ([...document.querySelectorAll(".agent-select")].find(button => button.dataset.agentKey === selectedKey) || $("search")).focus();
  });
  for (const button of document.querySelectorAll("[data-filter]")) button.addEventListener("click", () => {
    $("filter").value = button.dataset.filter; renderAgents(); document.body.dataset.mobileView = "agents";
  });
  for (const [trigger, dialog] of [["activity-toggle", "activity-drawer"], ["preferences-toggle", "preferences-dialog"]]) {
    $(trigger).setAttribute("aria-expanded", "false");
    $(trigger).addEventListener("click", () => { $(dialog).showModal(); $(trigger).setAttribute("aria-expanded", "true"); });
    $(dialog).addEventListener("close", () => $(trigger).setAttribute("aria-expanded", "false"));
  }
  for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => $(button.dataset.close).close());
  $("queued").addEventListener("input", () => { $("queued-count").textContent = `${$("queued").value.length.toLocaleString()} / 8,000`; });
  $("hb-kind").addEventListener("change", scheduleFields);
  $("search").addEventListener("input", renderAgents); $("filter").addEventListener("change", renderAgents);
  $("show-dismissed").addEventListener("change", renderEvents);
  $("event-scope").addEventListener("change", renderEvents); $("event-kind").addEventListener("change", renderEvents);
  $("clear-history").addEventListener("click", async () => {
    try { await request("DB_CLEAR_HISTORY"); await refresh(); notice("Activity history cleared. Live agent statuses remain available."); }
    catch (error) { notice(error.message, true); }
  });
  const poll = setInterval(refresh, 2000);
  window.addEventListener("unload", () => clearInterval(poll));
  void refresh();
})();
