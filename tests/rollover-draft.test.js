/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const { contentHarness, visibleElement } = require("./rollover.test.js");
const project = "g-p-0123456789abcdef0123456789abcdef-video-production";
const submitted = "Render a 1080p video using as few resources as possible.";

function destination(timing, captureRun = true) {
  const h = contentHarness(timing);
  h.window.location = new URL(`https://chatgpt.com/g/${project}`);
  const composer = Object.assign(visibleElement(submitted), { focus() {}, dispatchEvent() {} });
  Object.defineProperty(composer, "innerText", { get() { return this.textContent; }, set(value) { this.textContent = value; } });
  h.setSelector("#prompt-textarea", [composer]);
  const runs = captureRun ? h.api.captureHeartbeatRunsForTest() : [];
  const pending = { projectSegment: project, previousTitle: "Video production", message: "Continue", count: 2, limit: 20 };
  return Object.assign(h, { composer, runs, pending });
}

(async () => {
  const helper = contentHarness().api;
  const oldHandoff = helper.buildRolloverPrompt("Different agent")
    .replace("only as a display label", "only as an identifier");
  const sourceUrl = `https://chatgpt.com/g/${project}/c/original`;
  const modernHandoff = helper.buildRolloverPrompt("Original agent", sourceUrl);
  for (const draft of [oldHandoff, modernHandoff, oldHandoff.replace(/\n/g, "\n\n")]) {
    const h = destination();
    h.composer.textContent = draft;
    h.setRequestHandler(async () => ({ ok: true }));
    await h.api.startClaimedLogicRollover({ ...h.pending, requestId: "receipt", sourceUrl });
    assert.equal(h.composer.textContent, "", "a complete restored template is cleared after receipt verification");
    assert.equal(h.runs.length, 1);
    assert.ok(h.runs[0][2].includes("Source conversation: " + sourceUrl));
    assert.ok(!h.runs[0][2].includes('titled "Different agent"'), "fresh prompt uses this handoff's source");
  }
  for (const draft of [oldHandoff + " Extra instructions", oldHandoff.replace("Continue the unfinished task", "Delete the unfinished task"),
    oldHandoff.split("Start Logic Mode")[0], "My notes: " + oldHandoff]) {
    const h = destination();
    h.composer.textContent = draft;
    await assert.rejects(h.api.startClaimedLogicRollover({ ...h.pending, sourceUrl }), /different draft/);
    assert.equal(h.composer.textContent, draft);
    assert.equal(h.runs.length, 0);
  }
  for (const change of ["cancel", "draft", "navigation", "user", "stop"]) {
    const h = destination();
    h.composer.textContent = oldHandoff;
    h.setRequestHandler(async request => {
      if (request.type === "LOGIC_ROLLOVER_CHECK") {
        if (change === "cancel") return { ok: false, error: "Handoff cancelled" };
        if (change === "draft") h.composer.textContent = "New human instructions";
        if (change === "navigation") h.window.location = new URL("https://chatgpt.com/c/unrelated");
        if (change === "user") h.api.setTimeoutSnapshotsForTest(() => ({element: visibleElement("New message"),text:"New message"}));
        if (change === "stop") h.api.state.runId++;
      }
      return { ok: true };
    });
    const action = h.api.startClaimedLogicRollover({ ...h.pending, requestId: "receipt", sourceUrl });
    if (change === "stop") assert.equal(await action, false);
    else await assert.rejects(action, /cancelled|draft changed/);
    assert.equal(h.runs.length, 0);
    assert.equal(h.composer.textContent, change === "draft" ? "New human instructions" : oldHandoff);
  }
  {
    const h = destination();
    const sourcePath = new URL(sourceUrl).pathname;
    assert.equal(h.api.rolloverReadinessIssue(sourcePath, project, true), "");
    h.api.setTimeoutSnapshotsForTest(() => ({element: visibleElement("Retained turn"),text:"Retained turn"}));
    assert.match(h.api.rolloverReadinessIssue(sourcePath, project, true), /messages are still present/);
    h.window.location = new URL("https://chatgpt.com/");
    assert.match(h.api.rolloverReadinessIssue(sourcePath, project, true), /project ID/);
  }
  const fingerprint = await helper.rolloverDraftFingerprint(submitted);
  assert.equal(fingerprint.length, submitted.length);
  assert.match(fingerprint.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(fingerprint).includes(submitted), false);
  assert.equal(await helper.rolloverDraftFingerprint(""), null);
  assert.equal(await helper.rolloverDraftFingerprint("x".repeat(100001)), null);

  assert.equal(fingerprint.renderedLength, submitted.length);
  assert.equal(fingerprint.renderedSha256, fingerprint.sha256);
  for (const draft of [submitted, `\n${submitted}  `, submitted.replace(" a ", "  a "), submitted.replace(" a ", "\na\n")]) {
    const h = destination();
    h.composer.textContent = draft;
    await h.api.startClaimedLogicRollover({ ...h.pending, sourceUserFingerprint: fingerprint });
    assert.equal(h.composer.textContent, "");
    assert.equal(h.runs.length, 1);
    assert.equal(h.api.state.count, 2);
  }

  // The duplicate is only cleared. The real send path must write and send the
  // extension's title-based continuation protocol, never replay the duplicate.
  const actual = destination(undefined, false);
  actual.composer.textContent = oldHandoff;
  const form = visibleElement();
  const high = visibleElement("High", { "aria-label": "Select ChatGPT model", "aria-haspopup": "menu", "aria-expanded": "false" });
  form.querySelectorAll = () => [high];
  actual.composer.closest = selector => selector === "form" ? form : null;
  actual.api.prepareThinkingSendForTest(actual.composer);
  const sent = [];
  const send = visibleElement("Send");
  send.click = () => { sent.push(actual.composer.textContent); actual.composer.textContent = ""; };
  actual.setSelector("button[data-testid='send-button']", [send]);
  await actual.api.startClaimedLogicRollover({ ...actual.pending, sourceUserFingerprint: fingerprint });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0], actual.api.buildRolloverPrompt("Video production"));
  assert.match(sent[0], /continuation of the project chat titled "Video production"/);
  assert.match(sent[0], /Start Logic Mode for this conversation/);
  assert.equal(sent[0].includes(submitted), false);
  assert.equal(actual.api.state.error, false);
  for (const draft of [submitted.toUpperCase(), `${submitted} More instructions.`, submitted.replace("1080p", "720p"), `${submitted}\u200B`, submitted.replace(" a ", "\ta "), submitted.replace(" a ", "\u00a0a "), submitted.replace(".", "!")]) {
    const h = destination();
    h.composer.textContent = draft;
    await assert.rejects(h.api.startClaimedLogicRollover({ ...h.pending, sourceUserFingerprint: fingerprint }), /different draft/);
    assert.equal(h.composer.textContent, draft);
    assert.equal(h.runs.length, 0);
  }
  for (const saved of [null, { length: submitted.length, sha256: "invalid" }, await helper.rolloverDraftFingerprint("Another chat's prompt")]) {
    const h = destination();
    await assert.rejects(h.api.startClaimedLogicRollover({ ...h.pending, sourceUserFingerprint: saved }), /different draft/);
    assert.equal(h.composer.textContent, submitted);
  }

  // Legacy handoffs retain exact matching; absent rendering evidence is not guessed.
  const legacy = { length: fingerprint.length, sha256: fingerprint.sha256 };
  assert.equal(await helper.matchesSubmittedRolloverDraft(submitted, legacy), true);
  assert.equal(await helper.matchesSubmittedRolloverDraft(submitted.replace(" a ", "  a "), legacy), false);
  for (const invalid of [
    { ...fingerprint, renderedSha256: undefined },
    { ...fingerprint, renderedLength: fingerprint.length + 1 },
    { ...fingerprint, renderedSha256: "invalid" }
  ]) assert.equal(await helper.matchesSubmittedRolloverDraft(submitted, invalid), false);
  const spacedSource = await helper.rolloverDraftFingerprint(submitted.replace(" a ", "  a "));
  assert.equal(await helper.matchesSubmittedRolloverDraft(submitted, spacedSource), true);

  for (const change of ["draft", "whitespace-draft", "navigation", "stop"]) {
    let mutate;
    const h = destination({ crypto: { subtle: { async digest(...args) { mutate(); return webcrypto.subtle.digest(...args); } } } });
    mutate = () => {
      if (change === "draft") h.composer.textContent = "A new manual draft";
      if (change === "whitespace-draft") h.composer.textContent = submitted.replace(" a ", "  a ");
      if (change === "navigation") h.window.location = new URL("https://chatgpt.com/c/another-chat");
      if (change === "stop") h.api.state.runId += 1;
    };
    const operation = h.api.startClaimedLogicRollover({ ...h.pending, sourceUserFingerprint: fingerprint });
    if (change === "stop") assert.equal(await operation, false);
    else await assert.rejects(operation, /draft changed/);
    assert.equal(h.runs.length, 0);
    assert.equal(h.composer.textContent, change === "draft" ? "A new manual draft" : change === "whitespace-draft" ? submitted.replace(" a ", "  a ") : submitted);
  }

  // Exercise source capture -> prepared handoff -> claimed destination together.
  for (const sourceDraft of ["", submitted, submitted.replace(" a ", "  a "), "A different unsent request"]) {
    const h = destination();
    h.window.location = new URL(`https://chatgpt.com/g/${project}/c/source`);
    h.document.title = "Video production";
    h.composer.textContent = sourceDraft;
    const sourceNode = visibleElement(submitted);
    h.api.setTimeoutSnapshotsForTest(role => role === "user" ? { element: sourceNode, text: submitted } : { element: null, text: "" });
    const button = visibleElement("Start new chat");
    const alert = visibleElement("You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.");
    alert.querySelectorAll = () => [button];
    h.setAlerts([alert]);
    let clicks = 0, prepared;
    button.click = () => {
      clicks += 1;
      h.window.location = new URL(`https://chatgpt.com/g/${project}`);
      h.composer.textContent = submitted.replace(" a ", "  a ");
      h.setAlerts([]);
      h.api.setTimeoutSnapshotsForTest(() => ({ element: null, text: "" }));
    };
    h.setRequestHandler(async request => {
      if (request.type === "LOGIC_ROLLOVER_PREPARE") { prepared = request; return { ok: true, requestId: "handoff" }; }
      if (request.type === "LOGIC_ROLLOVER_CLAIM") return { ok: true, pending: { ...prepared, requestId: "handoff" } };
      return { ok: true };
    });
    Object.assign(h.api.state, { running: true, mode: "logic", logicPhase: "rolling_over", message: "Continue", count: 2, limit: 20, runId: 1 });
    await h.api.beginProjectRollover(1);
    if (sourceDraft === "A different unsent request") {
      assert.equal(clicks, 0);
      assert.equal(h.composer.textContent, sourceDraft);
    } else {
      assert.equal(clicks, 1);
      assert.equal(prepared.sourceUserFingerprint.sha256, fingerprint.sha256);
      assert.equal(prepared.sourceUserFingerprint.renderedSha256, fingerprint.renderedSha256);
      assert.equal(JSON.stringify(prepared).includes(submitted), false);
      assert.equal(h.composer.textContent, "");
      assert.equal(h.runs.length, 1);
    }
  }
  console.log("submitted rollover draft tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
