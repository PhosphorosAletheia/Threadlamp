/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
const messageInput = document.querySelector("#message");
const limitInput = document.querySelector("#limit");
const form = document.querySelector("#controls");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const logicStartButton = document.querySelector("#logic-start");
const logicResumeButton = document.querySelector("#logic-resume");
const logicStopButton = document.querySelector("#logic-stop");
const projectRolloverInput = document.querySelector("#project-rollover");
const userInputSoundInput = document.querySelector("#user-input-sound");
const testSoundButton = document.querySelector("#test-sound");
const statusTitle = document.querySelector("#status-title");
const statusDetail = document.querySelector("#status-detail");
const statusCount = document.querySelector("#count");
const statusDot = document.querySelector("#dot");
const haBadge = document.querySelector("#ha-badge");
const haSummary = document.querySelector("#ha-summary");
const haOpenSettingsButton = document.querySelector("#ha-open-settings");

let pollTimer;
let haPollTimer;

document.querySelector("#open-dashboard")?.addEventListener("click", async () => {
  const url = chrome.runtime.getURL("dashboard.html");
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else await chrome.tabs.create({ url });
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isChatGptUrl(url = "") {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "chatgpt.com" || hostname === "chat.openai.com";
  } catch {
    return false;
  }
}

async function sendToPage(payload) {
  const tab = await getActiveTab();
  if (!Number.isInteger(tab?.id) || !isChatGptUrl(tab.url)) {
    throw new Error("Open a chat at chatgpt.com first.");
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, payload);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["server-link.js", "content.js"]
      });
      return await chrome.tabs.sendMessage(tab.id, payload);
    } catch {
      throw new Error("The extension could not attach to this ChatGPT tab. Reload the page, then try again.");
    }
  }
}

async function sendToBackground(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (response?.ok === false) throw new Error(response.error || "Home Assistant operation failed.");
  return response;
}

function renderHomeAssistantSettings(settings) {
  if (!settings) return;

  const phase = settings.connection?.phase || "disabled";
  if (!settings.tokenSaved) haBadge.textContent = "Not configured";
  else if (!settings.enabled) haBadge.textContent = "Disabled";
  else if (phase === "connected") haBadge.textContent = "Connected";
  else if (phase === "connecting") haBadge.textContent = "Connecting";
  else haBadge.textContent = "Needs attention";

  haSummary.textContent = settings.connection?.detail
    || "Configure phone notifications in a tab that stays open.";
}

async function refreshHomeAssistantSettings() {
  try {
    const settings = await sendToBackground({ type: "HA_GET_SETTINGS" });
    renderHomeAssistantSettings(settings);
  } catch (error) {
    haBadge.textContent = "Needs attention";
    haSummary.textContent = error.message;
  }
}

function renderStatus(status) {
  const running = Boolean(status?.running);
  const hasError = Boolean(status?.error);
  const mode = status?.mode || (running ? "loop" : "idle");
  const logicPhase = status?.logicPhase || "idle";
  const paused = Boolean(status?.paused);

  if (hasError) statusTitle.textContent = "Needs attention";
  else if (mode === "setup") statusTitle.textContent = "Server setup";
  else if (mode === "logic" && paused) statusTitle.textContent = "Logic paused";
  else if (mode === "logic" && logicPhase === "waiting_user") statusTitle.textContent = "Logic paused";
  else if (mode === "logic" && logicPhase === "waiting_external") statusTitle.textContent = "External wait";
  else if (mode === "logic" && logicPhase === "sleeping") statusTitle.textContent = "Sleeping";
  else if (mode === "logic" && !running && logicPhase === "idle") statusTitle.textContent = "Logic idle";
  else if (mode === "logic" && logicPhase === "rolling_over") statusTitle.textContent = "Opening project chat";
  else if (mode === "logic" && logicPhase === "resuming") statusTitle.textContent = "Resuming logic";
  else if (mode === "logic" && logicPhase === "stopping") statusTitle.textContent = "Stopping logic";
  else if (mode === "logic") statusTitle.textContent = "Logic mode";
  else statusTitle.textContent = running ? "Running" : "Stopped";
  if (!paused && logicPhase === "waiting_external" && Number.isFinite(status?.waitUntil)) {
    const totalSeconds = Math.max(0, Math.ceil((status.waitUntil - Date.now()) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    const scheduledTime = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(status.waitUntil);
    const requestedWait = Number.isInteger(status?.waitMinutes)
      ? ` Requested wait: ${status.waitMinutes} minute${status.waitMinutes === 1 ? "" : "s"}.`
      : "";
    statusDetail.textContent = `External operation running.${requestedWait} Status at ${scheduledTime} (${minutes}:${seconds} remaining).`;
  } else {
    statusDetail.textContent = status?.detail || "Ready.";
  }
  statusCount.textContent = `${status?.count ?? 0} / ${status?.limit ?? 0}`;

  statusDot.className = "dot";
  if (hasError) statusDot.classList.add("error");
  else if (running) statusDot.classList.add("running");

  startButton.disabled = running;
  stopButton.disabled = !["loop", "setup"].includes(mode) || !running;
  logicStartButton.disabled = running;
  logicResumeButton.disabled = running;
  logicStopButton.disabled = mode !== "logic" || logicPhase === "stopping";
  messageInput.disabled = running;
  limitInput.disabled = running;
  projectRolloverInput.disabled = running;
}

function readConfiguration() {
  const message = messageInput.value.trim();
  const limit = Number.parseInt(limitInput.value, 10);

  if (!message) throw new Error("Enter a message to repeat.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Choose a limit from 1 to 1000.");
  }

  return { message, limit, rolloverEnabled: projectRolloverInput.checked };
}

async function refreshStatus() {
  try {
    const status = await sendToPage({ type: "GET_STATUS" });
    renderStatus(status);
  } catch (error) {
    renderStatus({ error: true, detail: error.message, count: 0, limit: 0 });
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  let configuration;
  try {
    configuration = readConfiguration();
  } catch (error) {
    renderStatus({ error: true, detail: error.message, count: 0, limit: 0 });
    return;
  }

  const { message, limit, rolloverEnabled } = configuration;

  await chrome.storage.local.set({ message, limit, rolloverEnabled });

  try {
    const status = await sendToPage({ type: "START", message, limit });
    renderStatus(status);
  } catch (error) {
    renderStatus({ error: true, detail: error.message, count: 0, limit });
  }
});

logicStartButton.addEventListener("click", async () => {
  let configuration;
  try {
    configuration = readConfiguration();
  } catch (error) {
    renderStatus({ error: true, detail: error.message, count: 0, limit: 0 });
    return;
  }

  const { message, limit, rolloverEnabled } = configuration;
  await chrome.storage.local.set({ message, limit, rolloverEnabled });

  try {
    const status = await sendToPage({
      type: "START_LOGIC",
      message,
      limit,
      rolloverEnabled
    });
    renderStatus(status);
  } catch (error) {
    renderStatus({ error: true, detail: error.message, count: 0, limit });
  }
});

logicResumeButton.addEventListener("click", async () => {
  let configuration;
  try {
    configuration = readConfiguration();
  } catch (error) {
    renderStatus({ error: true, detail: error.message, count: 0, limit: 0 });
    return;
  }

  const { message, limit, rolloverEnabled } = configuration;
  await chrome.storage.local.set({ message, limit, rolloverEnabled });

  try {
    const status = await sendToPage({
      type: "RESUME_LOGIC",
      message,
      limit,
      rolloverEnabled
    });
    renderStatus(status);
  } catch (error) {
    renderStatus({ error: true, detail: error.message, count: 0, limit });
  }
});

logicStopButton.addEventListener("click", async () => {
  try {
    const status = await sendToPage({ type: "STOP_LOGIC" });
    renderStatus(status);
  } catch (error) {
    renderStatus({ error: true, detail: error.message, count: 0, limit: 0 });
  }
});

haOpenSettingsButton.addEventListener("click", async () => {
  try {
    await chrome.runtime.openOptionsPage();
    window.close();
  } catch (error) {
    haBadge.textContent = "Needs attention";
    haSummary.textContent = error instanceof Error
      ? error.message
      : "Could not open the settings tab.";
  }
});

userInputSoundInput.addEventListener("change", async () => {
  userInputSoundInput.disabled = true;
  try {
    const settings = await sendToBackground({
      type: "ALERT_SET_SETTINGS",
      settings: { soundEnabled: userInputSoundInput.checked }
    });
    userInputSoundInput.checked = settings.soundEnabled !== false;
  } catch (error) {
    renderStatus({ error: true, detail: error.message, count: 0, limit: 0 });
  } finally {
    userInputSoundInput.disabled = false;
  }
});

testSoundButton.addEventListener("click", async () => {
  testSoundButton.disabled = true;
  try {
    await sendToBackground({ type: "ALERT_TEST_SOUND" });
  } catch (error) {
    renderStatus({ error: true, detail: error.message, count: 0, limit: 0 });
  } finally {
    testSoundButton.disabled = false;
  }
});

stopButton.addEventListener("click", async () => {
  try {
    const status = await sendToPage({ type: "STOP" });
    renderStatus(status);
  } catch (error) {
    renderStatus({ error: true, detail: error.message, count: 0, limit: 0 });
  }
});

projectRolloverInput.addEventListener("change", async () => {
  await chrome.storage.local.set({ rolloverEnabled: projectRolloverInput.checked });
});

async function initialize() {
  const saved = await chrome.storage.local.get({
    message: "Continue",
    limit: 5,
    rolloverEnabled: true
  });
  messageInput.value = saved.message;
  limitInput.value = saved.limit;
  projectRolloverInput.checked = saved.rolloverEnabled !== false;
  const [, , alertSettings] = await Promise.all([
    refreshStatus(),
    refreshHomeAssistantSettings(),
    sendToBackground({ type: "ALERT_GET_SETTINGS" })
  ]);
  userInputSoundInput.checked = alertSettings.soundEnabled !== false;
  pollTimer = window.setInterval(refreshStatus, 750);
  haPollTimer = window.setInterval(refreshHomeAssistantSettings, 2000);
}

window.addEventListener("unload", () => {
  window.clearInterval(pollTimer);
  window.clearInterval(haPollTimer);
});
initialize();
