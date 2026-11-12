/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
/* Durable project bindings and inboxes. No server event contains a chat prompt. */
(() => {
  "use strict";
  const KEY = "logicServerLinks";
  const ALARM = "logic-server-links";
  const SETUP_LEASE_MS = 15 * 60000;
  const sockets = new Map();
  let queue = Promise.resolve();
  const serial = work => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const read = async () => {
    await initializationPromise;
    return (await chrome.storage.local.get(KEY))[KEY] || {};
  };
  const save = records => chrome.storage.local.set({ [KEY]: records });
  const nonce = () => crypto.randomUUID();
  const sameChat = (a, b) => Boolean(ServerLink.chatKey(a) && ServerLink.chatKey(a) === ServerLink.chatKey(b));
  const summary = r => r ? {
    projectId: r.projectId, url: r.url, endpoint: r.endpoint || "", enabled: r.enabled,
    phase: r.phase,
    detail: r.pendingDestination && r.phase !== "blocked" ? "Waiting for the continuation prompt in the verified new chat." : r.detail,
    pending: r.events.length,
    uncertain: r.events.filter(e => e.phase === "uncertain").map(e => e.eventId)
  } : null;
  function close(id) {
    const s = sockets.get(id);
    if (!s) return;
    sockets.delete(id);
    clearInterval(s.timer);
    s.ws.close();
  }
  const send = (tabId, request) => {
    let timer;
    return Promise.race([
      chrome.tabs.sendMessage(tabId, request, { frameId: 0 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The assigned chat did not respond.")), 10000); })
    ]).finally(() => clearTimeout(timer));
  };
  async function alarm(records) {
    if (Object.values(records).some(r => r.enabled)) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
    else await chrome.alarms.clear(ALARM);
  }
  async function liveSetup(record) {
    try {
      const status = await send(record.tabId, { type: "SERVER_LINK_SETUP_STATUS" });
      const tab = await chrome.tabs.get(record.tabId);
      return status?.active === true && status.setupId === record.setupId
        && status.instanceId === record.instanceId
        && Heartbeat.canonicalUrl(status.url) === record.url
        && Heartbeat.canonicalUrl(tab.url) === record.url;
    } catch { return false; }
  }
  async function owner(record, sender) {
    const url = Heartbeat.canonicalUrl(sender.tab.url);
    if (!sameChat(url, record.url) || record.pendingDestination) throw new Error("This is not the project's assigned conversation.");
    if (record.tabId !== sender.tab.id) {
      try {
        const old = await chrome.tabs.get(record.tabId);
        if (sameChat(old.url, record.url)) throw new Error("OWNER_PRESENT");
      } catch (error) {
        if (error.message === "OWNER_PRESENT") throw new Error("Another open tab owns this project connection.");
      }
    }
    const identity = await send(sender.tab.id, { type: "HEARTBEAT_IDENTITY" });
    const current = await chrome.tabs.get(sender.tab.id);
    if (identity?.instanceId !== sender.instanceId || Heartbeat.canonicalUrl(identity?.url) !== url
      || Heartbeat.canonicalUrl(current.url) !== url) throw new Error("The chat page changed during verification.");
    record.tabId = sender.tab.id;
    record.instanceId = identity.instanceId;
    record.url = url;
  }
  async function wake(record) {
    if (!record.enabled || record.phase !== "connected" || record.pendingDestination || !record.events.some(e => e.phase === "queued")) return;
    let tab;
    try { tab = await chrome.tabs.get(record.tabId); } catch { /* Try exact saved identity after a restart. */ }
    if (!sameChat(tab?.url, record.url)) {
      const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
      const matches = tabs.filter(t => sameChat(t.url, record.url));
      if (matches.length !== 1) return;
      tab = matches[0];
    }
    // Wake is advisory. Content claims an event durably at its safe send boundary.
    try { await send(tab.id, { type: "SERVER_LINK_WAKE", url: Heartbeat.canonicalUrl(tab.url) }); } catch { /* Inbox waits. */ }
  }
  function connect(record) {
    if (!record.enabled || !record.endpoint || sockets.has(record.projectId)
      || ["blocked", "disabled", "setup", "confirming"].includes(record.phase)) return;
    const pairing = !record.credential;
    if (pairing && Date.now() > record.expiresAt) return;
    const ws = new WebSocket(ServerLink.endpoint(record.endpoint));
    const s = { ws, stage: "opening", challenge: nonce(), lastSeen: Date.now(), deadline: Date.now() + 20000 };
    sockets.set(record.projectId, s);
    const transmit = data => ws.send(JSON.stringify(data));
    ws.onopen = async () => {
      if (sockets.get(record.projectId) !== s) return;
      try {
        const proof = await ServerLink.proof(pairing ? record.pairingToken : record.credential,
          pairing ? "pair-client" : "auth-client", record.projectId, pairing ? record.setupId : "", s.challenge);
        if (sockets.get(record.projectId) !== s || ws.readyState !== WebSocket.OPEN) return;
        s.stage = "handshake";
        transmit({ type: pairing ? "pair" : "auth", protocol: 1, projectId: record.projectId,
          ...(pairing ? { setupId: record.setupId } : {}), proof, challenge: s.challenge });
      } catch { ws.close(); }
    };
    ws.onmessage = event => {
      void serial(async () => {
        if (sockets.get(record.projectId) !== s) return;
        const records = await read(), r = records[record.projectId];
        if (!r?.enabled || r.endpoint !== record.endpoint) return;
        if (typeof event.data !== "string" || event.data.length > 16384) throw new Error("Server frame exceeds the protocol limit.");
        const data = JSON.parse(event.data);
        if (s.stage === "handshake") {
          if (data.type !== (pairing ? "paired" : "authenticated") || data.protocol !== 1
            || data.projectId !== r.projectId || data.challenge !== s.challenge
            || (pairing && (data.setupId !== r.setupId || !/^[a-f0-9]{64,128}$/i.test(data.credential || "")))) {
            throw new Error("The server failed identity verification.");
          }
          const expectedProof = await ServerLink.proof(pairing ? record.pairingToken : record.credential,
            pairing ? "pair-server" : "auth-server", r.projectId, pairing ? r.setupId : "",
            s.challenge, pairing ? data.credential : "");
          if (typeof data.proof !== "string" || data.proof !== expectedProof) throw new Error("The server failed secret verification.");
          if (pairing) {
            r.credential = data.credential;
            delete r.pairingToken;
            await save(records);
          }
          s.stage = "testing"; s.challenge = nonce();
          transmit({ type: "test", challenge: s.challenge });
        } else if (s.stage === "testing") {
          if (data.type !== "test_ok" || data.projectId !== r.projectId || data.challenge !== s.challenge) throw new Error("The server failed its connection test.");
          s.stage = "ready"; s.lastSeen = Date.now();
          r.phase = r.setupComplete ? "connected" : "confirming";
          r.detail = r.setupComplete ? "Connected to the local server." : "Server verified. Waiting for chat setup confirmation.";
          await save(records);
          void wake(r);
        } else if (s.stage === "ready") {
          if (data.type === "pong") {
            if (data.challenge !== s.ping) throw new Error("Invalid server keepalive.");
            s.lastSeen = Date.now();
            s.ping = null;
            return;
          }
          const incoming = ServerLink.event(data, r.projectId);
          const existing = r.events.find(e => e.eventId === incoming.eventId);
          if (existing && existing.submissionId !== incoming.submissionId) throw new Error("The server reused an event ID for a different submission.");
          if (!r.events.some(e => e.eventId === incoming.eventId) && !r.seen.includes(incoming.eventId)) {
            if (r.events.length >= 100) { transmit({ type: "busy", eventId: incoming.eventId }); return; }
            r.events.push({ ...incoming, phase: "queued" });
            await save(records); // An acknowledgement must never precede durable storage.
          }
          transmit({ type: "ack", eventId: incoming.eventId });
          void wake(r);
        } else throw new Error("Unexpected server message.");
      }).catch(() => {
        void serial(async () => {
          if (sockets.get(record.projectId) !== s) return;
          close(record.projectId);
          const records = await read(), r = records[record.projectId];
          if (r) { r.phase = "blocked"; r.detail = "Server protocol verification failed. Inspect the server and retry setup."; await save(records); }
        }).catch(console.warn);
      });
    };
    ws.onerror = () => { /* onclose handles reconnect status. */ };
    ws.onclose = () => {
      if (sockets.get(record.projectId) !== s) return;
      clearInterval(s.timer); sockets.delete(record.projectId);
      void serial(async () => {
        const records = await read(), r = records[record.projectId];
        if (r?.enabled && !["blocked", "setup"].includes(r.phase)) {
          r.phase = "disconnected"; r.detail = "Local server disconnected. Pending events are retained; reconnecting.";
          await save(records);
        }
      }).catch(console.warn);
    };
    s.timer = setInterval(() => {
      if (s.stage !== "ready") {
        if (Date.now() > s.deadline) ws.close();
        return;
      }
      if (Date.now() - s.lastSeen > 45000) { ws.close(); return; }
      if (ws.readyState === WebSocket.OPEN && !s.ping) {
        s.ping = nonce(); transmit({ type: "ping", challenge: s.ping });
      }
    }, 20000);
  }
  async function handle(request, sender) {
    const popup = isTrustedExtensionPage(sender);
    const chat = (await isTrustedChatSender(sender)) && (sender.frameId === undefined || sender.frameId === 0);
    if (!popup && !chat) throw new Error("Untrusted server connection request.");
    const tab = popup ? await chrome.tabs.get(request.tabId) : sender.tab;
    const project = ServerLink.projectId(tab.url);
    if (!project || !Heartbeat.canonicalUrl(tab.url)) {
      if (chat && request.type === "SL_TAKE") return { ok: true, event: null };
      throw new Error("Open a saved conversation in a project first.");
    }
    const records = await read();
    let r = records[project];
    if (request.target) {
      await DashboardWorker.verifyTarget(request.target);
      if (Heartbeat.canonicalUrl(tab.url) !== request.target.url) throw new Error("The dashboard target conversation changed.");
    }
    if (request.type === "SL_GET" && popup) return { ok: true, connection: summary(r) };
    if (["SL_SETUP", "SL_RECOVER"].includes(request.type) && popup) {
      // Even an old popup sending SL_SETUP must recover an existing attempt.
      const previous = r;
      const recovering = request.type === "SL_RECOVER" || Boolean(previous);
      if (r?.enabled && !r.setupComplete && !["blocked", "disabled"].includes(r.phase)
        && await liveSetup(r)) throw new Error("Setup is already in progress. Stop or disable it before retrying.");
      if (r && !sameChat(r.url, tab.url)) throw new Error("This project is assigned to another conversation. Use Assign this chat first.");
      if (r?.tabId !== undefined && r.tabId !== tab.id) {
        let old;
        try { old = await chrome.tabs.get(r.tabId); } catch { /* Closed owner may be replaced. */ }
        if (sameChat(old?.url, r.url)) throw new Error("Another open tab owns this project connection.");
      }
      if (r?.events.some(e => e.phase !== "queued")) throw new Error("Resolve uncertain event delivery before retrying setup.");
      if (r?.pendingDestination) throw new Error("Finish or resolve the conversation handoff before recovering setup.");
      const identity = await send(tab.id, { type: "HEARTBEAT_IDENTITY" });
      if (Heartbeat.canonicalUrl(identity?.url) !== Heartbeat.canonicalUrl(tab.url)) throw new Error("The chat changed.");
      const current = await chrome.tabs.get(tab.id);
      if (Heartbeat.canonicalUrl(current.url) !== Heartbeat.canonicalUrl(tab.url)) throw new Error("The chat changed.");
      close(project);
      r = records[project] = { projectId: project, url: Heartbeat.canonicalUrl(tab.url), tabId: tab.id,
        instanceId: identity.instanceId, setupId: nonce(), pairingToken: nonce() + nonce(),
        ...(previous?.endpoint ? { endpoint: previous.endpoint } : {}),
        ...(previous?.credential ? { credential: previous.credential } : {}),
        expiresAt: Date.now() + SETUP_LEASE_MS, enabled: true, setupComplete: false, phase: "setup",
        events: previous?.events || [], seen: previous?.seen || [],
        detail: recovering ? "Recovering the existing server connection…" : "Sending server setup instructions…" };
      if (r.credential) delete r.pairingToken;
      await save(records); await alarm(records);
      let result;
      try {
        result = await send(tab.id, { type: "SERVER_LINK_SETUP", url: r.url, setupId: r.setupId,
          projectId: project, expiresAt: r.expiresAt, recovering,
          prompt: recovering ? ServerLink.recoveryPrompt(r, chrome.runtime.id, previous?.setupId)
            : ServerLink.setupPrompt(r, chrome.runtime.id) });
      } catch {
        r.phase = "blocked"; r.detail = "Setup delivery is uncertain. Inspect the chat before retrying."; await save(records);
        throw new Error(r.detail);
      }
      if (!result?.accepted) {
        // An explicit refusal proves no setup send was attempted. Keep the old
        // credentials, state and inbox so a busy chat cannot destroy recovery.
        if (previous) records[project] = previous;
        else delete records[project];
        await save(records); await alarm(records);
        if (previous) connect(previous);
        throw new Error(result?.detail || "The chat refused setup.");
      }
      return { ok: true, connection: summary(r) };
    }
    if (!r) return { ok: true, connection: null, event: null };
    if (popup) {
      if (request.type !== "SL_CONTROL") throw new Error("Unsupported connection control.");
      if (request.action === "assign") {
        if (r.events.some(e => e.phase !== "queued") || ["setup", "pairing", "confirming"].includes(r.phase)) throw new Error("Finish setup or resolve uncertain delivery before moving the connection.");
        r.url = Heartbeat.canonicalUrl(tab.url); r.tabId = tab.id; r.instanceId = null; r.pendingDestination = null;
        r.detail = "Assigned to this chat. Events wait until Logic Mode is running.";
      } else if (request.action === "disable") {
        close(project); r.enabled = false; r.phase = "disabled"; r.detail = "Server connection disabled. Pending events retained.";
        if (!r.setupComplete) {
          try { await send(r.tabId, { type: "SERVER_LINK_CANCEL", setupId: r.setupId }); } catch { /* The cancelled setup cannot pair. */ }
        }
      } else if (request.action === "enable") {
        if (!r.setupComplete || !r.credential) throw new Error("Complete setup first.");
        if (r.events.some(e => e.phase !== "queued")) throw new Error("Resolve uncertain delivery first.");
        r.enabled = true; r.phase = "disconnected"; r.detail = "Reconnecting…";
      } else if (request.action === "resolve") {
        const e = r.events.find(e => e.eventId === request.eventId && e.phase === "uncertain");
        if (!e || !["delivered", "retry"].includes(request.resolution)) throw new Error("Select an uncertain event and inspect the chat first.");
        if (request.resolution === "retry") { e.phase = "queued"; delete e.attemptId; }
        else { r.events = r.events.filter(item => item !== e); r.seen = [...r.seen, e.eventId].slice(-2000); }
        r.detail = "Delivery decision saved.";
        if (!r.events.some(e => e.phase === "uncertain")) r.phase = sockets.get(project)?.stage === "ready" ? "connected" : "disconnected";
      } else throw new Error("Unknown connection control.");
      await save(records); await alarm(records); connect(r); void wake(r);
      return { ok: true, connection: summary(r) };
    }
    if (request.type === "SL_BIND") {
      const pending = r.pendingDestination;
      const url = Heartbeat.canonicalUrl(tab.url);
      if (!pending || pending.token !== request.token || pending.tabId !== tab.id
        || Date.now() > pending.expiresAt || !url || sameChat(url, pending.sourceUrl)) {
        throw new Error("The server connection handoff could not be verified.");
      }
      const identity = await send(tab.id, { type: "HEARTBEAT_IDENTITY" });
      const current = await chrome.tabs.get(tab.id);
      if (identity?.instanceId !== request.instanceId || Heartbeat.canonicalUrl(identity.url) !== url
        || Heartbeat.canonicalUrl(current.url) !== url) throw new Error("The continuation page changed.");
      r.url = url; r.instanceId = request.instanceId; r.pendingDestination = null;
      await save(records);
      return { ok: true, connection: summary(r) };
    }
    if (request.type === "SL_TAKE" && (!sameChat(r.url, tab.url) || r.pendingDestination)) return { ok: true, event: null };
    if (["SL_SETUP_KEEPALIVE", "SL_READY", "SL_COMPLETE", "SL_FAIL"].includes(request.type)
      && (r.tabId !== tab.id || r.instanceId !== request.instanceId)) throw new Error("The server setup page instance changed.");
    // A fresh content-script instance must prove it owns the exact assigned URL.
    await owner(r, { ...sender, instanceId: request.instanceId });
    if (r.events.some(e => e.phase === "dispatching" && e.instanceId !== request.instanceId)) {
      for (const e of r.events) if (e.phase === "dispatching") e.phase = "uncertain";
      r.phase = "blocked"; r.detail = "The chat reloaded during event delivery. Inspect the chat before resolving it.";
      await save(records);
    }
    if (request.type === "SL_STATUS") {
      if (r.enabled && !r.setupComplete && r.phase === "disconnected") connect(r);
      return { ok: true, connection: summary(r) };
    }
    if (["SL_SETUP_KEEPALIVE", "SL_READY", "SL_COMPLETE"].includes(request.type)) {
      if (!r.enabled || r.setupComplete || ["blocked", "disabled"].includes(r.phase)
        || request.setupId !== r.setupId || !await liveSetup(r)) throw new Error("Server setup stopped or its chat page changed.");
      r.expiresAt = Date.now() + SETUP_LEASE_MS;
      await save(records);
    }
    if (request.type === "SL_SETUP_KEEPALIVE") {
      return { ok: true };
    } else if (request.type === "SL_READY") {
      if (!r.enabled || r.phase !== "setup" || request.setupId !== r.setupId || Date.now() > r.expiresAt) throw new Error("Setup expired or was cancelled.");
      const endpoint = ServerLink.endpoint(request.endpoint);
      if (r.endpoint && r.endpoint !== endpoint) throw new Error("Recovery returned a different server address. Keep the existing server and fixed port; inspect the chat before retrying.");
      r.endpoint = endpoint; r.phase = "pairing"; r.detail = "Verifying the local server…";
      await save(records); connect(r);
    } else if (request.type === "SL_COMPLETE") {
      if (!r.enabled || r.phase !== "confirming" || request.setupId !== r.setupId || Date.now() > r.expiresAt) throw new Error("Setup has not been verified or has expired.");
      r.setupComplete = true; r.phase = "connected"; r.detail = "Connected. Setup confirmed in chat.";
      delete r.pairingToken;
      await save(records);
    } else if (request.type === "SL_FAIL") {
      if (!r.enabled || request.setupId !== r.setupId || r.setupComplete) return { ok: true };
      close(project); r.phase = "blocked";
      r.detail = typeof request.detail === "string" && request.detail.trim()
        ? request.detail.trim().slice(0, 500) : "Chat setup stopped or needs attention. Inspect the chat, then retry setup.";
      delete r.pairingToken; await save(records);
    } else if (request.type === "SL_POKE") {
      await save(records);
      void wake(r);
    } else if (request.type === "SL_TAKE") {
      if (!r.enabled || r.phase !== "connected" || !r.setupComplete || r.events.some(e => e.phase !== "queued")) return { ok: true, event: null };
      const e = r.events.find(e => e.phase === "queued");
      if (!e) return { ok: true, event: null };
      e.phase = "dispatching"; e.attemptId = nonce(); e.instanceId = request.instanceId;
      await save(records);
      return { ok: true, event: { eventId: e.eventId, submissionId: e.submissionId, eventType: e.eventType },
        attemptId: e.attemptId };
    } else if (request.type === "SL_RESULT") {
      const e = r.events.find(e => e.attemptId === request.attemptId && e.instanceId === request.instanceId);
      if (!e) throw new Error("Unknown event delivery attempt.");
      if (request.outcome === "delivered") {
        r.events = r.events.filter(item => item !== e); r.seen = [...r.seen, e.eventId].slice(-2000);
      } else if (request.outcome === "unsent") {
        e.phase = "queued"; delete e.attemptId; delete e.instanceId;
      } else {
        e.phase = "uncertain"; r.phase = "blocked"; r.detail = "Event delivery is uncertain. Inspect the chat and resolve it in Server connection.";
      }
      await save(records);
    } else throw new Error("Unsupported server connection event.");
    return { ok: true, connection: summary(r) };
  }
  async function transfer(rollover, tab) {
    return serial(async () => {
      const records = await read(), r = records[ServerLink.projectId(rollover.sourceUrl)];
      if (!r || !sameChat(r.url, rollover.sourceUrl) || r.tabId !== rollover.sourceTabId) return;
      const url = Heartbeat.canonicalUrl(tab.url);
      if (url && ServerLink.projectId(url) !== r.projectId) throw new Error("Server connection rollover project mismatch.");
      r.tabId = tab.id; r.instanceId = null;
      r.pendingDestination = { tabId: tab.id, sourceUrl: r.url, token: nonce(), expiresAt: Date.now() + 120000 };
      rollover.serverLinkTransfer = { projectId: r.projectId, token: r.pendingDestination.token, expiresAt: r.pendingDestination.expiresAt };
      await save(records);
    });
  }
  async function maintain(restoring = false) {
    const records = await read();
    for (const r of Object.values(records)) {
      if (restoring && ["connected", "confirming"].includes(r.phase)) r.phase = "disconnected";
      if (restoring && r.events.some(e => e.phase === "dispatching")) {
        for (const e of r.events) if (e.phase === "dispatching") e.phase = "uncertain";
        r.phase = "blocked"; r.detail = "Extension restarted during event delivery. Inspect the chat before resolving the event.";
      }
      if (!r.enabled) continue;
      if (!r.setupComplete && !["blocked", "disabled"].includes(r.phase)) {
        if (await liveSetup(r)) {
          r.expiresAt = Date.now() + SETUP_LEASE_MS;
          if (r.phase === "setup") r.detail = "Waiting for the agent to finish server setup…";
        } else if (restoring || Date.now() > r.expiresAt) {
          close(r.projectId); r.phase = "blocked";
          r.detail = "Server setup no longer has its active chat page. Inspect the chat and retry setup.";
          delete r.pairingToken;
        }
      }
      if (r.pendingDestination) {
        if (Date.now() > r.pendingDestination.expiresAt) {
          r.phase = "blocked"; r.detail = "The continuation chat could not be verified. Assign the correct saved chat manually.";
        }
      }
    }
    await save(records); await alarm(records);
    for (const r of Object.values(records)) {
      try { connect(r); void wake(r); } catch { /* Next alarm retries unavailable local servers. */ }
    }
  }
  globalThis.ServerLinkWorker = { transfer, dashboard: (request, sender) => serial(async () => {
    await DashboardWorker.verifyTarget(request.target);
    return handle(request, sender);
  }) };
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (!String(request?.type || "").startsWith("SL_")) return false;
    serial(() => handle(request, sender)).then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  });
  chrome.alarms.onAlarm.addListener(event => {
    if (event.name === ALARM) void serial(() => maintain()).catch(console.warn);
  });
  chrome.runtime.onStartup.addListener(() => { void serial(() => maintain(true)).catch(console.warn); });
  void serial(() => maintain(true)).catch(console.warn);
})();
