/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { harness, sourceUrl, popup } = require("./heartbeat.test.js");
const { fixture } = require("./delivery-timeout.test.js");
const CONFIG = "logicSummaryConfig", RECORDS = "logicRunSummaries";
const saved = { [CONFIG]: { enabled: true, apiKey: "invented-test-key" } };
const completion = (id = "output-1", output = "Implemented the requested change. [[LOGIC:IDLE]]") => ({ type: "SUM_COMPLETE", url: sourceUrl, completion: id, output, flag: "idle" });
const sender = h => ({ id: popup.id, frameId: 0, url: sourceUrl, tab: { ...h.tabs.get(17) } });
const result = text => ({ ok: true, json: async () => ({ model: "test/free", choices: [{ message: { content: text } }] }) });
async function setup(fetch = async () => result("Implemented and checked the requested change."), initial = saved) {
  const calls = [];
  const h = await harness(structuredClone(initial), { configureContext(context) {
    context.AbortController = AbortController;
    context.fetch = async (...args) => { calls.push(args); return fetch(...args); };
  } });
  await h.context.SummaryWorker.list();
  return Object.assign(h, { calls, summary: () => h.local.values[RECORDS]?.[sourceUrl] });
}

test("one completed prompt output is sent with the free router; duplicates and secrets stay bounded", async () => {
  const h = await setup();
  assert.equal((await h.dispatch(completion(), sender(h))).ok, true);
  assert.equal(h.calls.length, 1);
  const [url, options] = h.calls[0], body = JSON.parse(options.body);
  assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(body.model, "openrouter/free");
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].content, "Completed assistant output:\n" + completion().output);
  assert.equal(options.redirect, "error");
  assert.equal(h.summary().last.text, "Implemented and checked the requested change.");
  assert.equal(h.summary().last.flag, "idle");
  assert.equal(JSON.stringify(h.local.values[RECORDS]).includes(completion().output), false, "raw output is never persisted");
  assert.equal((await h.dispatch(completion(), sender(h))).deduplicated, true);
  assert.equal(h.calls.length, 1);
  const settings = await h.dispatch({ type: "SUM_GET" });
  assert.equal(settings.keySaved, true);
  assert.equal(JSON.stringify(settings).includes("invented-test-key"), false);
  h.setPageHandler(async (id) => ({ instanceId: `page-${id}`, url: h.tabs.get(id).url, revision: "1" }));
  const list = await h.dispatch({ type: "DB_LIST" });
  assert.equal(list.agents.find(a => a.tabId === 17).summary.last.text, h.summary().last.text);
  assert.equal(list.agents.find(a => a.tabId === 99).summary, null, "summaries never cross conversation URLs");
});

test("disabled, untrusted, wrong-route, and iframe requests cannot call OpenRouter", async () => {
  const h = await setup();
  for (const source of [popup, { ...sender(h), frameId: 1 }, { ...sender(h), id: "foreign" }, { ...sender(h), tab: { id: 17, url: "https://chatgpt.com/c/other" } }]) {
    assert.equal((await h.dispatch(completion(), source)).ok, false);
  }
  assert.equal((await h.dispatch({ type: "SUM_GET" }, sender(h))).ok, false);
  assert.equal((await h.dispatch({ type: "SUM_SAVE", enabled: true, apiKey: "bad" }, sender(h))).ok, false);
  await h.dispatch({ type: "SUM_SAVE", enabled: false });
  assert.equal((await h.dispatch(completion(), sender(h))).skipped, true);
  assert.equal(h.calls.length, 0);
  await h.dispatch({ type: "SUM_FORGET" });
  assert.equal((await h.dispatch({ type: "SUM_GET" })).keySaved, false);
});

test("rate limits, malformed responses, and excessive output preserve the previous summary and do not retry", async () => {
  let response = result("Earlier result.");
  const h = await setup(async () => response);
  await h.dispatch(completion(), sender(h));
  response = { ok: false, status: 429, json: async () => { throw new Error("must not read provider details"); } };
  await h.dispatch(completion("rate-limited"), sender(h));
  assert.equal(h.summary().status, "error");
  assert.match(h.summary().error, /rate limit/);
  assert.equal(h.summary().last.text, "Earlier result.");
  await h.dispatch(completion("rate-limited"), sender(h));
  assert.equal(h.calls.length, 2);
  response = { ok: true, json: async () => ({ error: { message: "private provider payload" } }) };
  await h.dispatch(completion("malformed"), sender(h));
  assert.match(h.summary().error, /no usable summary/);
  assert.equal(JSON.stringify(h.summary()).includes("private provider payload"), false);
  await h.dispatch(completion("large", "x".repeat(200001)), sender(h));
  assert.equal(h.calls.length, 3);
  assert.match(h.summary().error, /No excerpt was sent/);
});

test("late results cannot overwrite a newer output; clearing cannot resurrect summaries", async () => {
  const pending = [];
  const h = await setup(() => new Promise(resolve => pending.push(resolve)));
  const first = h.dispatch(completion("first"), sender(h));
  while (pending.length < 1) await h.flush();
  const second = h.dispatch(completion("second"), sender(h));
  while (pending.length < 2) await h.flush();
  pending[1](result("Newer result.")); await second;
  pending[0](result("Older result.")); await first;
  assert.equal(h.summary().last.text, "Newer result.");
  const third = h.dispatch(completion("third"), sender(h));
  while (pending.length < 3) await h.flush();
  await h.dispatch({ type: "SUM_CLEAR" });
  pending[2](result("Must not reappear.")); await third;
  assert.equal(h.summary(), undefined);
});

test("worker restart exposes interrupted status without replaying private output", async () => {
  const h = await setup(undefined, { ...saved, [RECORDS]: { [sourceUrl]: { runId: "pending", status: "pending", last: null } } });
  assert.equal(h.summary().status, "error");
  assert.match(h.summary().error, /interrupted/);
  assert.equal(h.calls.length, 0);
});

test("content captures only each finished response regardless of its Logic tag", async () => {
  const f = fixture(); f.hide();
  const requests = [];
  f.setRequestHandler(async r => { requests.push(r); return { ok: true, enabled: false }; });
  for (const flag of ["continue", "wait", "user_input", "idle", "invalid_wait"]) {
    const text = `Output only for ${flag}. [[LOGIC:${flag.toUpperCase()}]]`;
    f.api.publishOutputSummary({ element: f.assistant(), text }, flag);
    const request = requests.at(-1);
    assert.equal(request.type, "SUM_COMPLETE");
    assert.equal(request.output, text);
    assert.equal(JSON.stringify(request).includes(f.user().textContent), false);
    assert.equal(JSON.stringify(request).includes("Previous completed reply"), false);
  }
  const count = requests.length;
  f.api.publishOutputSummary({ text: "Unfinished" }, "missing");
  assert.equal(requests.length, count, "wait for a completed tag");
  requests.length = 0;
  await f.run();
  const outputs = requests.filter(r => r.type === "SUM_COMPLETE");
  assert.deepEqual(outputs.map(r => r.flag), ["continue", "idle"], "real Logic loop emits each completed output separately");
  assert.equal(outputs[1].output, "Recovered.\n[[LOGIC:IDLE]]");
});

test("permission removal and timeouts leave an error without exposing provider details", async () => {
  const h = await setup((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("private network detail")), { once: true });
  }));
  h.context.chrome.permissions.contains = async () => false;
  await h.dispatch(completion("no-permission"), sender(h));
  assert.match(h.summary().error, /Allow OpenRouter/);
  assert.equal(h.calls.length, 0);
  h.context.chrome.permissions.contains = async () => true;
  h.context.setTimeout = (callback, ms) => setTimeout(callback, ms === 25000 ? 5 : ms);
  await h.dispatch(completion("timeout"), sender(h));
  assert.equal(h.calls.length, 1);
  assert.match(h.summary().error, /timeout/);
  assert.equal(h.summary().error.includes("private network detail"), false);
});

test("clearing during capture preparation prevents an old request from being sent", async () => {
  const h = await setup();
  const crypto = h.context.crypto;
  let release;
  h.context.crypto = { subtle: { digest: (...args) => new Promise(resolve => {
    release = async () => resolve(await crypto.subtle.digest(...args));
  }) } };
  const request = h.dispatch(completion(), sender(h));
  while (!release) await h.flush();
  await h.dispatch({ type: "SUM_CLEAR" });
  await release(); await request;
  assert.equal(h.calls.length, 0);
  assert.equal(h.summary(), undefined);
});

test("settings require host permission, keep keys private, and preserve a saved key on blank updates", async () => {
  const h = await setup(undefined, {});
  assert.equal((await h.dispatch({ type: "SUM_GET" })).enabled, false);
  assert.equal((await h.dispatch({ type: "SUM_SAVE", enabled: true })).ok, false);
  h.context.chrome.permissions.contains = async () => false;
  assert.equal((await h.dispatch({ type: "SUM_SAVE", enabled: true, apiKey: "example-key" })).ok, false);
  h.context.chrome.permissions.contains = async () => true;
  const savedSettings = await h.dispatch({ type: "SUM_SAVE", enabled: true, apiKey: "example-key" });
  assert.equal(savedSettings.keySaved, true);
  assert.equal(JSON.stringify(savedSettings).includes("example-key"), false);
  await h.dispatch({ type: "SUM_SAVE", enabled: false, apiKey: "" });
  assert.equal(h.local.values[CONFIG].apiKey, "example-key");
  h.context.chrome.runtime.getManifest = () => ({ version: "1.10.0" });
  const backup = await h.dispatch({ type: "SETTINGS_EXPORT_SNAPSHOT" });
  assert.equal(JSON.stringify(backup).includes("example-key"), false, "summary API key is not exported");
  assert.equal(backup.logicRunSummaries, undefined);
});
