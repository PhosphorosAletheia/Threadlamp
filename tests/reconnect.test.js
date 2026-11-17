/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { harness, sourceUrl } = require("./heartbeat.test.js");
const { contentHarness } = require("./rollover.test.js");
(async () => {
  const h = await harness();
  const sender = { id: "test-extension", frameId: 0, url: sourceUrl, tab: h.tabs.get(17) };
  const settings = { message: "Continue", limit: 5, count: 3, userHash: "a".repeat(64), rolloverEnabled: true, verifiedUser: true };
  const req = (type, extra = {}) => ({ type: `LR_${type}`, instanceId: "old-page", url: sourceUrl, token: "run-1", settings, ...extra });
  const liveInstanceId = contentHarness().api.heartbeatIdentity().instanceId;
  assert.match(liveInstanceId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  for (const instanceId of [liveInstanceId, "1790000000000-0.123456789", "1790000000000-1e-7"]) {
    const token = `${instanceId}:1`;
    assert.equal((await h.dispatch(req("SAVE", {instanceId,token}),sender)).ok,true,
      "real content IDs and pre-update IDs must save a reconnection checkpoint");
    assert.equal((await h.dispatch(req("PREPARE", {instanceId,token}),sender)).ok,true);
    const nextInstanceId=contentHarness().api.heartbeatIdentity().instanceId;
    assert.ok((await h.dispatch(req("CLAIM", {instanceId:nextInstanceId}),sender)).record);
    await h.dispatch(req("CLEAR", {instanceId:nextInstanceId}),sender);
  }
  for (const instanceId of ["", "a".repeat(151), "page/name", "page\nname", "page name"]) {
    assert.equal((await h.dispatch(req("SAVE", {instanceId}),sender)).ok,false);
    assert.equal((await h.dispatch(req("SAVE", {token:instanceId}),sender)).ok,false);
  }
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
  // Failed conversation loads have their own bounded retry budget. The
  // checkpoint is carried across reloads without trusting replacement settings.
  h.setNow(Date.parse("2026-10-16T14:20:00Z"));
  await h.dispatch(req("SAVE"), sender); await h.dispatch(req("PREPARE"), sender);
  assert.equal((await h.dispatch(req("RETRY_LOAD"), sender)).ok, false, "the old page cannot retry before a claim");
  for (let n = 1; n <= 4; n++) {
    const instanceId = `load-page-${n}`;
    const claimed = await h.dispatch(req("CLAIM", {instanceId}), sender);
    assert.equal(claimed.record.requested, true);
    assert.equal(claimed.record.loadRetries, n - 1);
    assert.equal((await h.dispatch(req("RETRY_LOAD", {instanceId,token:"wrong-run"}), sender)).ok,false);
    const retry = await h.dispatch(req("RETRY_LOAD", {instanceId,settings:{...settings,userHash:"b".repeat(64)}}), sender);
    assert.equal(retry.ok,true,retry.error); assert.equal(retry.loadRetries,n);
    assert.equal(h.session.values.logicReconnectCheckpoints[17].settings.userHash,settings.userHash);
    assert.equal((await h.dispatch(req("RETRY_LOAD", {instanceId}),sender)).ok,false,"cannot schedule duplicate reloads");
  }
  await h.dispatch(req("CLAIM",{instanceId:"load-page-5"}),sender);
  const exhausted=await h.dispatch(req("RETRY_LOAD",{instanceId:"load-page-5"}),sender);
  assert.equal(exhausted.ok,false);assert.match(exhausted.error,/retry or ten-minute limit/);
  await h.dispatch(req("SAVE",{instanceId:"load-page-5"}),sender);
  assert.equal(h.session.values.logicReconnectCheckpoints[17].loadRetries,4,"checkpoint refresh preserves retry budget");
  await h.dispatch(req("CLEAR",{instanceId:"load-page-5"}),sender);
  await h.dispatch(req("SAVE"),sender); await h.dispatch(req("PREPARE"),sender);
  h.setNow(Date.parse("2026-10-16T14:29:00Z"));
  await h.dispatch(req("CLAIM",{instanceId:"slow-load"}),sender);
  h.setNow(Date.parse("2026-10-16T14:30:01Z"));
  const expired=await h.dispatch(req("RETRY_LOAD",{instanceId:"slow-load"}),sender);
  assert.equal(expired.ok,false);assert.match(expired.error,/ten-minute limit/,"claiming a page must not extend the total deadline");
  console.log("reconnection worker: sender, tab and chat binding, durable single claim, reload budget, cancellation and expiry passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
