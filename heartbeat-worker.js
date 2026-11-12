/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
/* Durable per-conversation schedules. Imported after background.js. */
(() => {
  "use strict";
  const KEY = "logicHeartbeatSchedules";
  const PREFIX = "logic-heartbeat:";
  let queue = Promise.resolve();
  const serial = work => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const read = async () => (await chrome.storage.local.get(KEY))[KEY] || {};
  const save = records => chrome.storage.local.set({ [KEY]: records });
  const send = (tabId, message) => {
    let timer;
    return Promise.race([
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The chat did not acknowledge the heartbeat command.")), 10000); })
    ]).finally(() => clearTimeout(timer));
  };
  const publicRecord = record => record ? { ...record } : null;
  async function alarm(record) {
    const name = PREFIX + record.id;
    await chrome.alarms.clear(name);
    if (record.enabled && !record.suspendUntilIdle && !["paused", "blocked", "dispatching", "awaiting_idle"].includes(record.phase) && Number.isFinite(record.nextRunAt)) {
      await chrome.alarms.create(name, { when: Math.max(Date.now() + 1000, record.nextRunAt) });
    }
  }
  async function notifyError(record, detail) {
    try {
      await initializationPromise;
      if (typeof DashboardWorker !== "undefined") void DashboardWorker.notification({ type: "HA_NOTIFY_ERROR", detail },
        { id: record.tabId, url: record.url, title: record.chatTitle }).catch(console.warn);
      if (config.enabled) await sendErrorNotification({ chatTitle: record.chatTitle, detail }, { tab: { id: record.tabId, url: record.url, title: record.chatTitle } });
    } catch (error) { console.warn("[Threadlamp] Heartbeat error notification failed.", error); }
  }
  async function push(record) {
    try { return await send(record.tabId, { type: "HEARTBEAT_CONFIG", schedule: publicRecord(record) }); }
    catch { return null; }
  }
  async function block(records, record, detail) {
    record.phase = "blocked";
    record.detail = detail;
    record.nextRunAt = null;
    await save(records);
    await alarm(record);
    await push(record);
    void notifyError(record, detail);
  }
  async function locate(record) {
    try {
      const tab = await chrome.tabs.get(record.tabId);
      if (Heartbeat.sameChat(tab.url, record.url)) return tab;
    } catch { /* Browser restarts can change tab IDs. */ }
    const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
    const matches = tabs.filter(tab => Heartbeat.sameChat(tab.url, record.url));
    if (matches.length !== 1) throw new Error(matches.length ? "The scheduled chat is open in multiple tabs. Save its schedule in the intended tab." : "The scheduled chat is not open. Open it and resume its schedule.");
    return matches[0];
  }
  async function claimOwner(records, record, request, sender, confirmIdle = false) {
    if (record.tabId === sender.tab.id && record.instanceId === request.instanceId) return true;
    const ownedElsewhere = async () => {
      if (record.tabId === sender.tab.id) return false;
      try {
        const owner = await chrome.tabs.get(record.tabId);
        return Heartbeat.sameChat(owner.url, record.url);
      } catch { return false; }
    };
    if (await ownedElsewhere()) return false;

    // The saved instance token changes on reload. Confirm the instance now
    // running in the main frame before rebinding; a delayed old-page request
    // must not reclaim the schedule from its replacement.
    const identity = await send(sender.tab.id, { type: "HEARTBEAT_IDENTITY" });
    const samePage = value => {
      try {
        const current = new URL(value), expected = new URL(sender.tab.url);
        return current.origin === expected.origin && current.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, "");
      } catch { return false; }
    };
    const currentTab = await chrome.tabs.get(sender.tab.id);
    if (!request.instanceId || identity?.instanceId !== request.instanceId || !samePage(identity?.url) || !samePage(currentTab.url)) {
      throw new Error("The current chat page could not confirm heartbeat ownership. Retry after the page finishes loading.");
    }
    if (await ownedElsewhere()) return false;
    const interrupted = record.enabled && ["active", "dispatching"].includes(record.phase)
      && record.instanceId && record.instanceId !== request.instanceId;
    record.tabId = sender.tab.id;
    record.instanceId = request.instanceId;
    if (interrupted) {
      await block(records, record, "This chat reloaded during an active cycle. Inspect its last response, then Resume Logic Mode or the schedule.");
    } else {
      if (confirmIdle && record.enabled && !["paused", "blocked", "disabled"].includes(record.phase)) {
        record.phase = "awaiting_idle";
      }
      await save(records);
      await alarm(record);
    }
    return true;
  }
  async function fire(id, manual = false) {
    const records = await read();
    const record = records[id];
    if (!record?.enabled || record.suspendUntilIdle || ["paused", "blocked", "dispatching", "awaiting_idle"].includes(record.phase)) return { ok: false, error: "The heartbeat is paused or waiting for the current cycle to reach IDLE." };
    if (!manual && Date.now() < record.nextRunAt) { await alarm(record); return { ok: true }; }
    if (record.pendingDestination) {
      await block(records, record, "The new project chat has not obtained a saved conversation URL. Inspect the rollover before resuming its schedule.");
      return { ok: false, error: record.detail };
    }
    let tab;
    try { tab = await locate(record); }
    catch (error) { await block(records, record, error.message); return { ok: false, error: error.message }; }
    record.tabId = tab.id;
    const scheduledFor = manual ? Date.now() : record.nextRunAt;
    const previousPhase = record.phase;
    const attemptId = crypto.randomUUID();
    record.phase = "dispatching";
    record.attemptId = attemptId;
    record.lastAttemptAt = Date.now();
    record.lastSlot = manual ? record.lastSlot : Heartbeat.slotKey(record, scheduledFor);
    record.nextRunAt = Heartbeat.nextRun(record, Date.now(), record.lastSlot);
    // Persist before messaging. A worker restart cannot blindly resend this attempt.
    await save(records);
    await chrome.alarms.clear(PREFIX + id);
    let result;
    try {
      result = await send(tab.id, { type: "HEARTBEAT_WAKE", schedule: { ...record, phase: previousPhase }, attemptId, scheduledFor });
    } catch (error) {
      await block(records, record, `${error.message} Delivery is uncertain; inspect the chat before resuming.`);
      return { ok: false, error: record.detail };
    }
    if (result?.accepted) {
      record.phase = "active";
      record.initialCycle = false;
      record.detail = "Heartbeat accepted. The agent is working.";
      record.instanceId = result.instanceId;
      record.lastRunAt = Date.now();
    } else if (result?.busy) {
      record.phase = "active";
      record.detail = "Skipped heartbeat because this chat is already working.";
    } else if (result?.deferred) {
      record.phase = "sleeping";
      record.nextRunAt = Date.now() + 60000;
      record.detail = "An unsent draft is present. Heartbeat will check again in one minute.";
    } else {
      await block(records, record, result?.detail || "The chat refused the heartbeat. Inspect it before resuming.");
      return { ok: false, error: record.detail };
    }
    if (result?.suspendUntilIdle) {
      record.suspendUntilIdle = true;
      record.nextRunAt = null;
      record.detail = "Manual conversation active. Heartbeat resumes after IDLE.";
    }
    await save(records);
    await alarm(record);
    await push(record);
    return { ok: true, schedule: publicRecord(record) };
  }
  async function handle(request, sender) {
    const fromPopup = isTrustedExtensionPage(sender);
    const fromChat = (await isTrustedChatSender(sender)) && (sender.frameId === undefined || sender.frameId === 0);
    if (!fromPopup && !fromChat) throw new Error("Untrusted heartbeat request.");
    const records = await read();
    if (fromPopup) {
      if (!["HB_GET", "HB_SAVE", "HB_CONTROL"].includes(request.type)) throw new Error("Unsupported schedule control.");
      const tab = await chrome.tabs.get(request.tabId);
      const url = Heartbeat.canonicalUrl(tab.url);
      if (!url) throw new Error("Open a saved ChatGPT conversation before configuring a heartbeat.");
      if (request.target) {
        await DashboardWorker.verifyTarget(request.target);
        if (url !== request.target.url) throw new Error("The dashboard target conversation changed.");
      }
      let record = Object.values(records).find(item => Heartbeat.sameChat(item.url, url));
      if (request.type === "HB_GET") return { ok: true, schedule: publicRecord(record), defaultPrompt: Heartbeat.DEFAULT_PROMPT };
      if (request.type === "HB_SAVE") {
        const configuration = Heartbeat.normalize(request.configuration);
        const status = await send(tab.id, { type: "GET_STATUS" });
        if (!status) throw new Error("The chat's status is unavailable.");
        if (request.target) await DashboardWorker.verifyTarget(request.target);
        record = { ...record, ...configuration, id: record?.id || crypto.randomUUID(), url, tabId: tab.id, chatTitle: tab.title || "Unnamed chat", enabled: true, initialCycle: record?.enabled ? record.initialCycle : !status.running, phase: status.error || status.paused || status.logicPhase === "waiting_user" || (status.running && status.mode !== "logic") ? "blocked" : status.running && status.logicPhase !== "sleeping" ? "active" : "armed", detail: "Schedule saved.", pendingDestination: false, lastSlot: "" };
        record.nextRunAt = Heartbeat.nextRun(record);
        if (record.phase === "blocked") { record.nextRunAt = null; record.detail = "Resolve the chat's pause or error, then resume the schedule."; }
        records[record.id] = record;
        await save(records);
        const attached = await push(record);
        if (!attached?.instanceId) {
          await block(records, record, "The chat could not attach its heartbeat schedule.");
          throw new Error(record.detail);
        }
        record.instanceId = attached.instanceId;
        if (attached.blocked) {
          await block(records, record, attached.detail);
          return { ok: true, schedule: publicRecord(record) };
        }
        await save(records);
        await alarm(record);
      } else {
        if (!record) throw new Error("Save a heartbeat schedule first.");
        record.tabId = tab.id;
        if (request.action === "run") return fire(record.id, true);
        if (request.action === "disable") { record.enabled = false; record.suspendUntilIdle = false; record.phase = "disabled"; record.nextRunAt = null; record.detail = "Heartbeat disabled."; }
        else if (request.action === "pause") { record.phase = "paused"; record.nextRunAt = null; record.detail = "Heartbeat schedule paused."; }
        else if (request.action === "resume") {
          const result = await send(tab.id, { type: "HEARTBEAT_RESUME", schedule: record });
          if (!result?.accepted) throw new Error(result?.detail || "Resolve the chat's pause before resuming.");
          record.enabled = true;
          if (!result.active) record.suspendUntilIdle = false;
          record.phase = result.active ? "active" : "armed";
          record.instanceId = result.instanceId;
          record.detail = "Heartbeat schedule resumed.";
          record.nextRunAt = Heartbeat.nextRun(record, Date.now(), record.lastSlot);
        } else throw new Error("Unknown heartbeat control.");
        await save(records);
        await alarm(record);
        await push(record);
      }
      return { ok: true, schedule: publicRecord(record) };
    }
    const url = Heartbeat.canonicalUrl(sender.tab.url);
    if (request.type === "HB_AUTO_IDLE") {
      // Only the sending saved chat can request an automatic schedule. Never
      // replace another tab's owner or a deliberate disabled/paused schedule.
      if (!url || !Heartbeat.sameChat(url, request.url)) throw new Error("A saved, unchanged chat is required for an automatic heartbeat.");
      const tab = await chrome.tabs.get(sender.tab.id);
      if (!Heartbeat.sameChat(tab.url, url)) throw new Error("The chat changed before its heartbeat could be saved.");
      const existing = Object.values(records).find(item => Heartbeat.sameChat(item.url, url));
      if (existing) {
        if (!await claimOwner(records, existing, request, sender, true)) {
          return { ok: true, schedule: null, detail: "This chat's heartbeat is still owned by another open tab of this conversation." };
        }
        return { ok: true, schedule: publicRecord(existing) };
      }
      const configuration = Heartbeat.normalize({ kind: "interval", intervalMinutes: 60, timeZone: "America/Chicago",
        prompt: Heartbeat.DEFAULT_PROMPT, message: request.message, limit: request.limit, rolloverEnabled: request.rolloverEnabled });
      const record = { ...configuration, id: crypto.randomUUID(), url, tabId: tab.id, chatTitle: tab.title || "Unnamed chat",
        enabled: true, initialCycle: false, phase: "awaiting_idle", detail: "Waiting for the chat to confirm its idle cycle.",
        instanceId: request.instanceId, nextRunAt: null, lastSlot: "", pendingDestination: false, automatic: true };
      records[record.id] = record;
      await save(records);
      // The content script must confirm that its run is still current with
      // HB_STATE sleeping. Stop/navigation during this request cannot arm it.
      return { ok: true, schedule: publicRecord(record) };
    }
    let record = request.scheduleId ? records[request.scheduleId] : Object.values(records).find(item => Heartbeat.sameChat(item.url, url) && item.enabled);
    if (!record) return { ok: true, schedule: null };
    const pendingMatch = record.pendingDestination && record.tabId === sender.tab.id
      && new URL(sender.tab.url).origin === new URL(record.url).origin && (
      sameRolloverProject(record.projectSegment, projectSegmentFromUrl(sender.tab.url))

    );
    if (!Heartbeat.sameChat(record.url, url) && !pendingMatch) return { ok: true, schedule: null };
    if (request.type === "HB_ATTACH") {
      if (!await claimOwner(records, record, request, sender)) return { ok: true, schedule: null };
      return { ok: true, schedule: publicRecord(record) };
    }
    if (record.tabId !== sender.tab.id || (record.instanceId && record.instanceId !== request.instanceId)) throw new Error("This heartbeat belongs to another tab or page instance.");
    record.instanceId = request.instanceId;
    if (request.type === "HB_DISABLE") {
      record.enabled = false; record.suspendUntilIdle = false; record.phase = "disabled"; record.nextRunAt = null; record.detail = "Heartbeat disabled by Stop.";
    } else if (request.type === "HB_RESUME") {
      if (!record.enabled) throw new Error("The heartbeat schedule is disabled.");
      if (!request.active) record.suspendUntilIdle = false;
      record.phase = request.active ? "active" : "sleeping";
      record.nextRunAt = Heartbeat.nextRun(record, Date.now(), record.lastSlot);
      record.detail = "Heartbeat schedule resumed.";
    } else if (request.type === "HB_STATE") {
      if (!record.enabled) return { ok: true, schedule: publicRecord(record) };
      if (pendingMatch && url && url !== record.url) { record.url = url; record.pendingDestination = false; }
      if (request.chatTitle) record.chatTitle = normalizeRolloverTitle(request.chatTitle);
      if (request.phase === "sleeping") {
        if (!["paused", "blocked"].includes(record.phase)) {
          record.phase = "sleeping";
          record.nextRunAt = !record.suspendUntilIdle && record.nextRunAt > Date.now() ? record.nextRunAt : Heartbeat.nextRun(record, Date.now(), record.lastSlot);
          record.suspendUntilIdle = false;
          record.detail = "Sleeping until the next heartbeat.";
        }
      } else if (["blocked", "paused"].includes(request.phase)) {
        record.phase = request.phase;
        record.nextRunAt = null;
        record.detail = String(request.detail || "Heartbeat needs attention.").slice(0, 500);
      } else if (request.phase === "active" && !["paused", "blocked"].includes(record.phase)) {
        record.phase = "active";
        if (request.suspendUntilIdle) {
          record.suspendUntilIdle = true;
          record.nextRunAt = null;
          record.detail = "Manual conversation active. Heartbeat resumes after IDLE.";
        }
      }
    } else throw new Error("Unsupported heartbeat event.");
    await save(records);
    await alarm(record);
    return { ok: true, schedule: publicRecord(record) };
  }
  async function transfer(rollover, tab) {
    return serial(async () => {
      const records = await read();
      const sourceUrl = Heartbeat.canonicalUrl(rollover.sourceUrl);
      const record = Object.values(records).find(item => item.enabled && Heartbeat.sameChat(item.url, sourceUrl) && item.tabId === rollover.sourceTabId);
      if (!record) return;
      record.tabId = tab.id;
      record.url = Heartbeat.canonicalUrl(tab.url) || record.url;
      record.pendingDestination = !Heartbeat.canonicalUrl(tab.url);
      record.projectSegment = rollover.projectSegment;
      record.instanceId = null;
      record.phase = ["paused", "blocked"].includes(record.phase) ? record.phase : "active";
      await save(records);
      rollover.heartbeatSchedule = publicRecord(record);
    });
  }
  async function restore() {
    const records = await read();
    for (const record of Object.values(records)) {
      if (!record.enabled) continue;
      if (record.phase === "dispatching") await block(records, record, "The extension restarted while dispatching a heartbeat. Inspect the chat before resuming; it will not be sent twice automatically.");
      else await alarm(record);
    }
  }
  globalThis.HeartbeatScheduler = { transfer, dashboard: (request, sender) => serial(async () => {
    await DashboardWorker.verifyTarget(request.target);
    return handle(request, sender);
  }) };
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (!String(request?.type || "").startsWith("HB_")) return false;
    serial(() => handle(request, sender)).then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  });
  chrome.alarms.onAlarm.addListener(event => {
    if (event.name.startsWith(PREFIX)) void serial(() => fire(event.name.slice(PREFIX.length))).catch(error => console.warn("[Threadlamp] Heartbeat scheduler failed.", error));
  });
  chrome.runtime.onStartup.addListener(() => { void serial(restore).catch(console.warn); });
  chrome.runtime.onInstalled.addListener(() => { void serial(restore).catch(console.warn); });
  void serial(restore).catch(console.warn);
})();
