/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { fixture } = require("./delivery-timeout.test.js");
const { sourceUrl } = require("./heartbeat.test.js");
const { backgroundHarness } = require("./rollover.test.js");
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
  let f = prepare();
  const click = f.send.click;
  f.send.click = () => {
    assert.equal(f.messages.some(r => r.type === "HA_CANCEL_REQUEST"), false,
      "keep the phone request until the chat send is confirmed");
    click();
  };
  await f.run();
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0].includes('"submissionId":"submission-1"'));
  assert.ok(f.sends[0].includes("check whether it answers your request"));
  assert.equal(f.api.state.count, 1);
  assert.equal(f.api.state.error, false);
  const outcome = f.messages.findIndex(r => r.type === "SL_RESULT" && r.outcome === "delivered");
  const cancel = f.messages.findIndex(r => r.type === "HA_CANCEL_REQUEST");
  assert.ok(outcome >= 0 && cancel > outcome);
  assert.equal(f.messages[cancel].requestId, "phone-request");
  assert.equal(f.messages.filter(r => r.type === "HA_CANCEL_REQUEST").length, 1);

  // Empty inboxes preserve the input wait. Duplicate wakes only signal its one runner.
  f = prepare(); f.setPending(false);
  let woke = false;
  f.onTick(() => {
    if (woke || f.api.state.logicPhase !== "waiting_user"
      || !f.messages.some(r => r.type === "SL_TAKE")) return;
    woke = true;
    assert.equal(f.messages.some(r => r.type === "HA_CANCEL_REQUEST"), false);
    assert.equal(f.api.acceptServerWake({ url: sourceUrl + "-wrong" }).accepted, false);
    f.setPending(true);
    assert.equal(f.api.acceptServerWake({ url: sourceUrl }).accepted, true);
    assert.equal(f.api.acceptServerWake({ url: sourceUrl }).accepted, true);
  });
  await f.run();
  assert.equal(woke, true);
  assert.equal(f.sends.length, 1);

  // Drafts, Pause, generation, and message limits leave the form queued.
  for (const barrier of ["draft", "paused", "generating", "limit"]) {
    f = prepare();
    Object.assign(f.api.state, { logicPhase: "waiting_user", homeAssistantRequestId: "phone-request" });
    if (barrier === "draft") f.composer.innerText = f.composer.textContent = "My unfinished reply";
    if (barrier === "paused") f.api.state.paused = true;
    if (barrier === "generating") f.setSelector("button[data-testid='stop-button']", [f.composer]);
    if (barrier === "limit") f.api.state.count = f.api.state.limit;
    let ticks = 0;
    f.onTick(() => {
      if (++ticks < 8) return;
      assert.equal(f.messages.some(r => r.type === "SL_TAKE"), false, barrier);
      assert.equal(f.messages.some(r => r.type === "HA_CANCEL_REQUEST"), false, barrier);
      f.api.state.running = false;
    });
    await f.api.waitForServerOrUserInput(1, { element: f.user(), text: f.user().textContent });
    assert.equal(f.sends.length, 0, barrier);
  }

  // A phone reply arriving while a server event is being claimed cannot also send.
  f = prepare();
  f.onTake(async () => {
    const result = await f.api.handleHomeAssistantResponse({
      requestId: "phone-request", message: "Phone reply", tabUrl: sourceUrl
    });
    assert.equal(result.accepted, false);
  });
  await f.run();
  assert.equal(f.sends.length, 1);
  assert.ok(!f.sends[0].includes("Phone reply"));

  // A phone send already in progress wins; the server event stays in the inbox.
  f = prepare(); f.setPending(false);
  let phone = null;
  f.onTick(() => {
    if (phone || f.api.state.logicPhase !== "waiting_user"
      || !f.messages.some(r => r.type === "SL_TAKE")) return;
    phone = f.api.handleHomeAssistantResponse({
      requestId: "phone-request", message: "Phone reply", tabUrl: sourceUrl
    });
    f.setPending(true);
    f.api.acceptServerWake({ url: sourceUrl });
  });
  await f.run();
  assert.equal((await phone).accepted, true);
  assert.deepEqual(f.sends, ["Phone reply"]);
  assert.equal(f.messages.some(r => r.type === "SL_RESULT"), false);

  // A manual chat message wins without claiming or sending a form event.
  f = prepare();
  const previous = { element: f.user(), text: f.user().textContent };
  f.newUser();
  Object.assign(f.api.state, { logicPhase: "waiting_user" });
  assert.equal((await f.api.waitForServerOrUserInput(1, previous)).element, f.user());
  assert.equal(f.messages.some(r => r.type === "SL_TAKE"), false);

  // Stopping/navigating while a claim is pending releases it without a send.
  for (const interruption of ["stop", "navigate"]) {
    f = prepare();
    f.onTake(async () => {
      if (interruption === "stop") f.api.stopLoop();
      else f.window.location = new URL(sourceUrl + "-different");
    });
    await f.run();
    assert.equal(f.sends.length, 0, interruption);
    assert.ok(f.messages.some(r => r.type === "SL_RESULT" && r.outcome === "unsent"), interruption);
  }
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
  console.log("server events satisfy USER_INPUT; drafts, pause, limits and competing replies remain protected");
}
tests().catch(error => { console.error(error); process.exitCode = 1; });
