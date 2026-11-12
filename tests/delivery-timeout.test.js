/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { contentHarness, visibleElement } = require("./rollover.test.js");
const ERROR = "Message delivery timed out. Please try again.";

function fixture(outcomes = ["idle"]) {
  let now = 0, ticks = 0, tick = () => {};
  class Clock extends Date { static now() { return now; } }
  const h = contentHarness({ Date: Clock, setTimeout(fn, ms) {
    return setImmediate(() => {
      assert.ok(++ticks < 500, "a wait did not terminate");
      now += ms; tick(now); fn();
    });
  } });
  h.window.location = new URL("https://chatgpt.com/c/timeout-chat");
  h.document.title = "Timed out research";
  const turn = (rank, text) => Object.assign(visibleElement(text, { "data-message-id": `message-${rank}` }), {
    rank, contains(node) { return node === this; },
    compareDocumentPosition(node) { return node.rank > this.rank ? 4 : 0; }
  });
  let user = turn(1, "Private previous prompt");
  let assistant = turn(2, "Previous completed reply.\n[[LOGIC:CONTINUE]]");
  const notice = turn(3, `${ERROR} Retry`);
  notice.parentElement = h.document.body;
  let visible = true;
  notice.getBoundingClientRect = () => ({ width: visible ? 100 : 0, height: visible ? 40 : 0 });
  const retry = visibleElement("Retry");
  retry.parentElement = notice;
  retry.click = () => { throw new Error("Retry must NEVER be clicked"); };
  h.setSelector("button, [role='button']", [retry]);
  h.api.setTimeoutElementsForTest(role => [role === "user" ? user : assistant]);
  h.api.setTimeoutSnapshotsForTest(role => {
    const element = role === "user" ? user : assistant;
    return { element, text: element.textContent };
  });
  const composer = visibleElement();
  h.setSelector("#prompt-textarea", [composer]);
  const writes = [], sends = [], requests = [];
  h.setRequestHandler(async request => { requests.push(request); return { ok: true, enabled: false }; });
  const send = visibleElement("Send");
  let rank = 3;
  send.click = () => {
    sends.push(composer.innerText);
    composer.innerText = composer.textContent = "";
    const outcome = outcomes.shift() || "idle";
    if (outcome !== "timeout-no-user") user = turn(++rank, sends.at(-1));
    if (outcome.startsWith("timeout")) { notice.rank = ++rank; visible = true; }
    else if (outcome === "delayed-idle") {
      notice.rank = ++rank;
      const readyAt = now + 3000;
      tick = () => {
        if (now < readyAt) return;
        assistant = turn(++rank, "Recovered.\n[[LOGIC:IDLE]]"); visible = false;
        tick = () => {};
      };
    }
    else { assistant = turn(++rank, `Recovered.\n[[LOGIC:${outcome.toUpperCase()}]]`); visible = false; }
    h.setSelector("button[data-testid='send-button']", []);
  };
  h.api.setTimeoutWriterForTest((target, text) => {
    writes.push(text);
    target.innerText = target.textContent = text;
    h.setSelector("button[data-testid='send-button']", [send]);
    return true;
  });
  Object.assign(h.api.state, { running: true, runId: 1, mode: "logic", logicPhase: "monitoring", message: "Configured followup", count: 0, limit: 5 });
  return Object.assign(h, {
    notice, retry, composer, send, writes, sends, requests,
    user: () => user, assistant: () => assistant,
    hide: () => { visible = false; },
    onTick(fn) { tick = fn; },
    advanceClock(ms) { now += ms; },
    newUser() { user = turn(++rank, "Manual message"); },
    setWriter(fn) { h.api.setTimeoutWriterForTest(fn); },
    run: () => h.api.runLogicMode(1, true)
  });
}

async function runTests() {
  let f = fixture();
  let reloads = 0;
  f.window.location.reload = () => { reloads++; };
  assert.equal(f.api.findDeliveryTimeoutNotice(), f.notice);
  await f.run();
  assert.equal(reloads, 1);
  assert.deepEqual(f.writes, [], "reconnection never writes or resends a prompt");
  assert.deepEqual(f.sends, []);
  assert.equal(f.api.state.count, 0, "reload does not consume an automatic message");
  assert.ok(f.requests.find(r => r.type === "LR_PREPARE"));
  assert.ok(f.api.state.paused, "the old page cannot keep sending during reload");

  f = fixture();
  await f.api.checkpointLogicRun();
  f.api.setTimeoutElementsForTest(() => []);
  f.api.setTimeoutSnapshotsForTest(() => ({ element: null, text: "" }));
  f.setSelector("#prompt-textarea", []);
  f.window.location.reload = () => { reloads++; };
  assert.equal(f.api.findDeliveryTimeoutNotice(), f.notice, "captured empty-page timeout is recognized");
  await f.api.recoverDeliveryTimeout(1, f.api.deliveryTimeoutResponse());
  assert.equal(reloads, 2, "empty page reloads using the earlier checkpoint");

  for (const change of ["draft", "queued", "second-timeout", "no-checkpoint", "storage-failure"]) {
    f = fixture();
    f.window.location.reload = () => { throw new Error("Unexpected reload"); };
    if (change === "draft") f.composer.innerText = f.composer.textContent = "My draft";
    if (change === "queued") f.api.queueAdditionalPrompt("Queued instruction");
    if (change === "second-timeout") f.api.setReconnectAttemptedForTest(true);
    if (change === "no-checkpoint") f.api.setTimeoutSnapshotsForTest(() => ({ element: null, text: "" }));
    if (change === "storage-failure") f.setRequestHandler(async r => r.type.startsWith("LR_") ? { ok: false, error: "Storage unavailable" } : { ok: true });
    await f.run();
    assert.deepEqual(f.sends, [], change);
    assert.equal(f.api.state.error, true, change);
    assert.equal(f.api.state.logicPhase, "recovery_paused", change);
    assert.equal(f.api.getOverlayForTest().isConnected, true, change);
  }

  for (const change of ["old", "extra-text", "wrong-text", "disabled-retry", "ambiguous", "inside-transcript"]) {
    f = fixture();
    if (change === "old") f.notice.rank = 0;
    if (change === "extra-text") f.notice.textContent += " unrelated text";
    if (change === "wrong-text") f.notice.textContent = "Something went wrong. Retry";
    if (change === "disabled-retry") f.retry.disabled = true;
    if (change === "inside-transcript") f.notice.closest = () => ({});
    if (change === "ambiguous") {
      const retry = Object.assign(visibleElement("Retry"), { parentElement: { ...f.notice } });
      f.setSelector("button, [role='button']", [f.retry, retry]);
    }
    assert.equal(f.api.findDeliveryTimeoutNotice(), null, change);
  }
  for (const change of ["stop", "navigate", "draft", "notice-disappeared", "busy"]) {
    f = fixture();
    f.window.location.reload = () => { throw new Error("Unexpected reload"); };
    f.onTick(() => {
      if (change === "stop") { f.api.state.running = false; f.api.state.runId++; }
      if (change === "navigate") f.window.location = new URL("https://chatgpt.com/c/another-chat");
      if (change === "draft") f.composer.innerText = f.composer.textContent = "New draft";
      if (change === "notice-disappeared") f.hide();
      if (change === "busy") f.setSelector("button[data-testid='stop-button']", [visibleElement()]);
    });
    await f.run();
    assert.deepEqual(f.sends, [], change);
    assert.equal(f.requests.some(r => r.type === "LR_PREPARE"), false, change);
  }

  for (const condition of ["ready", "generating", "second-error", "wrong-user", "repeated-text", "missing-page", "draft", "unplanned-reload"]) {
    f = fixture(); f.hide();
    const settings = { message: "Configured followup", limit: 5, count: 3, rolloverEnabled: true, verifiedUser: true,
      userHash: await f.api.reconnectUserHash({ element: f.user(), text: f.user().textContent }) };
    f.api.state.running = false;
    f.api.state.mode = "idle";
    const runs = f.api.captureHeartbeatRunsForTest();
    f.setRequestHandler(async r => r.type === "LR_CLAIM"
      ? { ok: true, record: { token: "previous-run", attempted: true, requested: condition !== "unplanned-reload", settings } }
      : { ok: true });
    if (condition === "generating") f.setSelector("button[data-testid='stop-button']", [visibleElement()]);
    if (condition === "second-error") f.setAlerts([visibleElement("Something went wrong. Please try again.")]);
    if (condition === "wrong-user") f.newUser();
    if (condition === "repeated-text") { const text = f.user().textContent; f.newUser(); f.user().textContent = f.user().innerText = text; }
    if (condition === "missing-page") { f.setSelector("#prompt-textarea", []); f.api.setTimeoutSnapshotsForTest(() => ({ element: null, text: "" })); }
    if (condition === "draft") f.composer.innerText = f.composer.textContent = "Draft";
    await f.api.restoreLogicReconnect();
    if (["ready", "generating"].includes(condition)) {
      assert.equal(runs.length, 1, condition);
      assert.equal(runs[0][1], true, "resume observes the current response without startup instructions");
      assert.equal(f.api.state.count, 3, "the previous count is restored");
    } else {
      assert.equal(runs.length, 0, condition);
      assert.equal(f.api.state.error, true, condition);
      assert.equal(f.api.state.logicPhase, "recovery_paused", condition);
    }
    assert.deepEqual(f.sends, [], condition);
  }
  for (const response of ["IDLE", "CONTINUE", "GENERATING"]) {
    f = fixture(); f.hide();
    f.assistant().textContent = f.assistant().innerText = `Recovered response.\n[[LOGIC:${response === "GENERATING" ? "IDLE" : response}]]`;
    const settings = { message: "Configured followup", limit: 5, count: 3, rolloverEnabled: true, verifiedUser: true,
      userHash: await f.api.reconnectUserHash({ element: f.user(), text: f.user().textContent }) };
    f.api.state.running = false; f.api.state.mode = "idle";
    f.setRequestHandler(async r => r.type === "LR_CLAIM"
      ? { ok: true, record: { token: "restored-run", attempted: true, requested: true, settings } }
      : { ok: true, enabled: false });
    const runs = f.api.trackLogicRunsForTest();
    if (response === "GENERATING") {
      f.setSelector("button[data-testid='stop-button']", [visibleElement()]);
      f.onTick(now => { if (now >= 10000) f.setSelector("button[data-testid='stop-button']", []); });
    }
    await f.api.restoreLogicReconnect();
    assert.equal(runs.length, 1);
    await runs[0];
    assert.deepEqual(f.sends, response === "CONTINUE" ? ["Configured followup"] : [], response);
    assert.equal(f.api.state.count, response === "CONTINUE" ? 4 : 3, response);
    assert.equal(f.api.state.error, false, response);
  }
  console.log("timeout reconnection: empty page, one reload, ownership, no prompt replay, restored monitoring and visible failure passed");
}
if (require.main === module) runTests().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { fixture };
