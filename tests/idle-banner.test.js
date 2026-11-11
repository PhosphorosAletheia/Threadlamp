/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { fixture } = require("./delivery-timeout.test.js");
const { visibleElement } = require("./rollover.test.js");

async function idle() {
  const f = fixture(["idle"]);
  f.hide();
  f.assistant().textContent = "Cycle finished.\n[[LOGIC:IDLE]]";
  f.api.updateOverlay();
  const original = f.api.getOverlayForTest();
  original.shadowRoot.querySelector(".prompt-input").value = "Unfinished banner draft";
  await f.run();
  assert.equal(f.api.getOverlayForTest(), original, "retain the existing banner and editor");
  return f;
}

async function runTests() {
  let f = await idle();
  let shadow = f.api.getOverlayForTest().shadowRoot;
  assert.equal(f.api.state.running, false, "IDLE must still stop automatic messages");
  assert.equal(f.api.state.mode, "logic");
  assert.equal(f.api.state.logicPhase, "idle");
  assert.deepEqual(f.sends, []);
  assert.match(shadow.querySelector(".headline").textContent, /Logic mode · Idle/);
  assert.equal(shadow.querySelector(".pause").textContent, "Start next cycle");
  assert.equal(shadow.querySelector(".pause").hidden, false);
  assert.equal(shadow.querySelector(".stop").hidden, false);
  assert.equal(shadow.querySelector(".toggle-prompt").hidden, false);
  assert.equal(shadow.querySelector(".prompt-input").value, "Unfinished banner draft");

  assert.equal(f.api.queueAdditionalPrompt("Use this in the next cycle."), true);
  assert.deepEqual(f.sends, [], "queueing must not wake IDLE");
  shadow.querySelector(".pause").handlers.click();
  for (let i = 0; f.api.state.running && i < 100; i++) await new Promise(setImmediate);
  assert.equal(f.api.state.running, false);
  assert.equal(f.sends.length, 1, "explicit Start next cycle sends one startup");
  assert.match(f.sends[0], /Logic Mode/);
  assert.match(f.sends[0], /Additional instructions from the user for this round:\nUse this in the next cycle\./);
  assert.equal(f.api.getQueuedPromptForTest(), null);
  assert.equal(f.api.state.count, 0, "fresh cycle retains normal startup accounting");
  assert.ok(f.api.getOverlayForTest());

  f = await idle();
  shadow = f.api.getOverlayForTest().shadowRoot;
  f.composer.innerText = f.composer.textContent = "Manual draft";
  shadow.querySelector(".pause").handlers.click();
  assert.equal(f.api.state.running, false);
  assert.deepEqual(f.sends, []);
  assert.equal(f.composer.textContent, "Manual draft");
  assert.match(f.api.state.detail, /Clear or send your draft/);

  f = await idle();
  f.setSelector("button[data-testid='stop-button']", [visibleElement("Stop")]);
  f.api.getOverlayForTest().shadowRoot.querySelector(".pause").handlers.click();
  assert.equal(f.api.state.running, false);
  assert.deepEqual(f.sends, [], "do not start during generation");

  f = await idle();
  shadow = f.api.getOverlayForTest().shadowRoot;
  f.api.queueAdditionalPrompt("Do not send after Stop");
  shadow.querySelector(".stop").handlers.click();
  assert.equal(f.api.state.running, false);
  assert.equal(f.api.state.mode, "idle");
  assert.equal(f.api.getOverlayForTest(), null);
  assert.equal(f.api.getQueuedPromptForTest(), null);
  assert.deepEqual(f.sends, [], "Stop on an idle cycle only closes local controls");

  f = await idle();
  shadow = f.api.getOverlayForTest().shadowRoot;
  f.window.location = new URL("https://chatgpt.com/c/different-chat");
  shadow.querySelector(".pause").handlers.click();
  assert.deepEqual(f.sends, [], "an old banner cannot start a cycle in another chat");
  f.api.updateQuickActions();
  assert.equal(f.api.getOverlayForTest(), null);
  assert.equal(f.api.state.mode, "idle");

  f = await idle();
  shadow = f.api.getOverlayForTest().shadowRoot;
  f.window.location = new URL("https://chatgpt.com/c/different-chat");
  shadow.querySelector(".stop").handlers.click();
  assert.equal(f.api.getOverlayForTest(), null);
  assert.deepEqual(f.sends, [], "Stop on a stale idle banner must not send in another chat");
  f = fixture();
  f.hide();
  f.api.failSendsForTest();
  await f.run();
  assert.equal(f.api.state.running, false);
  assert.ok(f.api.getOverlayForTest(), "a fatal same-chat error stays visible");
  shadow = f.api.getOverlayForTest().shadowRoot;
  assert.match(shadow.querySelector(".detail").textContent, /Send button is unavailable/);
  assert.equal(shadow.querySelector(".dismiss").hidden, false);
  shadow.querySelector(".dismiss").handlers.click();
  assert.equal(f.api.getOverlayForTest(), null);
  assert.deepEqual(f.sends, [], "dismissing a notice never sends");

  f = fixture();
  f.hide();
  f.api.state.count = f.api.state.limit;
  await f.run();
  assert.equal(f.api.state.running, false);
  assert.ok(f.api.getOverlayForTest(), "limit shutdown stays visible");
  assert.match(f.api.state.detail, /5-message limit/);
  assert.equal(f.sends.length, 1, "only the shutdown instruction is sent");
  console.log("idle banner tests passed");
}

runTests().catch(error => { console.error(error); process.exitCode = 1; });
