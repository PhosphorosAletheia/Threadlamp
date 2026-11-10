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
  const turn = (rank, text) => Object.assign(visibleElement(text), {
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
  assert.equal(f.api.findDeliveryTimeoutNotice(), f.notice);
  assert.equal(f.api.deliveryTimeoutResponse().deliveryTimeout, true);
  await f.run();
  assert.deepEqual(f.writes, ["continue"]);
  assert.deepEqual(f.sends, ["continue"]);
  assert.equal(f.api.state.count, 1);
  assert.equal(f.api.state.running, false);
  assert.equal(f.api.state.error, false);
  assert.equal(f.requests.some(r => r.type === "HA_NOTIFY_ERROR"), false);

  f = fixture(["delayed-idle"]);
  f.notice.textContent = `${ERROR}Retry`;
  await f.run();
  assert.deepEqual(f.sends, ["continue"], "adjacent DOM text and a lingering notice are supported");
  assert.equal(f.api.state.error, false);

  for (const outcome of ["timeout", "timeout-no-user"]) {
    f = fixture([outcome]);
    await f.run();
    assert.deepEqual(f.sends, ["continue"], "consecutive timeout never loops or replays the failed prompt");
    assert.equal(f.api.state.running, false);
    assert.equal(f.api.state.error, true);
    assert.match(f.api.state.detail, /timed out again/);
    const errors = f.requests.filter(r => r.type === "HA_NOTIFY_ERROR");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].chatTitle, "Timed out research");
  }

  f = fixture(["continue", "timeout", "idle"]);
  await f.run();
  assert.deepEqual(f.sends, ["continue", "Configured followup", "continue"], "a completed valid response permits recovery of a later independent incident");
  assert.equal(f.api.state.count, 3);

  // A timeout may prevent a user bubble even during initial startup delivery.
  f = fixture(["timeout-no-user", "idle"]);
  await f.api.runLogicMode(1, false, "Unique startup prompt");
  assert.deepEqual(f.sends, ["Unique startup prompt", "continue"]);
  assert.equal(f.api.state.count, 1);
  assert.equal(f.api.state.error, false);

  for (const change of ["hidden", "quoted", "old", "extra-text", "wrong-text", "disabled-retry", "no-assistant", "ambiguous"]) {
    f = fixture();
    if (change === "hidden") f.hide();
    if (change === "quoted") f.assistant().contains = node => node === f.notice;
    if (change === "old") f.notice.rank = 0;
    if (change === "extra-text") f.notice.textContent += " unrelated text";
    if (change === "wrong-text") f.notice.textContent = "Something went wrong. Retry";
    if (change === "disabled-retry") f.retry.disabled = true;
    if (change === "no-assistant") f.api.setTimeoutElementsForTest(role => role === "user" ? [f.user()] : []);
    if (change === "ambiguous") {
      const other = Object.assign({}, f.notice);
      const retry = Object.assign(visibleElement("Retry"), { parentElement: other });
      f.setSelector("button, [role='button']", [f.retry, retry]);
    }
    assert.equal(f.api.findDeliveryTimeoutNotice(), null, change);
  }

  f = fixture();
  f.api.state.mode = "loop";
  assert.equal(f.api.deliveryTimeoutResponse(), null, "repeat mode must not inherit Logic Mode recovery");
  f = fixture();
  f.setSelector("button[data-testid='stop-button']", [visibleElement()]);
  assert.equal(f.api.deliveryTimeoutResponse(), null, "never recover while generation is active");
  f.onTick(() => f.setSelector("button[data-testid='stop-button']", []));
  await f.run();
  assert.deepEqual(f.sends, ["continue"]);

  f = fixture();
  f.api.state.count = f.api.state.limit;
  await f.run();
  assert.deepEqual(f.sends, []);
  assert.match(f.api.state.detail, /limit has been reached/);

  f = fixture();
  f.composer.innerText = f.composer.textContent = "My manual draft";
  await f.run();
  assert.deepEqual(f.writes, []);
  assert.equal(f.composer.innerText, "My manual draft");
  assert.equal(f.api.state.error, true);

  for (const change of ["stop", "pause", "navigate", "new-user", "notice-disappeared"]) {
    f = fixture();
    f.onTick(() => {
      if (change === "stop") { f.api.state.running = false; f.api.state.runId += 1; }
      if (change === "pause") { f.api.state.paused = true; f.onTick(() => { f.api.state.running = false; }); }
      if (change === "navigate") f.window.location = new URL("https://chatgpt.com/c/another-agent");
      if (change === "new-user") { f.newUser(); f.onTick(() => {}); }
      if (change === "notice-disappeared") f.hide();
    });
    await f.run();
    assert.deepEqual(f.sends, [], change);
    assert.deepEqual(f.writes, [], change);
  }

  for (const change of ["draft", "replacement-composer", "new-user", "navigate", "busy"]) {
    f = fixture();
    f.setWriter((target, text) => {
      target.innerText = target.textContent = change === "draft" ? "My replacement draft" : text;
      f.setSelector("button[data-testid='send-button']", [f.send]);
      if (change === "new-user") f.newUser();
      if (change === "navigate") f.window.location = new URL("https://chatgpt.com/c/another-agent");
      if (change === "busy") f.setSelector("button[data-testid='stop-button']", [visibleElement()]);
      if (change === "replacement-composer") f.setSelector("#prompt-textarea", [visibleElement("Manual draft in a replacement editor")]);
      return true;
    });
    await f.run();
    assert.deepEqual(f.sends, [], `pre-send ${change} guard`);
    assert.equal(f.api.state.error, true);
    if (change === "draft") assert.equal(f.composer.innerText, "My replacement draft");
  }
  console.log("delivery timeout tests passed");
}
if (require.main === module) runTests().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { fixture };
