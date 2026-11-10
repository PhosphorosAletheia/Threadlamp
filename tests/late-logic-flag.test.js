/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { fixture } = require("./delivery-timeout.test.js");
const { visibleElement } = require("./rollover.test.js");

function partial() {
  const f = fixture(["idle"]);
  f.hide();
  f.assistant().textContent = "x".repeat(41);
  f.assistant().querySelector = () => null;
  return f;
}

async function runTests() {
  // Reproduce a stable short turn, then a late final narrative after the loop
  // has already entered its missing-flag wait. Exercise the real send path.
  for (const flag of ["CONTINUE", "IDLE", "WAIT:1m", "USER_INPUT"]) {
    const f = partial();
    let arrived = false;
    f.onTick(now => {
      if (f.api.state.logicPhase === "waiting_user" && !arrived) {
        assert.match(f.api.state.detail, /41 characters/);
        f.assistant().textContent = `Completed image narrative.\n[[LOGIC:${flag}]]`;
        arrived = true;
      }
      if (flag === "USER_INPUT" && arrived && f.requests.some(r => r.type === "HA_NOTIFY_USER_INPUT")) {
        f.api.state.running = false;
      }
      if (now > 90000) throw new Error("late directive was not handled");
    });
    await f.run();
    assert.equal(arrived, true);
    assert.deepEqual(f.sends, flag === "CONTINUE" ? ["Configured followup"] : flag === "WAIT:1m" ? ["Status"] : []);
    assert.equal(f.requests.filter(r => r.type === "HA_NOTIFY_ERROR").length, 1, "no repeated missing-flag alerts");
    assert.equal(f.api.state.error, false, "a completed directive clears the missing-flag error");
  }

  // A valid intermediate tag must stay stable and generation must end.
  {
    const f = partial();
    let start;
    f.onTick(now => {
      if (start === undefined && f.api.state.logicPhase === "waiting_user") start = now;
      if (start === undefined) return;
      const elapsed = now - start;
      if (elapsed < 2500) {
        f.assistant().textContent = `Still rendering ${now}.\n[[LOGIC:CONTINUE]]`;
        f.setSelector("button[data-testid='stop-button']", [visibleElement("Stop")]);
        assert.deepEqual(f.sends, []);
      } else {
        f.setSelector("button[data-testid='stop-button']", []);
        f.assistant().textContent = "Finished.\n[[LOGIC:IDLE]]";
      }
    });
    await f.run();
    assert.deepEqual(f.sends, [], "do not act on a transient CONTINUE");
  }

  for (const barrier of ["draft", "user", "pause", "stop", "navigation", "invalid_wait", "trailing_prose", "image_only"]) {
    const f = partial();
    let start;
    f.onTick(now => {
      if (start === undefined && f.api.state.logicPhase === "waiting_user") {
        start = now;
        f.assistant().textContent = "Completed.\n[[LOGIC:CONTINUE]]";
        if (barrier === "draft") f.composer.innerText = f.composer.textContent = "Manual draft";
        if (barrier === "user") f.newUser();
        if (barrier === "pause") f.api.state.paused = true;
        if (barrier === "stop") { f.api.state.running = false; f.api.state.runId++; }
        if (barrier === "navigation") f.window.location = new URL("https://chatgpt.com/c/another-chat");
        if (barrier === "invalid_wait") f.assistant().textContent = "[[LOGIC:WAIT:0m]]";
        if (barrier === "trailing_prose") f.assistant().textContent += "\nAdditional narrative";
        if (barrier === "image_only") {
          f.assistant().textContent = "Image generated";
          f.assistant().querySelector = () => visibleElement();
        }
      }
      if (start === undefined) return;
      assert.deepEqual(f.sends, [], `${barrier} must prevent an automatic send`);
      // Clearing a draft without sending it does not opt back into recovery.
      if (barrier === "draft" && now - start > 1000) f.composer.innerText = f.composer.textContent = "";
      if (now - start > 5000) f.api.state.running = false;
    });
    await f.run();
    assert.deepEqual(f.sends, [], barrier);
    if (barrier === "navigation") assert.match(f.api.state.detail, /chat changed/);
  }

  // Replacing an intermediate DOM turn is also supported, with a fresh stable
  // period after an explicit Pause/Resume.
  {
    const f = partial();
    const original = f.assistant();
    const final = Object.assign(visibleElement("Finished.\n[[LOGIC:CONTINUE]]"), { rank: 3 });
    let replacement = false, pausedAt;
    f.api.setTimeoutSnapshotsForTest(role => {
      const element = role === "user" ? f.user() : replacement && f.assistant() === original ? final : f.assistant();
      return { element, text: element.textContent };
    });
    f.onTick(now => {
      if (pausedAt === undefined && f.api.state.logicPhase === "waiting_user") {
        pausedAt = now;
        replacement = true;
        f.api.state.paused = true;
      }
      if (pausedAt === undefined) return;
      if (now - pausedAt < 3000) assert.deepEqual(f.sends, []);
      else f.api.state.paused = false;
    });
    await f.run();
    assert.deepEqual(f.sends, ["Configured followup"]);
  }

  {
    const f = partial();
    let final = null, userAt;
    f.api.setTimeoutSnapshotsForTest(role => {
      const element = role === "user" ? f.user() : final || f.assistant();
      return { element, text: element.textContent };
    });
    f.onTick(now => {
      if (userAt === undefined && f.api.state.logicPhase === "waiting_user") {
        userAt = now;
        f.newUser();
        f.assistant().textContent = "Old turn finishes late.\n[[LOGIC:CONTINUE]]";
      }
      if (userAt !== undefined && now - userAt >= 3000 && !final) {
        final = Object.assign(visibleElement("Reply to the new user message.\n[[LOGIC:IDLE]]"), { rank: f.user().rank + 1 });
      }
      assert.deepEqual(f.sends, [], "the old late tag cannot answer a newer user turn");
    });
    await f.run();
    assert.ok(final);
    assert.equal(f.api.state.error, false);
    assert.equal(f.api.state.logicPhase, "idle");
  }

  // Recovery applies only to a missing flag, never an established human-input
  // pause, even if its rendered text later changes.
  {
    const f = partial();
    f.assistant().textContent = "Approval needed.\n[[LOGIC:USER_INPUT]]";
    let start;
    f.onTick(now => {
      if (start === undefined && f.api.state.logicPhase === "waiting_user") start = now;
      if (start === undefined) return;
      f.assistant().textContent = "Changed text.\n[[LOGIC:CONTINUE]]";
      if (now - start > 5000) f.api.state.running = false;
    });
    await f.run();
    assert.deepEqual(f.sends, []);
  }
  console.log("late Logic flag tests passed");
}

runTests().catch(error => { console.error(error); process.exitCode = 1; });
