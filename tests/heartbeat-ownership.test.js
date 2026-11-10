/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { harness, sourceUrl, definition } = require("./heartbeat.test.js");
const { contentHarness, visibleElement } = require("./rollover.test.js");

async function setup(phase = "sleeping") {
  const h = await harness();
  await h.dispatch({ type: "HB_SAVE", tabId: 17, configuration: { ...definition, intervalMinutes: 23 } });
  Object.assign(h.record(), { phase, enabled: phase !== "disabled", instanceId: "retired-page" });
  const sender = { id: "test-extension", frameId: 0, tab: { id: 17, url: sourceUrl } };
  const request = { type: "HB_AUTO_IDLE", url: sourceUrl, instanceId: "current-page", message: "Do not replace settings", limit: 999 };
  h.setPageHandler((id, message) => {
    if (message.type === "HEARTBEAT_IDENTITY") return { instanceId: "current-page", url: h.tabs.get(id)?.url };
    if (message.type === "HEARTBEAT_CONFIG") return { instanceId: "current-page" };
    throw new Error(`Unexpected command ${message.type}`);
  });
  return { h, sender, request };
}

async function runTests() {
  for (const phase of ["sleeping", "armed", "awaiting_idle", "paused", "disabled", "blocked", "active", "dispatching"]) {
    const { h, sender, request } = await setup(phase);
    const original = structuredClone(h.record());
    if (phase === "disabled") {
      const attach = await h.dispatch({ type: "HB_ATTACH", instanceId: request.instanceId }, sender);
      assert.equal(attach.schedule, null, "disabled schedules are skipped at startup, reproducing the reported path");
    }
    const result = await h.dispatch(request, sender);
    assert.equal(result.ok, true, phase);
    assert.equal(result.schedule.instanceId, "current-page", `${phase}: rebind a verified replacement page`);
    assert.equal(result.schedule.id, original.id);
    assert.equal(result.schedule.intervalMinutes, 23);
    assert.equal(result.schedule.message, definition.message);
    assert.equal(result.schedule.limit, definition.limit);
    assert.equal(h.alarms.size, 0, "ownership recovery alone must not wake or arm a chat");
    const protectedPhase = ["paused", "disabled", "blocked"].includes(phase);
    const interrupted = ["active", "dispatching"].includes(phase);
    assert.equal(result.schedule.phase, protectedPhase ? phase : interrupted ? "blocked" : "awaiting_idle");
    if (interrupted) assert.match(result.schedule.detail, /reloaded during an active cycle/);
    const update = { type: "HB_STATE", scheduleId: original.id, phase: "sleeping", instanceId: "current-page" };
    await h.dispatch(update, sender);
    assert.equal(h.alarms.size, protectedPhase || interrupted ? 0 : 1);
    const after = structuredClone(h.record());
    for (const type of ["HB_AUTO_IDLE", "HB_ATTACH"]) {
      const old = await h.dispatch({ ...request, type, instanceId: "retired-page" }, sender);
      if (type === "HB_ATTACH" && !after.enabled) assert.equal(old.schedule, null);
      else assert.equal(old.ok, false, `${phase}/${type}: a delayed retired page cannot take ownership back`);
      assert.deepEqual(h.record(), after);
    }
    const oldState = await h.dispatch({ ...update, instanceId: "retired-page", phase: "active" }, sender);
    assert.equal(oldState.ok, false);
    assert.equal(h.messages.some(item => item.request.type === "HEARTBEAT_WAKE"), false);
    assert.ok(h.messages.every(item => item.id === 17), "do not message other agents");
  }

  for (const oldOwner of ["closed", "navigated", "still-open"]) {
    const { h, sender, request } = await setup();
    h.tabs.set(99, { id: 99, url: sourceUrl });
    if (oldOwner === "closed") h.tabs.delete(17);
    if (oldOwner === "navigated") h.tabs.set(17, { id: 17, url: "https://chatgpt.com/c/unrelated" });
    const before = structuredClone(h.record());
    const priorMessages = h.messages.length;
    const result = await h.dispatch(request, { ...sender, tab: { id: 99, url: sourceUrl } });
    if (oldOwner === "still-open") {
      assert.equal(result.schedule, null);
      assert.match(result.detail, /another open tab/);
      assert.deepEqual(h.record(), before);
      assert.equal(h.messages.length, priorMessages, "a real ownership conflict needs no tab messages");
    } else {
      assert.equal(result.schedule.tabId, 99);
      assert.equal(result.schedule.instanceId, "current-page");
      assert.ok(h.messages.slice(priorMessages).every(item => item.id === 99));
      assert.equal(h.alarms.size, 0);
    }
  }

  for (const race of ["target-navigation", "owner-returns", "wrong-identity"]) {
    const { h, sender, request } = await setup();
    const before = structuredClone(h.record());
    if (race === "owner-returns") {
      h.tabs.set(17, { id: 17, url: "https://chatgpt.com/c/unrelated" });
      h.tabs.set(99, { id: 99, url: sourceUrl });
      sender.tab.id = 99;
    }
    h.setPageHandler((id, message) => {
      assert.equal(message.type, "HEARTBEAT_IDENTITY");
      if (race === "target-navigation") h.tabs.set(id, { id, url: "https://chatgpt.com/c/another" });
      if (race === "owner-returns") h.tabs.set(17, { id: 17, url: sourceUrl });
      return { instanceId: race === "wrong-identity" ? "someone-else" : "current-page", url: sourceUrl };
    });
    const result = await h.dispatch(request, sender);
    assert.ok(result.ok === false || result.schedule === null);
    assert.deepEqual(h.record(), before, race);
  }

  const { h, sender, request } = await setup();
  const attached = await h.dispatch({ type: "HB_ATTACH", instanceId: request.instanceId }, sender);
  assert.equal(attached.schedule.instanceId, "current-page");
  assert.equal(attached.schedule.phase, "sleeping", "ordinary attachment keeps its existing sleep behavior");
  assert.equal(h.alarms.size, 1);

  // Exercise the page's actual IDLE transition and identity response as well as
  // the scheduler, including the disabled-record startup-attachment gap.
  for (const phase of ["sleeping", "disabled"]) {
    const { h, sender } = await setup(phase);
    const page = contentHarness();
    page.window.location = new URL(sourceUrl);
    page.setSelector("#prompt-textarea", [visibleElement("")]);
    page.api.setResponseForTest("[[LOGIC:IDLE]]");
    page.api.setHeartbeatSnapshotForTest("[[LOGIC:IDLE]]");
    Object.assign(page.api.state, { running: true, runId: 1, mode: "logic", logicPhase: "monitoring", message: "Continue", limit: 5 });
    page.setRequestHandler(message => h.dispatch(message, sender));
    h.setPageHandler((id, message) => {
      assert.equal(id, 17);
      if (message.type === "HEARTBEAT_IDENTITY") return page.api.heartbeatIdentity();
      if (message.type === "HEARTBEAT_CONFIG") return page.api.configureHeartbeat(message.schedule);
      throw new Error(`Unexpected command ${message.type}`);
    });
    await page.api.runLogicMode(1, true);
    await h.dispatch({ type: "HB_GET", tabId: 17 });
    await h.flush();
    assert.equal(h.record().instanceId, page.api.heartbeatIdentity().instanceId);
    assert.doesNotMatch(page.api.state.detail, /another tab or page instance|another open tab/);
    assert.equal(h.record().phase, phase);
    assert.equal(page.api.state.logicPhase, phase === "sleeping" ? "sleeping" : "idle");
    assert.equal(h.messages.some(item => item.request.type === "HEARTBEAT_WAKE"), false);
  }
  console.log("heartbeat ownership tests passed");
}

runTests().catch(error => { console.error(error); process.exitCode = 1; });
