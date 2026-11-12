/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
(() => {
  "use strict";
  const KEY = "logicReconnectCheckpoints", TTL = 10 * 60 * 1000;
  let queue = Promise.resolve();
  const id = value => typeof value === "string" && /^[\w:-]{1,150}$/.test(value);
  function settings(value) {
    if (!value || typeof value.message !== "string" || !value.message.trim() || value.message.length > 4000
      || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 1000
      || !Number.isInteger(value.count) || value.count < 0 || value.count > value.limit
      || !/^[a-f0-9]{64}$/.test(value.userHash || "")) throw new Error("No verified run checkpoint is available. Resume manually after inspecting the chat.");
    return { message: value.message, limit: value.limit, count: value.count,
      rolloverEnabled: value.rolloverEnabled === true, userHash: value.userHash, verifiedUser: value.verifiedUser === true };
  }
  async function handle(request, sender) {
    await initializationPromise;
    if (!(await isTrustedChatSender(sender)) || sender.frameId !== 0 || !id(request.instanceId)) throw new Error("Untrusted reconnection request.");
    const tab = await chrome.tabs.get(sender.tab.id);
    const url = Heartbeat.canonicalUrl(tab.url);
    if (!url || url !== Heartbeat.canonicalUrl(sender.tab.url)
      || url !== Heartbeat.canonicalUrl(request.url)) throw new Error("The reconnection target changed.");
    const records = (await chrome.storage.session.get(KEY))[KEY] || {};
    for (const [key, record] of Object.entries(records)) if (Date.now() - record.at > TTL) delete records[key];
    let record = records[tab.id];
    const matches = record && record.url === url;
    let result = { ok: true };
    if (request.type === "LR_CLAIM") {
      if (!matches || record.instanceId === request.instanceId || record.claimed) result.record = null;
      else {
        result.record = { ...record };
        record.instanceId = request.instanceId; record.claimed = true; record.requested = false; record.at = Date.now();
      }
    } else if (request.type === "LR_CLEAR") {
      if (matches && record.instanceId === request.instanceId) delete records[tab.id];
    } else if (request.type === "LR_SAVE") {
      if (!id(request.token) || (matches && record.instanceId !== request.instanceId)) throw new Error("The run checkpoint belongs to another page.");
      const sameRun = matches && record.token === request.token;
      if (sameRun && record.requested) return { ok: true };
      records[tab.id] = { url, instanceId: request.instanceId, token: request.token, at: Date.now(),
        attempted: Boolean(sameRun && record.attempted), requested: false, claimed: false, settings: settings(request.settings) };
    } else if (request.type === "LR_PREPARE") {
      if (!matches || record.instanceId !== request.instanceId || record.token !== request.token || record.attempted) throw new Error("Automatic reconnection is unavailable or was already attempted. Inspect the chat before resuming.");
      record.settings = settings(request.settings);
      record.attempted = true; record.requested = true; record.claimed = false; record.at = Date.now();
    } else throw new Error("Unknown reconnection request.");
    await chrome.storage.session.set({ [KEY]: Object.fromEntries(Object.entries(records).sort((a, b) => b[1].at - a[1].at).slice(0, 100)) });
    return result;
  }
  chrome.runtime.onMessage.addListener((request, sender, reply) => {
    if (!String(request?.type || "").startsWith("LR_")) return false;
    const result = queue.then(() => handle(request, sender));
    queue = result.catch(() => {});
    result.then(reply, error => reply({ ok: false, error: error.message }));
    return true;
  });
  chrome.tabs.onRemoved?.addListener(tabId => {
    queue = queue.then(async () => {
      const records = (await chrome.storage.session.get(KEY))[KEY] || {};
      delete records[tabId]; await chrome.storage.session.set({ [KEY]: records });
    }).catch(() => {});
  });
})();
