/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { contentHarness, backgroundHarness, visibleElement } = require("./rollover.test.js");
const { harness: workerHarness, sourceUrl: workerSource } = require("./heartbeat.test.js");
const projectId = "g-p-0123456789abcdef0123456789abcdef";
const segment = `${projectId}-example-agent`;
const sourceUrl = `https://chatgpt.com/g/${segment}/c/source`;
const homeUrl = `https://chatgpt.com/g/${projectId}/project`;
const notice = "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.";

function fixture() {
  let now = 0, tick = () => {};
  class Clock extends Date { static now() { return now; } }
  const h = contentHarness({ Date: Clock, setTimeout(fn, ms) { return setImmediate(() => { now += ms; tick(); fn(); }); } });
  h.window.location = new URL(sourceUrl); h.document.title = "Funding screening update";
  const composer = visibleElement();
  h.setSelector("#prompt-textarea", [composer]);
  const alert = visibleElement(notice); h.setAlerts([alert]);
  let user = visibleElement("Private submitted user prompt"), assistant = visibleElement("Private previous response");
  h.api.setTimeoutSnapshotsForTest(role => {
    const element = role === "user" ? user : assistant;
    return { element, text: element?.textContent || "" };
  });
  const attrs = { href: homeUrl };
  const nav = { tagName: "NAV" };
  const link = visibleElement("Example Agent", attrs);
  link.closest = selector => selector === "nav, header, aside, [role='navigation']" ? nav : null;
  h.setSelector("a[href]", [link]);
  const calls = [], runs = h.api.captureHeartbeatRunsForTest();
  let pending, duringPrepare = () => {}, afterNavigation = () => {}, clicks = 0;
  link.click = () => {
    clicks++; h.window.location = new URL(homeUrl); h.setAlerts([]);
    user = assistant = null; afterNavigation();
  };
  h.setRequestHandler(async request => {
    calls.push(request);
    if (request.type === "LOGIC_ROLLOVER_PREPARE") {
      pending = { ...request, requestId: "handoff" }; duringPrepare();
      return { ok: true, requestId: "handoff" };
    }
    if (request.type === "LOGIC_ROLLOVER_CLAIM") return { ok: true, pending };
    return { ok: true, removed: true };
  });
  Object.assign(h.api.state, { running: true, mode: "logic", logicPhase: "rolling_over", runId: 8,
    rolloverEnabled: true, message: "Continue", count: 2, limit: 8 });
  return { ...h, composer, alert, link, attrs, calls, runs, clicks: () => clicks,
    duringPrepare: fn => { duringPrepare = fn; }, afterNavigation: fn => { afterNavigation = fn; },
    onTick: fn => { tick = fn; }, setTurns: (u, a) => { user = u; assistant = a; } };
}
function detection() {
  const h = fixture();
  for (const text of [notice, notice.replace("You've", "You’ve"),
    "This conversation is too long, please start a new one.",
    "This chat has reached its maximum length. Open a new chat to continue.",
    "You've reached the conversation length limit.",
    "The conversation has exceeded the length limit. Start a new conversation.",
    "Maximum conversation length reached", "Chat length limit exceeded"])
    assert.equal(h.api.isConversationLimitText(text), true, text);
  for (const text of ["You've reached your message limit. Try again in 2 hours.",
    "Rate limit reached. Start a new chat later.", "This message is too long. Shorten your prompt.",
    "You've reached the maximum length for this message.", "You've reached your daily conversation limit.",
    "This conversation has not reached its maximum length.", "If this conversation is too long, start a new chat.",
    "This chat may reach its maximum length soon.", `Here is an example: ${notice}`, `The quote says: ${notice}`,
    `This conversation is too long ${"ordinary prose ".repeat(80)}`])
    assert.equal(h.api.isConversationLimitText(text), false, text);
  h.setAlerts([]);
  h.setSelector("[role='status']", [visibleElement("This conversation is too long. Start a new chat.")]);
  assert.equal(h.api.hasMaximumLengthNotice(), true, "status-style service notice");
  h.setSelector("[role='status']", []);
  const assistant = visibleElement("This conversation is too long, please start a new one.");
  h.setTurns(null, assistant);
  assert.equal(h.api.hasMaximumLengthNotice(), true, "latest assistant service notice");
  assistant.getBoundingClientRect = () => ({ width: 0, height: 0 });
  assert.equal(h.api.hasMaximumLengthNotice(), false, "hidden stale message cannot trigger rollover");
}
function actions() {
  for (const label of ["Start new chat", "New chat", "Start a new chat", "Open new conversation"]) {
    const h = fixture(), button = visibleElement(label);
    h.alert.querySelectorAll = () => [button];
    assert.equal(h.api.findProjectRolloverAction().kind, "project_home", "prefer navigation that exposes a stable project ID");
    h.setSelector("a[href]", []);
    assert.equal(h.api.findProjectRolloverAction().kind, "notice_button", label);
    button.disabled = true;
    assert.equal(h.api.findProjectRolloverAction(), null);
  }
  for (const [name, change] of Object.entries({
    wrongProject: h => { h.attrs.href = homeUrl.replace(projectId, "g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); },
    anotherChat: h => { h.attrs.href = sourceUrl.replace("/source", "/other"); },
    foreign: h => { h.attrs.href = homeUrl.replace("chatgpt.com", "example.com"); },
    query: h => { h.attrs.href += "?prompt=untrusted"; },
    fragment: h => { h.attrs.href += "#other"; },
    newWindow: h => { h.attrs.target = "_blank"; },
    download: h => { h.attrs.download = ""; },
    disabled: h => { h.attrs["aria-disabled"] = "true"; },
    transcript: h => { h.link.closest = () => ({}); },
    nonNavigation: h => { h.link.closest = () => null; },
    noLimit: h => h.setAlerts([])
  })) {
    const h = fixture(); change(h);
    assert.equal(h.api.findProjectRolloverAction(), null, name);
  }
}
function unknownErrorFixture() {
  const h = fixture();
  h.setSelector("a[href]", []);
  const button = visibleElement("Start new chat");
  h.alert.textContent = "Unknown errorStart new chat";
  h.alert.querySelectorAll = () => [button];
  button.click = h.link.click;
  return { ...h, button };
}
async function unknownError() {
  for (const text of ["Unknown errorStart new chat", "Unknown error\nStart new chat", "Unknown error. Start new chat"]) {
    const h = unknownErrorFixture(); h.alert.textContent = text;
    assert.equal(h.api.hasMaximumLengthNotice(), true, text);
    assert.equal(h.api.findProjectRolloverAction().element, h.button);
    await h.api.beginProjectRollover(8);
    assert.equal(h.clicks(), 1);
    assert.equal(h.runs.length, 1, "resumes through guarded same-project rollover");
    assert.equal(h.calls.find(r => r.type === "LOGIC_ROLLOVER_PREPARE").projectHomeUrl, "");
  }
  for (const [name, change] of Object.entries({
    noButton: h => { h.alert.querySelectorAll = () => []; },
    headerOnly: h => { h.alert.textContent = "Unknown error"; h.alert.querySelectorAll = () => []; h.setSelector("button, [role='button']", [h.button]); },
    retry: h => { h.alert.textContent = "Unknown errorRetry"; h.button.textContent = "Retry"; },
    disabled: h => { h.button.disabled = true; },
    ariaDisabled: h => { h.button.getAttribute = name => name === "aria-disabled" ? "true" : null; },
    hiddenButton: h => { h.button.getBoundingClientRect = () => ({ width: 0, height: 0 }); },
    hiddenNotice: h => { h.alert.getBoundingClientRect = () => ({ width: 0, height: 0 }); },
    transcript: h => { h.alert.closest = () => ({}); },
    quotation: h => { h.alert.textContent = "Example: Unknown errorStart new chat"; },
    quota: h => { h.alert.textContent = "Message limit reachedStart new chat"; },
    extraProse: h => { h.alert.textContent += " is an example"; }
  })) {
    const h = unknownErrorFixture(); change(h);
    assert.equal(h.api.hasMaximumLengthNotice(), false, name);
    assert.equal(h.api.findProjectRolloverAction(), null, name);
  }
  for (const change of ["removed", "disabled", "replaced", "draft"]) {
    const h = unknownErrorFixture();
    h.duringPrepare(() => {
      if (change === "removed") h.alert.querySelectorAll = () => [];
      if (change === "disabled") h.button.disabled = true;
      if (change === "replaced") h.alert.querySelectorAll = () => [visibleElement("Start new chat")];
      if (change === "draft") h.composer.innerText = h.composer.textContent = "Manual draft";
    });
    await h.api.beginProjectRollover(8);
    assert.equal(h.clicks(), 0, change);
    assert.equal(h.runs.length, 0, change);
    assert.ok(h.calls.some(r => r.type === "LOGIC_ROLLOVER_CANCEL"), change);
  }
}
async function transitions() {
  let h = fixture();
  await h.api.beginProjectRollover(8);
  assert.equal(h.clicks(), 1);
  assert.equal(h.calls.find(r => r.type === "LOGIC_ROLLOVER_PREPARE").projectHomeUrl, homeUrl);
  assert.equal(h.runs.length, 1);
  assert.match(h.runs[0][2], /Funding screening update/);
  assert.equal(h.api.state.count, 2); assert.equal(h.api.state.limit, 8);
  for (const change of ["draft", "url", "link", "notice", "stop", "pause", "user", "generating"]) {
    h = fixture();
    h.duringPrepare(() => {
      if (change === "draft") h.composer.innerText = h.composer.textContent = "Preserve this manual draft";
      if (change === "url") h.window.location = new URL(sourceUrl + "-changed");
      if (change === "link") h.attrs.href += "?changed=1";
      if (change === "notice") h.setAlerts([]);
      if (change === "stop") h.api.state.running = false;
      if (change === "pause") h.api.state.paused = true;
      if (change === "user") h.setTurns(visibleElement("A new manual message"), null);
      if (change === "generating") h.setSelector("button[data-testid='stop-button']", [visibleElement("Stop")]);
    });
    await h.api.beginProjectRollover(8);
    assert.equal(h.clicks(), 0, change); assert.equal(h.runs.length, 0, change);
    assert.ok(h.calls.some(r => r.type === "LOGIC_ROLLOVER_CANCEL"), change);
    if (change === "draft") assert.equal(h.composer.textContent, "Preserve this manual draft");
  }
  h = fixture(); h.composer.innerText = h.composer.textContent = "My source draft";
  await h.api.beginProjectRollover(8);
  assert.equal(h.clicks(), 0); assert.equal(h.composer.textContent, "My source draft");
  h = fixture();
  h.afterNavigation(() => { h.composer.innerText = h.composer.textContent = "My destination draft"; });
  await h.api.beginProjectRollover(8);
  assert.equal(h.runs.length, 0); assert.equal(h.composer.textContent, "My destination draft");
  for (const blocked of ["staleTurns", "savedChat", "missingComposer"]) {
    h = fixture(); h.afterNavigation(() => {
      if (blocked === "staleTurns") h.setTurns(visibleElement("Old turn still mounted"), null);
      if (blocked === "savedChat") h.window.location = new URL(sourceUrl.replace("/source", "/another-chat"));
      if (blocked === "missingComposer") h.setSelector("#prompt-textarea", []);
    });
    await h.api.beginProjectRollover(8);
    assert.equal(h.runs.length, 0, blocked);
    assert.equal(h.calls.some(r => r.type === "LOGIC_ROLLOVER_CLAIM"), false, blocked);
    assert.equal(h.api.state.error, true, blocked);
  }
}
async function binding() {
  const { api } = await backgroundHarness();
  const sender = { id: "extension-test-id", tab: { id: 17, url: sourceUrl } };
  const payload = { projectSegment: segment, previousTitle: "Funding screening update", message: "Continue", count: 2, limit: 8, projectHomeUrl: homeUrl };
  const prepared = await api.prepareLogicRollover(payload, sender);
  for (const tab of [{ id: 99, url: homeUrl }, { id: 17, url: sourceUrl.replace("-example-agent", "") },
    { id: 17, url: sourceUrl.replace("/source", "/other") }, { id: 17, url: homeUrl.replace(projectId, "g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") }]) {
    assert.equal((await api.claimLogicRollover({ requestId: prepared.requestId }, { ...sender, tab })).pending, null);
  }
  const claimed = await api.claimLogicRollover({ requestId: prepared.requestId }, { ...sender, tab: { id: 17, url: homeUrl } });
  assert.equal(claimed.pending.projectHomeUrl, homeUrl);
  assert.equal(claimed.pending.previousTitle, payload.previousTitle);
  for (const invalid of [sourceUrl, homeUrl.replace("chatgpt.com", "example.com"), homeUrl + "?x=1"])
    await assert.rejects(api.prepareLogicRollover({ ...payload, projectHomeUrl: invalid }, sender), /navigation destination/);
}
async function heartbeat() {
  const h = await workerHarness();
  const saved = await h.dispatch({ type: "HB_SAVE", tabId: 17, configuration: { kind: "interval", intervalMinutes: 60,
    timeZone: "America/Chicago", prompt: "Scheduled checks", message: "Continue", limit: 8, rolloverEnabled: true } });
  assert.equal(saved.ok, true);
  const rollover = { sourceTabId: 17, sourceUrl: workerSource, projectSegment: `${projectId}-job-search` };
  h.tabs.get(17).url = homeUrl;
  await h.context.HeartbeatScheduler.transfer(rollover, h.tabs.get(17));
  const attached = await h.dispatch({ type: "HB_STATE", scheduleId: saved.schedule.id, instanceId: "new-page", phase: "active" },
    { id: "test-extension", tab: h.tabs.get(17) });
  assert.equal(attached.ok, true); assert.equal(attached.schedule.phase, "active", "heartbeat follows the same stable project ID without its slug");
}
(async () => { detection(); actions(); await unknownError(); await transitions(); await binding(); await heartbeat(); console.log("conversation-limit variants, unknown-error restart, same-project fallback, race guards and heartbeat transfer passed"); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
