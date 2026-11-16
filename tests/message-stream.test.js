/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const {fixture} = require("./delivery-timeout.test.js");
const {visibleElement} = require("./rollover.test.js");
const schema = require("../diagnostics-schema.js");
const STREAM = "Error in message stream";
function streamFixture() {
  const f=fixture(["idle"],{diagnosticSchema:schema});
  f.notice.textContent=`${STREAM}Retry`;
  // Captured UI: Retry DIV -> exact error DIV -> DIV -> ASIDE[role=alert].
  const wrapper=visibleElement("Retry"); wrapper.parentElement=f.notice;
  f.retry.parentElement=wrapper;
  const outer={...f.notice, get textContent(){return f.notice.textContent;},parentElement:f.document.body};
  f.notice.parentElement=outer;
  return f;
}

test("captured stream error uses one guarded reload, never Retry or a prompt send",async()=>{
  const f=streamFixture();let reloads=0;
  f.window.location.reload=()=>{reloads++;};
  assert.equal(f.api.findConnectionErrorNotice(),f.notice);
  await f.run();
  assert.equal(reloads,1);assert.deepEqual(f.writes,[]);assert.deepEqual(f.sends,[]);
  assert.equal(f.requests.filter(r=>r.type==="LR_PREPARE").length,1);
  const event=f.requests.find(r=>r.type==="DG_RECORD" && r.event.event==="reconnect_start");
  assert.equal(event.event.reason,"message_stream_error");
});

test("stream recognition rejects old, quoted, hidden, disabled and ambiguous notices",()=>{
  for(const variant of ["old","quoted","hidden","disabled","extra-prose","ambiguous"]){
    const f=streamFixture();
    if(variant==="old")f.notice.rank=0;
    if(variant==="quoted")f.notice.closest=()=>({});
    if(variant==="hidden")f.hide();
    if(variant==="disabled")f.retry.disabled=true;
    if(variant==="extra-prose")f.notice.textContent+=" Example only";
    if(variant==="ambiguous"){
      const second=Object.assign(visibleElement("Retry"),{parentElement:{...f.notice}});
      f.setSelector("button, [role='button']",[f.retry,second]);
    }
    assert.equal(f.api.findConnectionErrorNotice(),null,variant);
  }
});

test("a late stream error recovers after a partial response entered missing-flag wait",async()=>{
  const f=streamFixture();f.hide();let reloads=0,enteredMissingFlag=false;
  f.assistant().textContent="Partial response without a final flag.";
  f.assistant().querySelector=()=>null;
  f.window.location.reload=()=>{reloads++;};
  f.onTick(()=>{
    if(f.api.state.logicPhase==="waiting_user"){
      enteredMissingFlag=true;
      f.notice.getBoundingClientRect=()=>({width:100,height:40});
    }
  });
  await f.run();
  assert.equal(enteredMissingFlag,true);assert.equal(reloads,1);
  assert.deepEqual(f.sends,[]);assert.deepEqual(f.writes,[]);
  assert.equal(f.api.state.error,false);
});

for(const barrier of ["draft","queued","wrong-chat","second-error"]){
  test(`stream recovery preserves safety barrier: ${barrier}`,async()=>{
    const f=streamFixture();let reloads=0;
    f.window.location.reload=()=>{reloads++;};
    if(barrier==="draft")f.composer.innerText=f.composer.textContent="Unsent draft";
    if(barrier==="queued")f.api.queueAdditionalPrompt("Queued instruction");
    if(barrier==="wrong-chat")f.onTick(()=>{f.window.location=new URL("https://chatgpt.com/c/unrelated");});
    if(barrier==="second-error")f.api.setReconnectAttemptedForTest(true);
    await f.run();
    assert.equal(reloads,0);assert.deepEqual(f.sends,[]);assert.equal(f.api.state.error,true);
  });
}

test("manual typing during missing-flag wait prevents later automatic reload even after clearing",async()=>{
  const f=streamFixture();f.hide();let reloads=0,started;
  f.assistant().textContent="Partial response without a final flag.";
  f.assistant().querySelector=()=>null;
  f.window.location.reload=()=>{reloads++;};
  f.onTick(now=>{
    if(f.api.state.logicPhase!=="waiting_user")return;
    started??=now;
    f.composer.innerText=f.composer.textContent=now-started<1000 ? "Manual draft" : "";
    f.notice.getBoundingClientRect=()=>({width:100,height:40});
    if(now-started>40000)f.api.state.running=false;
  });
  await f.run();
  assert.equal(reloads,0);assert.deepEqual(f.sends,[]);
});

test("a stream error after restoration pauses and reports without another reload",async()=>{
  const f=streamFixture();let reloads=0;
  const settings={message:"Continue",limit:5,count:2,rolloverEnabled:true,verifiedUser:true,
    userHash:await f.api.reconnectUserHash({element:f.user(),text:f.user().textContent})};
  f.api.state.running=false;f.api.state.mode="idle";
  const runs=f.api.captureHeartbeatRunsForTest();
  f.window.location.reload=()=>{reloads++;};
  f.setRequestHandler(async request=>{
    f.requests.push(request);
    return request.type==="LR_CLAIM" ? {ok:true,record:{token:"run",attempted:true,requested:true,settings}} : {ok:true};
  });
  await f.api.restoreLogicReconnect();
  assert.equal(f.api.state.logicPhase,"recovery_paused");
  assert.equal(f.api.state.error,true);assert.equal(runs.length,0);assert.equal(reloads,0);
  assert.ok(f.requests.some(r=>r.type==="HA_NOTIFY_ERROR"));
  assert.deepEqual(f.sends,[]);
});
