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
    const chat = u.pathname.match(/\/c\/([^/]+)\/?$/)?.[1];
    if (!chat && !project && u.pathname !== "/") throw new Error("Queues require a saved conversation or a verified project handoff.");
    return {key:JSON.stringify([u.origin, project, chat ? "chat" : "tab", chat || tabId]), project, chat, origin:u.origin};
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
  async function handle(request, sender) {
    await initializationPromise;
    if (!await isTrustedChatSender(sender) || sender.frameId !== 0 || typeof request.url !== "string"
      || request.url.split(/[?#]/)[0] !== sender.tab.url?.split(/[?#]/)[0]) throw new Error("The queue's chat changed. Reload the correct conversation before using it.");
    return serial(async () => {
      const tab = await chrome.tabs.get(sender.tab.id);
      if (tab.url?.split(/[?#]/)[0] !== request.url.split(/[?#]/)[0]) throw new Error("The queue's tab changed.");
      const current = identity(request.url, tab.id), all = (await chrome.storage.local.get(KEY))[KEY] || {};
      const existing = entry(all, current.key);
      if (request.type === "Q_LOAD") return reply(existing);
      if (request.type === "Q_SAVE") {
        if (request.version !== existing.version) throw new Error("The saved queue changed in another page. Reload this chat to review it; no message was sent.");
        const next = {version:existing.version + 1, items:items(request.items)};
        all[current.key] = next; await save(all); return reply(next);
      }
      if (request.type === "Q_MOVE") {
        const previous = identity(request.from, tab.id), prior = entry(all, previous.key);
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
        const previous = identity(pending.sourceUrl, pending.sourceTabId), prior = entry(all, previous.key);
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
    handle(request, sender).then(respond, error => respond({ok:false, error:error.message || "Could not save the queue. No message was sent."}));
    return true;
  });
})();
