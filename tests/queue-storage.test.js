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
  const context={URL,Promise,window:{location:{href:h.tabs.get(id).url}},chrome:{runtime:{sendMessage:r=>h.dispatch(r,sender(h,id))}}};
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
