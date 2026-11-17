/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert=require("node:assert/strict"),{test}=require("node:test"),fs=require("node:fs"),vm=require("node:vm");
const {harness,sourceUrl,popup}=require("./heartbeat.test.js");
const KEY="logicMessageQueues";
const sender=(h,id=17)=>({id:popup.id,frameId:0,url:h.tabs.get(id).url,tab:{...h.tabs.get(id)}});
const req=(h,type,data={},id=17)=>h.dispatch({type,url:h.tabs.get(id).url,...data},sender(h,id));
const message={id:"message-one",text:"Review costs before continuing."};
async function client(h,id=17) {
  let restored=[],failure=null;
  const context={URL,Promise,setTimeout,window:{location:{href:h.tabs.get(id).url}},chrome:{runtime:{sendMessage:r=>h.dispatch(r,sender(h,id))}}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve("../queue-client.js"),"utf8")+"\nglobalThis.Store=ThreadlampQueueStore;",context);
  const store=new context.Store(items=>{restored=items;},error=>{failure=error;});
  await store.ready;
  return {store,context,get restored(){return restored;},get failure(){return failure;}};
}
test("queues survive content reload and a browser/worker restart, with FIFO and project isolation",async()=>{
  const h=await harness(),c=await client(h);
  await c.store.save([message,{id:"two",text:"Then report blockers."}]);
  const reloaded=await client(h);
  assert.deepEqual(reloaded.restored.map(x=>x.id),["message-one","two"]);
  const restarted=await harness(structuredClone(h.local.values)),after=await client(restarted);
  assert.deepEqual(after.restored.map(x=>x.id),["message-one","two"]);
  assert.equal((await req(h,"Q_LOAD",{},99)).items.length,0);
  h.tabs.get(99).url=sourceUrl.replace("0123456789abcdef0123456789abcdef","fedcba9876543210fedcba9876543210");
  assert.equal((await req(h,"Q_LOAD",{},99)).items.length,0);
  assert.equal(JSON.stringify(h.local.values).includes(message.text),true,"queue is intentionally durable local user content");
});
test("competing tabs cannot replay a consumed head or silently overwrite a newer queue",async()=>{
  const h=await harness(),a=await client(h);
  await a.store.save([message]);
  h.tabs.get(99).url=sourceUrl;
  const b=await client(h,99);
  await a.store.save([]); // durable removal before Send
  await assert.rejects(b.store.save([]),/another page/);
  assert.ok(b.failure);
  const reloaded=await client(h);
  assert.equal(reloaded.restored.length,0,"uncertain delivery must never replay after reload");
  await assert.rejects(b.store.save([message]),/another page/);
});
test("queue writes validate trusted sender, bounds, route and storage failure",async()=>{
  const h=await harness();
  assert.equal((await h.dispatch({type:"Q_LOAD",url:sourceUrl})).ok,false);
  assert.equal((await h.dispatch({type:"Q_LOAD",url:sourceUrl},{...sender(h),frameId:1})).ok,false);
  assert.equal((await req(h,"Q_SAVE",{version:0,items:[message,message]})).ok,false);
  assert.equal((await req(h,"Q_SAVE",{version:0,items:[{...message,text:"x".repeat(8001)}]})).ok,false);
  const c=await client(h);
  const set=h.local.set;
  h.local.set=async v=>{if(v[KEY])throw new Error("Storage quota exceeded");return set(v);};
  await assert.rejects(c.store.save([message]),/quota/);
  assert.ok(c.failure); assert.equal(h.local.values[KEY],undefined);
  h.local.set=set;
  await assert.rejects(c.store.flush(),/quota/);
});
test("only a claimed matching-project handoff transfers the source queue once",async()=>{
  const h=await harness();await req(h,"Q_SAVE",{version:0,items:[message]});
  const home=sourceUrl.replace(/\/c\/source$/,"/project");
  h.tabs.get(17).url=home;
  h.session.values.logicModePendingRollovers={handoff:{requestId:"handoff",sourceUrl,sourceTabId:17,claimedBy:17,
    projectSegment:"g-p-0123456789abcdef0123456789abcdef-job-search",queuedPrompts:[message],expiresAt:h.context.Date.now()+300000}};
  assert.equal((await req(h,"Q_HANDOFF",{requestId:"missing"})).ok,false);
  const moved=await req(h,"Q_HANDOFF",{requestId:"handoff"});assert.equal(moved.ok,true);assert.equal(moved.items[0].text,message.text);
  assert.equal((await req(h,"Q_HANDOFF",{requestId:"handoff"})).ok,false);
  h.tabs.get(99).url=sourceUrl;
  assert.equal((await req(h,"Q_LOAD",{},99)).items.length,0,"old chat cannot replay transferred messages");
  const c=await client(h);
  c.context.window.location.href=h.tabs.get(17).url=home.replace(/\/project$/,"/c/destination");
  await c.store.move();
  assert.equal((await client(h)).restored[0].text,message.text);
  h.tabs.get(99).url=home;
  assert.equal((await req(h,"Q_LOAD",{},99)).items.length,0,"unsaved landing queue cannot leak to another tab");
});
test("unsaved-to-saved migration refuses other projects and preserves both queues",async()=>{
  const h=await harness();
  const home=sourceUrl.replace(/\/c\/source$/,"/project");h.tabs.get(17).url=home;
  const c=await client(h);await c.store.save([message]);
  c.context.window.location.href=h.tabs.get(17).url=sourceUrl.replace("0123456789abcdef0123456789abcdef","fedcba9876543210fedcba9876543210");
  await assert.rejects(c.store.move(),/could not be verified/);
  assert.equal((await req(h,"Q_LOAD")).items.length,0);
  h.tabs.get(17).url=home;
  assert.equal((await req(h,"Q_LOAD")).items[0].text,message.text);
});

test("the real send path waits for a durable dequeue, preserves later appends and stops on save failure",async()=>{
  const {fixture}=require("./delivery-timeout.test.js");
  for(const fail of [false,true]) {
    let f,release,dequeueStarted=false,stored=[];
    class Store {
      constructor(){this.loaded=true;this.ready=Promise.resolve();}
      flush(){return Promise.resolve();}
      move(){return Promise.resolve();}
      async save(value){
        if(!value.length){dequeueStarted=true;await new Promise(r=>{release=r;});if(fail)throw new Error("Storage unavailable");}
        stored=structuredClone(value);
      }
    }
    f=fixture(["idle"],{QueueStore:Store});f.hide();
    assert.equal(f.api.queueAdditionalPrompt("First instructions"),true);
    const sending=f.run();
    while(!dequeueStarted) await new Promise(setImmediate);
    assert.equal(f.sends.length,0,"never click before the durable removal finishes");
    if(!fail) assert.equal(f.api.queueAdditionalPrompt("Next instructions"),true);
    release();await sending;
    assert.equal(f.sends.length,fail?0:1);
    if(!fail) assert.equal(f.api.getQueuedPromptForTest().text,"Next instructions","async save must not erase an appended entry");
    else assert.equal(f.api.state.error,true);
  }
});

test("manual navigation restores the destination queue without transferring the source",async()=>{
  const h=await harness(),c=await client(h);await c.store.save([message]);
  const destination=sourceUrl.replace(/\/c\/source$/,"/c/other");
  h.tabs.get(17).url=c.context.window.location.href=destination;
  await c.store.attach();assert.equal(c.restored.length,0);
  await c.store.save([{id:"other",text:"Other conversation only."}]);
  h.tabs.get(17).url=c.context.window.location.href=sourceUrl;
  await c.store.attach();assert.equal(c.restored[0].text,message.text);
});

test("handoff queues follow project landing through a temporary ID to the saved chat exactly once",async()=>{
  for (const temporary of ["local-chatgpt:temporary", "local-chatgpt%3Atemporary", "local-chatgpt%3atemporary"]) {
    const h=await harness(),home=sourceUrl.replace(/\/c\/source$/,"/project");
    h.tabs.get(17).url=home;
    const c=await client(h);await c.store.save([message]);
    c.context.window.location.href=h.tabs.get(17).url=home.replace(/\/project$/,"/c/"+temporary);
    await c.store.move();
    c.context.window.location.href=h.tabs.get(17).url=sourceUrl;
    await c.store.move();
    assert.equal((await client(h)).restored[0].text,message.text);
    h.tabs.get(17).url=home;
    assert.equal((await req(h,"Q_LOAD")).items.length,0,"landing queue cannot replay transferred messages");
  }
});

test("stale sender tab metadata requires exact active-document proof and the live destination",async()=>{
  const h=await harness(),home=sourceUrl.replace(/\/c\/source$/,"/project");
  const stale={...sender(h),url:home,tab:{...h.tabs.get(17),url:home},documentId:"current-document",documentLifecycle:"active"};
  let proof={documentId:"current-document",frameId:0,result:{url:sourceUrl,top:true}};
  h.context.chrome.scripting={executeScript:async options=>{
    assert.equal(options.target.tabId,17);assert.equal(options.target.documentIds[0],"current-document");return [proof];
  }};
  assert.equal((await h.dispatch({type:"Q_LOAD",url:sourceUrl},stale)).ok,true);
  const valid=proof;
  for(const invalid of [{...valid,documentId:"old-document"},{...valid,frameId:1},
    {...valid,result:{url:home,top:true}},{...valid,result:{url:sourceUrl,top:false}}]) {
    proof=invalid;
    assert.equal((await h.dispatch({type:"Q_SAVE",url:sourceUrl,version:0,items:[message]},stale)).ok,false);
  }
  proof=valid;
  for(const invalid of [{...stale,documentId:undefined},{...stale,documentLifecycle:"cached"},
    {...stale,id:"foreign-extension"},{...stale,frameId:1}]) {
    assert.equal((await h.dispatch({type:"Q_SAVE",url:sourceUrl,version:0,items:[message]},invalid)).ok,false);
  }
  h.tabs.get(17).url=sourceUrl+"-other-chat";
  assert.equal((await h.dispatch({type:"Q_SAVE",url:sourceUrl,version:0,items:[message]},stale)).ok,false);
  assert.equal(h.local.values[KEY],undefined,"failed checks never mutate queues");
});

test("queue migration retries rejected verification with fresh sender proof, never a queue write",async()=>{
  const h=await harness(),home=sourceUrl.replace(/\/c\/source$/,"/project");
  h.tabs.get(17).url=home;
  const c=await client(h);await c.store.save([message]);
  c.context.window.location.href=h.tabs.get(17).url=sourceUrl;
  let calls=0,writes=0;const retries=[],set=h.local.set;
  h.local.set=async data=>{if(data[KEY])writes++;return set(data);};
  h.context.chrome.scripting={executeScript:async()=>{throw new Error("Document not ready");}};
  c.context.chrome.runtime.sendMessage=r=>{
    calls++;
    const s=calls===1 ? {...sender(h),url:home,tab:{...h.tabs.get(17),url:home},documentId:"active-document",documentLifecycle:"active"} : sender(h);
    return h.dispatch(r,s);
  };
  await c.store.move({validate:()=>true,onRetry:(error,attempt)=>retries.push([error.queueFailure,error.queueProof,attempt])});
  assert.equal(c.failure,null);assert.equal(calls,2);assert.equal(writes,1);
  assert.deepEqual(retries,[["document","unavailable",1]]);
  assert.equal((await client(h)).restored[0].text,message.text);
  h.tabs.get(17).url=home;
  assert.equal((await req(h,"Q_LOAD")).items.length,0);
});

test("queue migration stops after bounded verification failures and preserves its source queue",async()=>{
  const h=await harness(),home=sourceUrl.replace(/\/c\/source$/,"/project");
  h.tabs.get(17).url=home;
  const c=await client(h);await c.store.save([message]);
  const before=JSON.stringify(h.local.values[KEY]);
  c.context.window.location.href=h.tabs.get(17).url=sourceUrl;
  let calls=0;
  h.context.chrome.scripting={executeScript:async()=>[{documentId:"wrong-document",frameId:0,result:{url:sourceUrl,top:true}}]};
  c.context.chrome.runtime.sendMessage=r=>{
    calls++;return h.dispatch(r,{...sender(h),url:home,tab:{...h.tabs.get(17),url:home},documentId:"active-document",documentLifecycle:"active"});
  };
  await assert.rejects(c.store.move({validate:()=>true}),/active page/);
  assert.equal(calls,3);assert.equal(c.failure.queueProof,"identity");
  assert.equal(JSON.stringify(h.local.values[KEY]),before);
});

test("queue migration never retries uncertain results, storage failures, navigation or lost prompt ownership",async()=>{
  for(const scenario of ["transport","missing","malformed","storage","sender","navigate","ownership","closed"]) {
    const h=await harness(),home=sourceUrl.replace(/\/c\/source$/,"/project");
    h.tabs.get(17).url=home;
    const c=await client(h);await c.store.save([message]);
    c.context.window.location.href=h.tabs.get(17).url=sourceUrl;
    const before=JSON.stringify(h.local.values[KEY]);let calls=0,valid=true;
    c.context.chrome.runtime.sendMessage=async()=>{
      calls++;
      if(scenario==="transport")throw new Error("Missing response");
      if(scenario==="missing")return undefined;
      if(scenario==="malformed")return {ok:true,queueRetrySafe:true};
      if(scenario==="navigate")c.context.window.location.href=sourceUrl+"-other";
      if(scenario==="ownership")valid=false;
      if(scenario==="closed")c.store.close();
      return {ok:false,error:"Rejected",queueFailure:scenario==="storage"?"storage":scenario==="sender"?"sender":"document",
        queueRetrySafe:!["storage","sender"].includes(scenario)};
    };
    await assert.rejects(c.store.move({validate:()=>valid}));
    assert.equal(calls,1,scenario);assert.equal(JSON.stringify(h.local.values[KEY]),before);
  }
});

test("initial queue read follows navigation without applying an obsolete queue or retrying a write",async()=>{
  const home=sourceUrl.replace(/\/c\/source$/,"/project"),calls=[],loaded=[];
  const context={URL,Promise,window:{location:{href:home}},chrome:{runtime:{sendMessage:async r=>{
    calls.push(r);
    if(calls.length===1){context.window.location.href=sourceUrl;return {ok:false,error:"The queue's chat changed."};}
    return {ok:true,version:3,items:[message]};
  }}}};
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve("../queue-client.js"),"utf8"),context);
  const store=new context.ThreadlampQueueStore(items=>loaded.push(items),()=>{});await store.ready;
  assert.equal(calls.length,2);assert.ok(calls.every(r=>r.type==="Q_LOAD"));
  assert.equal(store.url,sourceUrl);assert.equal(loaded.length,1);assert.equal(loaded[0][0].url,sourceUrl);
});

test("upgrading preserves a legacy temporary-ID queue and refuses to merge conflicting queues",async()=>{
  const project="g-p-0123456789abcdef0123456789abcdef",temporary="local-chatgpt%3Atemporary";
  const oldKey=JSON.stringify(["https://chatgpt.com",project,"chat",temporary]);
  const tabKey=JSON.stringify(["https://chatgpt.com",project,"tab",17]);
  const initial={[KEY]:{[oldKey]:{version:4,items:[message]}}};
  const h=await harness(initial);h.tabs.get(17).url=sourceUrl.replace(/\/c\/source$/,"/c/"+temporary);
  const c=await client(h);assert.equal(c.restored[0].text,message.text);
  c.context.window.location.href=h.tabs.get(17).url=sourceUrl;
  await c.store.move();assert.equal((await client(h)).restored[0].text,message.text);
  assert.equal(h.local.values[KEY][oldKey].items.length,0);
  const conflict=await harness({[KEY]:{[oldKey]:{version:4,items:[message]},[tabKey]:{version:2,items:[{id:"other",text:"Keep separate"}]}}});
  conflict.tabs.get(17).url=sourceUrl.replace(/\/c\/source$/,"/c/"+temporary);
  const before=JSON.stringify(conflict.local.values[KEY]);
  assert.equal((await req(conflict,"Q_LOAD")).ok,false);
  assert.equal(JSON.stringify(conflict.local.values[KEY]),before);
});

test("real Logic ownership and durable queue survive both new-chat URL transitions without resending startup",async()=>{
  const {fixture}=require("./delivery-timeout.test.js");
  for (const rejectOnce of [false,true]) {
  const h=await harness(),home=sourceUrl.replace(/\/c\/source$/,"/project"),temporary=home.replace(/\/project$/,"/c/local-chatgpt%3Atemporary");
  let f,store,rejected=false;
  h.context.chrome.scripting={executeScript:async()=>{throw new Error("Document unavailable during navigation");}};
  const context={URL,Promise,setTimeout,window:{get location(){return f?.window.location || new URL(home);}},
    chrome:{runtime:{sendMessage:r=>{
      h.tabs.get(17).url=context.window.location.href;
      if(rejectOnce && !rejected && r.type==="Q_MOVE") {
        rejected=true;
        return h.dispatch(r,{...sender(h),url:home,tab:{...h.tabs.get(17),url:home},documentId:"active-document",documentLifecycle:"active"});
      }
      return h.dispatch(r,sender(h));
    }}}};
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve("../queue-client.js"),"utf8"),context);
  class Store extends context.ThreadlampQueueStore {
    constructor(...args){super(...args);store=this;}
    async move(options){await super.move(options);if(this.url===temporary)f.onTick(()=>{f.window.location=new URL(sourceUrl);});}
  }
  f=fixture(["continue","idle"],{QueueStore:Store});f.hide();f.window.location=new URL(home);await store.ready;
  f.api.setTimeoutSnapshotsForTest(role=>{
    if(!f.sends.length)return {element:null,text:""};
    const element=role==="user"?f.user():f.assistant();return {element,text:element.textContent};
  });
  const send=f.send.click;f.send.click=()=>{send();if(f.sends.length===1)f.window.location=new URL(temporary);};
  await f.api.runLogicMode(1,false,"Initial continuation");
  assert.equal(f.api.state.error,false,f.api.state.detail);
  assert.deepEqual(f.sends,["Initial continuation","Configured followup"]);
  assert.equal(store.url,sourceUrl);
  assert.equal(rejected,rejectOnce);
  }
});
