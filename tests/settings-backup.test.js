/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { TextDecoder, TextEncoder } = require("node:util");

const root = path.resolve(__dirname, "..");

function storageArea() {
  const values = {};
  return {
    values,
    async get(keys) {
      if (typeof keys === "string") return { [keys]: values[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, values[key]]));
      }
      return { ...(keys || {}), ...values };
    },
    async set(update) {
      Object.assign(values, update);
    },
    async remove(key) {
      delete values[key];
    },
    async setAccessLevel() {}
  };
}

function cryptoHarness() {
  const context = {
    __test: {},
    crypto: webcrypto,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Date,
    JSON,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    atob: (value) => Buffer.from(value, "base64").toString("binary")
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(root, "settings-backup.js"), "utf8"),
    context,
    { filename: "settings-backup.js" }
  );
  return context.SettingsBackup;
}

async function backgroundHarness() {
  const local = storageArea();
  const session = storageArea();
  let permissionGranted = true;
  const removedOrigins = [];
  const context = {
    __test: {},
    console,
    URL,
    Date,
    Promise,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({}),
      text: async () => ""
    }),
    chrome: {
      runtime: {
        id: "extension-test-id",
        getManifest: () => ({ version: "1.5.9" }),
        getURL: (value) => `chrome-extension://extension-test-id/${value}`,
        getContexts: async () => [],
        onMessage: { addListener() {} },
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} },
        sendMessage: async () => ({ ok: true })
      },
      storage: { local, session },
      permissions: {
        contains: async () => permissionGranted,
        remove: async ({ origins }) => {
          removedOrigins.push(...origins);
          return true;
        }
      },
      offscreen: { createDocument: async () => {} },
      tabs: { sendMessage: async () => ({ accepted: true }) }
    }
  };

  vm.createContext(context);
  const source = `${fs.readFileSync(path.join(root, "background.js"), "utf8")}
    Object.assign(globalThis.__test, {
      exportSettingsSnapshot,
      normalizeSettingsSnapshot,
      validateSettingsSnapshotForImport,
      importSettingsSnapshot,
      setConfigForTest(value) { config = { ...defaultConfig(), ...value }; },
      setAlertSettingsForTest(value) { alertSettings = { ...value }; },
      getConfigForTest() { return { ...config }; }
    });`;
  vm.runInContext(source, context, { filename: "background.js" });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    api: context.__test,
    local,
    removedOrigins,
    setPermission(value) {
      permissionGranted = value;
    }
  };
}

async function testEncryptedRoundTrip() {
  const backup = cryptoHarness();
  const passphrase = "correct horse battery staple";
  const snapshot = {
    schemaVersion: 1,
    homeAssistant: {
      token: "secret-token-that-must-not-appear-in-plaintext"
    },
    loop: { message: "Continue", limit: 7 }
  };

  const encrypted = await backup.encryptSnapshot(snapshot, passphrase);
  assert.equal(encrypted.format, "chatgpt-continue-loop-settings-backup");
  assert.equal(encrypted.version, 1);
  assert.equal(JSON.stringify(encrypted).includes(snapshot.homeAssistant.token), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await backup.decryptBackup(encrypted, passphrase))),
    snapshot
  );

  await assert.rejects(
    () => backup.decryptBackup(encrypted, "wrong passphrase"),
    /could not be decrypted/
  );

  const tampered = JSON.parse(JSON.stringify(encrypted));
  const finalCharacter = tampered.cipher.data.at(-1);
  tampered.cipher.data = `${tampered.cipher.data.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;
  await assert.rejects(
    () => backup.decryptBackup(tampered, passphrase),
    /could not be decrypted/
  );

  await assert.rejects(
    () => backup.encryptSnapshot(snapshot, "too short"),
    /at least 12 characters/
  );
}

async function testSnapshotValidationAndRestore() {
  const harness = await backgroundHarness();
  const { api, local } = harness;
  api.setConfigForTest({
    enabled: false,
    baseUrl: "https://home-assistant.example",
    notifyAction: "notify.mobile_app_test_phone",
    approvalMessage: "Approved. Continue.",
    persistent: true,
    token: "test-token"
  });
  api.setAlertSettingsForTest({ soundEnabled: false });
  await local.set({ message: "Status", limit: 12, rolloverEnabled: false });

  const snapshot = await api.exportSettingsSnapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.extensionVersion, "1.5.9");
  assert.equal(snapshot.homeAssistant.token, "test-token");
  assert.equal(snapshot.workstationAlert.soundEnabled, false);
  assert.equal(snapshot.loop.message, "Status");
  assert.equal(snapshot.loop.limit, 12);
  assert.equal(snapshot.loop.rolloverEnabled, false);

  const validation = api.validateSettingsSnapshotForImport(snapshot);
  assert.equal(validation.homeAssistantBaseUrl, "https://home-assistant.example");
  assert.equal(validation.homeAssistantConfigured, true);
  assert.equal("token" in validation, false);

  api.setConfigForTest({});
  api.setAlertSettingsForTest({ soundEnabled: true });
  await local.set({ message: "Changed", limit: 1, rolloverEnabled: true });
  const result = await api.importSettingsSnapshot(snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.homeAssistant.tokenSaved, true);
  assert.equal("token" in result.homeAssistant, false);
  assert.equal(local.values.homeAssistantConfig.token, "test-token");
  assert.equal(local.values.workstationAlertSettings.soundEnabled, false);
  assert.equal(local.values.message, "Status");
  assert.equal(local.values.limit, 12);
  assert.equal(local.values.rolloverEnabled, false);

  const invalid = JSON.parse(JSON.stringify(snapshot));
  invalid.loop.limit = 0;
  await assert.rejects(
    () => api.importSettingsSnapshot(invalid),
    /repeat limit/
  );
  assert.equal(local.values.limit, 12, "invalid import must not change saved settings");

  const invalidType = JSON.parse(JSON.stringify(snapshot));
  invalidType.workstationAlert.soundEnabled = "false";
  await assert.rejects(
    () => api.importSettingsSnapshot(invalidType),
    /workstation alert settings/
  );
  assert.equal(local.values.workstationAlertSettings.soundEnabled, false);

  harness.setPermission(false);
  await assert.rejects(
    () => api.importSettingsSnapshot(snapshot),
    /permission was not granted/
  );
  assert.equal(local.values.homeAssistantConfig.token, "test-token");
}

(async () => {
  await testEncryptedRoundTrip();
  await testSnapshotValidationAndRestore();
  console.log("settings backup tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
