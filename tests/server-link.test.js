/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { harness, sourceUrl, popup } = require("./heartbeat.test.js");
const { fixture } = require("./delivery-timeout.test.js");
const KEY = "logicServerLinks";
const project = "g-p-0123456789abcdef0123456789abcdef";
const otherProject = "g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const endpoint = "ws://localhost:3000/.well-known/continue-loop";
const credential = "ab".repeat(32);

async function worker(saved = {}) {
  const sockets = [], timers = [];
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.onclose?.(); }
    async open() { this.readyState = 1; await this.onopen(); }
    receive(data) { this.onmessage({ data: typeof data === "string" ? data : JSON.stringify(data) }); }
  }
  const h = await harness(saved, { configureContext(context) {
    context.WebSocket = Socket;
    context.setInterval = fn => { timers.push(fn); return timers.length; };
    context.clearInterval = () => {};
  } });
  let instance = "page-A";
  const setups = [];
  h.setPageHandler(async (id, request) => {
    if (request.type === "HEARTBEAT_IDENTITY") return { instanceId: instance, url: h.tabs.get(id).url };
    if (request.type === "SERVER_LINK_SETUP") { setups.push(request); return { accepted: true }; }
    if (request.type === "SERVER_LINK_SETUP_STATUS") return {
      active: true, instanceId: instance, url: h.tabs.get(id).url,
      setupId: setups.findLast(s => s.url === h.tabs.get(id).url)?.setupId
    };
    if (request.type === "SERVER_LINK_WAKE") return { accepted: false };
    throw new Error("Unexpected page request: " + request.type);
  });
  const record = (p = project) => h.local.values[KEY]?.[p];
  const get = (tabId = 17) => h.dispatch({ type: "SL_GET", tabId });
  const chat = (type, data = {}, tabId = 17) => h.dispatch({ type, instanceId: instance, ...data },
    { id: "test-extension", frameId: 0, tab: h.tabs.get(tabId) });
  async function setup(tabId = 17, address = endpoint, complete = true, action = "SL_SETUP") {
    const created = await h.dispatch({ type: action, tabId });
    assert.equal(created.ok, true, created.error);
    const p = h.context.ServerLink.projectId(h.tabs.get(tabId).url);
    assert.ok(setups.at(-1).prompt.includes(record(p).pairingToken));
    assert.equal((await chat("SL_READY", { setupId: record(p).setupId, endpoint: address }, tabId)).ok, true);
    const s = sockets.at(-1);
    await s.open();
    const pair = s.sent.at(-1);
    assert.equal(pair.type, "pair");
    assert.equal(pair.token, undefined);
    const proof = await h.context.ServerLink.proof(record(p).pairingToken, "pair-server", p, record(p).setupId, pair.challenge, credential);
    s.receive({ type: "paired", protocol: 1, projectId: p, setupId: record(p).setupId, challenge: pair.challenge, credential, proof });
    await get(tabId);
    assert.equal(record(p).pairingToken, undefined);
    s.receive({ type: "test_ok", projectId: p, challenge: s.sent.at(-1).challenge });
    await get(tabId);
    assert.equal(record(p).phase, "confirming");
    if (!complete) return s;
    assert.equal((await chat("SL_COMPLETE", { setupId: record(p).setupId }, tabId)).ok, true);
    assert.equal(record(p).phase, "connected");
    return s;
  }
  return { ...h, sockets, timers, setups, record, get, chat, setup, setInstance: value => { instance = value; } };
}

function event(n = 1, p = project) {
  return { type: "event", projectId: p, eventId: `form-${n}`, eventType: "form_submitted", submissionId: `submission-${n}` };
}
async function protocolTests() {
  const h = await worker(), api = h.context.ServerLink;
  assert.equal(api.projectId(sourceUrl), project);
  assert.equal(api.projectId(sourceUrl.replace("job-search", "new-name")), project);
  assert.equal(api.chatKey(sourceUrl), api.chatKey(sourceUrl.replace("job-search", "new-name")));
  assert.equal(await api.proof("secret", "auth-client", project, "", "challenge"),
    createHmac("sha256", "secret").update(JSON.stringify(["auth-client", project, "", "challenge", ""])).digest("hex"));
  assert.equal(api.projectId("https://evil.example/g/" + project + "/c/test"), "");
  assert.equal(api.endpoint(endpoint), endpoint);
  for (const url of [
    "ws://example.com:3000/.well-known/continue-loop", "ws://localhost.evil:3000/.well-known/continue-loop",
    endpoint + "?secret=x", endpoint + "#fragment", endpoint.replace("3000", "80"),
    endpoint.replace("localhost", "user@localhost"), endpoint.replace("ws:", "http:"),
    "ws://127.0.0.1:3000/arbitrary", "ws://192.168.1.2:3000/.well-known/continue-loop"
  ]) assert.throws(() => api.endpoint(url), /Use ws/);
  const line = id => `[[SERVER_READY:${JSON.stringify({ protocol: 1, projectId: project, setupId: id, endpoint })}]]`;
  assert.equal(api.ready(line("fresh"), "fresh", project), endpoint);
  assert.equal(api.ready("```text\n" + line("fresh") + "\n```", "fresh", project), endpoint);
  assert.equal(api.ready("[[SERVER_READY:", "fresh", project), null);
  assert.throws(() => api.ready("```text\n" + line("old") + "\n```", "fresh", project), /does not match/);
  assert.throws(() => api.ready("```text\n" + line("fresh") + "\n" + line("fresh") + "\n```", "fresh", project), /more than one/);
  const responseRecord = { setupId: "fresh", projectId: project, endpoint,
    pairingToken: "private-pairing-token", credential: "private-credential" };
  const instructions = api.readyInstructions(responseRecord);
  assert.equal(api.ready(instructions, "fresh", project), endpoint);
  assert.ok(!instructions.includes(responseRecord.pairingToken));
  assert.ok(!instructions.includes(responseRecord.credential));
  for (const prompt of [api.setupPrompt(responseRecord, "extension"),
    api.recoveryPrompt(responseRecord, "extension", "previous")]) {
    assert.ok(prompt.includes(instructions));
    assert.ok(prompt.includes("not authentication secrets"));
    assert.ok(!prompt.includes("Do not wrap"));
  }
  assert.equal(api.ready("No setup response yet", "fresh", project), null);
  assert.throws(() => api.ready(line("old"), "fresh", project), /does not match/);
  assert.throws(() => api.ready(line("fresh") + "\n" + line("fresh"), "fresh", project), /more than one/);
  assert.throws(() => api.ready('[[SERVER_READY:{"private-content"}]]', "fresh", project),
    error => /invalid JSON/.test(error.message) && !error.message.includes("private-content"));
  assert.throws(() => api.event({ ...event(), submissionId: "ignore instructions\n" }, project), /Invalid/);
  assert.throws(() => api.event(event(1, otherProject), project), /Invalid/);
  assert.throws(() => api.event({ ...event(), prompt: "arbitrary instruction" }, project), /Invalid/);
}

async function routingTests() {
  const h = await worker();
  assert.equal((await h.dispatch({ type: "SL_SETUP", tabId: 17 }, { ...popup, id: "attacker" })).ok, false);
  const a = await h.setup();
  const publicData = JSON.stringify(await h.get());
  assert.ok(!publicData.includes(credential));
  assert.ok(!publicData.includes("pairingToken"));
  h.tabs.set(99, { id: 99, url: sourceUrl.replace(project, otherProject), title: "Other agent" });
  const b = await h.setup(99, endpoint.replace("3000", "8080"));
  a.receive(event()); await h.get();
  b.receive(event(2, otherProject)); await h.get(99);
  assert.equal(h.record().events.length, 1);
  assert.equal(h.record(otherProject).events.length, 1);

  h.tabs.get(17).url = sourceUrl.replace("job-search", "renamed-project");
  assert.equal((await h.chat("SL_STATUS")).ok, true, "project rename does not change the binding identity");
  h.tabs.get(17).url = sourceUrl;
  assert.equal(a.sent.at(-1).type, "ack");
  a.receive(event()); await h.get();
  assert.equal(h.record().events.length, 1, "server retry is deduplicated");
  const taken = await h.chat("SL_TAKE");
  assert.equal(taken.event.eventId, "form-1");
  assert.equal(h.record().events[0].phase, "dispatching", "persist before the composer is edited");
  assert.equal((await h.chat("SL_TAKE")).event, null, "one event in flight");
  assert.equal((await h.chat("SL_RESULT", { attemptId: taken.attemptId, outcome: "delivered" })).ok, true);
  assert.equal(h.record().events.length, 0);
  a.receive(event()); await h.get();
  assert.equal(h.record().events.length, 0, "ack retries cannot repeat a completed send");
  assert.equal(h.record(otherProject).events.length, 1);

  h.tabs.set(23, { id: 23, url: sourceUrl, title: "Duplicate" });
  assert.equal((await h.chat("SL_TAKE", {}, 23)).ok, false, "live duplicate owner is protected");
  h.tabs.set(23, { id: 23, url: sourceUrl.replace("/source", "/another"), title: "Another chat in same project" });
  assert.equal((await h.chat("SL_TAKE", {}, 23)).event, null);
  assert.equal((await h.dispatch({ type: "SL_SETUP", tabId: 23 })).ok, false, "setup cannot silently rebind another chat");

  a.receive(event(3)); await h.get();
  const interrupted = await h.chat("SL_TAKE");
  const stored = structuredClone(h.local.values);
  const restored = await worker(stored);
  assert.equal(restored.record().phase, "blocked");
  assert.equal(restored.record().events[0].phase, "uncertain");
  assert.equal((await restored.chat("SL_TAKE")).event, null);
  assert.equal((await restored.dispatch({ type: "SL_CONTROL", tabId: 17, action: "resolve", eventId: "form-3", resolution: "retry" })).ok, true);
  assert.equal(restored.record().events[0].phase, "queued");
  assert.equal(interrupted.ok, true);

  h.setInstance("page-B");
  assert.equal((await h.chat("SL_TAKE")).event, null, "page reload also detects an abandoned claim");
  assert.equal(h.record().phase, "blocked");
  assert.equal(h.record().events[0].phase, "uncertain");
  await h.dispatch({ type: "SL_CONTROL", tabId: 17, action: "resolve", eventId: "form-3", resolution: "delivered" });
  assert.equal(h.record().events.length, 0);
  await h.dispatch({ type: "SL_CONTROL", tabId: 17, action: "disable" });
  assert.equal(h.record().enabled, false);
  assert.equal(a.readyState, 3);
}

async function failureTests() {
  let h = await worker();
  await h.dispatch({ type: "SL_SETUP", tabId: 17 });
  assert.equal((await h.chat("SL_READY", { setupId: "stale", endpoint })).ok, false);
  assert.equal((await h.chat("SL_READY", { setupId: h.record().setupId, endpoint: endpoint.replace("localhost", "example.com") })).ok, false);
  await h.chat("SL_READY", { setupId: h.record().setupId, endpoint });
  let s = h.sockets.at(-1); await s.open();
  s.receive({ type: "paired", protocol: 1, projectId: otherProject, setupId: h.record().setupId, challenge: s.sent.at(-1).challenge, credential });
  await h.get(); await h.flush(); await h.get();
  assert.equal(h.record().phase, "blocked", "wrong project cannot pair");
  assert.equal(h.record().credential, undefined);

  h = await worker();
  await h.dispatch({ type: "SL_SETUP", tabId: 17 });
  assert.equal((await h.dispatch({ type: "SL_SETUP", tabId: 17 })).ok, false, "duplicate setup cannot replace the active handshake");
  await h.chat("SL_READY", { setupId: h.record().setupId, endpoint });
  s = h.sockets.at(-1); await s.open();
  s.receive({ type: "paired", protocol: 1, projectId: project, setupId: h.record().setupId,
    challenge: s.sent.at(-1).challenge, credential, proof: "00".repeat(32) });
  await h.get(); await h.flush(); await h.get();
  assert.equal(h.record().phase, "blocked", "echoing IDs is insufficient without the pre-shared secret");
  assert.equal(h.record().credential, undefined);

  h = await worker(); s = await h.setup();
  s.receive(event()); await h.get();
  const taken = await h.chat("SL_TAKE");
  await h.chat("SL_RESULT", { attemptId: taken.attemptId, outcome: "unsent" });
  assert.equal(h.record().events[0].phase, "queued");
  for (let n = 2; n <= 101; n++) s.receive(event(n));
  await h.get();
  assert.equal(h.record().events.length, 100);
  assert.equal(s.sent.at(-1).type, "busy", "full inbox leaves events on the server");
  const before = h.record().url;
  await assert.rejects(h.context.ServerLinkWorker.transfer({ sourceUrl, sourceTabId: 17 },
    { id: 22, url: sourceUrl.replace(project, otherProject) }), /mismatch/);
  assert.equal(h.record().url, before);
  const destination = sourceUrl.replace("/source", "/destination");
  const rollover = { sourceUrl, sourceTabId: 17 };
  await h.context.ServerLinkWorker.transfer(rollover, { id: 22, url: destination });
  assert.equal(h.record().url, sourceUrl, "navigation alone cannot move the server binding");
  h.tabs.set(22, { id: 22, url: destination });
  assert.equal((await h.chat("SL_BIND", { token: "wrong" }, 22)).ok, false);
  assert.equal((await h.chat("SL_BIND", { token: rollover.serverLinkTransfer.token }, 22)).ok, true);
  assert.equal(h.record().url, destination);
  assert.equal(h.record().endpoint, endpoint, "rollover retains the fixed server port");
  assert.equal(h.record().events.length, 100);
}

async function reconnectTests() {
  const h = await worker();
  const s = await h.setup();
  s.receive(event()); await h.get();
  s.close(); await h.get();
  assert.equal(h.record().phase, "disconnected");
  h.emitAlarm("logic-server-links"); await h.get();
  const next = h.sockets.at(-1);
  assert.notEqual(next, s);
  await next.open();
  const auth = next.sent.at(-1);
  assert.equal(auth.type, "auth");
  assert.equal(auth.credential, undefined, "reconnect never sends the permanent credential");
  assert.equal(auth.proof, await h.context.ServerLink.proof(credential, "auth-client", project, "", auth.challenge));
  next.receive({ type: "authenticated", protocol: 1, projectId: project, challenge: auth.challenge,
    proof: await h.context.ServerLink.proof(credential, "auth-server", project, "", auth.challenge) });
  await h.get();
  next.receive({ type: "test_ok", projectId: project, challenge: next.sent.at(-1).challenge }); await h.get();
  assert.equal(h.record().phase, "connected");
  assert.equal(h.record().events.length, 1);
  h.timers.at(-1)();
  const ping = next.sent.at(-1);
  assert.equal(ping.type, "ping");
  next.receive({ type: "pong", challenge: ping.challenge }); await h.get();
  assert.equal(h.record().phase, "connected");

  // A new worker with the same local storage must authenticate immediately,
  // without relying on a later alarm or sending another setup prompt.
  const saved = structuredClone(h.local.values);
  const restored = await worker(saved);
  assert.equal(restored.sockets.length, 1, "completed connection reconnects at worker startup");
  const resumed = restored.sockets[0];
  await resumed.open();
  const resumedAuth = resumed.sent.at(-1);
  assert.equal(resumedAuth.type, "auth");
  assert.equal(resumedAuth.proof, await restored.context.ServerLink.proof(
    credential, "auth-client", project, "", resumedAuth.challenge));
  resumed.receive({ type: "authenticated", protocol: 1, projectId: project, challenge: resumedAuth.challenge,
    proof: await restored.context.ServerLink.proof(credential, "auth-server", project, "", resumedAuth.challenge) });
  await restored.get();
  resumed.receive({ type: "test_ok", projectId: project, challenge: resumed.sent.at(-1).challenge });
  await restored.get();
  assert.equal(restored.record().phase, "connected");
  assert.equal(restored.record().credential, credential);
  assert.equal(restored.record().setupId, h.record().setupId);
  assert.deepEqual(restored.record().events, h.record().events);
  assert.equal(restored.setups.length, 0, "reload must not send setup/recovery prompts");
  assert.equal(restored.messages.some(m => m.request.type === "SERVER_LINK_SETUP"), false);

  const reinstalled = await worker();
  assert.equal(reinstalled.record(), undefined, "empty storage after uninstall has no connection to restore");
  assert.equal(reinstalled.sockets.length, 0);
}

async function setupLeaseTests() {
  const h = await worker();
  await h.dispatch({ type: "SL_SETUP", tabId: 17 });
  const setupId = h.record().setupId, originalExpiry = h.record().expiresAt;
  h.setNow(originalExpiry + 60000);
  assert.equal((await h.dispatch({ type: "SL_SETUP", tabId: 17 })).ok, false,
    "a slow live setup cannot be replaced even after its original lease");
  assert.equal((await h.chat("SL_SETUP_KEEPALIVE", { setupId })).ok, true);
  assert.ok(h.record().expiresAt > originalExpiry + 60000);
  assert.equal(h.setups.length, 1, "renewal never resends the setup prompt");
  assert.equal((await h.chat("SL_SETUP_KEEPALIVE", { setupId: "stale" })).ok, false);

  // Simulate a genuinely fresh worker with the same content script still waiting.
  const saved = structuredClone(h.local.values);
  const status = { active: true, instanceId: "page-A", url: sourceUrl, setupId };
  const restored = await harness(structuredClone(saved), {
    pageHandler: async (id, request) => {
      assert.equal(id, 17, "restore must not inspect unrelated agents");
      assert.equal(request.type, "SERVER_LINK_SETUP_STATUS");
      return status;
    }
  });
  let result = await restored.dispatch({ type: "SL_GET", tabId: 17 });
  assert.equal(result.connection.phase, "setup", "ordinary worker restart preserves live setup");
  assert.equal(restored.messages.filter(m => m.request.type === "SERVER_LINK_SETUP").length, 0);
  restored.setNow(originalExpiry + 3600000);
  restored.emitAlarm("logic-server-links");
  result = await restored.dispatch({ type: "SL_GET", tabId: 17 });
  assert.equal(result.connection.phase, "setup", "alarm renews even after a long browser suspension");
  assert.ok(restored.local.values[KEY][project].expiresAt > originalExpiry + 3600000);

  for (const invalid of [
    { active: false }, { instanceId: "reloaded-page" }, { setupId: "different-setup" },
    { url: sourceUrl.replace("/source", "/elsewhere") }
  ]) {
    const stopped = await harness(structuredClone(saved), {
      pageHandler: async () => ({ ...status, ...invalid })
    });
    const blocked = await stopped.dispatch({ type: "SL_GET", tabId: 17 });
    assert.equal(blocked.connection.phase, "blocked", JSON.stringify(invalid));
    assert.equal(stopped.local.values[KEY][project].pairingToken, undefined);
  }
  status.active = false;
  restored.setNow(restored.local.values[KEY][project].expiresAt + 1);
  restored.emitAlarm("logic-server-links");
  assert.equal((await restored.dispatch({ type: "SL_GET", tabId: 17 })).connection.phase, "blocked");

  h.setInstance("reloaded-page");
  assert.equal((await h.chat("SL_SETUP_KEEPALIVE", { setupId })).ok, false, "new page cannot inherit a setup lease");
  h.setInstance("page-A");
  await h.chat("SL_FAIL", { setupId, detail: "The agent requested human input during server setup." });
  assert.equal(h.record().detail, "The agent requested human input during server setup.");
  assert.equal((await h.chat("SL_SETUP_KEEPALIVE", { setupId })).ok, false, "renewal cannot revive a failed setup");
}

async function recoveryTests() {
  let h = await worker();
  assert.equal((await h.dispatch({ type: "SL_RECOVER", tabId: 99 })).ok, false, "recovery still requires a saved project chat");
  assert.equal((await h.dispatch({ type: "SL_RECOVER", tabId: 17 }, { ...popup, id: "attacker" })).ok, false);
  assert.equal(h.record(), undefined);
  await h.setup(17, endpoint, true, "SL_RECOVER");
  assert.equal(h.record().phase, "connected", "recovery can pair an existing server with no prior extension record");
  const discovered = h.setups[0];
  assert.equal(discovered.recovering, true);
  assert.match(discovered.prompt, /No earlier setup record is available/);
  assert.match(discovered.prompt, /Missing extension settings do not mean the server is missing/);
  assert.match(discovered.prompt, /If there is no identifiable existing server, request human input instead of creating one/);
  assert.ok(!discovered.prompt.includes("undefined"));
  assert.equal(h.setups.length, 1, "discovery sends a recovery prompt without an initial installation prompt");

  h = await worker();
  let s = await h.setup(17, endpoint, false);
  s.receive(event(77)); await h.get();
  const oldSetupId = h.record().setupId;
  await h.chat("SL_FAIL", { setupId: oldSetupId, detail: "Confirmation failed." });
  const before = structuredClone(h.record());
  assert.equal((await h.dispatch({ type: "SL_RECOVER", tabId: 17 })).ok, true);
  assert.notEqual(h.record().setupId, oldSetupId, "recovery has a fresh reply correlation ID");
  assert.equal(h.record().credential, before.credential, "paired credential survives recovery");
  assert.equal(h.record().endpoint, before.endpoint);
  assert.deepEqual(h.record().events, before.events);
  assert.deepEqual(h.record().seen, before.seen);
  const recovery = h.setups.at(-1);
  assert.equal(recovery.recovering, true);
  assert.match(recovery.prompt, /not a new installation/);
  assert.match(recovery.prompt, /Keep the existing backend credential unchanged/);
  assert.ok(!recovery.prompt.includes(credential));
  assert.equal(h.record().pairingToken, undefined);
  assert.equal((await h.chat("SL_READY", { setupId: h.record().setupId, endpoint: endpoint.replace("3000", "3001") })).ok, false,
    "recovery cannot move to a newly created server");
  assert.equal((await h.chat("SL_READY", { setupId: h.record().setupId, endpoint })).ok, true);
  s = h.sockets.at(-1); await s.open();
  const auth = s.sent.at(-1);
  assert.equal(auth.type, "auth", "existing credentials use authentication instead of pairing again");
  s.receive({ type: "authenticated", protocol: 1, projectId: project, challenge: auth.challenge,
    proof: await h.context.ServerLink.proof(credential, "auth-server", project, "", auth.challenge) });
  await h.get();
  s.receive({ type: "test_ok", projectId: project, challenge: s.sent.at(-1).challenge }); await h.get();
  assert.equal((await h.chat("SL_COMPLETE", { setupId: h.record().setupId })).ok, true);
  assert.equal(h.record().phase, "connected");
  assert.equal(h.record().events[0].eventId, "form-77");

  h = await worker();
  await h.dispatch({ type: "SL_SETUP", tabId: 17 });
  const first = h.record().setupId;
  await h.chat("SL_READY", { setupId: first, endpoint });
  await h.chat("SL_FAIL", { setupId: first, detail: "Pairing incomplete." });
  assert.equal((await h.dispatch({ type: "SL_SETUP", tabId: 17 })).ok, true, "legacy setup action also recovers");
  assert.equal(h.setups.at(-1).recovering, true);
  assert.match(h.setups.at(-1).prompt, /Re-pair ONLY the existing integration/);
  assert.ok(h.setups.at(-1).prompt.includes(h.record().pairingToken));
  assert.ok(h.setups.at(-1).prompt.includes(first), "previous attempt is identified for the agent");
  assert.equal(h.record().endpoint, endpoint);

  await h.chat("SL_FAIL", { setupId: h.record().setupId, detail: "Stopped." });
  const saved = structuredClone(h.record());
  h.setPageHandler(async (id, request) => {
    if (request.type === "HEARTBEAT_IDENTITY") return { instanceId: "page-A", url: sourceUrl };
    if (request.type === "SERVER_LINK_SETUP") return { accepted: false, detail: "The agent is still responding." };
    throw new Error("Unexpected page request");
  });
  const refused = await h.dispatch({ type: "SL_RECOVER", tabId: 17 });
  assert.equal(refused.ok, false);
  assert.deepEqual(h.record(), saved, "a refused recovery must preserve the previous attempt exactly");
}

async function recoveryAfterRestartTests() {
  for (const restart of ["page-reload", "browser-restart"]) {
    let h = await worker();
    const socket = await h.setup(17, endpoint, false);
    socket.receive(event(88)); await h.get();
    const saved = structuredClone(h.local.values), oldSetupId = h.record().setupId;
    const originalExpiry = h.record().expiresAt;
    let tabId = 17;
    if (restart === "browser-restart") {
      h = await worker(saved);
      h.tabs.delete(17);
      tabId = 27;
      h.tabs.set(tabId, { id: tabId, url: sourceUrl, title: "Restored chat" });
    }
    h.setInstance("new-page-after-restart");
    const messageStart = h.messages.length;
    assert.equal((await h.dispatch({ type: "SL_RECOVER", tabId })).ok, true,
      restart + " must recover without waiting for the saved setup lease to expire");
    assert.ok(h.context.Date.now() < originalExpiry);
    assert.equal(h.record().credential, credential);
    assert.equal(h.record().endpoint, endpoint);
    assert.equal(h.record().events[0].eventId, "form-88");
    assert.equal(h.record().tabId, tabId);
    assert.ok(h.messages.slice(messageStart).every(message => message.id === tabId));
    assert.match(h.setups.at(-1).prompt, /previous setup prompt or reply does not need to be the latest message/);
    assert.match(h.setups.at(-1).prompt, /Perform server configuration.*yourself/);
    assert.match(h.setups.at(-1).prompt, /intentionally already in chat/);
    assert.equal((await h.chat("SL_READY", { setupId: oldSetupId, endpoint }, tabId)).ok, false,
      "old replies cannot confirm the new recovery exchange");
    assert.equal((await h.chat("SL_READY", { setupId: h.record().setupId, endpoint }, tabId)).ok, true);
    const s = h.sockets.at(-1); await s.open();
    const auth = s.sent.at(-1);
    assert.equal(auth.type, "auth");
    s.receive({ type: "authenticated", protocol: 1, projectId: project, challenge: auth.challenge,
      proof: await h.context.ServerLink.proof(credential, "auth-server", project, "", auth.challenge) });
    await h.get(tabId);
    s.receive({ type: "test_ok", projectId: project, challenge: s.sent.at(-1).challenge }); await h.get(tabId);
    assert.equal((await h.chat("SL_COMPLETE", { setupId: h.record().setupId }, tabId)).ok, true);
    assert.equal(h.record().phase, "connected");
  }

  // Recovery starts from arbitrary later turns; none of the old setup DOM is needed.
  for (const previousReply of ["Later conversation with no setup information.", "Old human-input request.\n[[LOGIC:USER_INPUT]]"]) {
    const f = fixture();
    f.hide(); f.window.location = new URL(sourceUrl);
    f.user().textContent = "A later unrelated message sent after setup failed.";
    f.assistant().textContent = previousReply;
    Object.assign(f.api.state, { running: false, mode: "idle", logicPhase: "idle" });
    const setup = { url: sourceUrl, projectId: project, setupId: "fresh-recovery", prompt: "Recover existing service", recovering: true };
    f.setRequestHandler(async request => request.type === "SL_STATUS" ? { ok: true, connection: { phase: "confirming" } } : { ok: true });
    const click = f.send.click;
    f.send.click = () => {
      click();
      if (f.sends.length === 1) f.assistant().textContent = "```text\n" + `[[SERVER_READY:${JSON.stringify({
        protocol: 1, projectId: project, setupId: setup.setupId, endpoint
      })}]]` + "\n```";
    };
    assert.equal(f.api.startServerSetup(setup).accepted, true);
    for (let i = 0; i < 200 && f.api.getServerSetupForTest(); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.api.getServerSetupForTest(), null);
    assert.equal(f.api.state.error, false, f.api.state.detail);
    assert.equal(f.sends.length, 2, "fresh recovery and confirmation only");
  }
}

async function setupPromptRenderingTests() {
  const prompt = "Recover existing server.\nProject ID: ABC123\n\nKeep its fixed port.";
  for (const rendering of ["spaces", "joined-blocks", "innerText", "partial", "ui-text", "selected-child", "wrong-tag", "missing-tag", "duplicate-tag"]) {
    const f = fixture();
    f.hide(); f.window.location = new URL(sourceUrl);
    Object.assign(f.api.state, { running: false, mode: "idle", logicPhase: "idle" });
    const setup = { url: sourceUrl, projectId: project, setupId: "render-test", prompt, expiresAt: 900000, recovering: true };
    const requests = [];
    f.setRequestHandler(async request => {
      requests.push(request);
      return request.type === "SL_STATUS" ? { ok: true, connection: { phase: "confirming" } } : { ok: true };
    });
    const click = f.send.click;
    f.send.click = () => {
      click();
      if (f.sends.length !== 1) return;
      const sent = f.sends[0];
      const tag = sent.match(/\[\[SERVER_SETUP_REQUEST:[^\]]+\]\]/)[0];
      f.assistant().textContent = `[[SERVER_READY:${JSON.stringify({ protocol: 1, projectId: project, setupId: setup.setupId, endpoint })}]]`;
      f.user().innerText = ""; // Avoid the fixture's original untransformed text.
      if (rendering === "spaces") f.user().textContent = sent.replace(/\s+/g, "\u00a0 ");
      if (rendering === "joined-blocks") f.user().textContent = sent.replace(/\n/g, "");
      if (rendering === "innerText") { f.user().textContent = "Unhelpful DOM fallback"; f.user().innerText = sent; }
      if (rendering === "partial") {
        f.user().textContent = "Recover existing server.";
        let ticks = 0;
        f.onTick(() => { if (++ticks === 5) f.user().textContent = sent; });
      }
      if (rendering === "ui-text") f.user().textContent = "You said: " + sent + " Show less";
      if (rendering === "selected-child") f.api.setTimeoutSnapshotsForTest(role => {
        const element = role === "user" ? f.user() : f.assistant();
        return { element, text: role === "user" ? "Only part of the displayed prompt" : element.textContent };
      });
      if (rendering === "wrong-tag") f.user().textContent = sent.replace(tag, "[[SERVER_SETUP_REQUEST:older-request]]");
      if (rendering === "missing-tag") f.user().textContent = sent.replace(tag, "");
      if (rendering === "duplicate-tag") f.user().textContent = sent + tag;
    };
    f.api.startServerSetup(setup);
    for (let i = 0; i < 200 && f.api.getServerSetupForTest(); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.api.getServerSetupForTest(), null, rendering);
    if (["wrong-tag", "missing-tag", "duplicate-tag"].includes(rendering)) {
      assert.equal(f.api.state.error, true, rendering);
      assert.match(f.api.state.detail, /request tag/);
      assert.equal(f.sends.length, 1);
      assert.equal(requests.some(r => r.type === "SL_READY"), false);
    } else {
      assert.equal(f.api.state.error, false, rendering + ": " + f.api.state.detail);
      assert.equal(f.sends.length, 2);
      const tags = f.sends.map(text => text.match(/\[\[SERVER_SETUP_REQUEST:([^\]]+)\]\]/)[1]);
      assert.notEqual(tags[0], tags[1], "confirmation has a new request identity");
      assert.ok(requests.some(r => r.type === "SL_COMPLETE"));
    }
  }
}

async function slowSetupTests() {
  const setup = { url: sourceUrl, projectId: project, setupId: "slow-setup", prompt: "Set up server", expiresAt: 900000 };
  const ready = `[[SERVER_READY:${JSON.stringify({ protocol: 1, projectId: project, setupId: setup.setupId, endpoint })}]]`;
  const prepare = () => {
    const f = fixture();
    f.hide(); f.window.location = new URL(sourceUrl);
    Object.assign(f.api.state, { running: false, mode: "idle", logicPhase: "idle" });
    const requests = [];
    f.setRequestHandler(async request => {
      requests.push(request);
      if (request.type === "SL_STATUS") return { ok: true, connection: { phase: "confirming" } };
      return { ok: true };
    });
    return { f, requests };
  };
  const finish = async f => {
    for (let i = 0; i < 500 && f.api.getServerSetupForTest(); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.api.getServerSetupForTest(), null);
  };
  let { f, requests } = prepare();
  const click = f.send.click;
  let ticks = 0;
  f.send.click = () => {
    click(); ticks = 0;
    f.assistant().textContent = f.sends.length === 1 ? "Implementing the server now…" : "Saving configuration…";
  };
  f.onTick(() => {
    if (!f.sends.length) return;
    ticks++;
    if (ticks === 25) {
      assert.equal(f.api.state.error, false);
      assert.equal(f.api.serverSetupStatus().active, true);
      assert.equal(requests.some(r => r.type === "SL_COMPLETE"), false);
      f.advanceClock(16 * 60000);
    }
    if (ticks === 40 && f.sends.length === 1) f.assistant().textContent = '[[SERVER_READY:{"protocol":1,';
    if (ticks === 60) f.assistant().textContent = f.sends.length === 1 ? ready : "Saved.\n[[LOGIC:IDLE]]";
    if (f.sends.length === 1 && ticks === 60) f.setSelector("button[data-testid='stop-button']", [f.composer]);
    if (f.sends.length === 1 && ticks === 75) {
      assert.equal(requests.some(r => r.type === "SL_READY"), false, "visible generation must finish even with a ready block");
      f.setSelector("button[data-testid='stop-button']", []);
    }
  });
  assert.equal(f.api.startServerSetup(setup).accepted, true);
  await finish(f);
  assert.equal(f.api.state.error, false, f.api.state.detail);
  assert.equal(f.sends.length, 2, "long tool gaps and confirmation gaps must not trigger follow-up prompts");
  assert.ok(requests.filter(r => r.type === "SL_SETUP_KEEPALIVE").length >= 2);
  assert.ok(requests.some(r => r.type === "SL_COMPLETE"));
  assert.equal(f.api.serverSetupStatus().active, false);

  for (const interruption of ["stop", "navigation", "manual-message", "user-input"]) {
    ({ f, requests } = prepare());
    const send = f.send.click;
    f.send.click = () => { send(); f.assistant().textContent = "Still building…"; };
    let interrupted = false;
    f.onTick(now => {
      if (now < 10000 || interrupted) return;
      interrupted = true;
      if (interruption === "stop") f.api.stopLoop();
      if (interruption === "navigation") f.window.location = new URL(sourceUrl.replace("/source", "/elsewhere"));
      if (interruption === "manual-message") f.newUser();
      if (interruption === "user-input") f.assistant().textContent = `${ready}\nNeed approval.\n[[LOGIC:USER_INPUT]]`;
    });
    f.api.startServerSetup(setup);
    await finish(f);
    assert.equal(f.sends.length, 1, interruption);
    assert.equal(requests.some(r => r.type === "SL_READY" || r.type === "SL_COMPLETE"), false, interruption);
    if (interruption !== "stop") {
      assert.equal(f.api.state.error, true);
      assert.ok(requests.some(r => r.type === "SL_FAIL" && r.detail === f.api.state.detail));
    }
    assert.equal(f.api.serverSetupStatus().active, false);
  }
}

async function contentTests() {
  let f = fixture();
  f.hide(); f.window.location = new URL(sourceUrl);
  Object.assign(f.api.state, { running: false, mode: "idle", logicPhase: "idle" });
  const setup = { url: sourceUrl, projectId: project, setupId: "setup-one", prompt: "Set up server", expiresAt: 900000 };
  const requests = [];
  f.setRequestHandler(async request => {
    requests.push(request);
    if (request.type === "SL_STATUS") return { ok: true, connection: { phase: "confirming" } };
    return { ok: true };
  });
  const click = f.send.click;
  f.send.click = () => {
    click();
    if (f.sends.length === 1) f.assistant().textContent = `Ready\n[[SERVER_READY:${JSON.stringify({ protocol: 1, setupId: setup.setupId, projectId: project, endpoint })}]]`;
  };
  assert.equal(f.api.startServerSetup(setup).accepted, true);
  for (let i = 0; i < 250 && f.api.getServerSetupForTest(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.getServerSetupForTest(), null);
  assert.equal(f.api.state.error, false, f.api.state.detail);
  assert.equal(f.sends.length, 2, "setup instructions and confirmation are the only chat messages");
  assert.ok(requests.some(r => r.type === "SL_READY" && r.endpoint === endpoint));
  assert.ok(requests.some(r => r.type === "SL_COMPLETE"));
  assert.ok(!requests.some(r => r.type === "SL_TAKE"), "setup never consumes business events");

  f = fixture(["continue", "continue", "continue", "continue", "continue", "idle", "idle"]);
  f.hide(); f.window.location = new URL(sourceUrl);
  Object.assign(f.api.state, { running: false, mode: "idle", logicPhase: "idle" });
  f.setRequestHandler(async request => request.type === "SL_STATUS"
    ? { ok: true, connection: { phase: "confirming" } } : { ok: true });
  const lateClick = f.send.click;
  f.send.click = () => {
    lateClick();
    if (f.sends.length === 6) f.assistant().textContent = `[[SERVER_READY:${JSON.stringify({
      protocol: 1, setupId: setup.setupId, projectId: project, endpoint
    })}]]`;
  };
  f.api.startServerSetup(setup);
  for (let i = 0; i < 500 && f.api.getServerSetupForTest(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.getServerSetupForTest(), null);
  assert.equal(f.api.state.error, false, "the final permitted setup follow-up can finish pairing");
  assert.equal(f.sends.length, 7, "initial setup, five follow-ups, and confirmation");

  for (const kind of ["draft", "busy", "paused", "waiting_user", "wrong_chat"]) {
    f = fixture(); f.hide(); f.window.location = new URL(sourceUrl);
    Object.assign(f.api.state, { running: false, mode: "idle", logicPhase: "idle" });
    if (kind === "draft") f.composer.innerText = "Manual draft";
    if (kind === "busy") Object.assign(f.api.state, { running: true, mode: "logic", logicPhase: "monitoring" });
    if (kind === "paused") f.api.state.paused = true;
    if (kind === "waiting_user") f.api.state.logicPhase = "waiting_user";
    if (kind === "wrong_chat") f.window.location = new URL(sourceUrl.replace("/source", "/another"));
    assert.equal(f.api.startServerSetup(setup).accepted, false, kind);
    assert.equal(f.sends.length, 0);
  }

  f = fixture(); f.hide(); f.window.location = new URL(sourceUrl);
  const delivered = [];
  f.setRequestHandler(async request => {
    if (request.type === "SL_TAKE") return { ok: true, event: event(9), attemptId: "attempt-nine" };
    if (request.type === "SL_RESULT") delivered.push(request);
    return { ok: true };
  });
  assert.equal(await f.api.submitMessage(1, "Continue", "Sending", null, 8000, null, true), true);
  assert.ok(f.sends[0].includes("submission-9"));
  assert.equal(delivered[0].outcome, "delivered");
  assert.equal(f.api.acceptServerWake({ url: sourceUrl }).accepted, false, "working chat is not interrupted");

  for (const outcome of ["unsent", "uncertain"]) {
    f = fixture(outcome === "uncertain" ? ["timeout-no-user"] : ["idle"]);
    f.hide(); f.window.location = new URL(sourceUrl);
    const results = [];
    f.setRequestHandler(async request => {
      if (request.type === "SL_TAKE") {
        if (outcome === "unsent") f.window.location = new URL(sourceUrl.replace("/source", "/different"));
        return { ok: true, event: event(10), attemptId: "attempt-ten" };
      }
      if (request.type === "SL_RESULT") results.push(request);
      return { ok: true };
    });
    await assert.rejects(f.api.submitMessage(1, "Continue", "Sending", null, 8000, null, true),
      outcome === "unsent" ? /chat or draft changed/ : /uncertain/);
    assert.equal(results[0].outcome, outcome);
    assert.equal(f.sends.length, outcome === "unsent" ? 0 : 1);
  }

  f = fixture(); f.hide(); f.window.location = new URL(sourceUrl);
  f.assistant().textContent = "Done.\n[[LOGIC:IDLE]]";
  f.api.state.running = false;
  const wakeRequests = [];
  f.setRequestHandler(async request => { wakeRequests.push(request); return { ok: true }; });
  f.api.configureHeartbeat({ id: "schedule", url: sourceUrl, enabled: true, phase: "sleeping",
    message: "Continue", limit: 5, timeZone: "America/Chicago", nextRunAt: 3600000, initialCycle: false });
  const runs = f.api.captureHeartbeatRunsForTest();
  f.composer.innerText = "Unsent draft";
  assert.equal(f.api.acceptServerWake({ url: sourceUrl }).accepted, false);
  f.composer.innerText = "";
  f.api.state.paused = true;
  assert.equal(f.api.acceptServerWake({ url: sourceUrl }).accepted, false);
  f.api.state.paused = false;
  assert.equal(f.api.acceptServerWake({ url: sourceUrl }).accepted, true);
  assert.equal(runs[0][5], true, "event wake requires a durable event claim before sending");
  assert.ok(wakeRequests.some(r => r.type === "HB_STATE" && r.suspendUntilIdle));

  f = fixture(); f.hide(); f.window.location = new URL(sourceUrl.replace("/source", "/destination"));
  const bindings = [];
  f.setRequestHandler(async request => { bindings.push(request); return { ok: true }; });
  const transfer = { projectId: project, token: "handoff-token", expiresAt: 100000 };
  await f.api.bindServerDestination(1, transfer, "The extension continuation");
  assert.equal(bindings.length, 0, "an unrelated last prompt cannot confirm rollover");
  f.user().textContent = "The extension continuation\n\nExtra queued instructions";
  await f.api.bindServerDestination(1, transfer, "The extension continuation");
  assert.equal(bindings[0].type, "SL_BIND");
  assert.equal(bindings[0].token, transfer.token);
}

async function emptyInboxSendGuardsTests() {
  for (const stage of ["lookup", "before_send"]) {
    for (const change of ["draft", "navigation", "user_message", "composer", "generation"]) {
      const f = fixture();
      f.hide(); f.window.location = new URL(sourceUrl);
      if (stage === "before_send") f.send.disabled = true;
      let changed = false;
      const interrupt = () => {
        changed = true;
        if (change === "draft") f.composer.innerText = f.composer.textContent = "Keep my manual draft";
        if (change === "navigation") f.window.location = new URL(sourceUrl.replace("/source", "/different"));
        if (change === "user_message") f.newUser();
        if (change === "composer") f.setSelector("#prompt-textarea", []);
        if (change === "generation") f.setSelector("button[data-testid='stop-button']", [f.composer]);
      };
      f.setRequestHandler(async request => {
        if (request.type === "SL_TAKE") {
          if (stage === "lookup") interrupt();
          return { ok: true, event: null };
        }
        assert.notEqual(request.type, "SL_RESULT", "an empty inbox has no delivery claim to settle");
        return { ok: true, enabled: false };
      });
      f.onTick(() => {
        if (stage === "before_send" && f.writes.length && !changed) {
          interrupt();
          f.send.disabled = false;
        }
      });
      await assert.rejects(f.api.submitMessage(1, "Continue", "Sending", null, 8000, null, true),
        /chat or draft changed/, `${stage}: ${change}`);
      assert.equal(changed, true);
      assert.equal(f.sends.length, 0, `${stage}: ${change} must prevent Send`);
      if (stage === "lookup") assert.equal(f.writes.length, 0, "lookup interruptions must prevent writing");
      if (change === "draft") assert.equal(f.composer.innerText, "Keep my manual draft");
    }
  }
  for (const requireEvent of [false, true]) {
    const f = fixture();
    f.hide(); f.window.location = new URL(sourceUrl);
    f.setRequestHandler(async request => {
      assert.notEqual(request.type, "SL_RESULT");
      return { ok: true, event: null };
    });
    assert.equal(await f.api.submitMessage(1, "Continue", "Sending", null, 8000, null, true, requireEvent), !requireEvent);
    assert.equal(f.sends.length, requireEvent ? 0 : 1, "unchanged chats can still continue without an event");
  }
}

async function main() {
  await emptyInboxSendGuardsTests();
  await protocolTests(); await routingTests(); await failureTests(); await reconnectTests();
  await setupLeaseTests(); await recoveryTests(); await recoveryAfterRestartTests();
  await setupPromptRenderingTests(); await slowSetupTests(); await contentTests();
  console.log("server connection protocol, worker, and content tests passed");
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
