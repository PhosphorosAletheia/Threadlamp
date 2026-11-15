/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const schema = require("../diagnostics-schema.js");
async function saveReport(directory, report) {
  const text = JSON.stringify(schema.report(report)) + "\n";
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Diagnostic report is too large.");
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Diagnostic directory must be private.");
  const temporary = path.join(directory, ".report-" + crypto.randomUUID() + ".tmp");
  try {
    await fs.writeFile(temporary, text, {flag:"wx", mode:0o600});
    await fs.rename(temporary, path.join(directory, "latest.json"));
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
module.exports = {saveReport};
