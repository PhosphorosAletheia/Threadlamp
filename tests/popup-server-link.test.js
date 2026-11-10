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
const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(new Set(ids).size, ids.length);
const elements = new Map(ids.map(id => [id, {
  value: "", textContent: "", disabled: false, hidden: false, options: [], listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  replaceChildren() { this.options = []; this.value = ""; },
  appendChild(option) { this.options.push(option); if (!this.value) this.value = option.value; }
}]));
const $ = id => elements.get(id);
let permission = false, permissionCalls = 0, poll, record = null;
let activeTab = { id: 17, url: "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-research/c/one" };
const requests = [];
const context = {
  console, URL, Intl, Date,
  document: { getElementById: $, createElement: () => ({ value: "", textContent: "" }) },
  window: { addEventListener() {} }, setInterval: fn => { poll = fn; return 1; }, clearInterval() {},
  getActiveTab: async () => activeTab, refreshStatus: async () => {},
  chrome: { permissions: { request: async request => {
    permissionCalls++;
    assert.deepEqual(Array.from(request.origins), ["http://localhost/*", "http://127.0.0.1/*"]);
    return permission;
  } } },
  sendToBackground: async request => {
    requests.push(request);
    if (["SL_SETUP", "SL_RECOVER"].includes(request.type)) record = { enabled: true, phase: "setup", pending: 0, uncertain: [], url: activeTab.url };
    if (request.type === "SL_CONTROL" && request.action === "disable") record = { ...record, enabled: false, phase: "disabled" };
    return { ok: true, connection: record };
  }
};
vm.createContext(context);
for (const name of ["heartbeat.js", "server-link.js", "popup-server-link.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context);
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const click = async id => { $(id).listeners.click(); await flush(); };
(async () => {
  await flush();
  assert.deepEqual(requests.map(r => r.type), ["SL_GET"], "opening popup only reads configuration");
  assert.equal(permissionCalls, 0);
  assert.equal($("sl-setup").hidden, false);
  assert.equal($("sl-recover").disabled, false, "recovery is available without a saved attempt");
  await click("sl-recover");
  assert.match($("sl-status").textContent, /declined/);
  assert.equal(requests.filter(r => r.type === "SL_RECOVER").length, 0);
  await click("sl-setup");
  assert.match($("sl-status").textContent, /declined/);
  assert.equal(requests.filter(r => r.type === "SL_SETUP").length, 0);
  permission = true;
  await click("sl-recover");
  assert.equal(requests.at(-1).type, "SL_RECOVER", "recovery without a saved record is explicit");
  assert.equal($("sl-setup").hidden, true, "initial setup is hidden when an attempt already exists");
  assert.equal($("sl-recover").disabled, false, "explicit recovery can check whether a saved in-progress phase is stale; the worker prevents live duplicates");
  record = null; await poll();
  await click("sl-setup");
  assert.equal(record.phase, "setup");
  assert.equal($("sl-setup").disabled, true);
  assert.equal($("sl-toggle").disabled, false, "setup can be cancelled");
  activeTab = { id: 99, url: "https://chatgpt.com/c/other" };
  await click("sl-toggle");
  assert.equal(record.enabled, false);
  assert.equal($("sl-setup").hidden, true);
  assert.equal($("sl-recover").disabled, false);
  await click("sl-recover");
  assert.equal(requests.at(-1).type, "SL_RECOVER", "existing setup must never send the initial installation action");
  assert.equal(record.phase, "setup");
  assert.ok(requests.every(r => r.tabId === 17), "commands retain the original target tab");
  record = { ...record, enabled: true, phase: "blocked", uncertain: ["event-one"], pending: 1 };
  await poll();
  assert.equal($("sl-resolution").hidden, false);
  await click("sl-retry");
  assert.equal(requests.at(-1).eventId, "event-one");
  assert.equal(requests.at(-1).resolution, "retry");
  console.log("server connection popup controls tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
