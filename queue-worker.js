/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
/* Durable, revision-checked message queues. Never stores API keys or diagnostics. */
(() => {
  "use strict";
  const KEY = "logicMessageQueues";
  let chain = Promise.resolve();
  const serial = work => {const result = chain.then(work); chain = result.catch(() => {}); return result;};
  function identity(url, tabId) {
    const u = new URL(url);
    if (!["https://chatgpt.com", "https://chat.openai.com"].includes(u.origin)) throw new Error("Invalid queue origin.");
    const project = u.pathname.match(/\/g\/(g-p-[a-f0-9]{32})(?:[-/]|$)/i)?.[1]?.toLowerCase() || "";
    const segment = u.pathname.match(/\/c\/([^/]+)\/?$/)?.[1];
    let temporary = false;
    if (segment) {
      try { temporary = /^local-chatgpt:/i.test(decodeURIComponent(segment)); }
      catch { throw new Error("Invalid queue conversation ID."); }
    }
    const chat = temporary ? undefined : segment;
    if (!chat && !temporary && !project && u.pathname !== "/") throw new Error("Queues require a saved conversation or a verified project handoff.");
    return {key:JSON.stringify([u.origin, project, chat ? "chat" : "tab", chat || tabId]), project, chat, origin:u.origin,
      legacyKey:temporary ? JSON.stringify([u.origin, project, "chat", segment]) : ""};
  }
  function storedIdentity(value, all) {
    // Older builds keyed temporary routes like saved chats. Keep a nonempty
    // legacy queue reachable until the verified move to the real conversation.
    if (value.legacyKey && all[value.legacyKey]?.items?.length) {
      if (all[value.key]?.items?.length) throw new Error("Two saved queues exist for this temporary chat. Inspect them before resuming; neither was changed.");
      return {...value, key:value.legacyKey};
    }
    return value;
  }
  function items(value) {
    if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid queue size.");
    let total = 0; const ids = new Set();
    return value.map(item => {
      if (!item || typeof item.id !== "string" || !item.id || item.id.length > 128 || ids.has(item.id)
        || typeof item.text !== "string" || !item.text.trim() || item.text.length > 8000) throw new Error("Invalid queued message.");
      ids.add(item.id); total += item.text.length;
      if (total > 80000) throw new Error("Queue exceeds 80,000 characters.");
      return {id:item.id, text:item.text};
    });
  }
  async function save(all) {
    // Do not evict unsent queues to make room. Report the failure to the sender.
    if (JSON.stringify(all).length > 2000000) throw new Error("Saved queues are full. Remove unused queued messages before adding more.");
    await chrome.storage.local.set({[KEY]:all});
  }
  const entry = (all, key) => all[key] || {version:0, items:[]};
  const reply = record => ({ok:true, version:record.version, items:record.items});
  const cleanUrl = value => typeof value === "string" ? value.split(/[?#]/)[0] : "";
  const failure = (code, message) => Object.assign(new Error(message), {queueFailure:code});
  async function verifyPage(request, sender) {
    if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)
      || typeof request.url !== "string" || !isChatGptUrl(request.url)) {
      throw failure("sender", "The queue request did not come from a verified conversation page.");
    }
    const tab = await chrome.tabs.get(sender.tab.id);
    if (cleanUrl(tab.url) !== cleanUrl(request.url)) {
      throw failure("route", "The queue's chat changed. Reload the correct conversation before using it.");
    }
    if (cleanUrl(sender.tab.url) === cleanUrl(request.url) && await isTrustedChatSender(sender)) {
      const latest = await chrome.tabs.get(tab.id);
      if (cleanUrl(latest.url) === cleanUrl(request.url)) return latest;
      throw failure("route", "The queue's tab changed during verification. No queue changes were made.");
    }
    // Chrome's sender snapshot can lag behind same-document navigation. Only
    // browser-issued proof of this exact active top-frame document can replace it.
    if (typeof sender.documentId !== "string" || !sender.documentId
      || sender.documentLifecycle && sender.documentLifecycle !== "active"
      || !isChatGptUrl(sender.url) || !isChatGptUrl(sender.tab.url)
      || new URL(sender.url).origin !== new URL(request.url).origin
      || new URL(sender.tab.url).origin !== new URL(request.url).origin) {
      throw failure("sender", "The queue's current conversation could not be verified. Reload it before resuming.");
    }
    let proofFailure = "unavailable";
    try {
      const results = await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[sender.documentId]},
        func:() => ({url:location.href,top:window === window.top})});
      const proof = results?.length === 1 ? results[0] : null;
      const latest = await chrome.tabs.get(tab.id);
      if (proof?.documentId === sender.documentId && proof.frameId === 0 && proof.result?.top === true
        && cleanUrl(proof.result.url) === cleanUrl(request.url) && cleanUrl(latest.url) === cleanUrl(request.url)) return latest;
      proofFailure = !proof ? "missing" : proof.documentId !== sender.documentId ? "identity"
        : proof.frameId !== 0 ? "frame" : proof.result?.top !== true ? "top"
        : cleanUrl(proof.result.url) !== cleanUrl(request.url) ? "route" : "tab";
    } catch { /* A missing or replaced document cannot own the queue. */ }
    throw Object.assign(failure("document", "The queue's active page changed or could not be verified. Reload the correct conversation before resuming."), {queueProof:proofFailure});
  }
  async function handle(request, sender) {
    await initializationPromise;
    return serial(async () => {
      let tab;
      try {tab = await verifyPage(request, sender);}
      catch (error) {
        // Only this rejection is known to precede all queue reads and writes.
        // A fresh Q_MOVE may re-prove ownership; never replay uncertain writes.
        if (request.type === "Q_MOVE" && ["route", "document"].includes(error.queueFailure)) error.queueRetrySafe = true;
        throw error;
      }
      const all = (await chrome.storage.local.get(KEY))[KEY] || {};
      const current = storedIdentity(identity(request.url, tab.id), all);
      const existing = entry(all, current.key);
      if (request.type === "Q_LOAD") return reply(existing);
      if (request.type === "Q_SAVE") {
        if (request.version !== existing.version) throw new Error("The saved queue changed in another page. Reload this chat to review it; no message was sent.");
        const next = {version:existing.version + 1, items:items(request.items)};
        all[current.key] = next; await save(all); return reply(next);
      }
      if (request.type === "Q_MOVE") {
        const previous = storedIdentity(identity(request.from, tab.id), all), prior = entry(all, previous.key);
        if (previous.key === current.key) return reply(existing);
        if (previous.chat || !current.chat || previous.project !== current.project || previous.origin !== current.origin
          || request.version !== prior.version || existing.items.length) throw new Error("The new conversation's queue could not be verified. Inspect it before resuming.");
        all[current.key] = {version:existing.version+1, items:prior.items};
        all[previous.key] = {version:prior.version+1, items:[]};
        await save(all); return reply(all[current.key]);
      }
      if (request.type === "Q_HANDOFF") {
        const pending = (await getPendingRollovers())[String(request.requestId || "")];
        if (!pending || pending.completed || pending.expiresAt <= Date.now() || pending.claimedBy !== tab.id
          || !sameRolloverProject(current.project, pending.projectSegment) || current.origin !== new URL(pending.sourceUrl).origin) {
          throw new Error("The handoff no longer owns this queue.");
        }
        const previous = storedIdentity(identity(pending.sourceUrl, pending.sourceTabId), all), prior = entry(all, previous.key);
        if (previous.key === current.key || prior.transfer === request.requestId || existing.items.length) throw new Error("The handoff queue was already transferred or the destination has a queue. Inspect it before resuming.");
        const expected = items(pending.queuedPrompts || []);
        if (all[previous.key] && JSON.stringify(prior.items) !== JSON.stringify(expected)) throw new Error("The source queue changed during the handoff. No messages were transferred.");
        all[current.key] = {version:existing.version+1, items:expected};
        all[previous.key] = {version:prior.version+1, items:[], transfer:request.requestId};
        await save(all); return reply(all[current.key]);
      }
      throw new Error("Unknown queue request.");
    });
  }
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (!String(request?.type || "").startsWith("Q_")) return false;
    handle(request, sender).then(respond, error => respond({ok:false, error:error.message || "Could not save the queue. No message was sent.",
      queueFailure:error.queueFailure || "storage", queueProof:error.queueProof, queueRetrySafe:error.queueRetrySafe === true}));
    return true;
  });
})();
