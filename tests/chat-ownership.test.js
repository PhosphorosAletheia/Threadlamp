/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { fixture } = require("./delivery-timeout.test.js");
const { visibleElement } = require("./rollover.test.js");

(async () => {
  for (const mode of ["logic", "loop"]) {
    for (const change of ["draft", "navigation", "manual-message", "error"]) {
      const f = fixture(); f.hide();
      f.api.state.mode = mode; f.api.state.limit = 1;
      f.setWriter((composer, text) => {
        composer.innerText = composer.textContent = change === "draft" ? `${text} edited by user` : text;
        if (change === "navigation") f.window.location = new URL("https://chatgpt.com/c/another-agent");
        if (change === "manual-message") f.newUser();
        if (change === "error") f.api.state.error = true;
        f.setSelector("button[data-testid='send-button']", [f.send]);
        return true;
      });
      if (mode === "logic") await f.run(); else await f.api.runLoop(1);
      assert.deepEqual(f.sends, [], `${mode}: ${change} before Send must stop the old run`);
      assert.equal(f.api.state.error, true);
      assert.ok(f.api.getOverlayForTest(), "ownership failures stay visible");
    }
  }

  const guarded = fixture(); guarded.hide();
  await assert.rejects(guarded.api.submitMessage(1, "Continue", "Sending", null, 8000, async () => {
    await Promise.resolve();
    guarded.composer.innerText = guarded.composer.textContent = "Manual draft during an asynchronous guard";
    return true;
  }), /chat or draft changed/);
  assert.equal(guarded.writes.length, 0, "an asynchronous check cannot authorize overwriting a new manual draft");
  assert.deepEqual(guarded.sends, []);

  for (const paused of [false, true]) {
    const f = fixture(); f.hide();
    f.api.state.paused = paused;
    f.onTick(() => { f.window.location = new URL("https://chatgpt.com/c/another-agent"); });
    await f.run();
    assert.deepEqual(f.sends, [], "navigation while monitoring or paused cannot send in the destination");
    assert.equal(f.api.state.running, false);
    assert.match(f.api.state.detail, /chat changed/);
  }

  for (const change of ["draft", "navigation"]) {
    const f = fixture(); f.hide(); f.api.state.running = false;
    f.setWriter((composer, text) => {
      composer.innerText = composer.textContent = change === "draft" ? "Manual replacement" : text;
      if (change === "navigation") f.window.location = new URL("https://chatgpt.com/c/other-agent");
      f.setSelector("button[data-testid='send-button']", [f.send]);
      return true;
    });
    await f.api.sendQuickPrompt("continue");
    assert.deepEqual(f.sends, [], "quick prompts must recheck ownership before Send");
    assert.equal(f.api.state.error, true);
  }

  const project = "g-p-0123456789abcdef0123456789abcdef";
  for (const crossProject of [false, true]) {
    const f = fixture(); f.hide();
    f.window.location = new URL(`https://chatgpt.com/g/${project}-old-name`);
    f.api.setTimeoutSnapshotsForTest(role => {
      if (!f.sends.length) return { element: null, text: "" };
      const element = role === "user" ? f.user() : f.assistant();
      return { element, text: element.textContent };
    });
    const send = f.send.click;
    f.send.click = () => {
      send();
      f.window.location = new URL(`https://chatgpt.com/g/${crossProject ? project.replace("0123", "abcd") : project}-new-name/c/saved`);
    };
    await f.api.runLogicMode(1, false, "Initial task");
    assert.equal(f.sends.length, 1);
    assert.equal(f.api.state.error, crossProject, "only the exact submitted turn in the same project can bind a new chat URL");
  }
  // Delivery can be observed on the project landing page long before ChatGPT
  // assigns the saved URL. Keep proof of that message, not just its prompt text.
  for (const scenario of ["delayed", "long-delay", "local", "render-late", "handoff", "no-id", "wrong-id",
    "modern-id", "modern-plain-id", "modern-wrong-id", "modern-multiple-ids", "modern-mixed-turns", "encoded-local", "encoded-local-lower", "invalid-local",
    "wrong-text", "cross-project", "cross-origin", "saved-to-saved", "second-hop", "cancelled"]) {
    const f = fixture(["continue", "idle"]); f.hide();
    const home = `https://chatgpt.com/g/${project}/project`;
    const saved = `https://chatgpt.com/g/${project}/c/saved`;
    f.window.location = new URL(scenario === "saved-to-saved" ? saved + "-original"
      : scenario === "invalid-local" ? `https://chatgpt.com/g/${project}/c/local-chatgpt:%ZZ`
      : scenario.startsWith("encoded-local") ? `https://chatgpt.com/g/${project}/c/local-chatgpt${scenario.endsWith("lower") ? "%3a" : "%3A"}temporary`
      : scenario === "local" ? `https://chatgpt.com/g/${project}/c/local-chatgpt:temporary` : home);
    if (scenario === "local") {
      assert.equal(f.api.queueAdditionalPrompt("First queued"), true);
      assert.equal(f.api.queueAdditionalPrompt("Second queued"), true);
    }
    let absent = false;
    f.api.setTimeoutSnapshotsForTest(role => {
      if (!f.sends.length || absent) return {element:null, text:""};
      const element = role === "user" ? f.user() : f.assistant();
      return {element, text:element.textContent};
    });
    if (scenario === "handoff") {
      const form = visibleElement();
      const high = visibleElement("High", {"aria-label":"Select ChatGPT model", "aria-haspopup":"menu", "aria-expanded":"false"});
      form.querySelectorAll = () => [high];
      f.composer.closest = selector => selector === "form" ? form : null;
      f.setRequestHandler(async request => {
        f.requests.push(request);
        return request.type === "LOGIC_ROLLOVER_COMPLETE"
          ? {ok:true, heartbeatSchedule:{id:"schedule", enabled:true, phase:"active",
            url:`https://chatgpt.com/g/${project}/c/source`, pendingDestination:true, projectSegment:project}}
          : {ok:true};
      });
    }
    let modernWrapper;
    const modernId = "01234567-89ab-4cde-8f01-23456789abcd", otherId = "abcdef01-2345-4678-9abc-def012345678";
    const click = f.send.click;
    f.send.click = () => {
      click();
      if (f.sends.length !== 1) return;
      if (scenario === "no-id") f.user().getAttribute = () => null;
      if (scenario.startsWith("modern-")) {
        const user = f.user();
        user.getAttribute = () => null;
        let value = scenario === "modern-multiple-ids" ? JSON.stringify([modernId, otherId])
          : scenario === "modern-plain-id" ? modernId : JSON.stringify([modernId]);
        modernWrapper = {getAttribute: () => value, matches: () => false,
          querySelectorAll: () => scenario === "modern-mixed-turns" ? [user, f.assistant()] : [user],
          changeId: () => { value = JSON.stringify([otherId]); }};
        user.closest = selector => selector === "[data-chatgpt-search-message-ids]" ? modernWrapper : null;
      }
      f.onTick(() => {
        f.advanceClock(scenario === "long-delay" ? 10 * 60 * 1000 : 9000);
        const target = scenario === "cross-project" ? saved.replace("0123", "abcd")
          : scenario === "cross-origin" ? saved.replace("chatgpt.com", "chat.openai.com") : saved;
        f.window.location = new URL(target);
        if (scenario === "wrong-id") {
          const text = f.user().textContent;
          f.newUser(); f.user().textContent = f.user().innerText = text;
        }
        if (scenario === "modern-wrong-id") modernWrapper.changeId();
        if (scenario === "wrong-text") f.user().textContent = "Different instructions";
        if (scenario === "render-late") absent = true;
        if (scenario === "cancelled") { f.api.state.running = false; f.api.state.runId++; }
        f.onTick(() => {
          absent = false;
          if (scenario === "second-hop") f.window.location = new URL(saved + "-another");
          f.onTick(() => {});
        });
      });
    };
    await f.api.runLogicMode(1, false, "Initial continuation", "Starting", scenario === "handoff"
      ? {failureId:"receipt", projectSegment:project, sourceUrl:`https://chatgpt.com/g/${project}/c/source`} : null);
    const allowed = ["delayed", "long-delay", "local", "render-late", "handoff", "modern-id", "modern-plain-id", "encoded-local", "encoded-local-lower"].includes(scenario);
    const expected = scenario === "local" ? ["Initial continuation\n\nAdditional instructions from the user for this round:\nFirst queued",
      "Configured followup\n\nAdditional instructions from the user for this round:\nSecond queued"]
      : allowed ? ["Initial continuation", "Configured followup"] : ["Initial continuation"];
    assert.deepEqual(f.sends, expected, scenario);
    if (scenario !== "cancelled") assert.equal(f.api.state.error, !allowed, scenario);
    if (scenario === "handoff") assert.equal(f.requests.filter(r => r.type === "LOGIC_ROLLOVER_COMPLETE").length, 1);
  }
  console.log("chat ownership, delayed saved-URL binding and guarded first-send navigation tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
