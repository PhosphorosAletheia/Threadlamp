/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
/* Reattach only to the exact document inspected; never refresh the chat page. */
(() => {
  "use strict";
  const pending = new Map();
  const files = ["server-link.js", "diagnostics-schema.js", "queue-client.js", "content.js"];
  const supported = value => {
    try { const url = new URL(value); return url.protocol === "https:" && ["chatgpt.com", "chat.openai.com"].includes(url.hostname); }
    catch { return false; }
  };
  function prepareDocument() {
    const marker = document.getElementById("threadlamp-controller-lifecycle");
    const oldUI = document.getElementById("chatgpt-continue-loop-status") || document.getElementById("chatgpt-continue-loop-quick-actions");
    if (!marker && (oldUI || window.__chatGptContinueLoopLoaded)) return {legacy:true};
    // Works across old/new isolated worlds after an extension reload. It only
    // cancels old work; no state or message text is accepted from the DOM.
    document.dispatchEvent(new Event("threadlamp:detach"));
    window.__threadlampController?.dispose();
    if (document.getElementById("chatgpt-continue-loop-status") || document.getElementById("chatgpt-continue-loop-quick-actions")) return {legacy:true};
    window.__threadlampReattaching = true;
    return {ready:true};
  }
  async function ping(tabId, documentId) {
    let timer;
    try {
      return await Promise.race([chrome.tabs.sendMessage(tabId, {type:"AT_PING"}, documentId ? {documentId} : {frameId:0}),
        new Promise((_, reject) => {timer = setTimeout(() => reject(new Error("Attach check timed out.")), 2000);})]);
    } finally {clearTimeout(timer);}
  }
  async function attach(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!supported(tab.url) || tab.discarded || tab.status === "loading") throw new Error("This chat is loading or unavailable. Wait for it to finish loading.");
    try {
      const result = await ping(tabId);
      if (result?.ok && result.lifecycle === 1 && result.version === chrome.runtime.getManifest().version) return {ok:true, attached:false};
    } catch { /* The old extension context may no longer have a receiver. */ }
    const [inspection] = await chrome.scripting.executeScript({target:{tabId, frameIds:[0]}, func:prepareDocument});
    if (inspection?.result?.legacy) throw new Error("This tab uses an older Threadlamp controller. Refresh this chat once when safe; future extension reloads can reconnect without a page refresh.");
    if (!inspection?.result?.ready || !inspection.documentId) throw new Error("The chat document could not be verified. Try again when it has finished loading.");
    const current = await chrome.tabs.get(tabId);
    if (current.url !== tab.url || current.discarded) throw new Error("The chat changed while attaching. Wait for it to settle and try again.");
    await chrome.scripting.executeScript({target:{tabId, documentIds:[inspection.documentId]}, files});
    const result = await ping(tabId, inspection.documentId);
    if (!result?.ok || result.lifecycle !== 1 || result.version !== chrome.runtime.getManifest().version) throw new Error("Threadlamp could not confirm its new controller. Refresh this chat only when safe.");
    return {ok:true, attached:true};
  }
  function attachOnce(tabId) {
    if (!Number.isInteger(tabId)) return Promise.reject(new Error("Select a ChatGPT tab first."));
    if (!pending.has(tabId)) {
      const promise = attach(tabId).finally(() => pending.delete(tabId));
      pending.set(tabId, promise);
    }
    return pending.get(tabId);
  }
  async function attachOpenTabs() {
    const tabs = await chrome.tabs.query({url:["https://chatgpt.com/*", "https://chat.openai.com/*"]});
    // Sequential and bounded: never wake discarded tabs or reload documents.
    for (const tab of tabs) {
      if (tab.discarded || tab.status === "loading") continue;
      try {await attachOnce(tab.id);} catch { /* Legacy tabs remain available for a manual safe refresh. */ }
    }
  }
  chrome.runtime.onInstalled.addListener(() => {void attachOpenTabs().catch(() => {});});
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.type !== "AT_ATTACH") return false;
    if (!isTrustedExtensionPage(sender)) {sendResponse({ok:false,error:"Untrusted attach request."}); return false;}
    attachOnce(request.tabId).then(sendResponse, error => sendResponse({ok:false,error:error.message}));
    return true;
  });
})();
