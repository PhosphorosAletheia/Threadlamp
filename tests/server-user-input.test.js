/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { fixture } = require("./delivery-timeout.test.js");
const { sourceUrl } = require("./heartbeat.test.js");
const { backgroundHarness, visibleElement } = require("./rollover.test.js");
const event = { eventId: "form-1", submissionId: "submission-1", eventType: "form_submitted" };

function prepare() {
  const f = fixture();
  f.hide();
  f.window.location = new URL(sourceUrl);
  f.assistant().textContent = "Please complete the form.\n[[LOGIC:USER_INPUT]]";
  const requests = [];
  let pending = true;
  let onTake = async () => {};
  f.setRequestHandler(async request => {
    requests.push(request);
    if (request.type === "HA_NOTIFY_USER_INPUT") return { ok: true, enabled: true, requestId: "phone-request" };
    if (request.type === "SL_TAKE") {
      await onTake();
      if (!pending) return { ok: true, event: null };
      pending = false;
      return { ok: true, event, attemptId: "attempt-1" };
    }
    return { ok: true, enabled: false };
  });
  return Object.assign(f, {
    messages: requests,
    setPending(value) { pending = value; },
    onTake(fn) { onTake = fn; }
  });
}
async function tests() {
  let f;
  for (const barrier of ["server-event", "queued", "timeout", "stream-error", "draft", "paused", "limit", "maximum-length", "maximum-before-pause", "rerender"]) {
    f = prepare();
    if (barrier === "queued") f.api.queueAdditionalPrompt("Keep queued instructions");
    if (["timeout", "stream-error"].includes(barrier)) {
      f.notice.getBoundingClientRect = () => ({width:100,height:40});
      if (barrier === "stream-error") f.notice.textContent = "Error in message stream Retry";
      f.setAlerts([f.notice]);
    }
    if (barrier === "maximum-before-pause") {
      f.api.state.rolloverEnabled = true;
      f.setAlerts([visibleElement("You have reached the maximum length for this conversation. Please start a new chat.")]);
    }
    let ticks = 0;
    f.onTick(() => {
      if (f.api.state.logicPhase !== "waiting_user") return;
      if (++ticks === 1) {
        if (barrier === "draft") f.composer.innerText = "My unfinished reply";
        if (barrier === "paused") f.api.state.paused = true;
        if (barrier === "limit") f.api.state.count = f.api.state.limit;
        if (barrier === "rerender") {
          const replacement = {...f.user()};
          f.api.setTimeoutSnapshotsForTest(role => {
            const element = role === "user" ? replacement : f.assistant();
            return {element, text:element.textContent};
          });
        }
      }
      assert.equal(f.api.acceptServerWake({url:sourceUrl}).accepted, false, barrier);
      assert.equal(f.api.acceptServerWake({url:sourceUrl}).accepted, false, "duplicate wake is also blocked");
      if (barrier === "maximum-length") {
        f.api.state.rolloverEnabled = true;
        const run = f.api.state.runId;
        f.api.stopForMaximumLength();
        assert.equal(f.api.state.runId, run);
      }
      if (ticks < 8) return;
      assert.equal(f.api.state.logicPhase, "waiting_user", barrier);
      assert.equal(f.messages.some(r => r.type === "SL_TAKE"), false, barrier);
      assert.equal(f.messages.some(r => /LR_PREPARE|LOGIC_ROLLOVER/.test(r.type)), false, barrier);
      assert.equal(f.messages.some(r => r.type === "HA_CANCEL_REQUEST"), false, barrier);
      f.api.state.running = false;
    });
    await f.run();
    assert.equal(ticks, 8, barrier);
    assert.deepEqual(f.sends, [], barrier);
    if (barrier === "queued") assert.equal(f.api.getQueuedPromptForTest().text, "Keep queued instructions");
  }

  // The send boundary rejects an automatic sender even if it calls directly.
  f = prepare(); f.api.state.logicPhase = "waiting_user";
  await assert.rejects(f.api.submitMessage(1, "Continue", "Automatic send"), /waiting for your reply/);
  assert.deepEqual(f.sends, []);

  // An explicit phone reply is still allowed; events remain pending.
  f = prepare();
  let phone;
  f.onTick(() => {
    if (phone || f.api.state.logicPhase !== "waiting_user") return;
    phone = f.api.handleHomeAssistantResponse({requestId:"phone-request",message:"Phone reply",tabUrl:sourceUrl});
    assert.equal(f.api.acceptServerWake({url:sourceUrl}).accepted, false);
  });
  await f.run();
  assert.equal((await phone).accepted, true);
  assert.deepEqual(f.sends, ["Phone reply"]);
  assert.equal(f.messages.some(r => r.type === "SL_TAKE" || r.type === "SL_RESULT"), false);

  // A real new chat message releases the wait, without taking a server event.
  f = prepare();
  Object.assign(f.api.state, {logicPhase:"waiting_user"});
  const previous = {element:f.user(),text:f.user().textContent};
  f.onTick(() => f.newUser());
  assert.equal((await f.api.waitForServerOrUserInput(1, previous)).element, f.user());
  assert.equal(f.messages.some(r => r.type === "SL_TAKE"), false);

  // An older USER_INPUT does not block a timeout on a newer, real user turn.
  f = prepare(); f.newUser(); f.notice.rank = 5;
  f.notice.getBoundingClientRect = () => ({width:100,height:40});
  await f.run();
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0].startsWith("Configured followup"));

  // The cancellation path clears only this request's notification on the phone.
  const background = await backgroundHarness();
  background.api.setConfigForTest({
    enabled: true, baseUrl: "https://home-assistant.example",
    notifyAction: "notify.mobile_app_test_phone", token: "test-token", persistent: true
  });
  const sender = { id: "extension-test-id", tab: { id: 17, url: sourceUrl } };
  const other = { id: "extension-test-id", tab: { id: 99, url: sourceUrl + "-other" } };
  const tag = "chatgpt_logic_phone-request";
  await background.session.set({ homeAssistantPendingRequests: {
    "phone-request": { requestId: "phone-request", tabId: 17, tabUrl: sourceUrl, tag },
    "other-request": { requestId: "other-request", tabId: 99, tabUrl: other.tab.url, tag: "other-tag" }
  } });
  const cancelled = await background.dispatch({ type: "HA_CANCEL_REQUEST", requestId: "phone-request" }, sender);
  assert.equal(cancelled.removed, true);
  assert.deepEqual(JSON.parse(background.fetchCalls.at(-1)[1].body), {
    message: "clear_notification", data: { tag }
  });
  const otherCancelled = await background.dispatch({ type: "HA_CANCEL_REQUEST", requestId: "other-request" }, other);
  assert.equal(otherCancelled.removed, true, "the other agent's request was preserved");
  console.log("USER_INPUT blocks server events, timeout continuation, rollover and DOM remounts; explicit replies remain available");
}
tests().catch(error => { console.error(error); process.exitCode = 1; });
