/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
/* Opt-in, loopback-only bridge. No external runtime-message authority. */
(() => {
  "use strict";
  const KEY = "threadlampLanBridge", ALARM = "threadlamp-lan-reconnect";
  let settings = {enabled:false, port:3211, token:""}, socket = null, timer = null, retry = null;
  let generation = 0, phase = "disabled", detail = "LAN access is disabled.", lastSeen = 0;
  let configQueue = Promise.resolve();
  const status = () => ({ok:true, enabled:settings.enabled, port:settings.port, tokenSaved:Boolean(settings.token), phase, detail});
  function disconnect() {
    generation++;
    clearInterval(timer); clearTimeout(retry); timer = retry = null;
    const previous = socket; socket = null;
    if (previous) previous.close();
  }
  async function connect() {
    if (!settings.enabled || socket) return;
    const epoch = generation;
    if (!await chrome.permissions.contains({origins:["http://127.0.0.1/*"]})) {
      phase = "error"; detail = "Allow loopback access in the extension's LAN settings."; return;
    }
    if (epoch !== generation || socket || !settings.enabled) return;
    const ws = new WebSocket(`ws://127.0.0.1:${settings.port}/threadlamp/bridge`);
    socket = ws; phase = "connecting"; detail = "Connecting to the local helper…"; lastSeen = Date.now();
    const current = () => socket === ws && epoch === generation && settings.enabled;
    let inFlight = 0;
    ws.onopen = () => {
      if (!current()) return ws.close();
      ws.send(JSON.stringify({type:"auth", protocol:LanProtocol.protocol, token:settings.token}));
      timer = setInterval(() => {
        if (!current()) return;
        if (Date.now() - lastSeen > 45000) return ws.close();
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:"ping"}));
      }, 20000);
    };
    ws.onmessage = async event => {
      if (!current() || typeof event.data !== "string" || event.data.length > LanProtocol.requestLimit) return ws.close();
      let message;
      try { message = JSON.parse(event.data); } catch { return ws.close(); }
      if (!message || typeof message !== "object" || Array.isArray(message)) return ws.close();
      lastSeen = Date.now();
      if (message.type === "ready" && message.protocol === LanProtocol.protocol) {
        phase = "connected"; detail = "LAN helper connected. Authenticated dashboard controls are enabled."; return;
      }
      if (message.type === "pong") return;
      if (phase !== "connected" || message.type !== "request" || typeof message.id !== "string" || message.id.length > 80
        || !LanProtocol.allowed(message.request) || inFlight >= 32) return ws.close();
      inFlight++;
      try {
        // Initialization can yield; disabling/replacing the pairing must revoke
        // requests that have not entered the command router yet.
        await initializationPromise;
        if (!current()) return;
        let response;
        try { response = await DashboardWorker.remote(message.request); }
        catch (error) { response = {ok:false, error:error.message}; }
        if (!current() || ws.readyState !== WebSocket.OPEN) return;
        let encoded = JSON.stringify({type:"response", id:message.id, response});
        if (new TextEncoder().encode(encoded).length > LanProtocol.responseLimit) encoded = JSON.stringify({type:"response", id:message.id,
          response:{ok:false,error:"Dashboard response is too large for the LAN bridge."}});
        ws.send(encoded);
      } catch { if (current()) ws.close(); } finally { inFlight--; }
    };
    ws.onerror = () => { if (current()) { phase = "error"; detail = "Cannot connect to the helper. Check its pairing and whether it is running."; } };
    ws.onclose = () => {
      if (!current()) return;
      socket = null; clearInterval(timer); timer = null;
      phase = "disconnected"; detail = "Helper disconnected. Pending commands will not be retried automatically.";
      retry = setTimeout(() => void connect().catch(() => {}), 5000);
    };
  }
  async function configure(request) {
    const enabled = request.enabled === true;
    const port = Number(request.port ?? settings.port);
    const token = typeof request.token === "string" && request.token.trim() ? request.token.trim() : settings.token;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Use a helper port from 1024 to 65535.");
    if (enabled && !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Paste the helper's pairing token.");
    if (enabled && !await chrome.permissions.contains({origins:["http://127.0.0.1/*"]})) throw new Error("Loopback permission is required.");
    await chrome.storage.local.set({[KEY]:{enabled,port,token}});
    disconnect(); settings = {enabled,port,token};
    phase = enabled ? "connecting" : "disabled"; detail = enabled ? "Connecting…" : "LAN access is disabled.";
    if (enabled) { await chrome.alarms.create(ALARM, {periodInMinutes:1}); await connect(); }
    else await chrome.alarms.clear(ALARM);
    return status();
  }
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (!["LAN_GET", "LAN_SAVE"].includes(request?.type)) return false;
    if (!isTrustedExtensionPage(sender)) { respond({ok:false,error:"Only extension settings can configure LAN access."}); return false; }
    const result = configQueue.then(() => request.type === "LAN_GET" ? status() : configure(request));
    configQueue = result.catch(() => {});
    result.then(respond, error => respond({ok:false,error:error.message})); return true;
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void configQueue.then(connect).catch(() => {}); });
  configQueue = (async () => {
    await initializationPromise;
    const saved = (await chrome.storage.local.get(KEY))[KEY];
    if (saved) await configure(saved);
  })().catch(() => { phase = "error"; detail = "Review the saved LAN settings before reconnecting."; });
})();
