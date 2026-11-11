/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { fixture } = require("./delivery-timeout.test.js");

(async () => {
  for (const mode of ["logic", "loop"]) {
    for (const change of ["draft", "navigation", "manual-message"]) {
      const f = fixture(); f.hide();
      f.api.state.mode = mode; f.api.state.limit = 1;
      f.setWriter((composer, text) => {
        composer.innerText = composer.textContent = change === "draft" ? `${text} edited by user` : text;
        if (change === "navigation") f.window.location = new URL("https://chatgpt.com/c/another-agent");
        if (change === "manual-message") f.newUser();
        f.setSelector("button[data-testid='send-button']", [f.send]);
        return true;
      });
      if (mode === "logic") await f.run(); else await f.api.runLoop(1);
      assert.deepEqual(f.sends, [], `${mode}: ${change} before Send must stop the old run`);
      assert.equal(f.api.state.error, true);
      assert.ok(f.api.getOverlayForTest(), "ownership failures stay visible");
    }
  }

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
  console.log("chat ownership and guarded first-send navigation tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
