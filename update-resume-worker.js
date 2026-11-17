/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
/* Extension-update recovery is bound to the same browser document, not a title. */
(() => {
  "use strict";
  const KEY = "logicUpdateCheckpoints", TTL = 24 * 60 * 60 * 1000;
  let chain = Promise.resolve();
  const phases = ["monitoring", "resuming", "waiting_external", "waiting_user", "sleeping"];
  const hash = value => /^[a-f0-9]{64}$/.test(value || "");
  function clean(value) {
    if (!value || !["logic", "idle", "loop", "setup"].includes(value.mode)) throw new Error("Invalid update checkpoint.");
    const result = {active:value.active === true, paused:value.paused === true, error:value.error === true, mode:value.mode};
    if (!result.active) return result;
    if (result.mode !== "logic" || result.paused || result.error || !phases.includes(value.phase)
      || typeof value.message !== "string" || !value.message.trim() || value.message.length > 4000
      || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 1000
      || !Number.isInteger(value.count) || value.count < 0 || value.count > value.limit
      || !hash(value.userHash) || !hash(value.assistantHash)
      || value.phase === "waiting_external" && (!Number.isSafeInteger(value.waitUntil) || value.waitUntil < 0 || value.waitUntil > Date.now()+120*60000)) {
      throw new Error("The active update checkpoint could not be verified.");
    }
    return {...result, phase:value.phase, message:value.message, limit:value.limit, count:value.count,
      rolloverEnabled:value.rolloverEnabled === true, userHash:value.userHash, assistantHash:value.assistantHash,
      waitUntil:value.phase === "waiting_external" ? value.waitUntil : null,
      heartbeatActive:value.heartbeatActive === true};
  }
  async function handle(request, sender) {
    await initializationPromise;
    if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !sender.documentId
      || !isChatGptUrl(sender.url) || !isChatGptUrl(sender.tab.url)
      || sender.documentLifecycle && sender.documentLifecycle !== "active"
      || typeof request.instanceId !== "string" || !/^[\w.-]{1,150}$/.test(request.instanceId)) throw new Error("Untrusted update recovery request.");
    const tab = await chrome.tabs.get(sender.tab.id), url = Heartbeat.canonicalUrl(tab.url);
    if (!url || url !== Heartbeat.canonicalUrl(request.url)) throw new Error("The update recovery chat changed.");
    if (new URL(sender.url).origin !== new URL(url).origin || new URL(sender.tab.url).origin !== new URL(url).origin) throw new Error("The update recovery origin changed.");
    // Same-document navigation may leave Chrome's sender URLs behind the live
    // route. Require exact browser-document proof instead of rejecting its send.
    if (Heartbeat.canonicalUrl(sender.tab.url) !== url || !await isTrustedChatSender(sender)) {
      const [proof] = await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[sender.documentId]},func:()=>({url:location.href,top:window === window.top})});
      if (proof?.documentId !== sender.documentId || proof.frameId !== 0 || proof.result?.top !== true
        || Heartbeat.canonicalUrl(proof.result.url) !== url) throw new Error("The update recovery document could not be verified.");
    }
    const identity = await chrome.tabs.sendMessage(tab.id, {type:"HEARTBEAT_IDENTITY"}, {documentId:sender.documentId});
    if (identity?.instanceId !== request.instanceId || Heartbeat.canonicalUrl(identity?.url) !== url
      || Heartbeat.canonicalUrl((await chrome.tabs.get(tab.id)).url) !== url) throw new Error("The update recovery controller changed.");
    const all = (await chrome.storage.local.get(KEY))[KEY] || {};
    for (const [key, value] of Object.entries(all)) if (Date.now() - value.at > TTL) delete all[key];
    const previous = all[tab.id];
    let result = {ok:true};
    if (request.type === "UR_CLAIM") {
      result.record = null;
      if (previous?.url === url && previous.documentId === sender.documentId
        && previous.instanceId !== request.instanceId && !previous.claimed) {
        const [proof] = await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[sender.documentId]},func:()=>({url:location.href,top:window === window.top})});
        const latest = await chrome.tabs.get(tab.id);
        if (proof?.documentId !== sender.documentId || proof.frameId !== 0 || proof.result?.top !== true
          || Heartbeat.canonicalUrl(proof.result.url) !== url || Heartbeat.canonicalUrl(latest.url) !== url) throw new Error("The update recovery document changed.");
        result.record = clean(previous.settings);
        all[tab.id] = {...previous, instanceId:request.instanceId, claimed:true, confirmed:false};
      }
    } else if (request.type === "UR_CONFIRM") {
      if (!previous?.claimed || previous.instanceId !== request.instanceId || previous.url !== url
        || previous.documentId !== sender.documentId || !previous.settings.active) throw new Error("The update checkpoint is no longer owned by this controller.");
      previous.confirmed = true;
    } else if (request.type === "UR_SAVE" || request.type === "UR_BLOCK") {
      all[tab.id] = {url, documentId:sender.documentId, instanceId:request.instanceId, claimed:false, at:Date.now(),
        settings:request.type === "UR_BLOCK" ? {active:false,paused:true,error:false,mode:"logic"} : clean(request.settings)};
    } else throw new Error("Unknown update recovery request.");
    await chrome.storage.local.set({[KEY]:Object.fromEntries(Object.entries(all).sort((a,b)=>b[1].at-a[1].at).slice(0,100))});
    return result;
  }
  chrome.runtime.onMessage.addListener((request, sender, reply) => {
    if (!String(request?.type || "").startsWith("UR_")) return false;
    const result = chain.then(()=>handle(request,sender)); chain = result.catch(()=>{});
    result.then(reply,error=>reply({ok:false,error:error.message})); return true;
  });
  chrome.tabs.onRemoved?.addListener(tabId => {
    chain = chain.then(async()=>{const all=(await chrome.storage.local.get(KEY))[KEY]||{};delete all[tabId];await chrome.storage.local.set({[KEY]:all});}).catch(()=>{});
  });
})();
