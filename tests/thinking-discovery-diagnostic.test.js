/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "diagnostics/inspect-thinking-discovery.js"), "utf8");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
for (const [start, end] of [
  ["  function isVisible(", "  function isGenerating("],
  ["  function buttonIsEnabled(", "  async function ensureHighThinking("],
  ["  function findComposerShell(", "  function updateQuickActions("]
]) assert.ok(source.includes(content.slice(content.indexOf(start), content.indexOf(end))), "selector baseline must match source");

function element(text = "", attrs = {}) {
  return {
    tagName: "BUTTON", id: attrs.id || "", textContent: text, innerText: text,
    children: [], parentElement: null, isConnected: true, hidden: false,
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return { width: this.hidden ? 0 : 100, height: 30 }; },
    closest() { return null; }, contains(other) { return other === this; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    matches(selector) { return selector.includes("button") && this.tagName === "BUTTON"; },
    click() { throw new Error("Diagnostic must not click"); },
    focus() { throw new Error("Diagnostic must not focus"); }
  };
}
function inspect({ draftText = null, bannerText = "", text = "High", duplicate = false, unsupported = false, outside = false, hidden = false, disabled = false, navigate = false, late = false } = {}) {
  const draft = draftText ?? "PRIVATE DRAFT MUST NEVER BE PRINTED";
  const transcript = "PRIVATE TRANSCRIPT High";
  const composer = element(draft); composer.tagName = "DIV";
  const form = element(); form.tagName = "FORM";
  composer.closest = selector => selector === "form" ? form : null;
  const control = element(unsupported ? "Extended" : text, { "aria-label": "Select ChatGPT model", "aria-haspopup": "menu" });
  control.hidden = hidden; control.disabled = disabled;
  const second = element("Medium", { "aria-haspopup": "menu" });
  const privateButton = element(transcript, { "aria-haspopup": "menu" });
  privateButton.closest = selector => selector.includes("[data-message-author-role]") ? {} : null;
  let controls = outside || late ? [] : [control, ...(duplicate ? [second] : [])];
  form.querySelectorAll = () => [...controls, privateButton];
  form.contains = node => node === composer || controls.includes(node) || node === privateButton;
  const logs = []; let callback;
  const window = {
    location: { href: "https://chatgpt.com/g/private-project/c/private-chat" },
    getComputedStyle: () => ({ display: "block", visibility: "visible" })
  };
  const context = {
    URL, window, console: { log(value) { logs.push(value); } },
    setTimeout(fn, delay) { assert.equal(delay, 8000); callback = fn; },
    document: {
      readyState: "complete", visibilityState: "visible", body: {},
      getElementById(id) {
        assert.equal(id, "chatgpt-continue-loop-status");
        return bannerText ? { shadowRoot: { querySelector: selector => element(selector === ".detail" ? bannerText : "Logic mode") } } : null;
      },
      querySelectorAll(selector) {
        if (selector === "#prompt-textarea") return [composer];
        if (selector.startsWith("button, [role='button'],")) return [control, second, privateButton];
        return [];
      }
    }
  };
  vm.createContext(context); vm.runInContext(source, context);
  assert.equal(logs.length, 1, "only an instruction is printed before the delay");
  if (navigate) window.location.href += "-changed";
  if (late) controls = [control];
  callback();
  assert.equal(logs.length, 2);
  for (const secret of ["PRIVATE DRAFT MUST NEVER BE PRINTED", transcript, "private-project", "private-chat"]) assert.ok(!logs[1].includes(secret));
  return JSON.parse(logs[1]);
}
let report = inspect();
assert.equal(report.schemaVersion, 2);
assert.equal(report.initial.rollover.draft.rawLength, "PRIVATE DRAFT MUST NEVER BE PRINTED".length);
assert.equal(report.initial.rollover.extensionUI.overlayPresent, false);
assert.equal(report.initial.rollover.page.savedConversation, true);
assert.equal(report.initial.rollover.send.found, false);
assert.equal(report.initial.detectorFoundControl, true);
assert.equal(report.initial.scopedControls.length, 1, "transcript controls must be omitted");
assert.equal(report.initial.scopedControls[0].recognizedAsHigh, true);
for (const text of ["Thinking effort Medium", "Thinking effort High"]) {
  report = inspect({ text });
  assert.equal(report.initial.detectorFoundControl, true);
  assert.equal(report.initial.scopedControls[0].recognizedAsHigh, text.endsWith("High"));
}
report = inspect({ draftText: "This chat is a continuation of the project chat titled PRIVATE DRAFT MUST NEVER BE PRINTED\nStart Logic Mode for this conversation.", bannerText: "Cannot continue: thinking control missing." });
assert.equal(report.initial.rollover.draft.containsContinuationPreamble, true);
assert.equal(report.initial.rollover.draft.containsLogicStartup, true);
assert.equal(report.initial.rollover.extensionUI.detail, "Cannot continue: thinking control missing.");
assert.equal(report.delayed.rollover.extensionUI.overlayPresent, true);
report = inspect({ duplicate: true });
assert.equal(report.initial.detectorFoundControl, false);
assert.equal(report.initial.supportedScopedControlCount, 2);
report = inspect({ unsupported: true });
assert.ok(report.initial.scopedControls[0].rejectionReasons.includes("name_or_popup_not_supported"));
report = inspect({ outside: true });
assert.equal(report.initial.detectorFoundControl, false);
assert.ok(report.initial.otherCandidates[0].rejectionReasons.includes("outside_current_composer_scope"));
for (const property of ["hidden", "disabled"]) {
  report = inspect({ [property]: true });
  assert.equal(report.initial.detectorFoundControl, false, property);
}
report = inspect({ late: true });
assert.equal(report.initial.detectorFoundControl, false);
assert.equal(report.delayed.detectorFoundControl, true);
report = inspect({ navigate: true });
assert.equal(report.pageUnchanged, false);
assert.equal(report.delayed, null);
console.log("thinking discovery diagnostic: selector parity, ambiguity, delayed controls, navigation and redaction passed");
