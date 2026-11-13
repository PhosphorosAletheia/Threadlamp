/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  async function load() {
    try {
      const result = await chrome.runtime.sendMessage({type:"LAN_GET"});
      if (!result?.ok) throw new Error(result?.error || "LAN settings unavailable.");
      if (document.activeElement !== $("lan-port")) $("lan-port").value = result.port;
      $("lan-status").textContent = `${result.detail} ${result.tokenSaved ? "Pairing token saved." : "Not paired."}`;
    } catch (error) { $("lan-status").textContent = error.message; }
  }
  async function save(enabled) {
    $("lan-connect").disabled = $("lan-disable").disabled = true;
    try {
      if (enabled && !await chrome.permissions.request({origins:["http://127.0.0.1/*", "http://localhost/*"]})) throw new Error("Loopback access was declined.");
      const result = await chrome.runtime.sendMessage({type:"LAN_SAVE", enabled, port:Number($("lan-port").value), token:$("lan-token").value});
      if (!result?.ok) throw new Error(result?.error || "Unable to save LAN settings.");
      $("lan-token").value = ""; await load();
    } catch (error) { $("lan-status").textContent = error.message; }
    finally { $("lan-connect").disabled = $("lan-disable").disabled = false; }
  }
  $("lan-connect").addEventListener("click", () => void save(true));
  $("lan-disable").addEventListener("click", () => void save(false));
  const timer = setInterval(load, 5000);
  window.addEventListener("unload", () => clearInterval(timer));
  void load();
})();
