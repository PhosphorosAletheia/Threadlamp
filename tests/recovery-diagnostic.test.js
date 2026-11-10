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
const apiContext = { URL };
vm.createContext(apiContext);
const source = fs.readFileSync(path.join(root, "diagnostics/inspect-recovery-prompt.js"), "utf8");
// The diagnostic intentionally retains its original 1.8.3 template.
vm.runInContext('const VERSION = 1; const PATH = "/.well-known/continue-loop";\n'
  + source.slice(source.indexOf("  function recoveryPrompt("), source.indexOf("  const all =")), apiContext);
const extensionId = "a".repeat(32);
const record = {
  projectId: "g-p-0123456789abcdef0123456789abcdef",
  setupId: "11111111-1111-4111-8111-111111111111",
  pairingToken: "22222222-2222-4222-8222-222222222222".repeat(2)
};
const prompt = apiContext.recoveryPrompt(record, extensionId);
const primary = "[data-message-author-role='user'], [data-user-message-bubble='true']";
const alternate = "[data-conversation-role='user'], [data-turn='user'], [data-role='user'][data-testid*='conversation-turn'], [data-testid='user-turn']";
function inspect(text, inner = text, alternateOnly = false) {
  const node = {
    tagName: "DIV", textContent: text, innerText: inner, children: [],
    matches: selector => selector === (alternateOnly ? "[data-conversation-role='user']" : "[data-message-author-role='user']"),
    querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 100, height: 100 }),
    cloneNode: () => ({ textContent: text, querySelectorAll: () => [] })
  };
  const printed = [];
  const context = {
    console: { log: value => printed.push(value) },
    location: { origin: "https://chatgpt.com" },
    document: {
      querySelectorAll: selector => (selector === (alternateOnly ? alternate : primary) || node.matches(selector)) ? [node] : []
    }
  };
  vm.createContext(context);
  const report = vm.runInContext(source, context);
  assert.equal(printed.length, 1);
  const json = printed[0];
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(report)));
  for (const secret of [record.projectId, record.setupId, record.pairingToken, extensionId, prompt]) {
    assert.ok(!json.includes(secret), "diagnostic output must not contain prompt identifiers or secrets");
  }
  return report;
}
let report = inspect(prompt);
assert.equal(report.candidates[0].expectedPromptReconstructed, true);
assert.equal(report.candidates[0].comparison.extensionReader.matchesExtensionNormalization, true);
report = inspect("You said: " + prompt + " Show more");
assert.equal(report.candidates[0].comparison.extensionReader.matchesExtensionNormalization, false);
assert.equal(report.candidates[0].comparison.extensionReader.includesCompleteExpected, true);
assert.equal(report.candidates[0].comparison.extensionReader.extraPrefixLength, 10);
report = inspect("You said: " + prompt, prompt);
assert.equal(report.candidates[0].comparison.innerText.matchesExtensionNormalization, true);
report = inspect(prompt.replace(/\n/g, ""));
assert.equal(report.candidates[0].comparison.extensionReader.matchesExtensionNormalization, true);
report = inspect(prompt.replace("Recover the EXISTING", "Recover\u200B the EXISTING"));
assert.equal(report.candidates[0].expectedPromptReconstructed, false, "unrecoverable fields must not be guessed");
report = inspect(prompt, prompt, true);
assert.equal(report.currentSelectorFoundUser, false);
assert.equal(report.candidates[0].expectedPromptReconstructed, true);
assert.equal(report.candidates[0].selectedByCurrentSelectors, false);
console.log("read-only recovery diagnostic structure and redaction tests passed");
