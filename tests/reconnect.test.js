/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { harness, sourceUrl } = require("./heartbeat.test.js");
(async () => {
  const h = await harness();
  const sender = { id: "test-extension", frameId: 0, url: sourceUrl, tab: h.tabs.get(17) };
  const settings = { message: "Continue", limit: 5, count: 3, userHash: "a".repeat(64), rolloverEnabled: true, verifiedUser: true };
  const req = (type, extra = {}) => ({ type: `LR_${type}`, instanceId: "old-page", url: sourceUrl, token: "run-1", settings, ...extra });
  assert.equal((await h.dispatch(req("SAVE"), { ...sender, frameId: 1 })).ok, false);
  assert.equal((await h.dispatch(req("SAVE"), { ...sender, id: "other-extension" })).ok, false);
  assert.equal((await h.dispatch(req("SAVE", { settings: { ...settings, count: 6 } }), sender)).ok, false);
  assert.equal((await h.dispatch(req("SAVE"), sender)).ok, true);
  assert.equal((await h.dispatch(req("PREPARE"), sender)).ok, true);
  assert.equal((await h.dispatch(req("PREPARE"), sender)).ok, false, "a prepared reload cannot repeat");
  assert.equal((await h.dispatch(req("CLAIM"), sender)).record, null, "the old page cannot consume its own reload");
  h.tabs.set(99, { id: 99, url: sourceUrl });
  const other = { ...sender, tab: h.tabs.get(99) };
  assert.equal((await h.dispatch(req("CLAIM", { instanceId: "other-page" }), other)).record, null, "same URL in another tab cannot claim");
  h.tabs.set(17, { id: 17, url: sourceUrl.replace("source", "different") });
  assert.equal((await h.dispatch(req("CLAIM", { instanceId: "new-page" }), sender)).ok, false, "navigation is revalidated against Chrome");
  h.tabs.set(17, sender.tab);
  const claims = await Promise.all([1, 2].map(() => h.dispatch(req("CLAIM", { instanceId: "new-page" }), sender)));
  assert.equal(claims.filter(r => r.record).length, 1, "claim is serialized and durable before returning");
  assert.equal(claims.find(r => r.record).record.settings.count, 3);
  assert.equal((await h.dispatch(req("SAVE"), sender)).ok, false, "the old page cannot replace the new page's checkpoint");
  assert.equal((await h.dispatch(req("SAVE", { instanceId: "new-page" }), sender)).ok, true);
  assert.equal((await h.dispatch(req("PREPARE", { instanceId: "new-page" }), sender)).ok, false, "reload budget survives checkpoint updates");
  await h.dispatch(req("CLEAR"), sender);
  assert.ok(h.session.values.logicReconnectCheckpoints[17], "old page cannot clear a new owner's record");
  await h.dispatch(req("CLEAR", { instanceId: "new-page" }), sender);
  assert.equal(h.session.values.logicReconnectCheckpoints[17], undefined);
  await h.dispatch(req("SAVE"), sender);
  h.setNow(Date.parse("2026-10-16T14:11:00Z"));
  assert.equal((await h.dispatch(req("CLAIM", { instanceId: "late-page" }), sender)).record, null, "expired runs are not restored");
  console.log("reconnection worker: sender, tab and chat binding, durable single claim, reload budget, cancellation and expiry passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
