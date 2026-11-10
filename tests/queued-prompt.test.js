/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { fixture } = require("./delivery-timeout.test.js");
const { contentHarness, visibleElement } = require("./rollover.test.js");

function normal(outcomes = ["idle"], flag = "CONTINUE") {
  const f = fixture(outcomes);
  f.hide();
  f.assistant().textContent = `Ready.\n[[LOGIC:${flag}]]`;
  return f;
}
const combined = (base, prompt) => `${base}\n\nAdditional instructions from the user for this round:\n${prompt}`;

(async () => {
  let f = normal(["continue", "idle"]);
  f.api.updateOverlay();
  const shadow = f.api.getOverlayForTest().shadowRoot;
  const input = shadow.querySelector(".prompt-input");
  input.value = "Focus on costs.\nUse a table.";
  input.handlers.input();
  assert.equal(shadow.querySelector(".queue-prompt").disabled, false);
  shadow.querySelector(".queue-prompt").handlers.click();
  assert.equal(input.value, "");
  assert.match(shadow.querySelector(".queue-note").textContent, /Queued: Focus on costs/);
  assert.equal(shadow.querySelector(".cancel-prompt").hidden, false);
  input.value = "Unfinished draft for another round";
  let focusRestored = 0, isolatedKeys = 0;
  Object.assign(input, { isConnected: true, selectionStart: 4, selectionEnd: 7, selectionDirection: "forward",
    focus() { focusRestored += 1; },
    setSelectionRange(...range) { assert.deepEqual(range, [4, 7, "forward"]); }
  });
  shadow.activeElement = input;
  input.handlers.keydown({ stopPropagation() { isolatedKeys += 1; } });
  input.handlers.keyup({ stopPropagation() { isolatedKeys += 1; } });
  assert.equal(isolatedKeys, 2);
  f.api.updateOverlay();
  assert.equal(input.value, "Unfinished draft for another round", "polling must not overwrite a banner draft");
  await f.run();
  assert.deepEqual(f.sends, [combined("Configured followup", "Focus on costs.\nUse a table."), "Configured followup"]);
  assert.equal(f.api.getQueuedPromptForTest(), null);
  assert.equal(f.api.state.count, 2, "extra instructions do not create an extra turn");
  assert.equal(focusRestored, 2, "each automatic composer write returns focus to the banner draft");

  f = normal();
  assert.equal(f.api.queueAdditionalPrompt("   "), false);
  assert.equal(f.api.queueAdditionalPrompt("x".repeat(8001)), false);
  assert.equal(f.api.queueAdditionalPrompt("First"), true);
  assert.equal(f.api.queueAdditionalPrompt("Replacement"), true);
  await f.run();
  assert.deepEqual(f.sends, [combined("Configured followup", "Replacement")]);

  f = normal();
  f.api.queueAdditionalPrompt("Cancelled");
  f.api.getOverlayForTest().shadowRoot.querySelector(".cancel-prompt").handlers.click();
  await f.run();
  assert.deepEqual(f.sends, ["Configured followup"]);

  f = normal(["idle"], "WAIT:1m");
  f.api.queueAdditionalPrompt("Check the logs too.");
  await f.run();
  assert.deepEqual(f.sends, [combined("Status", "Check the logs too.")]);

  f = fixture(["timeout", "idle"]);
  f.api.queueAdditionalPrompt("Extra request");
  await f.run();
  assert.deepEqual(f.sends, [combined("continue", "Extra request")]);
  assert.equal(f.api.state.error, true, "timeout must not replay the queued request");
  assert.equal(f.api.getQueuedPromptForTest(), null);

  f = normal();
  f.api.queueAdditionalPrompt("Wakeup instructions");
  await f.api.runLogicMode(1, false, "Heartbeat protocol");
  assert.deepEqual(f.sends, [combined("Heartbeat protocol", "Wakeup instructions")]);

  f = normal(["idle"], "IDLE");
  f.api.queueAdditionalPrompt("Keep pending");
  await f.run();
  assert.deepEqual(f.sends, [], "queueing must not override IDLE or force another turn");
  assert.equal(f.api.getQueuedPromptForTest().text, "Keep pending");
  assert.match(f.api.getOverlayForTest().shadowRoot.querySelector(".queue-note").textContent, /Not sent/);

  f = normal(["idle"], "USER_INPUT");
  f.api.queueAdditionalPrompt("Not an approval");
  f.onTick(() => { f.api.state.running = false; });
  await f.run();
  assert.deepEqual(f.sends, [], "queueing must not approve a USER_INPUT request");

  f = normal();
  f.api.queueAdditionalPrompt("Wait for resume");
  f.api.state.paused = true;
  f.onTick(() => {
    assert.deepEqual(f.sends, []);
    f.api.state.paused = false;
    f.onTick(() => {});
  });
  await f.run();
  assert.deepEqual(f.sends, [combined("Configured followup", "Wait for resume")]);

  for (const change of ["navigate", "manual", "send-fails", "stop", "lock"]) {
    f = normal();
    f.api.queueAdditionalPrompt("One-time instructions");
    if (change === "navigate") f.window.location = new URL("https://chatgpt.com/c/other-agent");
    if (change === "send-fails") f.send.click = () => { throw new Error("Uncertain delivery"); };
    if (["manual", "stop", "lock"].includes(change)) {
      f.setWriter((target, text) => {
        target.innerText = target.textContent = text;
        f.setSelector("button[data-testid='send-button']", [f.send]);
        if (change === "manual") target.innerText = target.textContent = "My new draft";
        if (change === "stop") { f.api.state.logicPhase = "sleeping"; f.api.stopLogicMode(); }
        if (change === "lock") {
          assert.equal(f.api.cancelAdditionalPrompt(), false);
          assert.equal(f.api.queueAdditionalPrompt("Replacement too late"), false);
        }
        return true;
      });
    }
    await f.run();
    if (change === "lock") assert.deepEqual(f.sends, [combined("Configured followup", "One-time instructions")]);
    else assert.deepEqual(f.sends, [], change);
    if (["navigate", "manual"].includes(change)) assert.equal(f.api.getQueuedPromptForTest().text, "One-time instructions");
    else assert.equal(f.api.getQueuedPromptForTest(), null);
  }

  // A prompt queued after the current automatic send was prepared belongs to
  // the following round, not the text already in the ChatGPT composer.
  f = normal(["continue", "idle"]);
  let first = true;
  f.setWriter((target, text) => {
    target.innerText = target.textContent = text;
    f.setSelector("button[data-testid='send-button']", [f.send]);
    if (first) { first = false; f.api.queueAdditionalPrompt("Next round only"); }
    return true;
  });
  await f.run();
  assert.deepEqual(f.sends, ["Configured followup", combined("Configured followup", "Next round only")]);

  f = normal();
  f.api.queueAdditionalPrompt("Separate from phone responses");
  await f.api.submitMessage(1, "Approved", "Sending a phone response");
  assert.deepEqual(f.sends, ["Approved"]);
  assert.equal(f.api.getQueuedPromptForTest().text, "Separate from phone responses");
  assert.equal(JSON.stringify(f.api.publicStatus()).includes("Separate from phone responses"), false);
  const otherTab = normal();
  assert.equal(otherTab.api.getQueuedPromptForTest(), null);
  f.api.state.logicPhase = "rolling_over";
  assert.equal(f.api.queueAdditionalPrompt("Late change"), false);
  assert.equal(f.api.cancelAdditionalPrompt(), false);

  const rollover = contentHarness();
  const project = "g-p-0123456789abcdef0123456789abcdef-job-search";
  rollover.window.location = new URL(`https://chatgpt.com/g/${project}`);
  rollover.setSelector("#prompt-textarea", [visibleElement()]);
  const runs = rollover.api.captureHeartbeatRunsForTest();
  await rollover.api.startClaimedLogicRollover({ previousTitle: "Old chat", projectSegment: project,
    message: "Continue", limit: 5, count: 1, queuedPrompt: "Carried once" });
  assert.equal(runs.length, 1);
  assert.equal(rollover.api.getQueuedPromptForTest().text, "Carried once");
  assert.equal(rollover.api.getQueuedPromptForTest().url, rollover.window.location.href);
  console.log("queued prompt tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
