/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "diagnostics/inspect-rollover-draft-match.js"), "utf8");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
for (const [start, end] of [
  ["  const MESSAGE_CONTENT_SELECTORS =", "  const LOGIC_START_PROMPT ="],
  ["  function isVisible(", "  function isGenerating("],
  ["  function verifiedResourceRows(", "  function latestMessageSnapshot("],
  ["  function composerText(", "  function buttonIsEnabled("]
]) assert.ok(source.includes(content.slice(content.indexOf(start), content.indexOf(end))));
function inspect({ different = false, alternateOnly = false, noComposer = false, staleNotice = false, headingContainer = false } = {}) {
  const secret = "PRIVATE MESSAGE SENTINEL";
  function node(text, attrs = {}) {
    return { tagName: "DIV", innerText: text, textContent: text, children: [], childNodes: [], parentElement: null,
      getAttribute: key => attrs[key] || null, querySelectorAll: () => [], closest: () => null,
      getBoundingClientRect: () => ({ width: attrs.hidden ? 0 : 100, height: 30 }),
      contains: () => false, matches: () => false, cloneNode: () => ({ textContent: text, querySelectorAll: () => [] }),
      click() { throw Error("must not click"); }, focus() { throw Error("must not focus"); }
    };
  }
  const composer = node(different ? "PRIVATE DRAFT SENTINEL" : secret, { "aria-label": "New chat in PRIVATE PROJECT" });
  const user = node(secret);
  const heading = node("You said:");
  heading.tagName = "H4";
  const container = node("You said: " + secret);
  container.contains = other => other === user;
  heading.parentElement = container;
  const assistant = node(staleNotice ? "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat." : "PRIVATE ASSISTANT SENTINEL", { hidden: true });
  const project = node("", { "aria-label": "Change project: PRIVATE PROJECT" });
  let copied, printed;
  const ctx = {
    URL, HTMLTextAreaElement: class {}, HTMLInputElement: class {},
    window: { location: { href: "https://chatgpt.com/" }, getComputedStyle: () => ({ visibility: "visible", display: "block" }) },
    console: { log: value => { printed = value; } }, copy: value => { copied = value; },
    document: { querySelectorAll(selector) {
      if (selector === "#prompt-textarea") return noComposer ? [] : [composer];
      if (selector === "[data-conversation-role='user']") return [headingContainer ? heading : user];
      if (selector === "[data-message-author-role='user'],[data-user-message-bubble='true']") return alternateOnly ? [] : [user];
      if (selector === "[data-message-author-role='assistant'],[data-conversation-role='assistant']") return [assistant];
      if (selector === "button[aria-label^='Change project:']") return [project];
      return [];
    } }
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  assert.equal(copied, printed);
  for (const text of [secret, "PRIVATE DRAFT SENTINEL", "PRIVATE PROJECT", "PRIVATE ASSISTANT SENTINEL"]) assert.ok(!printed.includes(text));
  return JSON.parse(printed);
}
let r = inspect();
assert.equal(r.latestCurrentUser.readerEqualsDraft, true);
assert.equal(r.page.matchingProjectLabels, true);
assert.equal(r.latestSelectorsPointToSameNode, true);
r = inspect({ different: true });
assert.equal(r.draftMatchesAnyCurrentUser, false);
r = inspect({ alternateOnly: true });
assert.equal(r.currentUserSelectorCount, 0);
assert.equal(r.latestCurrentUser, null);
assert.equal(r.latestAlternateUser.readerEqualsDraft, true);
r = inspect({ noComposer: true });
assert.equal(r.page.composerFound, false);
assert.equal(r.draftMatchesAnyCurrentUser, false);
r = inspect({ staleNotice: true });
assert.equal(r.maximumLengthNotice.inLatestAssistant, true);
assert.equal(r.maximumLengthNotice.latestAssistantVisible, false);
r = inspect({ headingContainer: true });
assert.equal(r.schemaVersion, 2);
assert.equal(r.latestAlternateUser.readerEqualsDraft, false);
assert.equal(r.alternateContainerDraftComparison[0].readerContainsDraft, true);
assert.equal(r.alternateContainerDraftComparison[0].extraReaderPrefixLength, 10);
assert.equal(r.alternateContainerDraftComparison[0].extraReaderSuffixLength, 0);
assert.equal(r.alternateContainerDraftComparison[0].currentSelectorInside, true);
console.log("rollover draft-match diagnostic: source parity, draft matching, alternate selectors, stale notice and redaction passed");
