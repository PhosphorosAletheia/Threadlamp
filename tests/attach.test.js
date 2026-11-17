/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const {test} = require("node:test"), assert = require("node:assert/strict");
const {harness, popup} = require("./heartbeat.test.js");
const {contentHarness} = require("./rollover.test.js");

async function fixture({healthy=false, legacy=false, navigate=false}={}) {
  const calls=[]; let injected=false;
  const h=await harness({}, {pageHandler:async (_id,r)=> {
    if (r.type !== "AT_PING") throw Error("No receiver");
    if (healthy || injected) return {ok:true,lifecycle:1,version:"1.15.0"};
    throw Error("No receiver");
  },configureContext:context=> {
    context.chrome.scripting={executeScript:async args=> {
      calls.push(args);
      if (args.files) {injected=true;return [];}
      if (navigate) h.tabs.get(17).url="https://chatgpt.com/c/different";
      return [{frameId:0,documentId:"exact-document",result:legacy ? {legacy:true} : {ready:true}}];
    }};
  }});
  return {h,calls};
}
test("reattach is idempotent, serialized, and targets the inspected document",async()=> {
  const {h,calls}=await fixture();
  const results=await Promise.all([h.dispatch({type:"AT_ATTACH",tabId:17}),h.dispatch({type:"AT_ATTACH",tabId:17})]);
  assert.ok(results.every(r=>r.ok && r.attached));
  assert.equal(calls.length,2);
  assert.deepEqual(Array.from(calls[1].target.documentIds),["exact-document"]);
  assert.equal(calls[1].target.frameIds,undefined);
  assert.equal((await h.dispatch({type:"AT_ATTACH",tabId:17})).attached,false);
  assert.equal(calls.length,2);
});
test("legacy, navigating, discarded and untrusted targets cannot receive new code",async()=> {
  for (const options of [{legacy:true},{navigate:true}]) {
    const {h,calls}=await fixture(options);
    assert.equal((await h.dispatch({type:"AT_ATTACH",tabId:17})).ok,false);
    assert.equal(calls.length,1); assert.equal(calls[0].files,undefined);
  }
  const {h,calls}=await fixture();
  h.tabs.get(17).discarded=true;
  assert.equal((await h.dispatch({type:"AT_ATTACH",tabId:17})).ok,false);
  assert.equal((await h.dispatch({type:"AT_ATTACH",tabId:99},{id:popup.id,url:h.tabs.get(99).url,tab:h.tabs.get(99)})).ok,false);
  assert.equal(calls.length,0);
});
test("disposal cancels old runs, timers and UI and fences new sends",async()=> {
  const h=contentHarness(); const cleared=[];
  h.window.clearInterval=id=>cleared.push(id);
  h.api.state.running=true;h.api.state.mode="logic";h.api.state.runId=8;
  h.window.__threadlampController.dispose();
  assert.equal(h.api.state.running,false);assert.equal(h.api.state.runId,9);
  assert.equal(cleared.length,4);assert.equal(h.api.getOverlayForTest(),null);
  h.api.updateOverlay();h.api.updateQuickActions();
  assert.equal(h.api.getOverlayForTest(),null);
  assert.equal(await h.api.submitMessage(8,"Must not send","Testing"),false);
  h.window.__threadlampController.dispose();assert.equal(cleared.length,4);
});
test("document preparation refuses real legacy controls and disposes lifecycle-aware controls",async()=> {
  for (const legacy of [true,false]) {
    let oldUI=true,disposals=0;const elements=new Map();
    if (!legacy) elements.set("threadlamp-controller-lifecycle",{});
    const h=await harness({}, {pageHandler:async()=>{throw Error("No receiver");},configureContext:context=>{
      context.window={__chatGptContinueLoopLoaded:true};
      context.Event=class {constructor(type){this.type=type;}};
      context.document={getElementById:id=>id==="chatgpt-continue-loop-status"&&oldUI ? {} : elements.get(id),dispatchEvent:event=>{
        assert.equal(event.type,"threadlamp:detach");disposals++;oldUI=false;context.window.__chatGptContinueLoopLoaded=false;
      }};
      context.chrome.scripting={executeScript:async args=>{
        if (args.func) return [{documentId:"fixture-document",result:args.func(...(args.args || []))}];
        h.setPageHandler(async()=>({ok:true,lifecycle:1,version:"1.15.0"}));return [];
      }};
    }});
    const result=await h.dispatch({type:"AT_ATTACH",tabId:17});
    assert.equal(result.ok,!legacy);
    assert.equal(disposals,legacy ? 0 : 1);
    assert.equal(h.context.window.__threadlampReattaching,legacy ? undefined : true);
  }
});

test("a lost or timed-out ping cannot replace a live controller in the inspected document",async()=> {
  for(const timedOut of [false,true]) {
    const page=contentHarness();
    Object.assign(page.api.state,{running:true,mode:"setup",logicPhase:"server_setup",runId:7});
    let injected=0;
    const h=await harness({}, {pageHandler:async()=>{throw Object.assign(Error("Transient ping failure"),{attachTimeout:timedOut});},
      configureContext:context=>{
        context.window=page.window;
        context.document={getElementById:()=>{throw Error("A healthy controller must not be detached");}};
        context.chrome.scripting={executeScript:async args=>{
          if(args.files){injected++;throw Error("Must not inject");}
          return [{frameId:0,documentId:"same-document",result:args.func(...args.args)}];
        }};
      }});
    const result=await h.dispatch({type:"AT_ATTACH",tabId:17});
    assert.equal(result.ok,true);assert.equal(result.attached,false);assert.equal(injected,0);
    assert.equal(page.api.state.running,true);assert.equal(page.api.state.runId,7);
    assert.equal(page.api.state.mode,"setup");
  }
});
