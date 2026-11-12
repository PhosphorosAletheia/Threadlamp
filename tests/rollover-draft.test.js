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

function retainedHistory(h) {
  const hidden = visibleElement();
  hidden.display = "none";
  const wrapper = Object.assign(visibleElement(), { parentElement: hidden, display: "contents" });
  h.window.getComputedStyle = node => ({ visibility: "visible", display: node.display || "block" });
  const message = text => Object.assign(visibleElement(text), {
    parentElement: wrapper, children: [], matches: selector => selector === ".markdown"
  });
  const users = Array.from({length: 5}, () => message("Continue"));
  const assistants = [message("Old response [[LOGIC:CONTINUE]]")];
  const userSelector = "[data-message-author-role='user'],[data-user-message-bubble='true']";
  const assistantSelector = "[data-message-author-role='assistant'],[data-conversation-role='assistant']";
  h.setSelector(userSelector, users);
  h.setSelector(assistantSelector, assistants);
  return { hidden, wrapper, users, assistants, userSelector, assistantSelector, message };
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
  // Reproduce a project landing page retaining five prior user turns in a
  // display:none route subtree while its new composer is ready.
  {
    const h = destination(), history = retainedHistory(h);
    h.composer.textContent = "";
    assert.equal(h.api.messageElements("user").length, 0);
    assert.equal(h.api.messageElements("user", true).length, 5);
    assert.equal(h.api.rolloverDestinationHasMessages(), false);
    assert.equal(h.api.rolloverReadinessIssue(new URL(sourceUrl).pathname, project, true), "");
    await h.api.startClaimedLogicRollover({ ...h.pending, sourceUrl });
    assert.equal(h.runs.length, 1, "hidden retained history must not block a project-home handoff");
    h.window.location = new URL(sourceUrl + "-another-saved-chat");
    assert.equal(h.api.rolloverDestinationHasMessages(), true, "hidden history still blocks a saved destination");
    await assert.rejects(h.api.startClaimedLogicRollover({ ...h.pending, sourceUrl }), /could not be verified/);
    h.window.location = new URL(`https://chatgpt.com/g/${project}`);
    history.hidden.display = "block";
    assert.equal(h.api.messageElements("user").length, 5);
    assert.equal(h.api.rolloverDestinationHasMessages(), true, "real visible history must block handoff");
    for (const element of history.users) element.getBoundingClientRect = () => ({width:0,height:0});
    assert.equal(h.api.rolloverDestinationHasMessages(), true, "zero-sized or offscreen turns are not inactive routes");
    history.hidden.display = "contents";
    assert.equal(h.api.messageElements("user").length, 5, "display:contents is not a hidden route");
  }
  {
    const h = destination(), history = retainedHistory(h);
    const active = history.message("Current user turn"); active.parentElement = null;
    h.setSelector(history.userSelector, [active, ...history.users]);
    assert.equal(h.api.messageElements("user").length, 1);
    assert.equal(h.api.messageElements("user")[0], active, "hidden old turns cannot become the latest user");
    h.setSelector(history.userSelector, history.users);
    h.setSelector("[data-turn='user']", [active]);
    assert.equal(h.api.messageElements("user")[0], active, "inactive modern markup cannot hide active fallback turns");
  }
  {
    const h = destination(), history = retainedHistory(h);
    const parent = history.message("Visible assistant response"); parent.parentElement = null;
    const heading = Object.assign(visibleElement("Assistant"), {tagName:"H6", parentElement: parent,
      matches: selector => selector === "[data-conversation-role='assistant']",
      getBoundingClientRect: () => ({width:1,height:1})});
    h.setSelector(history.assistantSelector, [heading, ...history.assistants]);
    assert.equal(h.api.messageElements("assistant")[0], parent, "screen-reader labels retain their active response parent");
  }
  {
    const h = destination(), history = retainedHistory(h);
    h.composer.textContent = oldHandoff;
    h.setRequestHandler(async () => { history.hidden.display = "block"; return {ok:true}; });
    await assert.rejects(h.api.startClaimedLogicRollover({ ...h.pending, requestId:"receipt", sourceUrl }), /draft changed/);
    assert.equal(h.composer.textContent, oldHandoff, "history becoming active during verification preserves the draft");
    assert.equal(h.runs.length, 0);
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
  retainedHistory(actual);
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
  // Same-tab navigation retains the source heartbeat until delivery is proven.
  // It must permit the claimed startup, without authorizing ordinary sends or
  // a different source, project, receipt, or conversation.
  for (const scenario of ["valid", "unconfirmed", "ordinary", "wrong-source", "wrong-project", "no-receipt", "cancel-before-write",
    "cancel-before-send", "navigate-during-check", "schedule-during-check", "turn-during-check"]) {
    const h = destination(undefined, false);
    h.composer.textContent = "";
    const history = retainedHistory(h);
    const form = visibleElement();
    const high = visibleElement("High", {"aria-label":"Select ChatGPT model", "aria-haspopup":"menu", "aria-expanded":"false"});
    form.querySelectorAll = () => [high];
    h.composer.closest = selector => selector === "form" ? form : null;
    let writes = 0, clicks = 0, completed = false, checks = 0;
    h.api.prepareThinkingSendForTest(h.composer, (target, text) => { writes++; target.textContent = text; return true; });
    const schedule = {id:"source-schedule", enabled:true, phase:"active", url:sourceUrl};
    h.api.configureHeartbeat(scenario === "wrong-source" ? {...schedule, url:sourceUrl + "-other"} : schedule);
    const send = visibleElement("Send");
    let delivered = "";
    send.click = () => {
      assert.equal(h.api.getHeartbeatForTest().url, scenario === "wrong-source" ? sourceUrl + "-other" : sourceUrl);
      assert.equal(completed, false, "schedule transfer cannot precede Send");
      clicks++; delivered = h.composer.textContent; h.composer.textContent = "";
    };
    h.setSelector("button[data-testid='send-button']", [send]);
    h.api.observeStartupForTest(async () => scenario === "unconfirmed" ? null : ({element:visibleElement(delivered), text:delivered}));
    h.setRequestHandler(async request => {
      if (request.type === "LOGIC_ROLLOVER_CHECK") {
        checks++;
        // The first check validates the claim before starting the run.
        if (checks === 2) {
          if (scenario === "cancel-before-write") return {ok:false, error:"Handoff cancelled"};
          if (scenario === "navigate-during-check") h.window.location = new URL(sourceUrl + "-other");
          if (scenario === "schedule-during-check") h.api.configureHeartbeat({...schedule, url:sourceUrl + "-other"});
          if (scenario === "turn-during-check") history.hidden.display = "block";
        }
        if (scenario === "cancel-before-send" && writes) return {ok:false, error:"Handoff cancelled"};
      }
      if (request.type === "LOGIC_ROLLOVER_COMPLETE") {
        assert.equal(clicks, 1);
        assert.equal(h.api.getHeartbeatForTest().url, sourceUrl);
        completed = true;
        return {ok:true, heartbeatSchedule:{...schedule, url:sourceUrl + "-destination"}};
      }
      return {ok:true};
    });
    const runs = h.api.trackLogicRunsForTest();
    const pending = {...h.pending, sourceUrl, requestId:scenario === "no-receipt" ? undefined : "receipt"};
    if (scenario === "wrong-project") pending.sourceUrl = sourceUrl.replace("0123456789abcdef0123456789abcdef", "abcdef0123456789abcdef0123456789");
    if (scenario === "ordinary") {
      Object.assign(h.api.state, {running:true, mode:"logic", logicPhase:"monitoring", runId:1});
      await assert.rejects(h.api.submitMessage(1, "Continue", "Sending"), /left the scheduled conversation/);
    } else {
      await h.api.startClaimedLogicRollover(pending);
      await Promise.all(runs);
    }
    assert.equal(clicks, ["valid", "unconfirmed"].includes(scenario) ? 1 : 0, scenario);
    assert.equal(completed, scenario === "valid", scenario);
    assert.equal(writes, ["valid", "unconfirmed", "cancel-before-send"].includes(scenario) ? 1 : 0, scenario);
    if (scenario === "unconfirmed") assert.equal(h.api.getHeartbeatForTest().url, sourceUrl);
    if (scenario === "valid") {
      assert.equal(h.api.state.error, false);
      assert.equal(h.api.getHeartbeatForTest().url, sourceUrl + "-destination");
    }
  }
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
