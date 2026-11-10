/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { contentHarness, visibleElement } = require("./rollover.test.js");
const root = path.resolve(__dirname, "..");
const KEY = "logicHeartbeatSchedules";
const sourceUrl = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-job-search/c/source";
const popup = { id: "test-extension", url: "chrome-extension://test-extension/popup.html" };
const definition = { kind: "interval", intervalMinutes: 60, timeZone: "America/Chicago", prompt: "Do work due now.", message: "Continue", limit: 5, rolloverEnabled: true };
function area(values = {}) {
  return { values, get: async key => typeof key === "string" ? { [key]: structuredClone(values[key]) } : { ...key, ...structuredClone(values) }, set: async data => Object.assign(values, structuredClone(data)), remove: async key => { delete values[key]; }, setAccessLevel: async () => {} };
}
async function harness(saved = {}, options = {}) {
  let now = Date.parse("2026-10-16T14:00:00Z");
  const alarms = new Map();
  const messages = [];
  const fetchCalls = [];
  const listeners = { message: [], alarm: [], startup: [], installed: [] };
  const local = area(saved);
  const session = area();
  const tabs = new Map([[17, { id: 17, url: sourceUrl, title: "Job research" }], [99, { id: 99, url: "https://chatgpt.com/c/unrelated", title: "Another agent" }]]);
  let status = { running: false, mode: "idle", logicPhase: "idle", error: false };
  let wake = async () => ({ accepted: true, instanceId: "page-A" });
  let pageHandler = options.pageHandler;
  class Clock extends Date { static now() { return now; } }
  const context = {
    console, URL, Intl, TextEncoder, Date: Clock, crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (...args) => { fetchCalls.push(args); return { ok: true, headers: { get: () => "application/json" }, json: async () => ({}) }; },
    chrome: {
      runtime: {
        id: "test-extension", getURL: s => `chrome-extension://test-extension/${s}`, getContexts: async () => [],
        onMessage: { addListener: fn => listeners.message.push(fn) },
        onStartup: { addListener: fn => listeners.startup.push(fn) }, onInstalled: { addListener: fn => listeners.installed.push(fn) }
      },
      storage: { local, session }, permissions: { contains: async () => true },
      alarms: { clear: async name => alarms.delete(name), create: async (name, options) => alarms.set(name, options), onAlarm: { addListener: fn => listeners.alarm.push(fn) } },
      tabs: {
        get: async id => { if (!tabs.has(id)) throw new Error("Missing tab"); return { ...tabs.get(id) }; },
        query: async () => [...tabs.values()],
        sendMessage: async (id, request) => {
          messages.push({ id, request });
          if (pageHandler) return pageHandler(id, request);
          if (request.type === "GET_STATUS") return status;
          if (request.type === "HEARTBEAT_IDENTITY") return { instanceId: "page-A", url: tabs.get(id)?.url };
          if (request.type === "HEARTBEAT_CONFIG") return { instanceId: "page-A" };
          if (request.type === "HEARTBEAT_RESUME") return { accepted: true, active: false, instanceId: "page-A" };
          if (request.type === "HEARTBEAT_WAKE") return wake(request);
          throw new Error(`Unexpected message ${request.type}`);
        }
      }
    }
  };
  options.configureContext?.(context);
  vm.createContext(context);
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file }));
  context.importScripts("service-worker.js");
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  const dispatch = (request, sender = popup) => new Promise(resolve => {
    let handled = false;
    for (const listener of listeners.message) if (listener(request, sender, resolve) === true) handled = true;
    if (!handled) throw new Error("No handler");
  });
  const record = () => Object.values(local.values[KEY] || {})[0];
  const trigger = async () => {
    const r = record();
    for (const listener of listeners.alarm) listener({ name: `logic-heartbeat:${r.id}` });
    // A read queued after the alarm is an execution barrier for its state writes.
    await dispatch({ type: "HB_GET", tabId: r.tabId });
  };
  return { context, alarms, messages, tabs, local, session, fetchCalls, dispatch, record, trigger, flush,
    emitAlarm: name => { for (const listener of listeners.alarm) listener({ name }); },
    setNow: at => { now = at; }, setWake: fn => { wake = fn; }, setPageHandler: fn => { pageHandler = fn; }, setStatus: s => { status = s; } };
}
async function clockTests() {
  const h = await harness();
  const api = h.context.Heartbeat;
  assert.throws(() => api.normalize({ ...definition, intervalMinutes: 0 }), /interval/);
  assert.throws(() => api.normalize({ ...definition, timeZone: "Invalid/Zone" }), /timezone/);
  assert.throws(() => api.normalize({ ...definition, kind: "daily", days: [1], times: "25:00" }), /24-hour/);
  const daily = api.normalize({ ...definition, kind: "daily", days: [1, 2, 3, 4, 5], times: "09:00, 15:00" });
  assert.equal(new Date(api.nextRun(daily, Date.parse("2026-10-16T21:00:00Z"))).toISOString(), "2026-10-19T14:00:00.000Z", "Friday evening rolls to Monday in Chicago");
  const spring = api.normalize({ ...definition, kind: "daily", days: [0], times: "02:30" });
  assert.equal(new Date(api.nextRun(spring, Date.parse("2026-03-08T06:00:00Z"))).toISOString(), "2026-03-15T07:30:00.000Z", "nonexistent DST times are skipped");
  const fall = api.normalize({ ...definition, kind: "daily", days: [0], times: "01:00, 01:30" });
  assert.equal(new Date(api.nextRun(fall, Date.parse("2026-11-01T06:30:00Z"), "2026-11-01T01:30")).toISOString(), "2026-11-08T07:00:00.000Z", "multiple slots do not repeat during DST rollback");
  assert.equal(api.canonicalUrl("https://chatgpt.com/?temporary=1"), "");
  assert.equal(api.canonicalUrl(`${sourceUrl}?query=1`), sourceUrl);
  for (const id of ["local-chatgpt:temporary-id", "local-chatgpt%3Atemporary-id", "local-chatgpt%3atemporary-id"]) {
    assert.equal(api.canonicalUrl(sourceUrl.replace(/source$/, id)), "", "local IDs cannot finalize a rollover schedule");
    assert.equal(api.canonicalUrl(`https://chatgpt.com/c/${id}`), "");
  }
  assert.equal(api.canonicalUrl(sourceUrl.replace(/source$/, "bad%escape")), "");
}
async function schedulerTests() {
  const h = await harness();
  const rejected = await h.dispatch({ type: "HB_SAVE", tabId: 17, configuration: definition }, { id: "attacker", url: popup.url });
  assert.equal(rejected.ok, false);
  const result = await h.dispatch({ type: "HB_SAVE", tabId: 17, configuration: definition });
  assert.equal(result.ok, true);
  assert.equal(h.record().initialCycle, true);
  assert.equal(h.record().phase, "armed");
  assert.equal(h.alarms.size, 1);
  assert.ok(h.messages.every(message => message.id === 17), "configuration must not message other agents");
  h.setNow(h.record().nextRunAt + 5 * 3600000);
  let dispatches = 0;
  h.setWake(async request => {
    dispatches += 1;
    assert.equal(h.record().phase, "dispatching", "persist an attempt before sending");
    assert.equal(h.record().attemptId, request.attemptId);
    return { accepted: true, instanceId: "page-A" };
  });
  await h.trigger();
  assert.equal(dispatches, 1, "missed slots produce one catch-up, not a burst");
  assert.equal(h.record().phase, "active");
  assert.equal(h.record().initialCycle, false);
  await h.trigger();
  assert.equal(dispatches, 1, "duplicate alarm delivery before next due time must not send");
  const chat = { id: "test-extension", frameId: 0, tab: h.tabs.get(17) };
  const state = phase => h.dispatch({ type: "HB_STATE", scheduleId: h.record().id, instanceId: "page-A", phase, detail: "Human input needed" }, chat);
  await state("sleeping");
  assert.equal(h.record().phase, "sleeping");
  await state("blocked");
  assert.equal(h.alarms.size, 0);
  await state("sleeping");
  assert.equal(h.record().phase, "blocked", "IDLE cannot silently override a human-input block");
  await h.dispatch({ type: "HB_CONTROL", tabId: 17, action: "resume" });
  assert.equal(h.record().phase, "armed");
  await h.dispatch({ type: "HB_CONTROL", tabId: 17, action: "pause" });
  assert.equal(h.record().phase, "paused");
  assert.equal(h.alarms.size, 0);
  await h.dispatch({ type: "HB_CONTROL", tabId: 17, action: "resume" });
  h.setWake(async () => ({ accepted: false, busy: true }));
  await h.dispatch({ type: "HB_CONTROL", tabId: 17, action: "run" });
  assert.equal(h.record().phase, "active", "busy chats skip a heartbeat without overlapping");
  h.setWake(async () => { throw new Error("Channel closed"); });
  vm.runInContext('config = { ...config, enabled: true, baseUrl: "https://home-assistant.example", notifyAction: "notify.mobile_app_test", token: "test-token" };', h.context);
  await h.dispatch({ type: "HB_CONTROL", tabId: 17, action: "run" });
  await h.flush();
  assert.equal(h.record().phase, "blocked");
  assert.match(h.record().detail, /uncertain/);
  assert.equal(h.alarms.size, 0);
  const failure = JSON.parse(h.fetchCalls.at(-1)[1].body);
  assert.match(failure.message, /Job research.*uncertain/);
  assert.equal(failure.data.actions.length, 1);
  assert.equal(failure.data.actions[0].title, "Dismiss");
  await h.dispatch({ type: "HB_CONTROL", tabId: 17, action: "disable" });
  assert.equal(h.record().enabled, false);
  assert.ok(h.messages.every(message => message.id === 17));
}
async function endToEndCycleTest() {
  const h = await harness();
  const page = contentHarness();
  page.window.location.href = sourceUrl;
  page.window.location.pathname = new URL(sourceUrl).pathname;
  page.document.title = "Job research";
  page.setSelector("#prompt-textarea", [visibleElement("")]);
  const sender = { id: "test-extension", frameId: 0, tab: { id: 17, url: sourceUrl, title: "Job research" } };
  page.setRequestHandler(request => h.dispatch(request, sender));
  page.api.setHeartbeatSnapshotForTest("[[LOGIC:IDLE]]");
  page.api.completeHeartbeatCycleForTest();
  h.setPageHandler((id, request) => {
    assert.equal(id, 17, "all content commands must stay in the scheduled chat");
    if (request.type === "GET_STATUS") return page.api.publicStatus();
    if (request.type === "HEARTBEAT_IDENTITY") return page.api.heartbeatIdentity();
    if (request.type === "HEARTBEAT_CONFIG") return page.api.configureHeartbeat(request.schedule);
    if (request.type === "HEARTBEAT_WAKE") return page.api.acceptHeartbeat(request);
    if (request.type === "HEARTBEAT_RESUME") return page.api.resumeHeartbeatLocally(request.schedule);
    throw new Error(`Unexpected ${request.type}`);
  });
  const saved = await h.dispatch({ type: "HB_SAVE", tabId: 17, configuration: definition });
  assert.equal(saved.ok, true);
  assert.equal(page.api.state.logicPhase, "sleeping");
  for (let cycle = 0; cycle < 2; cycle += 1) {
    h.setNow(h.record().nextRunAt);
    await h.trigger();
    await h.flush();
    await h.dispatch({ type: "HB_GET", tabId: 17 });
    assert.equal(page.api.state.logicPhase, "sleeping", "the agent returns to sleep on IDLE");
    assert.equal(h.record().phase, "sleeping", "the scheduler persists the completed cycle");
    assert.equal(h.record().initialCycle, false);
    assert.equal(h.alarms.size, 1);
  }
  assert.equal(h.messages.filter(item => item.request.type === "HEARTBEAT_WAKE").length, 2);
  page.api.stopLogicMode();
  await h.flush();
  await h.dispatch({ type: "HB_GET", tabId: 17 });
  assert.equal(h.record().enabled, false);
  assert.equal(page.api.state.running, false);
  assert.equal(h.alarms.size, 0);
}
async function restartAndRolloverTests() {
  const h = await harness();
  await h.dispatch({ type: "HB_SAVE", tabId: 17, configuration: definition });
  const record = h.record();
  const restart = await harness({ [KEY]: { [record.id]: { ...record, phase: "dispatching" } } });
  assert.equal(restart.record().phase, "blocked");
  assert.equal(restart.messages.filter(message => message.request.type === "HEARTBEAT_WAKE").length, 0);
  const sleeping = await harness({ [KEY]: { [record.id]: { ...record, phase: "sleeping" } } });
  assert.equal(sleeping.alarms.size, 1, "worker startup restores the missing alarm");
  sleeping.tabs.set(88, { id: 88, url: sourceUrl, title: "Duplicate" });
  const duplicate = await sleeping.dispatch({ type: "HB_ATTACH", instanceId: "other-page" }, { id: "test-extension", tab: sleeping.tabs.get(88) });
  assert.equal(duplicate.schedule, null, "a duplicate tab cannot steal ownership");
  sleeping.tabs.delete(88);
  const rollover = { sourceUrl, sourceTabId: 17, projectSegment: "g-p-0123456789abcdef0123456789abcdef-job-search" };
  await sleeping.context.HeartbeatScheduler.transfer(rollover, { id: 22, url: "https://chatgpt.com/" });
  assert.equal(rollover.heartbeatSchedule.id, record.id);
  assert.equal(sleeping.record().pendingDestination, true);
  const destination = `https://chatgpt.com/g/${rollover.projectSegment}/c/destination`;
  const wrong = await sleeping.dispatch({ type: "HB_STATE", scheduleId: record.id, instanceId: "new-page", phase: "active" }, { id: "test-extension", tab: { id: 22, url: "https://chatgpt.com/c/unrelated" } });
  assert.equal(wrong.schedule, null);
  await sleeping.dispatch({ type: "HB_STATE", scheduleId: record.id, instanceId: "new-page", phase: "active" }, { id: "test-extension", tab: { id: 22, url: destination } });
  assert.equal(sleeping.record().url, destination);
  assert.equal(sleeping.record().pendingDestination, false);
}

async function temporaryRolloverUrlTests() {
  const projectSegment = "g-p-0123456789abcdef0123456789abcdef-job-search";
  const temporaryUrl = `https://chatgpt.com/g/${projectSegment}/c/local-chatgpt%3Atemporary-id`;
  const destination = `https://chatgpt.com/g/${projectSegment}/c/permanent-id`;
  for (const initialUrl of ["https://chatgpt.com/", temporaryUrl]) {
    for (const phase of ["active", "paused"]) {
      const h = await harness();
      await h.dispatch({ type: "HB_SAVE", tabId: 17, configuration: definition });
      const id = h.record().id;
      h.local.values[KEY][id].phase = phase;
      const rollover = { sourceUrl, sourceTabId: 17, projectSegment };
      await h.context.HeartbeatScheduler.transfer(rollover, { id: 17, url: initialUrl });
      assert.equal(h.record().url, sourceUrl);
      assert.equal(h.record().pendingDestination, true, "a local ID must remain a pending destination");
      const update = url => h.dispatch({ type: "HB_STATE", scheduleId: id, instanceId: "rollover-page", phase: "active" },
        { id: "test-extension", tab: { id: 17, url } });
      await update(sourceUrl);
      assert.equal(h.record().pendingDestination, true, "late source state must not finish the destination binding");
      const temporary = await update(temporaryUrl);
      assert.equal(temporary.schedule.pendingDestination, true);
      assert.equal(h.record().url, sourceUrl);
      assert.equal(h.record().phase, phase);

      // The content script permits the same verified project during the
      // pending transition, including after Send obtains the permanent URL.
      const page = contentHarness();
      page.window.location = new URL(temporaryUrl);
      Object.assign(page.api.state, { running: true, mode: "logic", logicPhase: "monitoring" });
      page.api.configureHeartbeat(temporary.schedule);
      assert.equal(page.api.heartbeatMatchesLocation(), true);
      page.window.location = new URL(destination);
      assert.equal(page.api.heartbeatMatchesLocation(), true);
      const final = await update(destination);
      assert.equal(final.schedule.url, destination);
      assert.equal(final.schedule.pendingDestination, false);
      assert.equal(final.schedule.phase, phase, "binding must not unpause a schedule");
      page.api.configureHeartbeat(final.schedule);
      assert.equal(page.api.heartbeatMatchesLocation(), true);
      page.window.location = new URL(sourceUrl.replace(/source$/, "another-chat"));
      assert.equal(page.api.heartbeatMatchesLocation(), false, "after binding, other chats in the project are refused");
      assert.equal((await update(temporaryUrl)).schedule, null, "late temporary state cannot replace the permanent binding");
      assert.equal((await update(sourceUrl)).schedule, null, "late source state cannot replace the permanent binding");
      assert.equal(h.messages.some(item => item.request.type === "HEARTBEAT_WAKE"), false);
    }
  }
  const h = await harness();
  h.tabs.set(17, { id: 17, url: temporaryUrl });
  const save = await h.dispatch({ type: "HB_SAVE", tabId: 17, configuration: definition });
  assert.equal(save.ok, false, "new schedules also require permanent conversation IDs");
  assert.equal(h.record(), undefined);
}
module.exports = { harness, sourceUrl, popup, definition };
if (require.main === module) (async () => { await clockTests(); await schedulerTests(); await restartAndRolloverTests(); await temporaryRolloverUrlTests(); await endToEndCycleTest(); console.log("heartbeat scheduler tests passed"); })().catch(error => { console.error(error); process.exitCode = 1; });
