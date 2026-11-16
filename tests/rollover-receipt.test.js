/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, sourceUrl } = require("./heartbeat.test.js");
const { fixture } = require("./delivery-timeout.test.js");
const { visibleElement } = require("./rollover.test.js");
const schema = require("../diagnostics-schema.js");
const project = new URL(sourceUrl).pathname.split("/")[2];
const home = `https://chatgpt.com/g/${project}/project`;
const temporary = `https://chatgpt.com/g/${project}/c/local-chatgpt%3Atemporary`;
const saved = `https://chatgpt.com/g/${project}/c/saved-destination`;

async function run(scenario) {
  const h = await harness();
  const sender = url => ({id:"test-extension", frameId:0, documentId:"document-A", documentLifecycle:"active",
    url:home, tab:{id:17,url}});
  const prepared = await h.dispatch({type:"LOGIC_ROLLOVER_PREPARE", projectSegment:project,
    previousTitle:"Original task", message:"Continue", count:0, limit:5}, {...sender(sourceUrl),url:sourceUrl});
  assert.equal(prepared.ok,true);
  h.tabs.set(17,{id:17,url:home});
  assert.ok((await h.dispatch({type:"LOGIC_ROLLOVER_CLAIM",requestId:prepared.requestId},sender(home))).pending);
  const f = fixture(["continue","idle"],{diagnosticSchema:schema});
  f.hide(); f.window.location = new URL(home);
  f.api.setTimeoutSnapshotsForTest(role => {
    if (!f.sends.length) return {element:null,text:""};
    const element = role === "user" ? f.user() : f.assistant();
    return {element,text:element.textContent};
  });
  const form = visibleElement();
  const high = visibleElement("High",{"aria-label":"Select ChatGPT model","aria-haspopup":"menu","aria-expanded":"false"});
  form.querySelectorAll = () => [high];
  f.composer.closest = selector => selector === "form" ? form : null;
  const click = f.send.click;
  f.send.click = () => {
    click();
    if (f.sends.length === 1) {
      f.window.location = new URL(scenario === "saved-to-saved" ? saved+"-first" : temporary);
      h.tabs.set(17,{id:17,url:f.window.location.href});
    }
  };
  let attempts = 0;
  h.context.chrome.scripting = {executeScript:async options => {
    assert.equal(options.target.tabId,17);
    assert.deepEqual(Array.from(options.target.documentIds),["document-A"]);
    if (attempts === 1) {
      f.window.location = new URL(scenario === "wrong-project" ? saved.replace("012345","abcdef") : saved);
      h.tabs.set(17,{id:17,url:f.window.location.href});
      if (scenario === "wrong-message") {const text=f.user().textContent;f.newUser();f.user().textContent=text;}
      if (scenario === "cancel") {f.api.state.running=false;f.api.state.runId++;}
    }
    return [{documentId:scenario === "replaced-document" ? "document-B" : "document-A", frameId:0,
      result:{url:f.window.location.href,top:true}}];
  }};
  f.setRequestHandler(async request => {
    f.requests.push(request);
    if (request.type !== "LOGIC_ROLLOVER_COMPLETE") return {ok:true,enabled:false};
    attempts++;
    if (scenario === "transport") throw new Error("Connection lost after delivery");
    if (scenario === "missing") return undefined;
    if (scenario === "receipt-failure") return {ok:false,error:"The handoff receipt no longer belongs to this chat."};
    const reply = await h.dispatch(request,sender(f.window.location.href));
    if (!reply.ok) assert.equal(reply.error,"Untrusted rollover request.");
    return reply;
  });
  await f.api.runLogicMode(1,false,"Initial continuation","Starting",{
    failureId:prepared.requestId,projectSegment:project,sourceUrl});
  return {h,f,attempts,receipt:h.session.values.logicModePendingRollovers[prepared.requestId]};
}

test("handoff confirmation recovers from a real worker route race without replaying startup",async()=>{
  const {f,attempts,receipt} = await run("route-race");
  assert.equal(attempts,2);
  assert.equal(receipt.completed,true);
  assert.equal(f.api.state.error,false);
  assert.deepEqual(f.sends,["Initial continuation","Configured followup"]);
  const retries=f.requests.filter(r=>r.type==="DG_RECORD" && r.event.event==="handoff_receipt_retry");
  assert.equal(retries.length,1);assert.equal(retries[0].event.retryAttempt,1);
});
for (const scenario of ["wrong-project","saved-to-saved","wrong-message","replaced-document","cancel","transport","missing","receipt-failure"]) {
  test(`handoff receipt preserves fail-closed behavior: ${scenario}`,async()=>{
    const {f,attempts,receipt}=await run(scenario);
    assert.equal(attempts,scenario === "replaced-document" ? 3 : 1);
    assert.equal(Boolean(receipt.completed),false);
    assert.deepEqual(f.sends,["Initial continuation"],"never resend the startup or continue after failed confirmation");
    if (scenario !== "cancel") assert.equal(f.api.state.error,true);
  });
}
