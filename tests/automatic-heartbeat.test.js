/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { harness, sourceUrl } = require("./heartbeat.test.js");
const { fixture } = require("./delivery-timeout.test.js");
const { visibleElement } = require("./rollover.test.js");
const flush = () => new Promise(setImmediate);

async function setup() {
  const h = await harness();
  const f = fixture(["idle"]);
  f.hide();
  f.window.location = new URL(sourceUrl);
  f.assistant().textContent = "Finished.\n[[LOGIC:IDLE]]";
  const originalAssistant = f.assistant();
  let manualReply;
  f.api.setTimeoutSnapshotsForTest(role => {
    const element = role === "user" ? f.user() : manualReply && f.assistant() === originalAssistant ? manualReply : f.assistant();
    return { element, text: element.textContent };
  });
  const requests = [];
  const sender = () => ({ id: "test-extension", frameId: 0, tab: { id: 17, url: f.window.location.href } });
  f.setRequestHandler(request => {
    requests.push(request);
    if (request.type.startsWith("HB_")) return h.dispatch(request, sender());
    return Promise.resolve({ ok: true, enabled: false });
  });
  h.setPageHandler((id, request) => {
    assert.equal(id, 17, "other agents must never be messaged");
    if (request.type === "GET_STATUS") return f.api.publicStatus();
    if (request.type === "HEARTBEAT_IDENTITY") return f.api.heartbeatIdentity();
    if (request.type === "HEARTBEAT_CONFIG") return f.api.configureHeartbeat(request.schedule);
    if (request.type === "HEARTBEAT_WAKE") return f.api.acceptHeartbeat(request);
    if (request.type === "HEARTBEAT_RESUME") return f.api.resumeHeartbeatLocally(request.schedule);
    throw new Error(`Unexpected page command ${request.type}`);
  });
  const barrier = () => h.dispatch({ type: "HB_GET", tabId: 17 });
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await flush(); await barrier();
      if (f.api.state.logicPhase === "sleeping" && h.record()?.phase === "sleeping") return;
    }
    assert.fail(`cycle did not sleep: ${f.api.state.detail}`);
  };
  const reply = flag => {
    manualReply = Object.assign(visibleElement(`Manual work completed.\n[[LOGIC:${flag}]]`), { rank: f.user().rank + 1, querySelector: () => null });
  };
  return { h, f, requests, sender, barrier, settle, reply };
}

async function runTests() {
  let x = await setup();
  await x.f.run(); await x.barrier(); await flush();
  assert.equal(x.h.record().automatic, true);
  assert.equal(x.h.record().intervalMinutes, 60);
  assert.equal(x.h.record().phase, "sleeping");
  assert.equal(x.h.alarms.size, 1);
  assert.equal(x.f.api.state.logicPhase, "sleeping");
  assert.deepEqual(x.f.sends, [], "IDLE schedules but never sends immediately");
  const firstWake = x.h.record().nextRunAt;
  await x.h.dispatch({ type: "HB_AUTO_IDLE", url: sourceUrl, instanceId: x.h.record().instanceId, message: "different", limit: 1 }, x.sender());
  assert.equal(Object.keys(x.h.local.values.logicHeartbeatSchedules).length, 1);
  assert.equal(x.h.record().nextRunAt, firstWake, "duplicate idle does not reset or replace schedule");
  assert.equal(x.h.record().message, "Configured followup");

  x.f.composer.innerText = x.f.composer.textContent = "Still typing";
  x.f.api.checkSleepingActivity();
  await x.barrier();
  assert.equal(x.h.record().nextRunAt, firstWake, "typing must not suspend the heartbeat");
  assert.equal(x.f.api.state.logicPhase, "sleeping");
  x.h.setNow(firstWake);
  await x.h.trigger();
  assert.equal(x.h.record().phase, "sleeping");
  assert.equal(x.h.record().nextRunAt, firstWake + 60000);
  assert.equal(x.h.alarms.size, 1);
  assert.deepEqual(x.f.sends, []);
  assert.equal(x.f.composer.textContent, "Still typing");
  assert.equal(x.f.api.state.paused, false);

  x.f.composer.innerText = x.f.composer.textContent = "";
  x.f.newUser();
  x.f.api.checkSleepingActivity();
  await x.barrier();
  assert.equal(x.h.record().suspendUntilIdle, true);
  assert.equal(x.h.record().nextRunAt, null);
  assert.equal(x.h.alarms.size, 0);
  assert.deepEqual(x.f.sends, [], "a manual prompt must not be followed by a duplicate startup");
  const duringManualRestart = await harness(x.h.local.values);
  assert.equal(duringManualRestart.alarms.size, 0, "manual-cycle suspension survives worker restart");
  x.h.setNow(firstWake + 5 * 3600000);
  await x.h.trigger();
  assert.deepEqual(x.f.sends, [], "stale alarms cannot send during manual work");
  const manualEnd = firstWake + 5 * 3600000;
  x.reply("CONTINUE");
  await x.settle();
  assert.deepEqual(x.f.sends, ["Configured followup"], "the manual reply enters the regular Logic loop");
  assert.equal(x.h.record().suspendUntilIdle, false);
  assert.equal(x.h.record().nextRunAt, manualEnd + 3600000, "next hourly heartbeat starts from the new IDLE");

  // A manual send that races the alarm must win even before the poll runs.
  x = await setup();
  await x.f.run(); await x.barrier();
  x.f.newUser();
  x.h.setNow(x.h.record().nextRunAt);
  await x.h.trigger();
  assert.equal(x.h.record().suspendUntilIdle, true);
  assert.equal(x.h.alarms.size, 0);
  assert.deepEqual(x.f.sends, []);
  x.reply("IDLE");
  await x.settle();
  assert.equal(x.h.alarms.size, 1);

  for (const action of ["pause", "disable"]) {
    x = await setup();
    await x.f.run(); await x.barrier();
    x.f.newUser(); x.f.api.checkSleepingActivity(); await x.barrier();
    await x.h.dispatch({ type: "HB_CONTROL", tabId: 17, action });
    x.reply("IDLE");
    for (let i = 0; i < 30; i++) { await flush(); await x.barrier(); }
    assert.equal(x.h.alarms.size, 0, `${action} during manual work must survive IDLE`);
    assert.equal(x.h.record().phase, action === "pause" ? "paused" : "disabled");
    assert.deepEqual(x.f.sends, []);
  }

  // No timer is created until the page confirms its idle transition.
  const h = await harness();
  const sender = { id: "test-extension", frameId: 0, tab: { id: 17, url: sourceUrl } };
  const request = { type: "HB_AUTO_IDLE", url: sourceUrl, instanceId: "page-A", message: "Continue", limit: 5 };
  assert.equal((await h.dispatch(request, { ...sender, id: "attacker" })).ok, false);
  assert.equal((await h.dispatch({ ...request, url: "https://chatgpt.com/c/other" }, sender)).ok, false);
  assert.equal(h.record(), undefined);
  const created = await h.dispatch(request, sender);
  assert.equal(created.schedule.phase, "awaiting_idle");
  assert.equal(h.alarms.size, 0);
  await h.trigger();
  assert.equal(h.messages.some(message => message.request.type === "HEARTBEAT_WAKE"), false);
  const restarted = await harness(h.local.values);
  assert.equal(restarted.alarms.size, 0, "an interrupted idle transition cannot arm on worker restart");
  h.tabs.set(99, { id: 99, url: sourceUrl });
  const other = await h.dispatch(request, { ...sender, tab: { id: 99, url: sourceUrl } });
  assert.equal(other.schedule, null);
  assert.equal(h.record().tabId, 17, "another tab cannot steal the schedule");

  for (const action of ["pause", "disable"]) {
    const h = await harness();
    await h.dispatch(request, sender);
    await h.dispatch({ type: "HB_CONTROL", tabId: 17, action });
    const before = structuredClone(h.record());
    await h.dispatch(request, sender);
    assert.deepEqual(h.record(), before, "automatic IDLE preserves an existing explicit control");
    assert.equal(h.alarms.size, 0);
  }
  for (const url of ["https://chatgpt.com/", "https://chatgpt.com/c/local-chatgpt%3Atemporary"]) {
    const h = await harness();
    h.tabs.set(17, { id: 17, url });
    const result = await h.dispatch({ ...request, url }, { ...sender, tab: { id: 17, url } });
    assert.equal(result.ok, false);
    assert.equal(h.record(), undefined);
  }

  for (const interruption of ["stop", "navigation", "user"]) {
    x = await setup();
    let release;
    x.f.setRequestHandler(async message => {
      if (!message.type.startsWith("HB_")) return { ok: true, enabled: false };
      const result = await x.h.dispatch(message, x.sender());
      if (message.type === "HB_AUTO_IDLE") await new Promise(resolve => { release = resolve; });
      return result;
    });
    const run = x.f.run();
    for (let i = 0; !release && i < 50; i++) await flush();
    assert.ok(release);
    assert.equal(x.h.alarms.size, 0);
    if (interruption === "stop") {
      x.f.api.stopLogicMode();
      for (let i = 0; x.f.api.state.running && i < 50; i++) await flush();
    } else if (interruption === "navigation") {
      x.f.window.location = new URL("https://chatgpt.com/c/another");
      x.h.tabs.set(17, { id: 17, url: x.f.window.location.href });
    } else x.f.newUser();
    release();
    await run; await x.barrier();
    assert.equal(x.h.alarms.size, 0, `${interruption} during automatic setup cannot start a timer`);
    if (interruption === "stop") assert.equal(x.h.record().enabled, false);
    if (interruption === "navigation") assert.equal(x.h.record().phase, "awaiting_idle");
    if (interruption === "user") {
      assert.equal(x.h.record().suspendUntilIdle, true);
      assert.deepEqual(x.f.sends, []);
      x.reply("IDLE"); await x.settle();
    }
  }
  console.log("automatic heartbeat transition tests passed");
}

runTests().catch(error => { console.error(error); process.exitCode = 1; });
