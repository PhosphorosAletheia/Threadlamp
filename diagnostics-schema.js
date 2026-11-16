/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
/* Shared allowlist: reports never accept arbitrary text, URLs, or DOM markup. */
(() => {
  "use strict";
  const events = new Set(["loaded", "state", "error", "handoff_prepare", "handoff_claimed", "handoff_verified",
    "draft_cleared", "thinking_verified", "prompt_written", "send_attempt", "send_observed", "handoff_complete", "handoff_receipt_retry",
    "identity_adopted", "identity_rejected", "reconnect_start", "reconnect_restored", "page_hidden", "overlay_restored",
    "summary_start", "summary_ready", "summary_error", "summary_skipped", "rewrite_ready", "rewrite_error", "queue_error"]);
  const reasons = new Set(["none", "other", "chat_changed", "project_changed", "draft_changed", "high_thinking",
    "context_invalidated", "receipt_rejected", "delivery_timeout", "send_unavailable", "handoff_unverified", "handoff_sender", "reconnect_sender", "logic_flag_missing",
    "notification_failed", "server_error", "conversation_limit", "summary_timeout", "summary_network",
    "summary_cancelled", "summary_response", "summary_rate_limit", "summary_cooldown", "summary_access",
    "summary_http", "summary_busy", "summary_size", "summary_settings", "summary_internal", "queue_storage",
    "rewrite_timeout", "rewrite_network", "rewrite_cancelled", "rewrite_rate_limit", "rewrite_access", "rewrite_response", "rewrite_busy", "rewrite_other"]);
  const modes = new Set(["idle", "logic", "loop", "setup"]);
  const phases = new Set(["idle", "starting", "monitoring", "waiting_user", "waiting", "sleeping", "rolling_over",
    "stopping", "update_paused", "recovery_paused", "reconnecting", "resuming", "arming_heartbeat", "server_setup", "sending"]);
  const numbers = ["runId", "count", "limit", "queueCount", "draftLength", "userLength", "userRenderedLength",
    "expectedLength", "paragraphs", "breaks", "searchIdCount", "wrapperTurns", "inputLength", "durationMs",
    "httpStatus", "activeRequests", "requestOrdinal", "cooldownSeconds", "retryAttempt"];
  const booleans = ["running", "paused", "hasComposer", "hasUser", "hasAssistant", "generating", "highThinking",
    "hasLegacyId", "hasSearchWrapper", "singleSearchUUID", "sourceProjectMatches", "draftMatchesExpected",
    "draftLooksLikeHandoff", "draftHasQueuedInstructions", "draftSourceProjectMatches", "confirmationExpired",
    "sourceIsUnsaved", "submissionPresent", "submissionTextMatches", "submissionTurnChanged", "messageIdPresent",
    "priorMessageIdPresent", "priorMessageIdMatches", "destinationStable", "pageReload", "pageDiscarded", "pagePersisted",
    "responseHeadersReceived"];
  const version = value => typeof value === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(value) ? value : "unknown";
  const number = value => Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : 0;
  const ref = value => typeof value === "string" && /^[a-f0-9]{16}$/.test(value) ? value : "";
  function reason(value) {
    const text = String(value || "").slice(0, 2000);
    for (const [code, pattern] of [
      ["queue_storage", /queue storage error/i],
      ["handoff_sender", /untrusted rollover request/i],
      ["reconnect_sender", /untrusted reconnection request/i],
      ["logic_flag_missing", /no valid final flag/i],
      ["context_invalidated", /extension context invalidated/i], ["chat_changed", /chat changed|left the scheduled conversation/i],
      ["project_changed", /project (?:changed|ID)|same project|same-project/i], ["draft_changed", /draft|message box/i],
      ["high_thinking", /high|thinking/i], ["receipt_rejected", /receipt|handoff.*(?:expired|cancelled)/i],
      ["delivery_timeout", /delivery timed out|reconnect/i], ["send_unavailable", /send button|accept the message/i],
      ["handoff_unverified", /handoff|continuation.*verified/i], ["notification_failed", /notification|alert/i],
      ["server_error", /server|socket/i], ["conversation_limit", /conversation.*(?:length|long)|maximum length/i]
    ]) if (pattern.test(text)) return code;
    return text ? "other" : "none";
  }
  function snapshot(input = {}) {
    input = input && typeof input === "object" ? input : {};
    const out = {event: events.has(input.event) ? input.event : "error", reason: reasons.has(input.reason) ? input.reason : "other",
      contentVersion: version(input.contentVersion), mode: modes.has(input.mode) ? input.mode : "idle",
      phase: phases.has(input.phase) ? input.phase : "idle"};
    for (const key of numbers) if (Number.isInteger(input[key]) && input[key] >= 0 && input[key] <= 10000000) out[key] = input[key];
    for (const key of booleans) if (typeof input[key] === "boolean") out[key] = input[key];
    if (["Q_LOAD", "Q_SAVE", "Q_MOVE", "Q_HANDOFF"].includes(input.queueOperation)) out.queueOperation = input.queueOperation;
    if (["sender", "route", "document", "storage"].includes(input.queueFailure)) out.queueFailure = input.queueFailure;
    if (Array.isArray(input.frames)) out.frames = input.frames.slice(0,5)
      .filter(frame => frame && frame.file === "content.js" && Number.isInteger(frame.line) && frame.line > 0 && frame.line <= 100000
        && Number.isInteger(frame.column) && frame.column >= 0 && frame.column <= 100000)
      .map(frame => ({file:frame.file, line:frame.line, column:frame.column}));
    return out;
  }
  function entry(input = {}) {
    input = input && typeof input === "object" ? input : {};
    return {...snapshot(input), at:number(input.at), tabId:number(input.tabId), workerVersion:version(input.workerVersion),
      projectRef:ref(input.projectRef), chatRef:ref(input.chatRef), instanceRef:ref(input.instanceRef),
      route:["project", "saved", "other"].includes(input.route) ? input.route : "other"};
  }
  function report(input) {
    if (!input || input.schema !== 1 || !Array.isArray(input.events) || !Array.isArray(input.incidents)) throw new Error("Invalid diagnostic report.");
    return {schema:1, generatedAt:number(input.generatedAt), enabled:input.enabled === true, workerVersion:version(input.workerVersion),
      dropped:number(input.dropped), events:input.events.slice(-400).map(entry),
      incidents:input.incidents.slice(-20).map(item => ({at:number(item?.at), tabId:number(item?.tabId),
        reason:reasons.has(item?.reason) ? item.reason : "other",
        events:(Array.isArray(item?.events) ? item.events : []).slice(-40).map(entry)}))};
  }
  const api = {events, reason, snapshot, entry, report, version};
  if (typeof module !== "undefined") module.exports = api;
  else globalThis.ThreadlampDiagnosticSchema = api;
})();
