/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
/* The LAN bridge has dashboard authority only, never arbitrary extension RPC. */
(() => {
  "use strict";
  const actions = new Set(["start_loop", "stop", "start_logic", "resume_logic", "pause", "resume", "next_cycle",
    "queue", "queue_append", "remove_queue", "cancel_queue", "continue", "status", "reply", "approve",
    "heartbeat_save", "heartbeat_run", "heartbeat_pause", "heartbeat_resume", "heartbeat_disable",
    "server_setup", "server_recover", "server_assign", "server_enable", "server_disable", "server_resolve"]);
  const types = new Set(["DB_LIST", "DB_INSPECT", "DB_DISMISS", "DB_CLEAR_HISTORY", "DB_COMMAND",
    "ALERT_GET_SETTINGS", "ALERT_SET_SETTINGS", "ALERT_TEST_SOUND", "HA_GET_SETTINGS",
    "LAN_OPEN_CHAT", "LAN_OPEN_OPTIONS", "LAN_LOOPBACK_PERMISSION"]);
  function allowed(request) {
    return Boolean(request && typeof request === "object" && !Array.isArray(request) && types.has(request.type)
      && (request.type !== "DB_COMMAND" || actions.has(request.action)));
  }
  const api = {allowed, requestLimit: 128 * 1024, responseLimit: 16 * 1024 * 1024, protocol: 1};
  if (typeof module !== "undefined") module.exports = api;
  else globalThis.LanProtocol = api;
})();
