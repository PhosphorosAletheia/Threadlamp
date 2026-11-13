/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { fixture } = require("./delivery-timeout.test.js");
const { harness, sourceUrl, popup } = require("./heartbeat.test.js");
const { visibleElement } = require("./rollover.test.js");
const target = (snapshot, tabId = 17) => ({ tabId, url: snapshot.url, instanceId: snapshot.instanceId, revision: snapshot.revision });
const request = (f, action, payload = {}, commandId = "command-1") => ({ action, payload, commandId, target: target(f.api.dashboardSnapshot()) });
function page() { const f = fixture(); f.hide(); f.window.location = new URL(sourceUrl); return f; }

async function projectTitleTests() {
  const f = page();
  const projectUrl = sourceUrl.replace(/\/c\/source$/, "/project");
  const link = (title, href = projectUrl) => visibleElement(title, { href });
  f.window.location = new URL(projectUrl);
  f.setSelector("a[href]", [link("Skip to content", "#main")]);
  assert.equal(f.api.dashboardSnapshot().projectTitle, "", "a project-home skip link is not a project name");
  f.setSelector("a[href]", [link("Skip to content", "#main"), link("Example Project")]);
  assert.equal(f.api.dashboardSnapshot().projectTitle, "Example Project", "skip links cannot obscure a genuine project name");
  f.setSelector("a[href]", [link("Skip to content", `${projectUrl}#main`), link("", ""), link("Example Project")]);
  assert.equal(f.api.dashboardSnapshot().projectTitle, "Example Project", "absolute fragment links are also excluded");
  f.window.location = new URL(sourceUrl);
  const transcriptLink = link("Untrusted transcript title");
  transcriptLink.closest = () => ({});
  const otherProject = projectUrl.replace("0123456789abcdef0123456789abcdef", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  f.setSelector("a[href]", [link("Job Search"), link("Job Search"), transcriptLink,
    link("Chat title", sourceUrl), link("Other Project", otherProject),
    link("Foreign project", projectUrl.replace("chatgpt.com", "example.com"))]);
  const initial = f.api.dashboardSnapshot();
  assert.equal(initial.projectTitle, "Job Search");
  f.document.title = "A renamed conversation";
  assert.equal(f.api.dashboardSnapshot().projectTitle, "Job Search");
  assert.equal(f.api.dashboardSnapshot().revision, initial.revision, "display names do not change command identity");
  const published = [];
  f.setRequestHandler(async message => { published.push(message); return { ok: true }; });
  f.api.publishDashboardStatus();
  assert.equal(published.find(m => m.type === "DB_RECORD").snapshot.projectTitle, "Job Search");
  f.setSelector("a[href]", [link("Job Search"), link("Conflicting label")]);
  assert.equal(f.api.dashboardSnapshot().projectTitle, "", "conflicting navigation labels are not guessed");
  f.window.location = new URL("https://chatgpt.com/c/ordinary-chat");
  f.setSelector("a[href]", [link("Job Search")]);
  assert.equal(f.api.dashboardSnapshot().projectTitle, "", "a sidebar project is not the current chat's project");
  f.window.location = new URL("https://chatgpt.com/");
  f.setSelector("#prompt-textarea", [visibleElement("", { "aria-label": "New chat in Job Search" })]);
  f.setSelector("button[aria-label^='Change project:']", [visibleElement("", { "aria-label": "Change project: Job Search" })]);
  assert.equal(f.api.dashboardSnapshot().projectTitle, "Job Search");

  const h = await harness();
  const snapshots = new Map([...h.tabs].map(([id, tab]) => [id, { instanceId: `page-${id}`, revision: "1", url: tab.url,
    projectTitle: id === 17 ? "Job Search" : "", detail: "Working" }]));
  h.setPageHandler(async (id, message) => {
    assert.equal(message.type, "DB_SNAPSHOT");
    return snapshots.get(id);
  });
  let list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.agents.find(a => a.tabId === 17).title, "Job Search");
  assert.equal(list.agents.find(a => a.tabId === 17).chatTitle, "Job research");
  assert.equal(list.agents.find(a => a.tabId === 99).title, "Another agent");
  assert.equal(list.events.find(e => e.tabId === 17).title, "Job Search");
  const otherChatUrl = sourceUrl.replace("/c/source", "/c/second-chat");
  h.tabs.set(42, { id: 42, url: otherChatUrl, title: "Second conversation" });
  snapshots.set(42, { instanceId: "page-42", revision: "1", url: otherChatUrl, detail: "Working" });
  list = await h.dispatch({ type: "DB_LIST" });
  const projectAgents = list.agents.filter(a => a.title === "Job Search");
  assert.equal(projectAgents.length, 2, "chats in the same project remain separate agents");
  assert.notEqual(projectAgents[0].instanceId, projectAgents[1].instanceId);
  snapshots.get(17).projectTitle = "";
  list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.agents.find(a => a.tabId === 17).title, "Job Search", "hidden sidebar uses retained project name");
  await h.dispatch({ type: "HA_NOTIFY_USER_INPUT", brief: "Choose a direction." }, { id: "test-extension", frameId: 0, tab: h.tabs.get(17) });
  list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.events.find(e => e.detail === "Choose a direction.").title, "Job Search");
  snapshots.get(17).projectTitle = "Career Planning";
  list = await h.dispatch({ type: "DB_LIST" });
  assert.ok(list.events.filter(e => e.tabId === 17).every(e => e.title === "Career Planning"), "history follows the project's latest known name");
  assert.equal(list.agents.find(a => a.tabId === 42).title, "Career Planning");
  snapshots.delete(17);
  list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.agents.find(a => a.tabId === 17).title, "Career Planning", "unavailable tabs retain project name");
  h.tabs.delete(17);
  list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.agents.find(a => a.tabId === 17).title, "Career Planning", "closed agents retain project name");
  // Existing 1.9.0 history did not carry project metadata on its events.
  h.local.values.logicDashboardHistory.events.push({ id: "legacy-event", agentKey: list.agents.find(a => a.tabId === 17).key, title: "Old chat title" });
  list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.events.find(e => e.id === "legacy-event").title, "Career Planning");
  await h.dispatch({ type: "DB_CLEAR_HISTORY" });
  assert.deepEqual(h.local.values.logicDashboardHistory.projectTitles, {});
  h.tabs.set(17, { id: 17, url: sourceUrl, title: "Chat title must not be the project name" });
  list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.agents.find(a => a.tabId === 17).title, "job search", "URL project slug is the last-resort label");
  h.tabs.get(17).url = sourceUrl.replace("-job-search", "");
  list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.agents.find(a => a.tabId === 17).title, "Project (name unavailable)");

  h.local.values.logicDashboardHistory.projectTitles = { "g-p-0123456789abcdef0123456789abcdef": "Skip to content" };
  const polluted = Object.values(h.local.values.logicDashboardHistory.agents).find(a => a.tabId === 42);
  polluted.title = polluted.projectTitle = "Skip to content";
  h.local.values.logicDashboardHistory.events.push({ id: "polluted-event", agentKey: polluted.key, url: polluted.url,
    title: "Skip to content", projectTitle: "Skip to content" });
  snapshots.delete(42);
  snapshots.set(17, { instanceId: "page-17", revision: "1", url: h.tabs.get(17).url,
    projectTitle: "Skip to content", detail: "Working" });
  list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.agents.find(a => a.tabId === 17).title, "Project (name unavailable)", "old content scripts cannot restore polluted labels");
  assert.equal(h.local.values.logicDashboardHistory.projectTitles["g-p-0123456789abcdef0123456789abcdef"], undefined, "polluted cache entries are removed");
  assert.equal(list.events.find(e => e.id === "polluted-event").title, "job search", "offline history also repairs polluted titles");
  snapshots.get(17).projectTitle = "Example Project";
  list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.agents.find(a => a.tabId === 17).title, "Example Project", "a fresh name repairs the dashboard");
  assert.ok(list.events.filter(e => e.tabId === 17).every(e => e.title === "Example Project"), "history uses the repaired project name");
  snapshots.get(17).projectTitle = "Skip to main content";
  list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.agents.find(a => a.tabId === 17).title, "Example Project", "older pages cannot overwrite a repaired project name");
}

async function contentTests() {
  {
    const batch = page();
    batch.api.queueAdditionalPrompt("Existing instructions");
    const append = request(batch, "queue_append", {text:"Shared instructions"}, "append-once");
    assert.equal((await batch.api.executeDashboardCommand(append)).ok, true);
    assert.equal((await batch.api.executeDashboardCommand(append)).ok, true);
    assert.equal(batch.api.dashboardSnapshot().queuedPrompt, "Existing instructions\n\nShared instructions");
    assert.deepEqual(batch.sends, [], "broadcast only queues; it never sends a prompt");
    const stale = request(batch, "queue_append", {text:"Stale message"}, "append-stale");
    batch.api.queueAdditionalPrompt("Updated locally");
    assert.equal((await batch.api.executeDashboardCommand(stale)).ok, false);
    assert.equal((await batch.api.executeDashboardCommand(request(batch, "queue_append", {text:"x".repeat(8000)}, "append-overflow"))).ok, false);
    assert.equal(batch.api.dashboardSnapshot().queuedPrompt, "Updated locally");
    batch.api.cancelAdditionalPrompt();
    assert.equal((await batch.api.executeDashboardCommand(request(batch, "queue_append", {text:"First queued item"}, "append-empty"))).ok, true);
    assert.equal(batch.api.dashboardSnapshot().queuedPrompt, "First queued item");
    batch.api.state.running = false; batch.api.state.mode = "idle";
    assert.equal((await batch.api.executeDashboardCommand(request(batch, "queue_append", {text:"No restart"}, "append-stopped"))).ok, false);
    assert.equal(batch.api.state.running, false);
  }
  let f = page();
  let snapshot = f.api.dashboardSnapshot();
  assert.equal(snapshot.capabilities.queue, true);
  assert.equal(snapshot.capabilities.reply, false, "a reply requires an explicit input wait");
  assert.equal(snapshot.capabilities.continue, false, "quick sends cannot interrupt a running agent");
  assert.equal((await f.api.executeDashboardCommand(request(f, "queue", { text: "One-time instructions" }))).ok, true);
  assert.equal(f.api.dashboardSnapshot().queuedPrompt, "One-time instructions");
  assert.equal(f.api.publicStatus().queuedPrompt, undefined, "ordinary status and activity must not expose queued text");
  const old = request(f, "queue", { text: "stale dashboard edit" }, "command-old");
  f.api.queueAdditionalPrompt("New local instructions");
  assert.equal((await f.api.executeDashboardCommand(old)).ok, false);
  assert.equal(f.api.dashboardSnapshot().queuedPrompt, "New local instructions");
  const cancel = request(f, "cancel_queue", {}, "cancel-once");
  assert.equal((await f.api.executeDashboardCommand(cancel)).ok, true);
  f.api.queueAdditionalPrompt("Later instructions");
  assert.equal((await f.api.executeDashboardCommand(cancel)).ok, true);
  assert.equal(f.api.dashboardSnapshot().queuedPrompt, "Later instructions", "duplicate cancellation cannot cancel a later prompt");
  for (const kind of ["url", "instance", "revision"]) {
    const stale = request(f, "pause", {}, `stale-${kind}`);
    stale.target[kind === "instance" ? "instanceId" : kind] += "-wrong";
    assert.equal((await f.api.executeDashboardCommand(stale)).ok, false);
    assert.equal(f.api.state.paused, false);
  }
  const pause = request(f, "pause", {}, "pause-once");
  assert.equal((await f.api.executeDashboardCommand(pause)).ok, true);
  await f.api.executeDashboardCommand(pause);
  assert.equal(f.api.state.paused, true, "duplicate pause cannot toggle back to resumed");

  for (const change of ["draft", "navigation", "manual_send", "generation"]) {
    f = page(); f.api.state.running = false; f.api.state.mode = "idle";
    f.send.disabled = true;
    let changed = false;
    f.onTick(() => {
      if (!f.writes.length || changed) return;
      changed = true;
      if (change === "draft") f.composer.innerText = f.composer.textContent = "My manual edit";
      if (change === "navigation") f.window.location = new URL(sourceUrl + "-new");
      if (change === "manual_send") f.newUser();
      if (change === "generation") f.setSelector("button[data-testid='stop-button']", [f.composer]);
      f.send.disabled = false;
    });
    const result = await f.api.executeDashboardCommand(request(f, "continue"));
    assert.equal(result.ok, false, change);
    assert.equal(f.sends.length, 0, change);
    if (change === "draft") assert.equal(f.composer.innerText, "My manual edit");
  }
  f = page(); f.api.state.running = false; f.api.state.mode = "idle";
  const quick = request(f, "continue");
  assert.equal((await f.api.executeDashboardCommand(quick)).ok, true);
  assert.equal((await f.api.executeDashboardCommand(quick)).ok, true);
  assert.deepEqual(f.sends, ["continue"]);
  f = fixture(["timeout-no-user"]); f.hide(); f.window.location = new URL(sourceUrl); f.api.state.running = false; f.api.state.mode = "idle";
  const uncertain = await f.api.executeDashboardCommand(request(f, "status"));
  assert.equal(uncertain.ok, false); assert.equal(uncertain.uncertain, true);

  // Actual USER_INPUT runner with Home Assistant disabled. The dashboard reply
  // is manual input and must not depend on a phone notification request ID.
  f = page(); f.assistant().textContent = "Choose a direction.\n[[LOGIC:USER_INPUT]]";
  const messages = [];
  f.setRequestHandler(async r => { messages.push(r); return { ok: true, enabled: false, event: null }; });
  let reply;
  f.onTick(() => {
    if (!reply && f.api.dashboardSnapshot().capabilities.reply) reply = f.api.executeDashboardCommand(request(f, "reply", { text: "Use the first option." }));
  });
  await f.run();
  assert.equal((await reply).ok, true);
  assert.deepEqual(f.sends, ["Use the first option."]);
  assert.equal(f.api.state.count, 0, "a dashboard reply is manual input, not an automatic follow-up");
  assert.equal(messages.some(r => r.type === "SL_RESULT"), false);

  // A competing phone reply must not send while the dashboard owns delivery.
  f = page(); f.assistant().textContent = "Choose.\n[[LOGIC:USER_INPUT]]";
  f.setRequestHandler(async r => r.type === "HA_NOTIFY_USER_INPUT" ? { ok: true, enabled: true, requestId: "phone-id" } : { ok: true, event: null });
  let dashboardReply, phoneReply;
  f.send.disabled = true;
  f.onTick(() => {
    if (!dashboardReply && f.api.dashboardSnapshot().capabilities.reply) dashboardReply = f.api.executeDashboardCommand(request(f, "reply", { text: "Dashboard answer" }));
    if (dashboardReply && f.writes.length && !phoneReply) {
      phoneReply = f.api.handleHomeAssistantResponse({ message: "Phone answer", requestId: "phone-id", tabUrl: sourceUrl });
      f.send.disabled = false;
    }
  });
  await f.run();
  assert.equal((await dashboardReply).ok, true); assert.equal((await phoneReply).accepted, false);
  assert.deepEqual(f.sends, ["Dashboard answer"]);
}

async function workerTests() {
  const h = await harness();
  const snapshots = new Map([...h.tabs].map(([id, tab]) => [id, { instanceId: `page-${id}`, revision: "1", url: tab.url,
    running: true, mode: "logic", logicPhase: "monitoring", detail: "Working", count: 0, limit: 5 }]));
  const executed = [];
  h.setPageHandler(async (id, message) => {
    if (message.type === "DB_SNAPSHOT") return snapshots.get(id);
    if (message.type === "DB_EXECUTE") { executed.push({ id, message }); return { ok: true }; }
    if (message.type === "GET_STATUS") return snapshots.get(id);
    if (message.type === "HEARTBEAT_CONFIG") return { instanceId: snapshots.get(id).instanceId };
    if (message.type === "HEARTBEAT_IDENTITY") return { instanceId: `page-${id}`, url: h.tabs.get(id).url };
    throw new Error("Unexpected request: " + message.type);
  });
  const bad = await h.dispatch({ type: "DB_LIST" }, { id: "attacker", url: "https://bad.example/" });
  assert.equal(bad.ok, false);
  const list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.agents.length, 2); assert.equal(list.events.length, 2);
  assert.ok(list.agents.every(a => a.online));
  const configuration = { kind: "interval", intervalMinutes: 30, timeZone: "America/Chicago", prompt: "Check work.", message: "Continue", limit: 3, rolloverEnabled: true };
  const schedule = await h.dispatch({ type: "DB_COMMAND", commandId: "schedule-command", action: "heartbeat_save", target: target(snapshots.get(17)), payload: { configuration } });
  assert.equal(schedule.ok, true, schedule.error);
  assert.equal(schedule.schedule.intervalMinutes, 30);
  assert.equal(schedule.schedule.tabId, 17);
  const inspected = await h.dispatch({ type: "DB_INSPECT", target: target(snapshots.get(17)) });
  assert.equal(inspected.ok, true, inspected.error);
  assert.equal(inspected.schedule.intervalMinutes, 30);
  assert.equal(inspected.connection, null);
  const action = { type: "DB_COMMAND", commandId: "test-command-1", action: "queue_append", payload: {text:"Shared instructions"}, target: target(snapshots.get(17)) };
  assert.equal((await h.dispatch(action)).ok, true);
  assert.equal((await h.dispatch(action)).ok, true);
  assert.equal(executed.length, 1); assert.equal(executed[0].id, 17);
  const wrongApproval = await h.dispatch({ ...action, action: "approve", commandId: "old-approval", payload: { text: "Obsolete approval" } });
  assert.equal(wrongApproval.ok, false); assert.equal(executed.length, 1);
  const notification = await h.dispatch({ type: "HA_NOTIFY_USER_INPUT", brief: "Choose the next step." }, { id: "test-extension", frameId: 0, tab: h.tabs.get(17) });
  assert.equal(notification.enabled, false);
  await h.dispatch({ type: "DB_LIST" });
  assert.ok(h.local.values.logicDashboardHistory.events.some(e => e.detail === "Choose the next step."), "dashboard notifications work with HA disabled");
  h.tabs.get(17).url += "-navigated";
  assert.equal((await h.dispatch({ ...action, commandId: "test-command-2" })).ok, false);
  assert.equal(executed.length, 1);
  h.tabs.get(17).url = sourceUrl;
  snapshots.get(17).instanceId = "reloaded";
  assert.equal((await h.dispatch({ ...action, commandId: "test-command-3" })).ok, false);
  assert.equal(executed.length, 1);
  const recorded = await h.dispatch({ type: "DB_RECORD", snapshot: { ...snapshots.get(17), detail: "Input needed", queuedPrompt: "PRIVATE", credential: "SECRET" } },
    { ...popup, url: sourceUrl, frameId: 0, tab: h.tabs.get(17) });
  assert.equal(recorded.ok, true);
  assert.ok(!JSON.stringify(h.local.values.logicDashboardHistory).includes("PRIVATE"));
  assert.ok(!JSON.stringify(h.local.values.logicDashboardHistory).includes("SECRET"));
  assert.equal((await h.dispatch({ type: "DB_RECORD", snapshot: snapshots.get(17) }, { id: "test-extension", frameId: 1, tab: h.tabs.get(17) })).ok, false);
  await h.dispatch({ type: "DB_DISMISS", eventId: list.events[0].id });
  assert.ok(h.local.values.logicDashboardHistory.events.find(e => e.id === list.events[0].id).dismissed);
  h.tabs.delete(17);
  const afterClose = await h.dispatch({ type: "DB_LIST" });
  assert.ok(afterClose.agents.some(a => a.tabId === 17 && !a.online));
  assert.equal((await h.dispatch({ ...action, commandId: "test-command-4" })).ok, false);
  assert.equal(executed.length, 1);
  await h.dispatch({ type: "DB_CLEAR_HISTORY" });
  assert.equal(h.local.values.logicDashboardHistory.events.length, 0);
}
(async () => { await projectTitleTests(); await contentTests(); await workerTests(); console.log("dashboard project titles, routing, status privacy, stale commands, queue conflicts and reply coordination passed"); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
