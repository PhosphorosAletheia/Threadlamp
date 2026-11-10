/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const buttons = ["sl-setup", "sl-recover", "sl-toggle", "sl-assign", "sl-delivered", "sl-retry"].map($);
  let tab, record, busy = false;
  function render(connection) {
    record = connection;
    $("sl-status").textContent = connection
      ? `${connection.phase}: ${connection.detail} ${connection.endpoint || ""} Pending events: ${connection.pending}.`
      : "No server connection configured for this project.";
    $("sl-toggle").textContent = connection?.enabled ? "Disable" : "Enable";
    $("sl-setup").hidden = Boolean(connection);
    $("sl-toggle").disabled = busy || !connection;
    $("sl-assign").disabled = busy || !connection || connection.url === Heartbeat.canonicalUrl(tab?.url);
    $("sl-setup").disabled = busy || !tab || ["setup", "pairing", "confirming"].includes(connection?.phase);
    // Only the worker can distinguish a live setup from a saved stale phase
    // after reload. Let explicit recovery verify it without waiting for expiry.
    $("sl-recover").disabled = busy || !tab;
    const choices = $("sl-event"), selected = choices.value;
    choices.replaceChildren();
    for (const eventId of connection?.uncertain || []) {
      const option = document.createElement("option");
      option.value = option.textContent = eventId;
      choices.appendChild(option);
    }
    if ([...choices.options].some(option => option.value === selected)) choices.value = selected;
    $("sl-resolution").hidden = !connection?.uncertain.length;
    $("sl-delivered").disabled = $("sl-retry").disabled = busy;
  }
  async function request(type, extra = {}) {
    return sendToBackground({ type, tabId: tab.id, ...extra });
  }
  async function action(work) {
    busy = true; buttons.forEach(b => { b.disabled = true; });
    try {
      const result = await work();
      busy = false; render(result.connection);
    } catch (error) {
      busy = false; render(record); $("sl-status").textContent = error.message;
    }
  }
  function startSetup(recovering) {
    // Request only loopback hosts, directly from the user's setup click.
    const permission = chrome.permissions.request({ origins: ["http://localhost/*", "http://127.0.0.1/*"] });
    void action(async () => {
      if (!await permission) throw new Error("Local server permission was declined.");
      await refreshStatus();
      return request(recovering || record ? "SL_RECOVER" : "SL_SETUP");
    });
  }
  $("sl-setup").addEventListener("click", () => startSetup(false));
  $("sl-recover").addEventListener("click", () => startSetup(true));
  $("sl-toggle").addEventListener("click", () => void action(() => request("SL_CONTROL", { action: record.enabled ? "disable" : "enable" })));
  $("sl-assign").addEventListener("click", () => void action(() => request("SL_CONTROL", { action: "assign" })));
  for (const [id, resolution] of [["sl-delivered", "delivered"], ["sl-retry", "retry"]]) {
    $(id).addEventListener("click", () => void action(() => request("SL_CONTROL", {
      action: "resolve", eventId: $("sl-event").value, resolution
    })));
  }
  const poll = setInterval(async () => {
    if (!tab || busy) return;
    try { render((await request("SL_GET")).connection); }
    catch (error) { $("sl-status").textContent = error.message; }
  }, 3000);
  window.addEventListener("unload", () => clearInterval(poll));
  void (async () => {
    try {
      const active = await getActiveTab();
      if (!Heartbeat.canonicalUrl(active?.url) || !ServerLink.projectId(active.url)) throw new Error("Open a saved project conversation to set up its server.");
      tab = active;
      render((await request("SL_GET")).connection);
    } catch (error) {
      $("sl-status").textContent = error.message;
      buttons.forEach(button => { button.disabled = true; });
    }
  })();
})();
