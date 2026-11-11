/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
/* Shared validation and clock calculations. No browser state or timers. */
(() => {
  "use strict";
  const DEFAULT_PROMPT = "Scheduled heartbeat. Perform the tasks due for this cycle using this conversation's instructions. Continue while work remains. When this cycle is complete, end with [[LOGIC:IDLE]]. If human input is required, use [[LOGIC:USER_INPUT]] and wait for it.";
  function normalize(input = {}) {
    const kind = input.kind === "daily" ? "daily" : input.kind === "interval" ? "interval" : null;
    if (!kind) throw new Error("Choose an interval or specific times.");
    const timeZone = String(input.timeZone || "America/Chicago").trim();
    try { new Intl.DateTimeFormat("en-US", { timeZone }).format(); }
    catch { throw new Error("Enter a valid timezone, such as America/Chicago."); }
    const intervalMinutes = Number(input.intervalMinutes ?? 60);
    if (kind === "interval" && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080)) {
      throw new Error("Choose an interval from 1 to 10080 minutes.");
    }
    const times = [...new Set((Array.isArray(input.times) ? input.times : String(input.times || "").split(",")).map(s => String(s).trim()).filter(Boolean))].sort();
    const days = [...new Set((input.days || []).map(Number))].sort();
    if (kind === "daily" && (!times.length || times.length > 24 || times.some(s => !/^([01]\d|2[0-3]):[0-5]\d$/.test(s)))) {
      throw new Error("Enter up to 24 times in 24-hour format, such as 09:00, 15:00.");
    }
    if (kind === "daily" && (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6))) {
      throw new Error("Choose at least one weekday.");
    }
    const prompt = String(input.prompt || "").trim();
    const message = String(input.message || "").trim();
    const limit = Number(input.limit);
    if (!prompt || prompt.length > 4000) throw new Error("Enter a heartbeat prompt of 1–4000 characters.");
    if (!message || message.length > 4000) throw new Error("Enter a follow-up message of 1–4000 characters.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Choose a cycle limit from 1 to 1000 messages.");
    return { kind, timeZone, intervalMinutes: kind === "interval" ? intervalMinutes : 60, times: kind === "daily" ? times : [], days: kind === "daily" ? days : [], prompt, message, limit, rolloverEnabled: input.rolloverEnabled !== false };
  }
  function canonicalUrl(value) {
    try {
      const url = new URL(value);
      if (!["https://chatgpt.com", "https://chat.openai.com"].includes(url.origin) || url.username || url.password) return "";
      const match = url.pathname.match(/^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/);
      if (!match) return "";
      // ChatGPT assigns a local conversation ID while the first prompt is
      // being delivered. It is replaced by a server ID and cannot own a schedule.
      if (/^local-chatgpt:/i.test(decodeURIComponent(match[1]))) return "";
      return url.origin + url.pathname.replace(/\/$/, "");
    } catch { return ""; }
  }
  function chatKey(value) {
    return canonicalUrl(value).replace(/^(https:\/\/[^/]+\/g\/g-p-[a-f0-9]{32})(?:-[^/]+)?/i, "$1");
  }
  function sameChat(left, right) {
    const key = chatKey(left);
    return Boolean(key && key === chatKey(right));
  }
  function localClock(timeZone) {
    return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  }
  function slot(formatter, timestamp) {
    const p = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
    return { key: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`, time: `${p.hour}:${p.minute}`, day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
  }
  function nextRun(config, after = Date.now(), lastSlot = "") {
    if (config.kind === "interval") return after + config.intervalMinutes * 60000;
    const formatter = localClock(config.timeZone);
    // Walking UTC minutes handles timezone offsets and nonexistent DST times.
    // lastSlot prevents a second run at the repeated fall-back wall-clock time.
    const end = after + 8 * 86400000;
    for (let at = Math.floor(after / 60000) * 60000 + 60000; at <= end; at += 60000) {
      const candidate = slot(formatter, at);
      if (candidate.key !== lastSlot && config.days.includes(candidate.day) && config.times.includes(candidate.time)) {
        // Use the first occurrence of a repeated wall-clock time, including when
        // several configured times fall inside the DST rollback hour.
        let repeated = false;
        for (let minutes = 1; minutes <= 180; minutes += 1) {
          if (slot(formatter, at - minutes * 60000).key === candidate.key) { repeated = true; break; }
        }
        if (!repeated) return at;
      }
    }
    throw new Error("No scheduled time was found in the next eight days.");
  }
  globalThis.Heartbeat = { DEFAULT_PROMPT, normalize, canonicalUrl, chatKey, sameChat, nextRun, slotKey: (config, at) => config.kind === "daily" ? slot(localClock(config.timeZone), at).key : String(at) };
})();
