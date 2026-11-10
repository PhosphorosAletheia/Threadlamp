/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";

(() => {
  const FORMAT = "chatgpt-continue-loop-settings-backup";
  const VERSION = 1;
  const PBKDF2_ITERATIONS = 310000;
  const MAX_BACKUP_BYTES = 256 * 1024;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value, label) {
    if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new Error(`The backup has an invalid ${label}.`);
    }
    let binary;
    try {
      binary = atob(value);
    } catch {
      throw new Error(`The backup has an invalid ${label}.`);
    }
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function validatePassphrase(passphrase, minimumLength = 1) {
    if (typeof passphrase !== "string" || passphrase.length < minimumLength) {
      throw new Error(
        minimumLength > 1
          ? `Use a backup passphrase with at least ${minimumLength} characters.`
          : "Enter the backup passphrase."
      );
    }
  }

  async function deriveKey(passphrase, salt, iterations) {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function additionalData() {
    return encoder.encode(`${FORMAT}:${VERSION}`);
  }

  async function encryptSnapshot(snapshot, passphrase) {
    validatePassphrase(passphrase, 12);
    const plaintext = encoder.encode(JSON.stringify(snapshot));
    if (plaintext.byteLength > MAX_BACKUP_BYTES) {
      throw new Error("The settings snapshot is unexpectedly large and was not exported.");
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: additionalData() },
      key,
      plaintext
    );

    return {
      format: FORMAT,
      version: VERSION,
      createdAt: new Date().toISOString(),
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: PBKDF2_ITERATIONS,
        salt: bytesToBase64(salt)
      },
      cipher: {
        name: "AES-GCM",
        iv: bytesToBase64(iv),
        data: bytesToBase64(new Uint8Array(encrypted))
      }
    };
  }

  function validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new Error("The selected file is not a settings backup.");
    }
    if (envelope.format !== FORMAT || envelope.version !== VERSION) {
      throw new Error("This settings backup format or version is not supported.");
    }
    if (
      envelope.kdf?.name !== "PBKDF2"
      || envelope.kdf?.hash !== "SHA-256"
      || envelope.kdf?.iterations !== PBKDF2_ITERATIONS
      || envelope.cipher?.name !== "AES-GCM"
    ) {
      throw new Error("The settings backup uses unsupported encryption parameters.");
    }

    const salt = base64ToBytes(envelope.kdf.salt, "encryption salt");
    const iv = base64ToBytes(envelope.cipher.iv, "encryption IV");
    const data = base64ToBytes(envelope.cipher.data, "encrypted payload");
    if (salt.byteLength !== 16 || iv.byteLength !== 12 || data.byteLength < 17) {
      throw new Error("The encrypted settings backup is incomplete or damaged.");
    }
    if (data.byteLength > MAX_BACKUP_BYTES + 16) {
      throw new Error("The encrypted settings backup is too large.");
    }
    return { salt, iv, data };
  }

  async function decryptBackup(envelope, passphrase) {
    validatePassphrase(passphrase);
    const { salt, iv, data } = validateEnvelope(envelope);
    const key = await deriveKey(passphrase, salt, envelope.kdf.iterations);

    let decrypted;
    try {
      decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: additionalData() },
        key,
        data
      );
    } catch {
      throw new Error("The backup could not be decrypted. Check the passphrase and file.");
    }

    let snapshot;
    try {
      snapshot = JSON.parse(decoder.decode(decrypted));
    } catch {
      throw new Error("The decrypted settings backup is damaged.");
    }
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("The decrypted file does not contain a settings snapshot.");
    }
    return snapshot;
  }

  globalThis.SettingsBackup = Object.freeze({
    FORMAT,
    VERSION,
    MAX_BACKUP_BYTES,
    encryptSnapshot,
    decryptBackup,
    validateEnvelope
  });
})();
