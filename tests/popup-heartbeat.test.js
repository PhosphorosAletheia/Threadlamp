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
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, "popup IDs must be unique");
const inputs = new Map(ids.map(id => [id, { value: "", textContent: "", disabled: false, checked: false, hidden: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } }]));
const $ = id => inputs.get(id);
$("hb-kind").value = "interval";
$("hb-interval").value = "60";
$("hb-times").value = "09:00, 15:00";
$("hb-timezone").value = "America/Chicago";
$("hb-limit").value = "5";
const days = Array.from({ length: 7 }, (_, value) => ({ value: String(value), checked: value >= 1 && value <= 5 }));
const requests = [];
let schedule = null;
let activeTab = { id: 17, url: "https://chatgpt.com/c/scheduled" };
let poll;
const context = {
  Intl, Date, URL, console,
  document: {
    querySelector(selector) { assert.ok(selector.startsWith("#")); const result = $(selector.slice(1)); assert.ok(result, `Missing DOM control ${selector}`); return result; },
    querySelectorAll: selector => selector === ".hb-days input:checked" ? days.filter(day => day.checked) : days
  },
  window: { addEventListener() {} }, setInterval: fn => { poll = fn; return 1; }, clearInterval() {},
  messageInput: { value: "Continue" }, projectRolloverInput: { checked: true },
  getActiveTab: async () => activeTab, refreshStatus: async () => {},
  sendToBackground: async request => {
    requests.push(request);
    if (request.type === "HB_SAVE") schedule = { ...request.configuration, enabled: true, phase: "sleeping", detail: "Sleeping", nextRunAt: Date.now() + 60000 };
    if (request.type === "HB_CONTROL") {
      if (request.action === "pause") schedule = { ...schedule, phase: "paused", nextRunAt: null };
      if (request.action === "resume") schedule = { ...schedule, phase: "sleeping", nextRunAt: Date.now() + 60000 };
      if (request.action === "run") schedule = { ...schedule, phase: "active", lastRunAt: Date.now() };
      if (request.action === "disable") schedule = { ...schedule, enabled: false, phase: "disabled", nextRunAt: null };
    }
    return { ok: true, schedule };
  }
};
vm.createContext(context);
for (const name of ["heartbeat.js", "popup-heartbeat.js"]) vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name });
const flush = () => new Promise(resolve => setImmediate(resolve));
const submit = async () => { $("hb-form").listeners.submit({ preventDefault() {} }); await flush(); };
const click = async id => { $(id).listeners.click(); await flush(); };
(async () => {
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "HB_GET", "opening the popup must not enable a schedule");
  assert.ok($("hb-prompt").value.includes("[[LOGIC:IDLE]]"));
  $("hb-kind").value = "daily";
  $("hb-kind").listeners.change();
  assert.equal($("hb-daily-fields").hidden, false);
  assert.equal($("hb-interval").disabled, true);
  await submit();
  assert.equal(schedule.kind, "daily");
  assert.deepEqual(Array.from(schedule.times), ["09:00", "15:00"]);
  assert.deepEqual(Array.from(schedule.days), [1, 2, 3, 4, 5]);
  assert.match($("hb-status").textContent, /Next heartbeat/);
  await click("hb-pause");
  assert.equal(schedule.phase, "paused");
  assert.equal($("hb-pause").textContent, "Resume");
  assert.equal($("hb-run").disabled, true);
  await click("hb-pause");
  assert.equal(schedule.phase, "sleeping");
  activeTab = { id: 99, url: "https://chatgpt.com/c/other-agent" };
  await click("hb-run");
  assert.equal(schedule.phase, "active");
  assert.ok(requests.every(request => request.tabId === 17), "popup commands stay bound to the original chat");
  const saves = requests.filter(request => request.type === "HB_SAVE").length;
  $("hb-timezone").value = "Not/AZone";
  await submit();
  assert.equal(requests.filter(request => request.type === "HB_SAVE").length, saves);
  assert.match($("hb-status").textContent, /valid timezone/);
  await click("hb-disable");
  assert.equal(schedule.enabled, false);
  await poll();
  assert.equal($("hb-badge").textContent, "Disabled");
  schedule = { ...schedule, enabled: true, phase: "active", suspendUntilIdle: true, nextRunAt: null, detail: "Manual conversation active." };
  await poll();
  assert.equal($("hb-badge").textContent, "Suspended until IDLE");
  assert.equal($("hb-run").disabled, true);
  assert.equal($("hb-disable").disabled, false);
  assert.equal($("hb-pause").textContent, "Pause");
  schedule = { ...schedule, phase: "sleeping", suspendUntilIdle: false, nextRunAt: Date.now() + 3600000 };
  await poll();
  assert.equal($("hb-run").disabled, false);
  assert.match($("hb-status").textContent, /Next heartbeat/);
  console.log("heartbeat popup controls tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
