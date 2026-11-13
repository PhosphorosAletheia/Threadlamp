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

// Minimal rich-editor fixture: paragraphs add layout newlines, while an empty
// aria-hidden SVG decoration sits alongside ordinary text in nested spans.
const textNode = text => ({ nodeType: 3, nodeValue: text });
function editorElement(tagName, childNodes = [], attributes = {}) {
  return { nodeType: 1, tagName, childNodes, attributes,
    getAttribute(name) { return this.attributes[name] ?? null; },
    get textContent() { return this.childNodes.map(n => n.nodeType === 3 ? n.nodeValue : n.textContent).join(""); } };
}
function decoratedDraft(text) {
  const path = editorElement("path");
  const svg = editorElement("svg", [path]);
  const icon = editorElement("SPAN", [editorElement("SPAN", [svg], { contenteditable: "false" }), editorElement("SPAN")],
    { contenteditable: "false", "aria-hidden": "true" });
  const lines = text.split("\n");
  const paragraphs = lines.map(line => editorElement("P", line ? [textNode(line)] : [editorElement("BR")]));
  paragraphs.at(-1).childNodes = [editorElement("SPAN", [editorElement("SPAN", [icon, textNode(lines.at(-1))])])];
  return { icon, svg, path, paragraphs, rendered: lines.join("\n\n") + "\n", text };
}

async function decoratedQueueTests() {
  const extra = "Inspect the example.\nKeep the result concise.";
  const expected = combined("Continue", extra);
  for (const inProject of [false, true]) {
    const f = normal();
    if (inProject) f.window.location = new URL("https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-example/c/example");
    f.api.queueAdditionalPrompt(extra);
    f.setWriter((target, text) => {
      const rich = decoratedDraft(text);
      target.childNodes = rich.paragraphs;
      target.textContent = rich.paragraphs.map(p => p.textContent).join("");
      target.innerText = rich.rendered;
      f.setSelector("button[data-testid='send-button']", [f.send]);
      return true;
    });
    assert.equal(await f.api.submitMessage(1, "Continue", "Sending", null, 8000, null, true), true);
    assert.equal(f.sends.length, 1, "a decorative icon must not prevent the queued send");
    assert.equal(f.api.getQueuedPromptForTest(), null, "consume the queue once Send is attempted");
  }
  // The real writer must preserve a valid editor tree instead of replacing it
  // through textContent when the page decorates the inserted text.
  const writer = normal();
  let fallbackWrites = 0;
  Object.defineProperty(writer.composer, "textContent", {
    get() { return this.childNodes?.map(p => p.textContent).join("") || ""; },
    set() { fallbackWrites += 1; }
  });
  writer.composer.focus = writer.composer.dispatchEvent = () => {};
  writer.document.createRange = () => ({ selectNodeContents() {}, collapse() {} });
  writer.document.execCommand = (command, ui, text) => {
    assert.equal(command, "insertText");
    const rich = decoratedDraft(text);
    writer.composer.childNodes = rich.paragraphs;
    writer.composer.innerText = rich.rendered;
    return true;
  };
  assert.equal(writer.api.writeComposerForTest(writer.composer, expected), true);
  assert.equal(fallbackWrites, 0, "preserve valid rich editor content");

  const f = normal();
  for (const change of ["text", "space", "newline", "invisible", "nonhidden", "label", "image", "editable", "unknown", "deep", "no_svg"]) {
    const rich = decoratedDraft(expected);
    if (change === "text") rich.icon.childNodes.push(textNode("extra"));
    if (change === "space") rich.icon.childNodes.push(textNode(" "));
    if (change === "newline") rich.paragraphs.push(editorElement("P", [editorElement("BR")]), editorElement("P", [textNode("Extra line")]));
    if (change === "invisible") rich.icon.childNodes.push(textNode("\u200b"));
    if (change === "nonhidden") delete rich.icon.attributes["aria-hidden"];
    if (change === "label") rich.icon.attributes["aria-label"] = "Attachment";
    if (change === "image") rich.svg.childNodes.push(editorElement("IMG", [], { src: "example.png" }));
    if (change === "editable") rich.icon.attributes.contenteditable = "true";
    if (change === "unknown") rich.svg.childNodes.push(editorElement("foreignObject"));
    if (change === "deep") for (let i = 0; i < 40; i++) rich.svg.childNodes.push(editorElement("path"));
    if (change === "no_svg") rich.icon.childNodes = [editorElement("SPAN")];
    const composer = { innerText: rich.rendered, childNodes: rich.paragraphs };
    assert.equal(f.api.composerDraftMatches(composer, expected), false, change);
  }
  for (const edit of ["Inspect the Example.", "Inspect  the example.", "Inspect the example.\t", "Inspect the example.\u00a0", "Inspect the example.\u200b"]) {
    const rich = decoratedDraft(expected.replace("Inspect the example.", edit));
    assert.equal(f.api.composerDraftMatches({ innerText: rich.rendered, childNodes: rich.paragraphs }, expected), false,
      "actual text changes remain significant");
  }
}

(async () => {
  await decoratedQueueTests();
  let f = normal(["continue", "idle"]);
  f.api.updateOverlay();
  const shadow = f.api.getOverlayForTest().shadowRoot;
  const input = shadow.querySelector(".prompt-input");
  input.value = "Focus on costs.\nUse a table.";
  input.handlers.input();
  assert.equal(shadow.querySelector(".queue-prompt").disabled, false);
  shadow.querySelector(".queue-prompt").handlers.click();
  assert.equal(input.value, "");
  assert.match(shadow.querySelector(".queue-note").textContent, /1 queued/);
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

  f = normal(["continue", "idle"]);
  assert.equal(f.api.queueAdditionalPrompt("   "), false);
  assert.equal(f.api.queueAdditionalPrompt("x".repeat(8001)), false);
  assert.equal(f.api.queueAdditionalPrompt("First"), true);
  assert.equal(f.api.queueAdditionalPrompt("Second"), true);
  await f.run();
  assert.deepEqual(f.sends, [combined("Configured followup", "First"), combined("Configured followup", "Second")]);

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
  assert.deepEqual(f.sends, [], "timeout does not resend or consume a queued request");
  assert.equal(f.api.getQueuedPromptForTest().text, "Extra request");
  assert.equal(f.api.state.error, true, "timeout must not replay the queued request");

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
          assert.equal(f.api.queueAdditionalPrompt("Later entry"), true);
          assert.equal(f.api.removeAdditionalPrompt(f.api.getQueuedPromptForTest().id), false);
        }
        return true;
      });
    }
    await f.run();
    if (change === "lock") assert.deepEqual(f.sends, [combined("Configured followup", "One-time instructions")]);
    else assert.deepEqual(f.sends, [], change);
    if (["navigate", "manual"].includes(change)) assert.equal(f.api.getQueuedPromptForTest().text, "One-time instructions");
    else if (change === "lock") assert.equal(f.api.getQueuedPromptForTest().text, "Later entry");
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

  // Stable IDs allow removing a middle entry without changing the others.
  f = normal(["continue", "idle"]);
  for (const text of ["First", "Remove me", "Third"]) f.api.queueAdditionalPrompt(text);
  const middle = f.api.getQueuedPromptsForTest()[1].id;
  assert.equal(f.api.removeAdditionalPrompt(middle), true);
  assert.equal(f.api.removeAdditionalPrompt(middle), false);
  await f.run();
  assert.deepEqual(f.sends, [combined("Configured followup", "First"), combined("Configured followup", "Third")]);

  // Failed preparation preserves every entry; an attempted send consumes just
  // the first, even if clicking Send throws before delivery can be confirmed.
  for (const attempted of [false, true]) {
    f = normal();
    f.api.queueAdditionalPrompt("First"); f.api.queueAdditionalPrompt("Second");
    if (attempted) f.send.click = () => { throw new Error("Uncertain delivery"); };
    else f.setWriter((target, text) => { target.innerText = target.textContent = "Manual edit"; return true; });
    await f.run();
    assert.deepEqual(Array.from(f.api.getQueuedPromptsForTest(), item => item.text), attempted ? ["Second"] : ["First", "Second"]);
  }
  f = normal();
  for (let i = 0; i < 100; i++) assert.equal(f.api.queueAdditionalPrompt(`Message ${i}`), true);
  assert.equal(f.api.queueAdditionalPrompt("Overflow"), false);
  assert.equal(f.api.getQueuedPromptsForTest().length, 100);
  f.api.cancelAdditionalPrompt();
  for (let i = 0; i < 10; i++) assert.equal(f.api.queueAdditionalPrompt("x".repeat(8000)), true);
  assert.equal(f.api.queueAdditionalPrompt("Overflow"), false);
  assert.equal(f.api.getQueuedPromptsForTest().length, 10);
  // IDs and size constraints are checked when a persisted handoff is claimed.
  for (const queuedPrompts of [null, {}, [{id:"a",text:""}], [{id:"a",text:"x"},{id:"a",text:"y"}],
    [{id:"a",text:"x".repeat(8001)}], Array.from({length:101}, (_,i) => ({id:`q-${i}`,text:"x"})),
    Array.from({length:11}, (_,i) => ({id:`q-${i}`,text:"x".repeat(8000)}))]) {
    assert.equal(f.api.normalizeQueuedPrompts({queuedPrompts}), null);
  }

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
  await rollover.api.startClaimedLogicRollover({ previousTitle: "Old chat", projectSegment: project,
    message: "Continue", limit: 5, count: 1, queuedPrompts: [{id:"first",text:"First"},{id:"second",text:"Second"}] });
  assert.deepEqual(Array.from(rollover.api.getQueuedPromptsForTest(), item => [item.id,item.text,item.url]),
    [["first","First",rollover.window.location.href],["second","Second",rollover.window.location.href]]);
  console.log("queued prompt tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
