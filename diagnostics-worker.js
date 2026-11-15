/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
(() => {
  "use strict";
  const KEY = "threadlampDiagnostics", AGE = 7 * 86400000, schema = ThreadlampDiagnosticSchema;
  let queue = Promise.resolve(), pending = 0, dropped = 0, cached = null;
  const rates = new Map();
  const version = () => schema.version(chrome.runtime.getManifest().version);
  function serialized(work) {
    if (pending >= 128) { dropped++; return Promise.resolve({ok:false, error:"Diagnostics busy."}); }
    pending++;
    const job = queue.then(async () => {
      await initializationPromise;
      if (!cached) {
        const saved = (await chrome.storage.local.get(KEY))[KEY];
        const clean = schema.report({schema:1, events:Array.isArray(saved?.events) ? saved.events : [], incidents:Array.isArray(saved?.incidents) ? saved.incidents : []});
        cached = {enabled:saved?.enabled !== false,
          salt:typeof saved?.salt === "string" && /^[a-f0-9-]{36}$/.test(saved.salt) ? saved.salt : crypto.randomUUID(),
          events:clean.events, incidents:clean.incidents};
      }
      const data = cached;
      data.events = data.events.filter(e => e.at >= Date.now() - AGE).slice(-400);
      data.incidents = data.incidents.filter(e => e.at >= Date.now() - AGE).slice(-20);
      const result = await work(data);
      await chrome.storage.local.set({[KEY]:data});
      return result;
    }).finally(() => pending--);
    queue = job.catch(() => { cached = null; });
    return job;
  }
  async function reference(salt, value) {
    if (!value) return "";
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ":" + value));
    return Array.from(new Uint8Array(bytes).slice(0,8), n => n.toString(16).padStart(2,"0")).join("");
  }
  async function record(request, sender) {
    if (!schema.events.has(request.event?.event) || sender.frameId !== 0 || !await isTrustedChatSender(sender)) {
      throw new Error("Untrusted diagnostic event.");
    }
    const now = Date.now(), rate = rates.get(sender.tab.id);
    if (rate && now - rate.at < 60000 && ++rate.count > 120) { dropped++; return {ok:true, dropped:true}; }
    if (!rate || now - rate.at >= 60000) rates.set(sender.tab.id, {at:now, count:1});
    if (rates.size > 256) rates.delete(rates.keys().next().value);
    const event = schema.snapshot(request.event);
    return serialized(async data => {
      if (!data.enabled) return {ok:true, enabled:false};
      const url = new URL(sender.tab.url), project = url.pathname.match(/g-p-[a-f0-9]{32}/i)?.[0]?.toLowerCase() || "";
      const chat = url.pathname.match(/\/c\/([^/]+)/)?.[1] || "";
      const instance = typeof request.instance === "string" && /^[a-zA-Z0-9.-]{1,80}$/.test(request.instance) ? request.instance : "";
      const item = {...event, at:now, tabId:sender.tab.id, workerVersion:version(),
        projectRef:await reference(data.salt, project), chatRef:await reference(data.salt, chat),
        instanceRef:await reference(data.salt, instance), route:chat ? "saved" : project ? "project" : "other"};
      const last = data.events.at(-1);
      if (last && now-last.at < 2000 && JSON.stringify({...last,at:0}) === JSON.stringify({...item,at:0})) return {ok:true};
      data.events.push(item); data.events = data.events.slice(-400);
      if (item.event === "error" || item.event === "identity_rejected") {
        data.incidents.push({at:now, tabId:item.tabId, reason:item.reason,
          events:data.events.filter(e => e.tabId === item.tabId).slice(-40)});
        data.incidents = data.incidents.slice(-20);
      }
      return {ok:true};
    });
  }
  function request(input) {
    return serialized(data => {
      if (input.type === "DG_SET") data.enabled = input.enabled === true;
      else if (input.type === "DG_CLEAR") { data.events = []; data.incidents = []; data.salt = crypto.randomUUID(); dropped = 0; }
      else if (!["DG_GET", "DG_EXPORT"].includes(input.type)) throw new Error("Unknown diagnostic request.");
      if (input.type === "DG_EXPORT") return {ok:true, report:schema.report({...data, schema:1, generatedAt:Date.now(), workerVersion:version(), dropped})};
      return {ok:true, enabled:data.enabled, eventCount:data.events.length, incidentCount:data.incidents.length, dropped};
    });
  }
  globalThis.DiagnosticWorker = {request};
  chrome.runtime.onMessage.addListener((input, sender, respond) => {
    if (!String(input?.type || "").startsWith("DG_")) return false;
    const work = input.type === "DG_RECORD" ? record(input, sender)
      : isTrustedExtensionPage(sender) ? request(input) : Promise.reject(new Error("Untrusted diagnostic request."));
    work.then(respond, () => respond({ok:false, error:"Diagnostic request failed."}));
    return true;
  });
})();
