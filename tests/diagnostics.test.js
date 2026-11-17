/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {webcrypto} = require("node:crypto");
const schema = require("../diagnostics-schema.js"), {saveReport} = require("../helper/diagnostics.js");
const {contentHarness, visibleElement} = require("./rollover.test.js");
test("handoff and reconnection trust failures are distinct from timeouts and missing flags",()=>{
  assert.equal(schema.reason("Untrusted rollover request."),"handoff_sender");
  assert.equal(schema.reason("Untrusted reconnection request."),"reconnect_sender");
  assert.equal(schema.reason("Logic Mode paused: found the latest assistant turn (733 characters) but no valid final flag."),"logic_flag_missing");
  assert.equal(schema.reason("Message delivery timed out. Please try again."),"delivery_timeout");
  const report=schema.snapshot({event:"handoff_receipt_retry",reason:"handoff_sender",retryAttempt:1,privateText:"SECRET"});
  assert.equal(report.event,"handoff_receipt_retry");assert.equal(report.retryAttempt,1);
  assert.equal(JSON.stringify(report).includes("SECRET"),false);
});
function worker(store = {}) {
  let listener, now = 1800000000000;
  class Clock extends Date { static now() { return now; } }
  const context = {ThreadlampDiagnosticSchema:schema, URL, TextEncoder, crypto:webcrypto, Date:Clock, initializationPromise:Promise.resolve(),
    isTrustedChatSender:async sender => sender.id === "self" && sender.tab?.url?.startsWith("https://chatgpt.com/"),
    isTrustedExtensionPage:sender => sender.id === "self" && sender.url === "chrome-extension://self/dashboard.html",
    chrome:{runtime:{getManifest:() => ({version:"1.15.0"}),onMessage:{addListener:fn => {listener=fn;}}},
      storage:{local:{get:async key => ({[key]:structuredClone(store[key])}),set:async value => Object.assign(store,structuredClone(value))}}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../diagnostics-worker.js"),"utf8"),context);
  const page = {id:"self",url:"chrome-extension://self/dashboard.html"};
  const sender = (id=1) => ({id:"self",frameId:0,tab:{id,url:`https://chatgpt.com/g/g-p-${String(id).repeat(32)}/c/private-chat-${id}`}});
  return {store, sender, advance:ms => {now+=ms;}, dispatch:(request, from=page) => new Promise(resolve => listener(request,from,resolve))};
}
const event = (name="state", extra={}) => ({type:"DG_RECORD",instance:"1800000000000-0.1234",event:{event:name,reason:"none",contentVersion:"1.14.5",...extra}});
test("diagnostics redact untrusted fields, bind sender identity, and preserve per-tab incident context across worker restarts",async()=>{
  const h=worker();
  assert.equal((await h.dispatch(event(),{id:"foreign",frameId:0,tab:{id:1,url:"https://chatgpt.com/"}})).ok,false);
  assert.equal((await h.dispatch(event(),{...h.sender(),frameId:1})).ok,false);
  assert.equal((await h.dispatch({type:"DG_EXPORT"},h.sender())).ok,false);
  const privateText="PRIVATE_PROMPT_TOKEN_TITLE";
  await h.dispatch(event("handoff_prepare",{title:privateText,token:privateText,url:privateText,mode:privateText,phase:privateText}),h.sender());
  await h.dispatch(event("send_attempt",{expectedLength:33,draftMatchesExpected:true}),h.sender(2));
  await h.dispatch(event("error",{reason:"draft_changed",draftLength:35,detail:privateText}),h.sender());
  const exported=(await h.dispatch({type:"DG_EXPORT"})).report;
  const encoded=JSON.stringify(exported);
  for(const secret of [privateText,"private-chat","https:","g-p-","1800000000000-0.1234"])assert.equal(encoded.includes(secret),false,secret);
  assert.equal(exported.incidents.length,1);assert.equal(exported.incidents[0].events.length,2);
  assert.ok(exported.incidents[0].events.every(e=>e.tabId===1));
  assert.equal(exported.events[0].contentVersion,"1.14.5");assert.equal(exported.workerVersion,"1.15.0");
  assert.match(exported.events[0].projectRef,/^[a-f0-9]{16}$/);
  assert.match(exported.events[0].instanceRef,/^[a-f0-9]{16}$/);
  assert.notEqual(exported.events[0].projectRef,exported.events[1].projectRef);
  const restarted=worker(h.store);
  assert.deepEqual(JSON.parse(JSON.stringify((await restarted.dispatch({type:"DG_EXPORT"})).report)),JSON.parse(JSON.stringify(exported)));
  await restarted.dispatch({type:"DG_SET",enabled:false});
  await restarted.dispatch(event("error"),restarted.sender());
  assert.equal((await restarted.dispatch({type:"DG_GET"})).eventCount,3);
  await restarted.dispatch({type:"DG_CLEAR"});
  assert.equal((await restarted.dispatch({type:"DG_EXPORT"})).report.events.length,0);
});
test("retention, rate limits, deduplication and incident bounds are enforced",async()=>{
  const h=worker();
  await h.dispatch(event(),h.sender());await h.dispatch(event(),h.sender());
  assert.equal((await h.dispatch({type:"DG_GET"})).eventCount,1);
  for(let i=0;i<450;i++) {h.advance(3000);await h.dispatch(event(i%10===0?"error":"state",{runId:i}),h.sender());}
  const report=(await h.dispatch({type:"DG_EXPORT"})).report;
  assert.equal(report.events.length,400);assert.equal(report.incidents.length,20);
  assert.ok(report.incidents.every(i=>i.events.length<=40));
  for(let i=0;i<140;i++)await h.dispatch(event("state",{runId:i}),h.sender());
  assert.ok((await h.dispatch({type:"DG_GET"})).dropped>0);
  h.advance(8*86400000);assert.equal((await h.dispatch({type:"DG_GET"})).eventCount,0);
  assert.equal((await h.dispatch({type:"DG_GET"})).incidentCount,0);
});
test("content captures draft structure and classifications without exporting its contents",async()=>{
  const h=contentHarness({diagnosticSchema:schema});
  const project="g-p-"+"1".repeat(32);h.window.location=new URL(`https://chatgpt.com/g/${project}/project`);
  const draft="This chat is a continuation\nSource project ID: g-p-"+"2".repeat(32)+"\nAdditional instructions from the user for this round:\nPRIVATE_QUEUED_TEXT";
  const composer=visibleElement(draft);h.setSelector("#prompt-textarea",[composer]);
  const requests=[];h.setRequestHandler(async request=>{requests.push(request);return {ok:true};});
  h.api.recordDiagnostic("handoff_claimed");
  const report=requests.find(r=>r.type==="DG_RECORD");
  assert.ok(report);assert.equal(report.event.draftLength,draft.length);
  assert.equal(report.event.draftLooksLikeHandoff,true);assert.equal(report.event.draftHasQueuedInstructions,true);
  assert.equal(report.event.draftSourceProjectMatches,false);
  assert.equal(JSON.stringify(report).includes("PRIVATE_QUEUED_TEXT"),false);
  assert.equal(JSON.stringify(report).includes("g-p-"),false);
  h.setRequestHandler(()=>Promise.reject(new Error("Extension context invalidated")));
  assert.doesNotThrow(()=>h.api.recordDiagnostic("error"));
  await new Promise(r=>setImmediate(r));
});
test("quick prompts remain sendable when diagnostic delivery fails",async()=>{
  const h=contentHarness({diagnosticSchema:schema});
  h.window.location=new URL("https://chatgpt.com/c/example");
  const composer=visibleElement("");h.setSelector("#prompt-textarea",[composer]);
  h.api.prepareThinkingSendForTest(composer);
  const send=visibleElement("Send");let clicks=0;
  send.click=()=>{clicks++;composer.innerText=composer.textContent="";};
  h.setSelector("button[data-testid='send-button']",[send]);
  h.setRequestHandler(async request=>{if(request.type==="DG_RECORD")throw new Error("Recorder unavailable");return {ok:true};});
  await h.api.sendQuickPrompt("continue");
  assert.equal(clicks,1);assert.equal(h.api.state.error,false);
});
test("helper writes only sanitized bounded reports with private permissions",async t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),"threadlamp-diagnostics-test-"));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const dir=path.join(parent,"diagnostics");
  const report={schema:1,enabled:true,generatedAt:1,events:[{event:"error",detail:"PRIVATE",url:"PRIVATE",reason:"PRIVATE"}],incidents:[],token:"PRIVATE"};
  await saveReport(dir,report);
  const file=path.join(dir,"latest.json");assert.equal(fs.statSync(dir).mode&0o777,0o700);assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.equal(fs.readFileSync(file,"utf8").includes("PRIVATE"),false);
  await saveReport(dir,{...report,events:[]});assert.equal(JSON.parse(fs.readFileSync(file)).events.length,0);
  const linked=path.join(parent,"linked");fs.symlinkSync(dir,linked);
  await assert.rejects(saveReport(linked,report),/private/);
  assert.equal(fs.readdirSync(dir).length,1);
});

test("queue failures retain only allowlisted operation and verification categories",async()=>{
  const h=worker();
  await h.dispatch(event("queue_error",{reason:"queue_storage",queueOperation:"Q_MOVE",queueFailure:"route",queueProof:"tab"}),h.sender());
  const report=(await h.dispatch({type:"DG_EXPORT"})).report;
  assert.equal(report.incidents.length,1);
  assert.equal(report.events[0].queueOperation,"Q_MOVE");
  assert.equal(report.events[0].queueFailure,"route");
  assert.equal(report.events[0].queueProof,"tab");
  const retry=schema.snapshot({event:"queue_move_retry",retryAttempt:1,queueProof:"unavailable"});
  assert.equal(retry.event,"queue_move_retry");assert.equal(retry.queueProof,"unavailable");
  assert.equal(schema.snapshot({event:"queue_error",queueOperation:"Q_MOVE",queueFailure:"ownership"}).queueFailure,"ownership");
  for(const reattachReason of ["ping_timeout","ping_failed","invalid_reply","version_changed"])
    assert.equal(schema.snapshot({event:"loaded",reattachReason}).reattachReason,reattachReason);
  assert.equal(schema.snapshot({event:"loaded",reattachReason:"PRIVATE"}).reattachReason,undefined);
  const rejected=schema.snapshot({event:"queue_error",queueOperation:"PRIVATE_URL",queueFailure:"PRIVATE_DRAFT",queueProof:"PRIVATE_ERROR"});
  assert.equal(JSON.stringify(rejected).includes("PRIVATE"),false);
});
