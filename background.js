/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";

const HA_CONFIG_KEY = "homeAssistantConfig";
const HA_PENDING_KEY = "homeAssistantPendingRequests";
const HA_ERROR_NOTIFICATIONS_KEY = "homeAssistantErrorNotifications";
const ALERT_SETTINGS_KEY = "workstationAlertSettings";
const LOGIC_ROLLOVER_KEY = "logicModePendingRollovers";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const HA_EVENT_TYPE = "mobile_app_notification_action";
const HA_RECONNECT_MS = 5000;
const HA_KEEPALIVE_MS = 20 * 1000;
const HA_CONNECT_TIMEOUT_MS = 10 * 1000;
const HA_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIC_ROLLOVER_TTL_MS = 5 * 60 * 1000;
const LOGIC_ROLLOVER_FALLBACK_CLAIM_MS = 60 * 1000;
const DEFAULT_APPROVAL_MESSAGE = "Approved. Continue with the current task.";
const SETTINGS_SNAPSHOT_VERSION = 1;
const CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

let config = defaultConfig();
let alertSettings = { soundEnabled: true };
let creatingOffscreenDocument = null;
let socket = null;
let socketGeneration = 0;
let reconnectTimer = null;
let keepaliveTimer = null;
let nextSocketMessageId = 1;
let subscriptionMessageId = null;
const actionsInProgress = new Set();
let errorNotificationQueue = Promise.resolve();
let connection = {
  phase: "disabled",
  detail: "Home Assistant notifications are disabled.",
  updatedAt: Date.now()
};

function defaultConfig() {
  return {
    enabled: false,
    baseUrl: "",
    notifyAction: "",
    approvalMessage: DEFAULT_APPROVAL_MESSAGE,
    persistent: true,
    token: ""
  };
}

function setConnection(phase, detail) {
  connection = { phase, detail, updatedAt: Date.now() };
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("Home Assistant URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Do not put credentials in the Home Assistant URL.");
  }
  return url.origin;
}

function originPattern(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}/*`;
}

function normalizeNotifyAction(value) {
  const action = String(value || "").trim().toLowerCase();
  if (!/^notify\.mobile_app_[a-z0-9_]+$/.test(action)) {
    throw new Error("Notification action must look like notify.mobile_app_your_phone.");
  }
  return action;
}

function normalizeApprovalMessage(value) {
  const message = String(value || "").replace(/\s+/g, " ").trim();
  if (!message) throw new Error("Enter the message the Approve button should send.");
  if (message.length > 4000) throw new Error("Approval message must be 4,000 characters or fewer.");
  return message;
}

function normalizeBrief(value) {
  const brief = String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return brief || "ChatGPT needs your input. Open the conversation to review its request.";
}

function isChatGptUrl(value = "") {
  try {
    return CHATGPT_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function projectSegmentFromUrl(value = "") {
  try {
    const url = new URL(value);
    if (!CHATGPT_HOSTS.has(url.hostname)) return "";
    return url.pathname.match(/^\/g\/(g-p-[^/]+)(?:\/|$)/)?.[1] || "";
  } catch {
    return "";
  }
}

function chatPathFromUrl(value = "") {
  try {
    const url = new URL(value);
    if (!CHATGPT_HOSTS.has(url.hostname)) return "";
    return url.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
}

function projectSlugFromSegment(segment = "") {
  const match = String(segment).match(/^g-p-[a-f0-9]{32}-(.+)$/i);
  return match?.[1] || "";
}

function sameRolloverProject(left, right) {
  const id = value => String(value || "").match(/^(g-p-[a-f0-9]{32})(?:-[^/]+)?$/i)?.[1]?.toLowerCase();
  return Boolean(id(left) && id(left) === id(right));
}

function rolloverProjectHome(url, projectSegment) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && CHATGPT_HOSTS.has(parsed.hostname)
      && !parsed.search && !parsed.hash
      && /^\/g\/[^/]+(?:\/project)?\/?$/.test(parsed.pathname)
      && sameRolloverProject(projectSegmentFromUrl(url), projectSegment);
  } catch { return false; }
}

function normalizeProjectName(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function selectedProjectMatchesSegment(selectedProjectName, projectSegment) {
  const slug = projectSlugFromSegment(projectSegment);
  return Boolean(
    slug
    && normalizeProjectName(selectedProjectName) === normalizeProjectName(slug)
  );
}

function isTrustedExtensionPage(sender) {
  if (sender?.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:" && url.hostname === chrome.runtime.id;
  } catch {
    return false;
  }
}

function isTrustedChatSender(sender) {
  return Boolean(
    sender?.id === chrome.runtime.id
    && Number.isInteger(sender.tab?.id)
    && isChatGptUrl(sender.tab.url)
  );
}

function publicSettings() {
  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    notifyAction: config.notifyAction,
    approvalMessage: config.approvalMessage,
    persistent: config.persistent,
    tokenSaved: Boolean(config.token),
    connection: { ...connection }
  };
}

async function protectStorage() {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  ]);
}

async function loadConfig() {
  const saved = await chrome.storage.local.get([HA_CONFIG_KEY, ALERT_SETTINGS_KEY]);
  const candidate = saved[HA_CONFIG_KEY];
  config = candidate && typeof candidate === "object"
    ? { ...defaultConfig(), ...candidate }
    : defaultConfig();

  const savedAlerts = saved[ALERT_SETTINGS_KEY];
  alertSettings = {
    soundEnabled: savedAlerts?.soundEnabled !== false
  };
}

async function saveAlertSettings(request) {
  alertSettings = {
    soundEnabled: Boolean(request.soundEnabled)
  };
  await chrome.storage.local.set({ [ALERT_SETTINGS_KEY]: alertSettings });
  return { ...alertSettings };
}

function normalizeLoopSettings(candidate = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("The backup's loop settings are invalid.");
  }
  if (candidate.message !== undefined && typeof candidate.message !== "string") {
    throw new Error("The backup's repeat message is invalid.");
  }
  if (candidate.rolloverEnabled !== undefined && typeof candidate.rolloverEnabled !== "boolean") {
    throw new Error("The backup's project-rollover setting is invalid.");
  }
  const message = (candidate.message ?? "Continue").trim();
  const limit = candidate.limit ?? 5;
  if (!message || message.length > 4000) {
    throw new Error("The backup's repeat message must contain 1 to 4,000 characters.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("The backup's repeat limit must be a whole number from 1 to 1,000.");
  }
  return {
    message,
    limit,
    rolloverEnabled: candidate.rolloverEnabled !== false
  };
}

function normalizeImportedHomeAssistant(candidate = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("The backup's Home Assistant settings are invalid.");
  }

  for (const field of ["baseUrl", "notifyAction", "approvalMessage", "token"]) {
    if (candidate[field] !== undefined && typeof candidate[field] !== "string") {
      throw new Error(`The backup's Home Assistant ${field} value is invalid.`);
    }
  }
  for (const field of ["enabled", "persistent"]) {
    if (candidate[field] !== undefined && typeof candidate[field] !== "boolean") {
      throw new Error(`The backup's Home Assistant ${field} value is invalid.`);
    }
  }

  const rawBaseUrl = (candidate.baseUrl || "").trim();
  const rawNotifyAction = (candidate.notifyAction || "").trim();
  const rawToken = (candidate.token || "").trim();
  const hasConfiguration = Boolean(rawBaseUrl || rawNotifyAction || rawToken);
  if (!hasConfiguration) {
    if (candidate.enabled) {
      throw new Error("The backup enables Home Assistant but has no configuration.");
    }
    return {
      ...defaultConfig(),
      approvalMessage: normalizeApprovalMessage(
        candidate.approvalMessage || DEFAULT_APPROVAL_MESSAGE
      ),
      persistent: candidate.persistent !== false
    };
  }

  if (!rawBaseUrl || !rawNotifyAction || !rawToken) {
    throw new Error("The backup's Home Assistant configuration is incomplete.");
  }
  if (rawToken.length > 16384) {
    throw new Error("The backup's Home Assistant token is unexpectedly large.");
  }
  return {
    enabled: Boolean(candidate.enabled),
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    notifyAction: normalizeNotifyAction(rawNotifyAction),
    approvalMessage: normalizeApprovalMessage(
      candidate.approvalMessage || DEFAULT_APPROVAL_MESSAGE
    ),
    persistent: candidate.persistent !== false,
    token: rawToken
  };
}

async function exportSettingsSnapshot() {
  const saved = await chrome.storage.local.get({
    message: "Continue",
    limit: 5,
    rolloverEnabled: true
  });
  return {
    schemaVersion: SETTINGS_SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    homeAssistant: { ...config },
    workstationAlert: { ...alertSettings },
    loop: normalizeLoopSettings(saved)
  };
}

function normalizeSettingsSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("The decrypted backup does not contain extension settings.");
  }
  if (snapshot.schemaVersion !== SETTINGS_SNAPSHOT_VERSION) {
    throw new Error("The decrypted settings snapshot version is not supported.");
  }
  if (
    !snapshot.workstationAlert
    || typeof snapshot.workstationAlert !== "object"
    || Array.isArray(snapshot.workstationAlert)
    || typeof snapshot.workstationAlert.soundEnabled !== "boolean"
  ) {
    throw new Error("The backup's workstation alert settings are invalid.");
  }
  return {
    homeAssistant: normalizeImportedHomeAssistant(snapshot.homeAssistant),
    workstationAlert: {
      soundEnabled: snapshot.workstationAlert.soundEnabled
    },
    loop: normalizeLoopSettings(snapshot.loop)
  };
}

function validateSettingsSnapshotForImport(snapshot) {
  const normalized = normalizeSettingsSnapshot(snapshot);
  return {
    ok: true,
    homeAssistantBaseUrl: normalized.homeAssistant.baseUrl,
    homeAssistantConfigured: Boolean(normalized.homeAssistant.token),
    loopLimit: normalized.loop.limit
  };
}

async function importSettingsSnapshot(snapshot) {
  const normalized = normalizeSettingsSnapshot(snapshot);
  const importedConfig = normalized.homeAssistant;
  const previousBaseUrl = config.baseUrl;

  if (importedConfig.baseUrl) {
    const permitted = await chrome.permissions.contains({
      origins: [originPattern(importedConfig.baseUrl)]
    });
    if (!permitted) {
      throw new Error("Home Assistant site permission was not granted for the imported URL.");
    }
  }

  await chrome.storage.local.set({
    [HA_CONFIG_KEY]: importedConfig,
    [ALERT_SETTINGS_KEY]: normalized.workstationAlert,
    message: normalized.loop.message,
    limit: normalized.loop.limit,
    rolloverEnabled: normalized.loop.rolloverEnabled
  });

  config = importedConfig;
  alertSettings = normalized.workstationAlert;
  restartConnection();

  if (previousBaseUrl && previousBaseUrl !== importedConfig.baseUrl) {
    await chrome.permissions.remove({
      origins: [originPattern(previousBaseUrl)]
    }).catch(() => false);
  }

  return {
    ok: true,
    homeAssistant: publicSettings(),
    workstationAlert: { ...alertSettings },
    loop: { ...normalized.loop }
  };
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play a short local alert when Logic Mode needs user input."
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

async function playWorkstationAlert(force = false) {
  if (!force && !alertSettings.soundEnabled) {
    return { ok: true, enabled: false };
  }

  await ensureOffscreenDocument();
  const result = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_PLAY_USER_INPUT_SOUND"
  });
  if (!result?.ok) throw new Error(result?.error || "The audio document did not play the alert.");
  return { ok: true, enabled: true };
}

async function saveConfig(request) {
  const previousBaseUrl = config.baseUrl;
  const baseUrl = normalizeBaseUrl(request.baseUrl);
  const notifyAction = normalizeNotifyAction(request.notifyAction);
  const approvalMessage = normalizeApprovalMessage(request.approvalMessage);
  const suppliedToken = String(request.token || "").trim();
  const token = suppliedToken || config.token;

  if (!token) throw new Error("Enter a Home Assistant access token.");

  const permitted = await chrome.permissions.contains({ origins: [originPattern(baseUrl)] });
  if (!permitted) {
    throw new Error("Home Assistant site permission was not granted.");
  }

  config = {
    enabled: Boolean(request.enabled),
    baseUrl,
    notifyAction,
    approvalMessage,
    persistent: Boolean(request.persistent),
    token
  };

  await chrome.storage.local.set({ [HA_CONFIG_KEY]: config });
  restartConnection();

  if (previousBaseUrl && previousBaseUrl !== baseUrl) {
    await chrome.permissions.remove({ origins: [originPattern(previousBaseUrl)] }).catch(() => false);
  }

  return publicSettings();
}

async function forgetConfig() {
  const previousBaseUrl = config.baseUrl;
  const pending = await getPendingRequests();
  if (config.enabled && config.baseUrl && config.notifyAction && config.token) {
    await Promise.all(
      Object.values(pending).map((request) => (
        clearPhoneNotification(request?.tag).catch(() => undefined)
      ))
    );
  }
  disconnectSocket();
  config = defaultConfig();
  setConnection("disabled", "Home Assistant settings were removed.");
  await Promise.all([
    chrome.storage.local.remove(HA_CONFIG_KEY),
    chrome.storage.session.remove(HA_PENDING_KEY)
  ]);
  if (previousBaseUrl) {
    await chrome.permissions.remove({ origins: [originPattern(previousBaseUrl)] }).catch(() => false);
  }
  return publicSettings();
}

function requireConfigured() {
  if (!config.enabled) throw new Error("Home Assistant notifications are disabled.");
  if (!config.baseUrl || !config.notifyAction || !config.token) {
    throw new Error("Home Assistant settings are incomplete.");
  }
}

async function haFetch(path, options = {}) {
  requireConfigured();
  const response = await fetch(new URL(path, config.baseUrl), {
    ...options,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error("Home Assistant rejected the access token.");
    throw new Error(`Home Assistant request failed with HTTP ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

function notifyServicePath() {
  const [domain, service] = config.notifyAction.split(".");
  return `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
}

async function callNotifyService(payload) {
  return haFetch(notifyServicePath(), {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

async function testConnection() {
  await haFetch("/api/");
  connectSocket();
  return { ok: true, detail: "Home Assistant API connection succeeded." };
}

async function sendTestNotification() {
  const data = { tag: "chatgpt_logic_test" };
  if (config.persistent) Object.assign(data, { persistent: true, sticky: true });
  await callNotifyService({
    title: "Threadlamp",
    message: "Home Assistant notifications are configured correctly.",
    data
  });
  return { ok: true, detail: "Test notification sent." };
}

async function getPendingRequests() {
  const saved = await chrome.storage.session.get(HA_PENDING_KEY);
  const pending = saved[HA_PENDING_KEY];
  return pending && typeof pending === "object" ? pending : {};
}

async function setPendingRequests(pending) {
  await chrome.storage.session.set({ [HA_PENDING_KEY]: pending });
}

async function prunePendingRequests() {
  const pending = await getPendingRequests();
  const now = Date.now();
  let changed = false;
  for (const [requestId, request] of Object.entries(pending)) {
    if (!request?.expiresAt || request.expiresAt <= now) {
      delete pending[requestId];
      changed = true;
    }
  }
  if (changed) await setPendingRequests(pending);
  return pending;
}

function makeRequestId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24).toUpperCase();
}

async function getPendingRollovers() {
  const saved = await chrome.storage.session.get(LOGIC_ROLLOVER_KEY);
  const pending = saved[LOGIC_ROLLOVER_KEY];
  return pending && typeof pending === "object" ? pending : {};
}

async function setPendingRollovers(pending) {
  await chrome.storage.session.set({ [LOGIC_ROLLOVER_KEY]: pending });
}

async function prunePendingRollovers() {
  const pending = await getPendingRollovers();
  const now = Date.now();
  let changed = false;

  for (const [requestId, request] of Object.entries(pending)) {
    if (!request?.expiresAt || request.expiresAt <= now) {
      delete pending[requestId];
      changed = true;
    }
  }

  if (changed) await setPendingRollovers(pending);
  return pending;
}

function normalizeRolloverTitle(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function normalizeFailureDetail(value, fallback) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
    || fallback;
}

function normalizeNotificationTagPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .slice(0, 80)
    || "unknown";
}

async function sendRolloverFailureNotification(request, sender) {
  requireConfigured();
  const previousTitle = normalizeRolloverTitle(request.previousTitle);
  const detail = normalizeFailureDetail(request.detail, "The extension could not start the new project chat.");
  const failureId = normalizeNotificationTagPart(request.failureId || sender.tab.id);
  const tabUrl = sender.tab.url;
  const data = {
    tag: `chatgpt_rollover_failed_${failureId}`,
    url: tabUrl,
    clickAction: tabUrl
  };
  if (config.persistent) Object.assign(data, { persistent: true, sticky: true });

  await sendDismissibleErrorNotification({
    title: "ChatGPT project continuation failed",
    message: previousTitle
      ? `Could not continue “${previousTitle}” in a new project chat. ${detail}`
      : detail,
    data
  });
  return { ok: true, enabled: true };
}

async function sendErrorNotification(request, sender) {
  requireConfigured();
  const chatTitle = normalizeRolloverTitle(request.chatTitle)
    || normalizeRolloverTitle(sender.tab.title)
    || `Unnamed chat (tab ${sender.tab.id})`;
  const detail = normalizeFailureDetail(request.detail, "The chat automation encountered an error.");
  const tabUrl = sender.tab.url;
  const data = {
    // Replace earlier runtime-error notifications from this tab, without colliding
    // with another chat or its pending user-input/rollover notifications.
    tag: `chatgpt_error_${sender.tab.id}`,
    url: tabUrl,
    clickAction: tabUrl
  };
  if (config.persistent) Object.assign(data, { persistent: true, sticky: true });
  await sendDismissibleErrorNotification({
    title: "ChatGPT automation error",
    message: `“${chatTitle}”: ${detail}`,
    data
  });
  return { ok: true, enabled: true };
}

function queueErrorNotification(operation) {
  const result = errorNotificationQueue.then(operation);
  errorNotificationQueue = result.catch(() => undefined);
  return result;
}

async function getErrorNotifications() {
  const saved = await chrome.storage.local.get(HA_ERROR_NOTIFICATIONS_KEY);
  const records = saved[HA_ERROR_NOTIFICATIONS_KEY];
  return records && typeof records === "object" && !Array.isArray(records) ? records : {};
}

function sendDismissibleErrorNotification(payload) {
  return queueErrorNotification(async () => {
    requireConfigured();
    const records = await getErrorNotifications();
    const tag = payload.data.tag;
    const previous = records[tag];
    const action = `CHATGPT_DISMISS_ERROR_${crypto.randomUUID()}`;
    records[tag] = { tag, action, baseUrl: config.baseUrl, notifyAction: config.notifyAction };
    // Save before delivery so a fast phone tap can be handled. Keep only routing
    // metadata, not titles, errors, transcripts, or credentials, across restarts.
    await chrome.storage.local.set({ [HA_ERROR_NOTIFICATIONS_KEY]: records });
    try {
      await callNotifyService({
        ...payload,
        data: { ...payload.data, actions: [{ action, title: "Dismiss" }] }
      });
    } catch (error) {
      if (previous) records[tag] = previous;
      else delete records[tag];
      await chrome.storage.local.set({ [HA_ERROR_NOTIFICATIONS_KEY]: records });
      throw error;
    }
  });
}

function dismissErrorNotification(action) {
  return queueErrorNotification(async () => {
    if (!config.enabled) return;
    const records = await getErrorNotifications();
    const record = Object.values(records).find(item => item?.action === action);
    if (!record || record.baseUrl !== config.baseUrl || record.notifyAction !== config.notifyAction) return;
    // Serialized with new error delivery: an old button cannot clear a newer
    // error using the same tag. This never calls a ChatGPT content script.
    await clearPhoneNotification(record.tag);
    delete records[record.tag];
    await chrome.storage.local.set({ [HA_ERROR_NOTIFICATIONS_KEY]: records });
    setConnection("connected", "Home Assistant error notification dismissed. Chat state is unchanged.");
  });
}

async function prepareLogicRollover(request, sender) {
  const sourceUrl = sender.tab.url;
  const sourcePath = chatPathFromUrl(sourceUrl);
  const projectSegment = projectSegmentFromUrl(sourceUrl);
  if (!projectSegment || request.projectSegment !== projectSegment) {
    throw new Error("The current conversation could not be verified as a project chat.");
  }
  const projectHomeUrl = typeof request.projectHomeUrl === "string" ? request.projectHomeUrl : "";
  if (projectHomeUrl && (!rolloverProjectHome(projectHomeUrl, projectSegment)
    || new URL(projectHomeUrl).origin !== new URL(sourceUrl).origin)) {
    throw new Error("The same-project navigation destination could not be verified.");
  }

  const previousTitle = normalizeRolloverTitle(request.previousTitle);
  const message = String(request.message || "").trim();
  const queuedPrompt = typeof request.queuedPrompt === "string" ? request.queuedPrompt.trim() : "";
  const sourceUserFingerprint = request.sourceUserFingerprint == null ? null : {
    length: request.sourceUserFingerprint.length, sha256: request.sourceUserFingerprint.sha256,
    ...(request.sourceUserFingerprint.renderedLength !== undefined || request.sourceUserFingerprint.renderedSha256 !== undefined
      ? { renderedLength: request.sourceUserFingerprint.renderedLength, renderedSha256: request.sourceUserFingerprint.renderedSha256 } : {})
  };
  const limit = Number.parseInt(request.limit, 10);
  const count = Number.parseInt(request.count, 10);

  if (!previousTitle) throw new Error("The previous conversation title could not be determined.");
  if (!message || message.length > 4000) throw new Error("The continuation message is invalid.");
  if (queuedPrompt.length > 8000) throw new Error("The queued prompt is too long.");
  if (sourceUserFingerprint && (!Number.isInteger(sourceUserFingerprint.length)
    || sourceUserFingerprint.length < 1 || sourceUserFingerprint.length > 100000
    || typeof sourceUserFingerprint.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sourceUserFingerprint.sha256))) {
    throw new Error("The source message fingerprint is invalid.");
  }
  if (sourceUserFingerprint && (sourceUserFingerprint.renderedLength !== undefined || sourceUserFingerprint.renderedSha256 !== undefined)
    && (!Number.isInteger(sourceUserFingerprint.renderedLength) || sourceUserFingerprint.renderedLength < 1
      || sourceUserFingerprint.renderedLength > sourceUserFingerprint.length
      || typeof sourceUserFingerprint.renderedSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(sourceUserFingerprint.renderedSha256))) {
    throw new Error("The source message rendering fingerprint is invalid.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("The Logic Mode message limit is invalid.");
  }
  if (!Number.isInteger(count) || count < 0 || count >= limit) {
    throw new Error("The Logic Mode message counter cannot continue.");
  }

  const pending = await prunePendingRollovers();
  for (const [pendingId, existing] of Object.entries(pending)) {
    if (existing?.sourceTabId === sender.tab.id) delete pending[pendingId];
  }
  const requestId = makeRequestId();
  pending[requestId] = {
    requestId,
    sourceTabId: sender.tab.id,
    sourceUrl,
    sourcePath,
    projectSegment,
    projectHomeUrl,
    previousTitle,
    message,
    queuedPrompt,
    sourceUserFingerprint,
    limit,
    count,
    rolloverEnabled: true,
    createdAt: Date.now(),
    expiresAt: Date.now() + LOGIC_ROLLOVER_TTL_MS
  };
  await setPendingRollovers(pending);
  return { ok: true, requestId };
}

async function claimLogicRollover(request, sender) {
  const projectSegment = projectSegmentFromUrl(sender.tab.url);
  const currentPath = chatPathFromUrl(sender.tab.url);
  const selectedProjectName = String(request.selectedProjectName || "").trim();
  const requestedId = String(request.requestId || "");
  if (!projectSegment && (currentPath !== "/" || !selectedProjectName)) {
    return { ok: true, pending: null };
  }

  const pending = await prunePendingRollovers();
  const entries = Object.entries(pending)
    .filter(([, request]) => (
      request.sourcePath !== currentPath
      // A slug-only URL change is still the same saved conversation.
      && !(currentPath.match(/\/c\/([^/]+)$/)?.[1]
        && currentPath.match(/\/c\/([^/]+)$/)?.[1] === request.sourcePath.match(/\/c\/([^/]+)$/)?.[1])
      // The fallback uses the current tab's project home, never another live chat.
      && (!request.projectHomeUrl || (request.sourceTabId === sender.tab.id
        && new URL(sender.tab.url).origin === new URL(request.sourceUrl).origin
        && (rolloverProjectHome(sender.tab.url, request.projectSegment) || currentPath === "/")))
      && (
        sameRolloverProject(request.projectSegment, projectSegment)
        || (
          currentPath === "/"
          && selectedProjectMatchesSegment(selectedProjectName, request.projectSegment)
        )
      )
    ))
    .sort(([, left], [, right]) => right.createdAt - left.createdAt);

  let match = requestedId
    ? entries.find(([requestId]) => requestId === requestedId)
    : null;

  if (!match) match = entries.find(([, request]) => (
    request.sourceTabId === sender.tab.id
    || request.sourceTabId === sender.tab.openerTabId
  ));

  if (!match) {
    const recent = entries.filter(([, request]) => (
      Date.now() - request.createdAt <= LOGIC_ROLLOVER_FALLBACK_CLAIM_MS
    ));
    if (recent.length === 1) match = recent[0];
  }

  if (!match) return { ok: true, pending: null };

  const [requestId, rollover] = match;
  if (typeof HeartbeatScheduler !== "undefined") await HeartbeatScheduler.transfer(rollover, sender.tab);
  if (typeof ServerLinkWorker !== "undefined") await ServerLinkWorker.transfer(rollover, sender.tab);
  delete pending[requestId];
  await setPendingRollovers(pending);
  return { ok: true, pending: rollover };
}

async function cancelLogicRollover(request, sender) {
  const requestId = String(request.requestId || "");
  const pending = await getPendingRollovers();
  const rollover = pending[requestId];
  if (!rollover) return { ok: true, removed: false };
  if (rollover.sourceTabId !== sender.tab.id) {
    throw new Error("That rollover request belongs to another ChatGPT tab.");
  }

  delete pending[requestId];
  await setPendingRollovers(pending);
  return { ok: true, removed: true };
}

async function waitForSocket(timeoutMs = HA_CONNECT_TIMEOUT_MS) {
  connectSocket();
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (connection.phase === "connected") return true;
    if (connection.phase === "auth_error") return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function sendUserInputNotification(request, sender) {
  requireConfigured();
  const socketReady = await waitForSocket();
  if (!socketReady) {
    throw new Error(`Home Assistant event connection is not ready: ${connection.detail}`);
  }

  const brief = normalizeBrief(request.brief);
  const tabUrl = sender.tab.url;
  const tabId = sender.tab.id;
  const pending = await prunePendingRequests();
  const existingEntry = Object.entries(pending).find(([, item]) => (
    item.tabUrl === tabUrl && item.brief === brief
  ));

  if (existingEntry) {
    const [requestId, existing] = existingEntry;
    pending[requestId] = {
      ...existing,
      tabId,
      expiresAt: Date.now() + HA_REQUEST_TTL_MS
    };
    await setPendingRequests(pending);
    return { ok: true, enabled: true, requestId, deduplicated: true };
  }

  const requestId = makeRequestId();
  const tag = `chatgpt_logic_${requestId.toLowerCase()}`;
  const approveAction = `CHATGPT_APPROVE_${requestId}`;
  const replyAction = `CHATGPT_REPLY_${requestId}`;
  const data = {
    tag,
    url: tabUrl,
    clickAction: tabUrl,
    actions: [
      {
        action: approveAction,
        title: "Approve",
        authenticationRequired: true
      },
      {
        action: replyAction,
        title: "Reply",
        behavior: "textInput",
        textInputButtonTitle: "Send",
        textInputPlaceholder: "Type your response"
      }
    ]
  };
  if (config.persistent) Object.assign(data, { persistent: true, sticky: true });

  await callNotifyService({
    title: "ChatGPT needs your input",
    message: brief,
    data
  });

  pending[requestId] = {
    requestId,
    tabId,
    tabUrl,
    brief,
    tag,
    approveAction,
    replyAction,
    createdAt: Date.now(),
    expiresAt: Date.now() + HA_REQUEST_TTL_MS
  };
  await setPendingRequests(pending);
  return { ok: true, enabled: true, requestId, deduplicated: false };
}

async function clearPhoneNotification(tag) {
  if (!tag || !config.enabled) return;
  await callNotifyService({
    message: "clear_notification",
    data: { tag }
  });
}

async function removePendingRequest(requestId, clearNotification = true) {
  const pending = await getPendingRequests();
  const request = pending[requestId];
  if (!request) return false;
  delete pending[requestId];
  await setPendingRequests(pending);
  if (clearNotification) {
    await clearPhoneNotification(request.tag).catch(() => undefined);
  }
  return true;
}

async function cancelPendingRequest(request, sender) {
  const requestId = String(request.requestId || "");
  const pending = await getPendingRequests();
  const item = pending[requestId];
  if (!item) return { ok: true, removed: false };
  if (item.tabId !== sender.tab.id && item.tabUrl !== sender.tab.url) {
    throw new Error("That Home Assistant request belongs to another conversation.");
  }
  await removePendingRequest(requestId);
  return { ok: true, removed: true };
}

function socketUrl() {
  const url = new URL(config.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/websocket";
  url.search = "";
  url.hash = "";
  return url.href;
}

function clearSocketTimers() {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
  reconnectTimer = null;
  keepaliveTimer = null;
}

function disconnectSocket() {
  socketGeneration += 1;
  clearSocketTimers();
  const previous = socket;
  socket = null;
  subscriptionMessageId = null;
  if (previous && previous.readyState < WebSocket.CLOSING) previous.close();
}

function scheduleReconnect(generation) {
  if (!config.enabled || generation !== socketGeneration || reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, HA_RECONNECT_MS);
}

function startKeepalive(generation) {
  if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
  keepaliveTimer = setInterval(() => {
    if (generation !== socketGeneration || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ id: nextSocketMessageId++, type: "ping" }));
  }, HA_KEEPALIVE_MS);
}

async function handleNotificationAction(data) {
  const action = String(data?.action || "");
  if (action.startsWith("CHATGPT_DISMISS_ERROR_")) {
    try {
      await dismissErrorNotification(action);
    } catch {
      setConnection("connected", "The error notification could not be dismissed. Try Dismiss again.");
    }
    return;
  }
  if (!action.startsWith("CHATGPT_APPROVE_") && !action.startsWith("CHATGPT_REPLY_")) return;

  const pending = await prunePendingRequests();
  const request = Object.values(pending).find((item) => (
    item.approveAction === action || item.replyAction === action
  ));
  if (!request) return;
  if (actionsInProgress.has(request.requestId)) return;

  const isApprove = action === request.approveAction;
  const message = isApprove
    ? config.approvalMessage
    : String(data?.reply_text || "").trim();

  if (!message) {
    setConnection("connected", "A Home Assistant reply was empty; Logic Mode remains paused.");
    return;
  }
  if (message.length > 4000) {
    setConnection("connected", "A Home Assistant reply exceeded 4,000 characters and was rejected.");
    return;
  }

  actionsInProgress.add(request.requestId);
  try {
    const result = await chrome.tabs.sendMessage(request.tabId, {
      type: "HA_REMOTE_RESPONSE",
      requestId: request.requestId,
      tabUrl: request.tabUrl,
      message,
      responseType: isApprove ? "approve" : "reply"
    });

    if (!result?.accepted) {
      throw new Error(result?.detail || "The ChatGPT tab rejected the response.");
    }

    await removePendingRequest(request.requestId);
    setConnection("connected", "Home Assistant response delivered to ChatGPT.");
  } catch (error) {
    setConnection(
      "connected",
      error instanceof Error
        ? `Home Assistant response was not delivered: ${error.message}`
        : "Home Assistant response was not delivered."
    );
  } finally {
    actionsInProgress.delete(request.requestId);
  }
}

function handleSocketMessage(event, generation) {
  if (generation !== socketGeneration) return;

  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }

  if (message.type === "auth_required") {
    socket.send(JSON.stringify({ type: "auth", access_token: config.token }));
    return;
  }

  if (message.type === "auth_invalid") {
    setConnection("auth_error", "Home Assistant rejected the access token.");
    disconnectSocket();
    return;
  }

  if (message.type === "auth_ok") {
    subscriptionMessageId = nextSocketMessageId++;
    socket.send(JSON.stringify({
      id: subscriptionMessageId,
      type: "subscribe_events",
      event_type: HA_EVENT_TYPE
    }));
    startKeepalive(generation);
    return;
  }

  if (message.type === "result" && message.id === subscriptionMessageId) {
    if (message.success) {
      setConnection("connected", "Listening for Home Assistant phone responses.");
    } else {
      setConnection("error", "Home Assistant refused the notification-action subscription.");
      disconnectSocket();
    }
    return;
  }

  if (message.type === "event" && message.event?.event_type === HA_EVENT_TYPE) {
    void handleNotificationAction(message.event.data);
  }
}

function connectSocket() {
  if (!config.enabled || !config.baseUrl || !config.token) {
    disconnectSocket();
    setConnection("disabled", "Home Assistant notifications are disabled.");
    return;
  }
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;

  disconnectSocket();
  const generation = socketGeneration;
  setConnection("connecting", "Connecting to Home Assistant…");

  try {
    socket = new WebSocket(socketUrl());
  } catch (error) {
    setConnection("error", error instanceof Error ? error.message : "WebSocket connection failed.");
    scheduleReconnect(generation);
    return;
  }

  socket.onmessage = (event) => handleSocketMessage(event, generation);
  socket.onerror = () => {
    if (generation === socketGeneration) setConnection("error", "Home Assistant event connection failed.");
  };
  socket.onclose = () => {
    if (generation !== socketGeneration) return;
    socket = null;
    subscriptionMessageId = null;
    if (connection.phase !== "auth_error") {
      setConnection("disconnected", "Home Assistant event connection closed; retrying…");
      scheduleReconnect(generation);
    }
  };
}

function restartConnection() {
  disconnectSocket();
  connectSocket();
}

async function initialize() {
  await protectStorage();
  await loadConfig();
  await Promise.all([prunePendingRequests(), prunePendingRollovers()]);
  if (config.enabled) connectSocket();
}

function startInitialization() {
  const pendingInitialization = initialize();
  void pendingInitialization.catch((error) => {
    setConnection(
      "error",
      error instanceof Error
        ? `Home Assistant initialization failed: ${error.message}`
        : "Home Assistant initialization failed."
    );
  });
  return pendingInitialization;
}

let initializationPromise = startInitialization();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (/^(HB_|SL_|DB_)/.test(String(request?.type || ""))) return false;
  // Let the offscreen document exclusively handle its private audio message.
  if (request?.type === "OFFSCREEN_PLAY_USER_INPUT_SOUND") return false;

  void (async () => {
    await initializationPromise;

    switch (request?.type) {
      case "HA_GET_SETTINGS":
        if (!isTrustedExtensionPage(sender)) throw new Error("Untrusted settings request.");
        return publicSettings();

      case "SETTINGS_EXPORT_SNAPSHOT":
        if (!isTrustedExtensionPage(sender)) throw new Error("Untrusted settings-export request.");
        return exportSettingsSnapshot();

      case "SETTINGS_IMPORT_SNAPSHOT":
        if (!isTrustedExtensionPage(sender)) throw new Error("Untrusted settings-import request.");
        return importSettingsSnapshot(request.snapshot);

      case "SETTINGS_VALIDATE_SNAPSHOT":
        if (!isTrustedExtensionPage(sender)) throw new Error("Untrusted settings-validation request.");
        return validateSettingsSnapshotForImport(request.snapshot);

      case "ALERT_GET_SETTINGS":
        if (!isTrustedExtensionPage(sender)) throw new Error("Untrusted alert-settings request.");
        return { ...alertSettings };

      case "ALERT_SET_SETTINGS":
        if (!isTrustedExtensionPage(sender)) throw new Error("Untrusted alert-settings request.");
        return saveAlertSettings(request.settings || {});

      case "ALERT_TEST_SOUND":
        if (!isTrustedExtensionPage(sender)) throw new Error("Untrusted sound-test request.");
        return playWorkstationAlert(true);

      case "ALERT_PLAY_USER_INPUT":
        if (!isTrustedChatSender(sender)) throw new Error("Untrusted alert request.");
        return playWorkstationAlert();

      case "ALERT_PLAY_ROLLOVER_FAILURE":
        if (!isTrustedChatSender(sender)) throw new Error("Untrusted alert request.");
        return playWorkstationAlert();

      case "LOGIC_ROLLOVER_PREPARE":
        if (!isTrustedChatSender(sender)) throw new Error("Untrusted rollover request.");
        return prepareLogicRollover(request, sender);

      case "LOGIC_ROLLOVER_CLAIM":
        if (!isTrustedChatSender(sender)) throw new Error("Untrusted rollover request.");
        return claimLogicRollover(request, sender);

      case "LOGIC_ROLLOVER_CANCEL":
        if (!isTrustedChatSender(sender)) throw new Error("Untrusted rollover request.");
        return cancelLogicRollover(request, sender);

      case "HA_SAVE_SETTINGS":
        if (!isTrustedExtensionPage(sender)) throw new Error("Untrusted settings request.");
        return saveConfig(request.settings || {});

      case "HA_FORGET_SETTINGS":
        if (!isTrustedExtensionPage(sender)) throw new Error("Untrusted settings request.");
        return forgetConfig();

      case "HA_TEST_CONNECTION":
        if (!isTrustedExtensionPage(sender)) throw new Error("Untrusted test request.");
        return testConnection();

      case "HA_TEST_NOTIFICATION":
        if (!isTrustedExtensionPage(sender)) throw new Error("Untrusted test request.");
        return sendTestNotification();

      case "HA_NOTIFY_USER_INPUT":
        if (!isTrustedChatSender(sender)) throw new Error("Untrusted notification request.");
        if (typeof DashboardWorker !== "undefined") void DashboardWorker.notification(request, sender.tab).catch(console.warn);
        if (!config.enabled) return { ok: true, enabled: false };
        return sendUserInputNotification(request, sender);

      case "HA_NOTIFY_ROLLOVER_FAILURE":
        if (!isTrustedChatSender(sender)) throw new Error("Untrusted notification request.");
        if (typeof DashboardWorker !== "undefined") void DashboardWorker.notification(request, sender.tab).catch(console.warn);
        if (!config.enabled) return { ok: true, enabled: false };
        return sendRolloverFailureNotification(request, sender);

      case "HA_NOTIFY_ERROR":
        if (!isTrustedChatSender(sender)) throw new Error("Untrusted notification request.");
        if (typeof DashboardWorker !== "undefined") void DashboardWorker.notification(request, sender.tab).catch(console.warn);
        if (!config.enabled) return { ok: true, enabled: false };
        return sendErrorNotification(request, sender);

      case "HA_CANCEL_REQUEST":
        if (!isTrustedChatSender(sender)) throw new Error("Untrusted cancellation request.");
        return cancelPendingRequest(request, sender);

      default:
        return null;
    }
  })().then(
    (result) => sendResponse(result),
    (error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Extension background operation failed."
    })
  );
  return true;
});

function reinitialize() {
  initializationPromise = startInitialization();
}

chrome.runtime.onStartup.addListener(reinitialize);
chrome.runtime.onInstalled.addListener(reinitialize);
