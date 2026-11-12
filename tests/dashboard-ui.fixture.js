/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
/* Offline browser fixture. Uses invented agents; never connects to Chrome tabs or ChatGPT. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error("Pass an absolute temporary output directory.");
fs.mkdirSync(output, { recursive: true });
const root = path.resolve(__dirname, "..");
for (const file of ["dashboard.css", "brand.css", "dashboard.js", "heartbeat.js"]) fs.copyFileSync(path.join(root, file), path.join(output, file));
function mock() {
  const actions = [];
  const caps = { start_loop: false, start_logic: false, resume_logic: false, stop: true, pause: true, resume: false,
    next_cycle: false, queue: true, cancel_queue: false, continue: false, status: false, reply: false, approve: false };
  const base = { online: true, revision: "1", mode: "logic", logicPhase: "monitoring", running: true, count: 2, limit: 10,
    message: "Continue", rolloverEnabled: true, lastSeen: Date.now(), queuedPrompt: "", capabilities: caps };
  const agents = [
    { ...base, tabId: 17, instanceId: "research", title: "Product Research", chatTitle: "Competitive landscape & source review", url: "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-research/c/research", detail: "Reviewing source material. Waiting for the response…" },
    { ...base, tabId: 18, instanceId: "build", title: "Agent Dashboard", chatTitle: "Controls & notifications", url: "https://chatgpt.com/c/build", detail: "Logic Mode paused. Choose the next milestone.", userInputBrief: "Choose the next milestone: controls or notifications?", logicPhase: "waiting_user", capabilities: { ...caps, reply: true, approve: true } },
    { ...base, tabId: 19, instanceId: "schedule", title: "Daily Operations", chatTitle: "Scheduled system checks", url: "https://chatgpt.com/c/checks", detail: "Work cycle complete. Sleeping until the next heartbeat.", logicPhase: "sleeping", count: 0, heartbeat: { nextRunAt: Date.now() + 1800000 } },
    { ...base, online: false, tabId: 20, instanceId: "offline", title: "Previous Research", chatTitle: "Archived source review", url: "https://chatgpt.com/c/archive", detail: "Previously seen agent. Its page is no longer connected." }
  ];
  agents[0].summary = { status: "ready", last: { text: "Reviewed three competitors and compared their published features. Pricing still needs verification.", completedAt: Date.now() - 60000, model: "example/free", flag: "continue" } };
  agents[1].summary = { status: "error", error: "OpenRouter free-model rate limit reached.", last: { text: "Built the dashboard controls and requested the next milestone.", completedAt: Date.now() - 120000, model: "example/free", flag: "user_input" } };
  agents[2].summary = { status: "pending", last: null };
  const events = [{ id: "event-1", at: Date.now(), agentKey: `18:build:${agents[1].url}`, tabId: 18, title: agents[1].title, kind: "input", detail: agents[1].detail },
    { id: "event-2", at: Date.now() - 120000, agentKey: `19:schedule:${agents[2].url}`, tabId: 19, title: agents[2].title, kind: "status", detail: agents[2].detail }];
  const configuration = { kind: "interval", intervalMinutes: 60, times: [], days: [], timeZone: "America/Chicago", prompt: "Check the next scheduled tasks.", limit: 5, phase: "sleeping", detail: "Waiting for next cycle." };
  globalThis.chrome = {
    runtime: { openOptionsPage: async () => {}, sendMessage: async request => {
      if (request.type === "DB_LIST") return structuredClone({ ok: true, agents, events, version: "1.10.0" });
      if (request.type === "DB_INSPECT") return { ok: true, schedule: configuration, connection: null, defaultPrompt: "Do the scheduled work." };
      if (request.type === "ALERT_GET_SETTINGS") return { soundEnabled: true };
      if (request.type === "HA_GET_SETTINGS") return { enabled: true, connection: { phase: "connected" }, approvalMessage: "Approved. Continue with the current task." };
      if (request.type === "DB_DISMISS") { events.find(e => e.id === request.eventId).dismissed = true; return { ok: true }; }
      if (request.type === "DB_CLEAR_HISTORY") { events.length = 0; return { ok: true }; }
      if (request.type === "DB_COMMAND") {
        actions.push(request);
        const agent = agents.find(a => a.tabId === request.target.tabId);
        if (request.action === "queue") { agent.queuedPrompt = request.payload.text; agent.capabilities = { ...agent.capabilities, cancel_queue: true }; }
        if (request.action === "pause") { agent.paused = true; agent.capabilities = { ...agent.capabilities, pause: false, resume: true }; }
        if (request.action === "resume") { agent.paused = false; agent.capabilities = { ...agent.capabilities, pause: true, resume: false }; }
        if (request.action === "cancel_queue") { agent.queuedPrompt = ""; agent.capabilities = { ...agent.capabilities, cancel_queue: false }; }
        return { ok: true };
      }
      return { ok: true };
    } },
    tabs: { get: async id => ({ id, url: agents.find(a => a.tabId === id).url, windowId: 1 }), update: async () => {} },
    windows: { update: async () => {} }, permissions: { request: async () => true }
  };
  const errors = [];
  addEventListener("error", event => errors.push(event.message));
  addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
  addEventListener("DOMContentLoaded", async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve, 100));
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const $ = id => document.getElementById(id);
    const visible = node => Boolean(node && node.getClientRects().length);
    const click = selector => {
      const node = document.querySelector(selector);
      assert(visible(node), `Control is visible: ${selector}`);
      assert(!node.disabled, `Control is enabled: ${selector}`);
      node.focus(); node.click();
    };
    const input = (id, value) => { assert(visible($(id)), `Editor is visible: ${id}`); $(id).value = value; $(id).dispatchEvent(new Event("input", { bubbles: true })); };
    const select = async id => {
      if (innerWidth <= 720 && document.body.dataset.mobileView === "detail") click("#back-to-agents");
      click(`.agent-select[data-agent-key^="${id}:"]`); await wait();
    };
    const tab = name => click(`#tab-${name}`);
    const change = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event("change", { bubbles: true })); };
    const checkLayout = () => {
      assert(document.documentElement.scrollWidth <= innerWidth, "No horizontal page overflow");
      assert(document.documentElement.scrollHeight <= innerHeight + 1, "Workspace fits viewport without a long page");
      assert([...document.querySelectorAll("[role=tabpanel]")].filter(visible).length === 1, "Exactly one tool panel is visible");
      assert(visible($("agent-title")) && $("agent-title").getBoundingClientRect().bottom < innerHeight, "Agent identity stays visible");
    };
    try {
      await wait();
      assert(document.querySelectorAll(".agent-card").length === 4, "All four agents should render");
      assert(document.querySelector(".agent-select").dataset.agentKey.startsWith("18:"), "Input requests sort first");
      assert(actions.length === 0, "Opening the dashboard never runs commands");
      assert(!$("activity-drawer").open, "Activity stays out of the workspace until requested");
      await select(17);
      assert($("agent-summary").textContent.includes("Reviewed three competitors"), "Selected agent displays its last output summary");
      assert($("agent-summary-meta").textContent.includes("CONTINUE"), "Summary includes ending Logic tag");
      assert($("agent-title").textContent === agents[0].title, "Project selection");
      assert($("chat-title").textContent === agents[0].chatTitle, "Chat is secondary context");
      checkLayout();
      input("queued", "Review edge cases before the next round.");
      click("[data-action='queue']"); await wait();
      assert(actions.at(-1).target.tabId === 17 && actions.at(-1).payload.text.startsWith("Review edge"), "Queue targets selected agent");
      assert($("queue-pending").textContent.includes("Review edge"), "Queued prompt visible in disclosure");
      assert(!$("queue-badge").hidden, "Pending queue badge");
      input("queued", "Unsent dashboard draft");
      tab("run"); tab("queue");
      click("#refresh"); await wait();
      assert($("queued").value === "Unsent dashboard draft", "Tabs and polling preserve edits");
      click("[data-action='pause']"); await wait();
      assert(visible(document.querySelector("[data-action='resume']")), "Paused agent shows resume");
      assert(!visible(document.querySelector("[data-action='pause']")), "Irrelevant pause action hidden");
      click("[data-action='resume']"); await wait();
      await select(18);
      assert(!$("panel-reply").hidden, "Selecting input request opens reply tool");
      input("reply", "Build the controls first.");
      tab("queue"); tab("reply");
      assert($("reply").value === "Build the controls first.", "Reply draft survives tab switches");
      click("[data-action='reply']"); await wait();
      assert(actions.at(-1).target.tabId === 18 && actions.at(-1).action === "reply", "Reply targets correct agent");
      assert($("reply").value === "", "Confirmed reply clears dashboard editor");
      input("reply", "Keep this unsent reply draft.");
      click("[data-action='approve']"); await wait();
      assert($("reply").value === "Keep this unsent reply draft.", "Approval preserves unsent reply text");
      await select(17);
      assert($("queued").value === "Unsent dashboard draft", "Switching agents preserves unsent dashboard drafts");
      await select(20);
      assert([...document.querySelectorAll("#detail [data-action]")].every(button => button.disabled), "Offline agent has no enabled controls");
      await select(17);
      tab("heartbeat");
      input("hb-prompt", "Run scheduled checks."); click("[data-action='heartbeat_save']"); await wait();
      assert(actions.at(-1).action === "heartbeat_save", "Heartbeat control works");
      assert(actions.at(-1).payload.configuration.prompt === "Run scheduled checks.", "Heartbeat payload");
      change("hb-kind", "daily");
      assert(!$("hb-daily-fields").hidden && $("hb-interval-field").hidden, "Only relevant schedule fields shown");
      change("hb-kind", "interval");
      tab("queue");
      $("tab-queue").focus();
      $("tab-queue").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      assert(document.activeElement === $("tab-reply") && !$("panel-reply").hidden, "Arrow keys navigate tabs and panels");
      $("tab-reply").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      assert(document.activeElement === $("tab-server"), "End selects last tab");
      $("tab-server").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      assert(document.activeElement === $("tab-queue"), "Home selects first tab");
      assert(document.querySelectorAll('[role=tab][tabindex="0"]').length === 1, "Single keyboard entry into tablist");
      click("#activity-toggle");
      assert($("activity-drawer").open, "Activity opens in modal drawer");
      change("event-kind", "attention");
      assert(document.querySelectorAll(".event").length === 1, "Activity filters input and errors");
      click(".event .text-button"); await wait();
      assert(!$("activity-drawer").open && $("agent-title").textContent === agents[1].title, "Activity jumps to correct agent");
      assert(!$("panel-reply").hidden, "Input event opens reply panel");
      assert($("reply").value === "Keep this unsent reply draft.", "Reply draft remains after approval and agent switching");
      click("#activity-toggle");
      change("event-scope", "selected");
      assert(document.querySelectorAll(".event").length === 1, "Selected agent activity scope");
      click('[data-close="activity-drawer"]'); await wait();
      assert(document.activeElement === $("activity-toggle"), "Dialog close restores trigger focus");
      click("#preferences-toggle"); assert($("preferences-dialog").open, "Settings dialog opens");
      click('[data-close="preferences-dialog"]');
      click('[data-filter="waiting"]');
      assert(document.querySelectorAll(".agent-card").length === 1, "Overview counts filter the list");
      click('[data-filter="all"]');
      await select(17); tab("queue");
      checkLayout();
      const originalTitle = agents[0].title, originalDetail = agents[0].detail;
      agents[0].title = "Long project title with several words and a very long identifier " + "project".repeat(28);
      agents[0].detail = "Detailed status message. ".repeat(80);
      for (let i = 0; i < 40; i++) agents.push({ ...base, tabId: 100 + i, instanceId: `extra-${i}`, title: `Extra project ${i}`, url: `https://chatgpt.com/c/extra-${i}`, detail: "Working" });
      click("#refresh"); await wait();
      checkLayout();
      assert(document.querySelectorAll(".agent-card").length === 44, "Large agent list remains available");
      if (innerWidth <= 720) click("#back-to-agents");
      assert($("agents").scrollHeight > $("agents").clientHeight, "Large list scrolls independently");
      if (innerWidth <= 720) await select(17);
      assert(visible(document.querySelector("[data-action='stop']")), "Stop remains visible with long names and status");
      assert($("queued").value === "Unsent dashboard draft", "Stress refresh preserves draft");
      agents.splice(4); agents[0].title = originalTitle; agents[0].detail = originalDetail;
      click("#refresh"); await wait();
      if (innerWidth > 720 && innerHeight >= 700) {
        const queueButton = document.querySelector('[data-action="queue"]').getBoundingClientRect();
        assert(queueButton.bottom <= document.querySelector(".app-status").getBoundingClientRect().top, "Primary queue action is above the fold on laptop screens");
      }
      assert(errors.length === 0, errors.join("; "));
      const report = document.createElement("pre"); report.id = "smoke-result"; report.textContent = "PASS: project selection, priority ordering, tabs, keyboard, queue, reply, approvals, pause/resume, heartbeat, activity filters, dialogs, focus, offline guards, draft retention, viewport layout; no browser errors";
      report.hidden = true; document.body.append(report);
      // Optional screenshot views use the same tested mock, never real chats.
      const preview = new URLSearchParams(location.search).get("preview");
      if (preview === "reply") await select(18);
      if (preview === "activity") click("#activity-toggle");
      if (preview === "agents" && innerWidth <= 720) click("#back-to-agents");
      document.activeElement?.blur();
    } catch (error) {
      const report = document.createElement("pre"); report.id = "smoke-result"; report.textContent = "FAIL: " + error.message;
      document.body.append(report);
    }
  });
}
fs.writeFileSync(path.join(output, "fixture.js"), `(${mock.toString()})();\n`);
fs.writeFileSync(path.join(output, "index.html"), fs.readFileSync(path.join(root, "dashboard.html"), "utf8").replace('<script src="heartbeat.js">', '<script src="fixture.js"></script><script src="heartbeat.js">'));
console.log(output);
