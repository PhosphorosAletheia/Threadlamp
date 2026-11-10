/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const controls = ["#hb-save", "#hb-run", "#hb-pause", "#hb-disable"].map($);
  let tabId;
  let schedule = null;
  let busy = false;
  let poll;
  function fields() {
    $("#hb-interval-fields").hidden = $("#hb-kind").value !== "interval";
    $("#hb-daily-fields").hidden = $("#hb-kind").value !== "daily";
    $("#hb-interval").disabled = $("#hb-kind").value !== "interval";
  }
  function render(record) {
    schedule = record;
    const enabled = Boolean(record?.enabled);
    const paused = ["paused", "blocked", "disabled"].includes(record?.phase);
    $("#hb-badge").textContent = enabled ? record.suspendUntilIdle && !paused ? "Suspended until IDLE" : record.phase : "Disabled";
    $("#hb-run").disabled = busy || !enabled || paused || record.suspendUntilIdle || record.phase === "awaiting_idle";
    $("#hb-pause").disabled = busy || !record;
    $("#hb-pause").textContent = paused ? "Resume" : "Pause";
    $("#hb-disable").disabled = busy || !enabled;
    let detail = record?.detail || "No heartbeat configured.";
    if (enabled && record.nextRunAt) {
      const when = new Intl.DateTimeFormat(undefined, { timeZone: record.timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(record.nextRunAt);
      detail += ` Next heartbeat: ${when}.`;
    }
    if (record?.lastRunAt) detail += ` Last run: ${new Intl.DateTimeFormat(undefined, { timeZone: record.timeZone, hour: "numeric", minute: "2-digit" }).format(record.lastRunAt)}.`;
    $("#hb-status").textContent = detail;
  }
  async function request(type, extra = {}) {
    if (!Number.isInteger(tabId)) throw new Error("Open a saved ChatGPT conversation first.");
    return sendToBackground({ type, tabId, ...extra });
  }
  async function act(work) {
    busy = true;
    controls.forEach(control => { control.disabled = true; });
    try { const result = await work(); render(result.schedule); await refreshStatus(); }
    catch (error) { $("#hb-status").textContent = error.message; }
    finally {
      busy = false;
      $("#hb-save").disabled = !Number.isInteger(tabId);
      $("#hb-run").disabled = !schedule?.enabled || schedule.suspendUntilIdle || ["paused", "blocked", "disabled", "awaiting_idle"].includes(schedule?.phase);
      $("#hb-pause").disabled = !schedule;
      $("#hb-disable").disabled = !schedule?.enabled;
    }
  }
  $("#hb-kind").addEventListener("change", fields);
  $("#hb-form").addEventListener("submit", event => {
    event.preventDefault();
    void act(async () => {
      const configuration = Heartbeat.normalize({
        kind: $("#hb-kind").value, intervalMinutes: $("#hb-interval").value,
        times: $("#hb-times").value, timeZone: $("#hb-timezone").value,
        days: [...document.querySelectorAll(".hb-days input:checked")].map(input => Number(input.value)),
        prompt: $("#hb-prompt").value, limit: $("#hb-limit").value,
        message: messageInput.value, rolloverEnabled: projectRolloverInput.checked
      });
      return request("HB_SAVE", { configuration });
    });
  });
  $("#hb-run").addEventListener("click", () => void act(() => request("HB_CONTROL", { action: "run" })));
  $("#hb-pause").addEventListener("click", () => void act(() => request("HB_CONTROL", { action: ["paused", "blocked", "disabled"].includes(schedule?.phase) ? "resume" : "pause" })));
  $("#hb-disable").addEventListener("click", () => void act(() => request("HB_CONTROL", { action: "disable" })));
  async function initializeHeartbeat() {
    $("#hb-prompt").value = Heartbeat.DEFAULT_PROMPT;
    fields();
    try {
      const tab = await getActiveTab();
      if (!Heartbeat.canonicalUrl(tab?.url)) throw new Error("Open a saved ChatGPT conversation to configure its heartbeat.");
      tabId = tab.id;
      // The main popup handles attaching the installed content script if needed.
      await refreshStatus();
      const result = await request("HB_GET");
      if (result.schedule) {
        const record = result.schedule;
        $("#hb-kind").value = record.kind;
        $("#hb-interval").value = record.intervalMinutes;
        if (record.times.length) $("#hb-times").value = record.times.join(", ");
        $("#hb-timezone").value = record.timeZone;
        $("#hb-prompt").value = record.prompt;
        $("#hb-limit").value = record.limit;
        if (record.kind === "daily") document.querySelectorAll(".hb-days input").forEach(input => { input.checked = record.days.includes(Number(input.value)); });
        fields();
      }
      render(result.schedule);
      poll = setInterval(async () => {
        if (busy) return;
        try { render((await request("HB_GET")).schedule); }
        catch (error) { $("#hb-status").textContent = error.message; }
      }, 3000);
    } catch (error) {
      tabId = undefined;
      $("#hb-status").textContent = error.message;
      controls.forEach(control => { control.disabled = true; });
    }
  }
  window.addEventListener("unload", () => clearInterval(poll));
  void initializeHeartbeat();
})();
