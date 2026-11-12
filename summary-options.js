/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const status = $("summary-status"), key = $("summary-key"), enabled = $("summary-enabled");
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || "Summary settings could not be saved.");
    return result;
  }
  function render(value) {
    enabled.checked = value.enabled; key.value = "";
    $("summary-key-state").textContent = value.keySaved ? "Key saved locally. Leave blank to keep it." : "No API key saved.";
    status.textContent = value.enabled ? "Summaries enabled for each completed Logic Mode response using openrouter/free." : "Summaries disabled.";
  }
  $("summary-controls").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      if (enabled.checked && !await chrome.permissions.request({ origins: ["https://openrouter.ai/*"] })) {
        throw new Error("OpenRouter access was not granted.");
      }
      render(await send({ type: "SUM_SAVE", enabled: enabled.checked, apiKey: key.value }));
    } catch (error) { status.textContent = error.message; }
    finally { key.value = ""; }
  });
  $("summary-forget").addEventListener("click", async () => {
    try { render(await send({ type: "SUM_FORGET" })); }
    catch (error) { status.textContent = error.message; }
  });
  $("summary-clear").addEventListener("click", async () => {
    try { await send({ type: "SUM_CLEAR" }); status.textContent = "Saved summaries cleared."; }
    catch (error) { status.textContent = error.message; }
  });
  send({ type: "SUM_GET" }).then(render, error => { status.textContent = error.message; });
})();
