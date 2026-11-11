/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { backgroundHarness, contentHarness, visibleElement } = require("./rollover.test.js");
const { harness, sourceUrl, definition } = require("./heartbeat.test.js");
(async () => {
  const h = await backgroundHarness();
  const sender = { id: "extension-test-id", frameId: 0, url: sourceUrl, tab: { id: 17, url: sourceUrl } };
  const project = new URL(sourceUrl).pathname.split("/")[2];
  const payload = { projectSegment: project, previousTitle: "Original agent", message: "Continue", count: 0, limit: 5 };
  const others = [18, 19].map(id => ({ ...sender, tab: { id, url: sourceUrl.replace("source", `agent-${id}`) } }));
  const preparations = await Promise.all([sender, ...others].map(s => h.api.prepareLogicRollover(payload, s)));
  assert.equal(Object.keys((await h.session.get("logicModePendingRollovers")).logicModePendingRollovers).length, 3,
    "concurrent prepares must preserve every independent agent's record");
  const home = `https://chatgpt.com/g/${project}`;
  const child = { ...sender, url: home, tab: { id: 100, openerTabId: 17, url: home } };
  h.api.recordChildForTest(100, 17);
  const claimed = await h.api.claimLogicRollover({ requestId: preparations[0].requestId }, child);
  assert.equal(claimed.pending.sourceTabId, 17, "only a child created after preparation inherits its own opener's handoff");
  assert.equal((await h.api.claimLogicRollover({ requestId: preparations[0].requestId }, child)).pending, null);
  await assert.rejects(h.api.completeLogicRollover(preparations[0], others[0]), /receipt/);
  assert.equal((await h.api.completeLogicRollover({ ...preparations[0], type: "LOGIC_ROLLOVER_CHECK" }, child)).ok, true);
  await h.api.completeLogicRollover(preparations[0], child);
  assert.equal((await h.api.cancelLogicRollover(preparations[0], sender)).completed, true);
  const unfinished = await h.api.prepareLogicRollover(payload, sender);
  await h.api.claimLogicRollover(unfinished, { ...sender, tab: { id: 17, url: home } });
  assert.equal((await h.api.cancelLogicRollover(unfinished, sender)).completed, false,
    "a claim alone does not prove successful continuation");
  await assert.rejects(h.api.completeLogicRollover({ ...unfinished, type: "LOGIC_ROLLOVER_CHECK" }, child), /receipt/);
  assert.equal((await h.api.cancelLogicRollover({ requestId: "absent" }, sender)).completed, undefined,
    "a missing receipt does not prove success");

  for (const invalid of [
    { ...sender, frameId: 1 },
    { ...sender, url: sourceUrl + "-another" },
    { ...sender, url: sourceUrl.replace("https:", "http:"), tab: { id: 17, url: sourceUrl.replace("https:", "http:") } },
    { ...sender, id: "foreign-extension" }
  ]) assert.equal((await h.dispatch({ type: "LOGIC_ROLLOVER_PREPARE", ...payload }, invalid)).ok, false);

  const page = contentHarness();
  page.window.location = new URL(home + "/c/existing-agent");
  page.setSelector("#prompt-textarea", [visibleElement("")]);
  page.api.setTimeoutSnapshotsForTest(() => ({ element: visibleElement("Existing task"), text: "Existing task" }));
  await assert.rejects(page.api.startClaimedLogicRollover({ ...payload, requestId: "pending", sourceUrl }), /could not be verified/,
    "an existing agent's history must reject handoff startup");

  h.api.setConfigForTest({ enabled: true, baseUrl: "https://home-assistant.example", notifyAction: "notify.mobile_app_test", token: "test-token" });
  h.api.allowNotificationForTest();
  const notification = { type: "HA_NOTIFY_USER_INPUT", brief: "Review this task." };
  const duplicate = { ...sender, tab: { id: 99, url: sourceUrl } };
  const replies = await Promise.all([h.dispatch(notification, sender), h.dispatch(notification, duplicate)]);
  assert.ok(replies.every(r => r.ok));
  assert.notEqual(replies[0].requestId, replies[1].requestId, "duplicate chat tabs cannot reassign phone approval ownership");
  for (const wrong of [duplicate, { ...sender, url: sourceUrl + "-other", tab: { id: 17, url: sourceUrl + "-other" } }]) {
    assert.equal((await h.dispatch({ type: "HA_CANCEL_REQUEST", requestId: replies[0].requestId }, wrong)).ok, false);
  }
  const saved = (await h.session.get("homeAssistantPendingRequests")).homeAssistantPendingRequests;
  assert.equal(Object.keys(saved).length, 2);
  await h.api.handleNotificationAction({ action: saved[replies[0].requestId].approveAction });
  assert.equal(h.tabMessages.at(-1)[0], 17);
  assert.equal(h.tabMessages.at(-1)[2].frameId, 0);
  assert.ok(h.fetchCalls.every(([, options]) => options.redirect === "error"));

  const heartbeat = await harness();
  await heartbeat.dispatch({ type: "HB_SAVE", tabId: 17, configuration: definition });
  const original = heartbeat.record().id;
  const renamed = sourceUrl.replace("job-search", "new-name");
  heartbeat.tabs.set(17, { id: 17, url: renamed, title: "Renamed project" });
  const schedule = await heartbeat.dispatch({ type: "HB_GET", tabId: 17 });
  assert.equal(schedule.schedule.id, original, "project rename retains the original schedule");
  await heartbeat.dispatch({ type: "HB_SAVE", tabId: 17, configuration: definition });
  assert.equal(Object.keys(heartbeat.local.values.logicHeartbeatSchedules).length, 1);
  assert.equal(heartbeat.context.Heartbeat.sameChat(sourceUrl, sourceUrl.replace("012345", "abcde0")), false);
  const currentSender = { id: "test-extension", frameId: 0, url: renamed, tab: heartbeat.tabs.get(17) };
  const transition = await heartbeat.dispatch({ type: "LOGIC_ROLLOVER_PREPARE", ...payload,
    projectSegment: new URL(renamed).pathname.split("/")[2] }, currentSender);
  assert.equal(transition.ok, true);
  heartbeat.tabs.set(17, { id: 17, url: home });
  const destinationSender = { ...currentSender, url: home, tab: heartbeat.tabs.get(17) };
  const transfer = await heartbeat.dispatch({ type: "LOGIC_ROLLOVER_CLAIM", requestId: transition.requestId }, destinationSender);
  assert.ok(transfer.pending);
  assert.equal(heartbeat.record().url, renamed, "claim alone cannot move heartbeat ownership");
  const savedDestination = home + "/c/new-agent";
  heartbeat.tabs.set(17, { id: 17, url: savedDestination });
  const receipt = await heartbeat.dispatch({ type: "LOGIC_ROLLOVER_COMPLETE", requestId: transition.requestId },
    { ...destinationSender, url: savedDestination, tab: heartbeat.tabs.get(17) });
  assert.equal(receipt.ok, true);
  assert.equal(heartbeat.record().url, savedDestination, "confirmed continuation transfers its schedule");
  console.log("handoff isolation, receipts, notification ownership, sender security and stable project routing passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
