/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {harness,sourceUrl,popup,definition}=require("./heartbeat.test.js");
const {fixture}=require("./delivery-timeout.test.js");
const {visibleElement}=require("./rollover.test.js");
const KEY="logicUpdateCheckpoints";
const settings={active:true,mode:"logic",paused:false,error:false,phase:"monitoring",message:"Continue",limit:25,count:7,
  userHash:"a".repeat(64),assistantHash:"b".repeat(64),rolloverEnabled:true};
async function worker(initial={}) {
  let owner="first",documentId="same-browser-document";
  const h=await harness(initial,{pageHandler:async()=>({instanceId:owner,url:sourceUrl}),configureContext:c=>{
    c.chrome.scripting={executeScript:async()=>[{documentId,frameId:0,result:{url:sourceUrl,top:true}}]};
  }});
  return {h,setOwner:value=>{owner=value;},setDocument:value=>{documentId=value;},
    request:(type,extra={})=>h.dispatch({type,url:sourceUrl,instanceId:owner,...extra},{id:popup.id,frameId:0,
      documentId,documentLifecycle:"active",url:sourceUrl,tab:{...h.tabs.get(17)}})};
}
test("update checkpoint survives extension restart but can be claimed only once in the same document",async()=>{
  const a=await worker();assert.equal((await a.request("UR_SAVE",{settings})).ok,true);
  const b=await worker(structuredClone(a.h.local.values));b.setOwner("replacement");
  const claim=await b.request("UR_CLAIM");assert.equal(claim.record.count,7);assert.equal(claim.record.userHash,settings.userHash);
  assert.equal((await b.request("UR_CLAIM")).record,null);
  const c=await worker(structuredClone(a.h.local.values));c.setOwner("new-page");c.setDocument("different-document");
  assert.equal((await c.request("UR_CLAIM")).record,null);
  assert.equal(JSON.stringify(a.h.local.values).includes("Private previous prompt"),false);
});
test("paused, stopped, uncertain sends, stale owners and wrong destinations cannot authorize resume",async()=>{
  for(const record of [{active:false,mode:"logic",paused:true},{active:false,mode:"idle",paused:false},{active:false,mode:"logic",error:true}]) {
    const w=await worker();await w.request("UR_SAVE",{settings:record});w.setOwner("replacement");
    assert.equal((await w.request("UR_CLAIM")).record.active,false);
  }
  const w=await worker();await w.request("UR_SAVE",{settings});await w.request("UR_BLOCK");w.setOwner("replacement");
  assert.equal((await w.request("UR_CLAIM")).record.active,false);
  assert.equal((await w.request("UR_SAVE",{settings,instanceId:"retired"})).ok,false);
  assert.equal((await w.request("UR_SAVE",{settings,url:sourceUrl+"-wrong"})).ok,false);
  assert.equal((await w.request("UR_SAVE",{settings:{...settings,count:26}})).ok,false);
  assert.equal((await w.h.dispatch({type:"UR_CLAIM",instanceId:"foreign",url:sourceUrl},popup)).ok,false);
});
test("only confirmed update recovery keeps an active heartbeat from being blocked on owner replacement",async()=>{
  for(const confirmed of [false,true]) {
    const w=await worker();
    await w.h.dispatch({type:"HB_SAVE",tabId:17,configuration:definition});
    Object.assign(w.h.record(),{phase:"active",instanceId:"first"});
    await w.request("UR_SAVE",{settings:{...settings,heartbeatActive:true}});
    w.setOwner("replacement");await w.request("UR_CLAIM");
    if(confirmed)assert.equal((await w.request("UR_CONFIRM")).ok,true);
    const result=await w.h.dispatch({type:"HB_ATTACH",instanceId:"replacement"},{id:popup.id,frameId:0,
      documentId:"same-browser-document",documentLifecycle:"active",url:sourceUrl,tab:{...w.h.tabs.get(17)}});
    assert.equal(result.schedule.phase,confirmed?"active":"blocked");
  }
});
test("a newly saved chat can fence recovery despite stale sender URLs, only with exact document proof",async()=>{
  const w=await worker(),home=sourceUrl.replace(/\/c\/source$/,"/project");
  const sender={id:popup.id,frameId:0,documentId:"same-browser-document",documentLifecycle:"active",url:home,tab:{...w.h.tabs.get(17),url:home}};
  const request={type:"UR_BLOCK",url:sourceUrl,instanceId:"first"};
  assert.equal((await w.h.dispatch(request,sender)).ok,true);
  w.h.context.chrome.scripting.executeScript=async()=>[{documentId:"replaced",frameId:0,result:{url:sourceUrl,top:true}}];
  assert.equal((await w.h.dispatch(request,sender)).ok,false);
});
async function contentRecord(f,phase="monitoring") {
  return {...settings,phase,userHash:await f.api.reconnectUserHash({element:f.user(),text:f.user().textContent}),
    assistantHash:await f.api.reconnectHash(f.assistant().textContent),waitUntil:phase==="waiting_external"?600000:null};
}
function prepareRestore(f) {
  Object.assign(f.api.state,{running:false,paused:true,logicPhase:"update_paused",runId:3});
  f.api.setUpdateRecoveryReadyForTest(false);f.hide();
}
test("content recovery verifies the submitted turn and keeps counters, WAIT deadline and resume-only startup",async()=>{
  for(const phase of ["monitoring","waiting_external","waiting_user"]) {
    const f=fixture([],{runtimeId:"test-extension"}),record=await contentRecord(f,phase);prepareRestore(f);
    const runs=f.api.captureHeartbeatRunsForTest();
    f.setRequestHandler(async r=>r.type==="UR_CLAIM"?{ok:true,record}:{ok:true});
    await f.api.restoreAfterExtensionUpdate();
    assert.equal(runs.length,1,phase);assert.equal(runs[0][1],true);
    assert.equal(runs[0][6].waitUntil,record.waitUntil);assert.equal(f.api.state.count,7);assert.equal(f.api.state.limit,25);
    assert.equal(f.sends.length,0);
  }
});
test("drafts, changed user turns, page errors, navigation and manual stop during verification never resume",async()=>{
  for(const issue of ["draft","user","error","navigation","stop","response"]) {
    const f=fixture([],{runtimeId:"test-extension"}),record=await contentRecord(f,issue==="response"?"waiting_user":"monitoring");prepareRestore(f);
    const runs=f.api.captureHeartbeatRunsForTest();f.setRequestHandler(async r=>r.type==="UR_CLAIM"?{ok:true,record}:{ok:true});
    if(issue==="draft")f.composer.innerText="Unsent private draft";
    if(issue==="user")f.newUser();
    if(issue==="error")f.setAlerts([visibleElement("Something went wrong. Try again.")]);
    if(issue==="response")f.assistant().textContent="A different completed response";
    if(issue==="navigation")f.onTick(()=>{f.window.location=new URL("https://chatgpt.com/c/other");});
    if(issue==="stop")f.onTick(()=>{f.api.state.runId++;f.api.state.running=false;});
    await f.api.restoreAfterExtensionUpdate();
    assert.equal(runs.length,0,issue);assert.equal(f.sends.length,0,issue);
  }
});
test("restored WAIT uses the original deadline rather than starting a new full wait",async()=>{
  const f=fixture();f.hide();f.advanceClock(5000);const start=f.api.state.runId;
  const result=await f.api.waitForExternalOperation(start,{element:f.user(),text:f.user().textContent},10,7000);
  assert.equal(result.reason,"timer");assert.equal(f.api.state.waitUntil,null);
});
test("update checkpoint is durably blocked before any automatic composer write",async()=>{
  const f=fixture([],{runtimeId:"test-extension"});f.hide();let release,blocked=false;
  f.setRequestHandler(async request=>{
    if(request.type==="UR_BLOCK"){blocked=true;await new Promise(r=>{release=r;});return {ok:false,error:"Storage unavailable"};}
    return {ok:true};
  });
  const run=f.run();while(!blocked)await new Promise(setImmediate);
  assert.equal(f.writes.length,0);assert.equal(f.sends.length,0);release();await run;
  assert.equal(f.writes.length,0);assert.equal(f.sends.length,0);assert.equal(f.api.state.error,true);
});

test("automatic recovery processes completed CONTINUE and WAIT flags once without replaying startup",async()=>{
  for (const phase of ["monitoring","waiting_external"]) {
    const f=fixture(["idle"],{runtimeId:"test-extension"});
    if(phase==="waiting_external") f.assistant().textContent="External work underway.\n[[LOGIC:WAIT:10m]]";
    const record=await contentRecord(f,phase);record.waitUntil=phase==="waiting_external"?12000:null;
    prepareRestore(f);const runs=f.api.trackLogicRunsForTest();
    f.setRequestHandler(async r=>r.type==="UR_CLAIM"?{ok:true,record}:{ok:true,enabled:false});
    await f.api.restoreAfterExtensionUpdate();await Promise.all(runs);
    assert.deepEqual(f.sends,[phase==="waiting_external"?"Status":"Continue"]);
    assert.equal(f.api.state.count,8);assert.equal(f.api.state.error,false,f.api.state.detail);
  }
});
test("sleeping agents retain their schedule without waking paused, disabled or missing schedules",async()=>{
  for(const phase of ["sleeping","paused","disabled","missing"]) {
    const f=fixture([],{runtimeId:"test-extension"});f.assistant().textContent="Cycle complete.\n[[LOGIC:IDLE]]";
    const record=await contentRecord(f,"sleeping");prepareRestore(f);const runs=f.api.captureHeartbeatRunsForTest();
    const schedule={id:"schedule",url:f.window.location.href,phase,enabled:phase!=="disabled",initialCycle:false,
      message:"Continue",limit:25,rolloverEnabled:true,timeZone:"UTC",nextRunAt:100000};
    f.setRequestHandler(async r=>r.type==="UR_CLAIM"?{ok:true,record}:r.type==="HB_ATTACH"?{ok:true,schedule:phase==="missing"?null:schedule}:{ok:true});
    await f.api.restoreAfterExtensionUpdate();
    assert.equal(f.api.state.running,phase==="sleeping",phase);assert.equal(f.sends.length,0);assert.equal(runs.length,0);
    if(phase==="sleeping")assert.equal(f.api.getHeartbeatForTest().nextRunAt,100000);
  }
});
test("restoring a USER_INPUT wait does not repeat phone or workstation alerts",async()=>{
  const f=fixture([],{runtimeId:"test-extension"});f.assistant().textContent="Please choose a direction.\n[[LOGIC:USER_INPUT]]";
  const record=await contentRecord(f,"waiting_user");prepareRestore(f);const runs=f.api.trackLogicRunsForTest(),requests=[];
  f.setRequestHandler(async r=>{requests.push(r.type);return r.type==="UR_CLAIM"?{ok:true,record}:{ok:true,enabled:false};});
  f.onTick(()=>{if(f.api.state.running && f.api.state.logicPhase==="waiting_user"){f.api.state.running=false;f.api.state.runId++;}});
  await f.api.restoreAfterExtensionUpdate();await Promise.all(runs);
  assert.equal(f.sends.length,0);assert.equal(requests.some(type=>/ALERT|HA_NOTIFY/.test(type)),false);
});
