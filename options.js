/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";

const form = document.querySelector("#ha-controls");
const enabledInput = document.querySelector("#ha-enabled");
const urlInput = document.querySelector("#ha-url");
const notifyActionInput = document.querySelector("#ha-notify-action");
const tokenInput = document.querySelector("#ha-token");
const tokenState = document.querySelector("#ha-token-state");
const approvalMessageInput = document.querySelector("#ha-approval-message");
const persistentInput = document.querySelector("#ha-persistent");
const badge = document.querySelector("#ha-badge");
const status = document.querySelector("#ha-status");
const testConnectionButton = document.querySelector("#ha-test-connection");
const testNotificationButton = document.querySelector("#ha-test-notification");
const forgetButton = document.querySelector("#ha-forget");
const backupPassphraseInput = document.querySelector("#backup-passphrase");
const backupConfirmInput = document.querySelector("#backup-confirm");
const backupFileInput = document.querySelector("#backup-file");
const backupExportButton = document.querySelector("#backup-export");
const backupImportButton = document.querySelector("#backup-import");
const backupStatus = document.querySelector("#backup-status");

let tokenSaved = false;
let pollTimer;
let pendingImport = null;

async function sendToBackground(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (response?.ok === false) {
    throw new Error(response.error || "Home Assistant operation failed.");
  }
  return response;
}

function normalizeOrigin(value) {
  const url = new URL(String(value || "").trim());
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("Home Assistant URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Do not include credentials in the Home Assistant URL.");
  }
  return url.origin;
}

function originPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.host}/*`;
}

function setStatus(detail, kind = "") {
  status.textContent = detail;
  status.className = kind;
}

function setBackupStatus(detail, kind = "") {
  backupStatus.textContent = detail;
  backupStatus.className = kind;
}

function setBackupBusy(busy) {
  backupExportButton.disabled = busy;
  backupImportButton.disabled = busy;
  backupPassphraseInput.disabled = busy;
  backupConfirmInput.disabled = busy;
  backupFileInput.disabled = busy;
}

function clearBackupSecrets(clearFile = false) {
  backupPassphraseInput.value = "";
  backupConfirmInput.value = "";
  if (clearFile) backupFileInput.value = "";
}

function resetPendingImport() {
  pendingImport = null;
  backupImportButton.textContent = "Unlock encrypted backup";
}

function backupFilename() {
  const date = new Date().toISOString().slice(0, 10);
  return `chatgpt-continue-loop-settings-${date}.encrypted.json`;
}

function downloadJson(documentValue, filename) {
  const blob = new Blob([`${JSON.stringify(documentValue, null, 2)}\n`], {
    type: "application/json"
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function renderSettings(settings, populate = false) {
  if (!settings) return;

  tokenSaved = Boolean(settings.tokenSaved);
  tokenState.textContent = tokenSaved
    ? "Token saved locally. Leave this field blank to keep it, or enter a replacement."
    : "No token saved. Enter the token here only; never paste it into ChatGPT.";
  tokenInput.placeholder = tokenSaved
    ? "Saved — enter a replacement only"
    : "Enter access token";

  if (populate) {
    enabledInput.checked = Boolean(settings.enabled);
    urlInput.value = settings.baseUrl || "";
    notifyActionInput.value = settings.notifyAction || "";
    approvalMessageInput.value = settings.approvalMessage
      || "Approved. Continue with the current task.";
    persistentInput.checked = settings.persistent !== false;
    tokenInput.value = "";
  }

  const phase = settings.connection?.phase || "disabled";
  if (!tokenSaved) badge.textContent = "Not configured";
  else if (!settings.enabled) badge.textContent = "Disabled";
  else if (phase === "connected") badge.textContent = "Connected";
  else if (phase === "connecting") badge.textContent = "Connecting";
  else badge.textContent = "Needs attention";

  const configured = Boolean(settings.baseUrl && settings.notifyAction && tokenSaved);
  const hasSavedSettings = Boolean(settings.baseUrl || settings.notifyAction || tokenSaved);
  testConnectionButton.disabled = !configured || !settings.enabled;
  testNotificationButton.disabled = !configured || !settings.enabled;
  forgetButton.disabled = !hasSavedSettings;

  if (settings.connection?.detail) {
    setStatus(
      settings.connection.detail,
      phase === "connected"
        ? "success"
        : ["error", "auth_error"].includes(phase) ? "error" : ""
    );
  }
}

async function refreshSettings(populate = false) {
  try {
    const settings = await sendToBackground({ type: "HA_GET_SETTINGS" });
    renderSettings(settings, populate);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  let baseUrl;
  try {
    baseUrl = normalizeOrigin(urlInput.value);
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }

  const notifyAction = notifyActionInput.value.trim().toLowerCase();
  if (!/^notify\.mobile_app_[a-z0-9_]+$/.test(notifyAction)) {
    setStatus("Notification action must look like notify.mobile_app_your_phone.", "error");
    return;
  }

  const approvalMessage = approvalMessageInput.value.trim();
  if (!approvalMessage) {
    setStatus("Enter the message the Approve button should send.", "error");
    return;
  }
  if (!tokenInput.value.trim() && !tokenSaved) {
    setStatus("Enter a Home Assistant access token.", "error");
    return;
  }

  setStatus("Requesting access to the Home Assistant address…");
  let granted;
  try {
    granted = await chrome.permissions.request({
      origins: [originPattern(baseUrl)]
    });
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Could not request Home Assistant access.",
      "error"
    );
    return;
  }
  if (!granted) {
    setStatus("Home Assistant site permission was not granted.", "error");
    return;
  }

  try {
    const settings = await sendToBackground({
      type: "HA_SAVE_SETTINGS",
      settings: {
        enabled: enabledInput.checked,
        baseUrl,
        notifyAction,
        token: tokenInput.value.trim(),
        approvalMessage,
        persistent: persistentInput.checked
      }
    });
    urlInput.value = baseUrl;
    tokenInput.value = "";
    renderSettings(settings, true);
    setStatus("Home Assistant settings saved locally.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

testConnectionButton.addEventListener("click", async () => {
  setStatus("Testing the Home Assistant API…");
  try {
    const result = await sendToBackground({ type: "HA_TEST_CONNECTION" });
    setStatus(result.detail, "success");
    window.setTimeout(() => void refreshSettings(), 500);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

testNotificationButton.addEventListener("click", async () => {
  setStatus("Sending a test notification…");
  try {
    const result = await sendToBackground({ type: "HA_TEST_NOTIFICATION" });
    setStatus(result.detail, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

forgetButton.addEventListener("click", async () => {
  if (!window.confirm("Forget the saved Home Assistant URL, action, and access token?")) return;
  try {
    const settings = await sendToBackground({ type: "HA_FORGET_SETTINGS" });
    renderSettings(settings, true);
    setStatus("Home Assistant settings removed.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

backupExportButton.addEventListener("click", async () => {
  const passphrase = backupPassphraseInput.value;
  if (passphrase.length < 12) {
    setBackupStatus("Use a backup passphrase with at least 12 characters.", "error");
    return;
  }
  if (passphrase !== backupConfirmInput.value) {
    setBackupStatus("The backup passphrases do not match.", "error");
    return;
  }

  setBackupBusy(true);
  setBackupStatus("Encrypting the saved extension settings…");
  try {
    const snapshot = await sendToBackground({ type: "SETTINGS_EXPORT_SNAPSHOT" });
    const encrypted = await SettingsBackup.encryptSnapshot(snapshot, passphrase);
    downloadJson(encrypted, backupFilename());
    clearBackupSecrets();
    setBackupStatus(
      "Encrypted backup downloaded. Keep the file and its passphrase in separate safe places.",
      "success"
    );
  } catch (error) {
    setBackupStatus(error.message || "The encrypted backup could not be created.", "error");
  } finally {
    setBackupBusy(false);
  }
});

backupImportButton.addEventListener("click", async () => {
  if (pendingImport) {
    setBackupBusy(true);
    setBackupStatus("Restoring the validated settings backup…");
    try {
      if (pendingImport.homeAssistantBaseUrl) {
        const granted = await chrome.permissions.request({
          origins: [originPattern(pendingImport.homeAssistantBaseUrl)]
        });
        if (!granted) {
          throw new Error("Home Assistant site permission was not granted; no settings were imported.");
        }
      }

      const result = await sendToBackground({
        type: "SETTINGS_IMPORT_SNAPSHOT",
        snapshot: pendingImport.snapshot
      });
      renderSettings(result.homeAssistant, true);
      clearBackupSecrets(true);
      resetPendingImport();
      setBackupStatus(
        "Settings restored. The Home Assistant token, loop options, and sound preference were imported.",
        "success"
      );
    } catch (error) {
      setBackupStatus(error.message || "The encrypted backup could not be imported.", "error");
    } finally {
      setBackupBusy(false);
    }
    return;
  }

  const file = backupFileInput.files?.[0];
  const passphrase = backupPassphraseInput.value;
  if (!file) {
    setBackupStatus("Select an encrypted settings backup file.", "error");
    return;
  }
  if (!passphrase) {
    setBackupStatus("Enter the passphrase used to create this backup.", "error");
    return;
  }
  const maximumFileBytes = Math.ceil(SettingsBackup.MAX_BACKUP_BYTES * 1.5) + 4096;
  if (file.size > maximumFileBytes) {
    setBackupStatus("The selected backup file is unexpectedly large.", "error");
    return;
  }
  setBackupBusy(true);
  setBackupStatus("Decrypting and validating the settings backup…");
  try {
    let envelope;
    try {
      envelope = JSON.parse(await file.text());
    } catch {
      throw new Error("The selected file is not valid JSON.");
    }
    const snapshot = await SettingsBackup.decryptBackup(envelope, passphrase);

    const validation = await sendToBackground({
      type: "SETTINGS_VALIDATE_SNAPSHOT",
      snapshot
    });

    const importedBaseUrl = String(validation.homeAssistantBaseUrl || "").trim();
    pendingImport = {
      snapshot,
      homeAssistantBaseUrl: importedBaseUrl ? normalizeOrigin(importedBaseUrl) : ""
    };
    clearBackupSecrets();
    backupImportButton.textContent = "Restore unlocked settings";
    setBackupStatus(
      "Backup unlocked and validated. Select Restore unlocked settings to replace the current settings.",
      "success"
    );
  } catch (error) {
    setBackupStatus(error.message || "The encrypted backup could not be imported.", "error");
  } finally {
    setBackupBusy(false);
  }
});

backupPassphraseInput.addEventListener("input", () => {
  if (pendingImport) resetPendingImport();
});

backupFileInput.addEventListener("change", () => {
  if (pendingImport) resetPendingImport();
});

window.addEventListener("unload", () => window.clearInterval(pollTimer));

void (async () => {
  await refreshSettings(true);
  pollTimer = window.setInterval(refreshSettings, 2000);
})();
