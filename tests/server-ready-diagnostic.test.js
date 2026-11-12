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
const source = fs.readFileSync(path.join(root, "diagnostics/inspect-server-ready.js"), "utf8");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const reader = content.slice(content.indexOf("  function verifiedResourceRows("),
  content.indexOf("  function latestMessageSnapshot("));
assert.ok(source.includes(reader), "diagnostic must use the current source reader");
const privateValues = {
  setupId: "private-setup-id",
  projectId: "private-project-id",
  endpoint: "ws://localhost:3456/.well-known/continue-loop",
  credential: "PRIVATE-CREDENTIAL-MUST-NOT-APPEAR"
};
const payload = JSON.stringify({ protocol: 1, ...privateValues });
const block = `[[SERVER_READY:${payload}]]`;
function inspect(raw, visible = raw, selectedRoot = null) {
  const primary = "[data-message-author-role='assistant'],[data-conversation-role='assistant']";
  const markdown = selectedRoot === null ? null : {
    innerText: selectedRoot, textContent: selectedRoot, contains: () => false
  };
  const node = {
    children: [], tagName: "DIV", textContent: raw, innerText: visible,
    matches: () => false,
    querySelectorAll: selector => selector === ".markdown" && markdown ? [markdown] : [],
    cloneNode: () => ({ textContent: raw, querySelectorAll: () => [] })
  };
  const printed = [];
  const context = {
    URL,
    window: { getComputedStyle: () => ({display: "block"}) },
    console: { log: value => printed.push(value) },
    document: { querySelectorAll: selector => selector === primary ? [node] : [] }
  };
  vm.createContext(context);
  const report = vm.runInContext(source, context);
  assert.equal(printed.length, 1);
  assert.deepEqual(JSON.parse(printed[0]), JSON.parse(JSON.stringify(report)));
  for (const value of Object.values(privateValues)) {
    assert.ok(!printed[0].includes(value), "report must not expose private field values");
  }
  return report.candidates[0];
}
let candidate = inspect("[[SERVER_READY:");
assert.equal(candidate.extensionReader.markers[0].onlyWhitespaceAfterOpener, true);
assert.equal(candidate.extensionReader.strictSingleLineBlockCount, 0);
candidate = inspect(block);
assert.equal(candidate.extensionReader.strictSingleLineBlockCount, 1);
assert.equal(candidate.extensionReader.markers[0].jsonValid, true);
assert.equal(candidate.extensionReader.markers[0].allowedEndpointShape, true);
candidate = inspect(block, "[[SERVER_READY:");
assert.equal(candidate.innerText.markers[0].onlyWhitespaceAfterOpener, true);
assert.equal(candidate.textContent.strictSingleLineBlockCount, 1);
candidate = inspect(block, block, "[[SERVER_READY:");
assert.equal(candidate.extensionReader.strictSingleLineBlockCount, 0);
assert.equal(candidate.textContent.strictSingleLineBlockCount, 1);
candidate = inspect(`[[SERVER_READY:\n${payload}\n]]`);
assert.equal(candidate.extensionReader.strictSingleLineBlockCount, 0);
assert.equal(candidate.extensionReader.markers[0].jsonValid, true);
assert.equal(candidate.extensionReader.markers[0].payloadHasLineBreaks, true);
candidate = inspect('[[SERVER_READY:{"secret":"PRIVATE-CREDENTIAL-MUST-NOT-APPEAR",bad}]]');
assert.equal(candidate.extensionReader.markers[0].jsonValid, false);
candidate = inspect(block + "\n" + block);
assert.equal(candidate.extensionReader.strictSingleLineBlockCount, 2);
candidate = inspect('[[SERVER_READY:null]]');
assert.equal(candidate.extensionReader.markers[0].jsonValid, true);
assert.equal(candidate.extensionReader.markers[0].allowedEndpointShape, false);
console.log("SERVER_READY diagnostic truncation, reader selection, multiline and redaction tests passed");
