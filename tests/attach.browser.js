/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
/* Actual unpacked-extension reloads in a disposable Chromium profile. All
 * fixture-page requests are intercepted; no live chats or user profile. */
"use strict";
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),assert=require("node:assert/strict");
const {spawn}=require("node:child_process"),{once}=require("node:events"),{WebSocket}=require("ws");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"threadlamp-attach-browser-")),root=path.resolve(__dirname,"..");
  let browser,cdp;
  try {
    const extension=path.join(dir,"extension");fs.mkdirSync(extension);
    // Use exactly the release files, without copying private local state.
    for(const file of JSON.parse(fs.readFileSync(path.join(root,"release-files.json"))).extension){
      fs.mkdirSync(path.dirname(path.join(extension,file)),{recursive:true});fs.copyFileSync(path.join(root,file),path.join(extension,file));
    }
    const profile=path.join(dir,"profile");
    fs.mkdirSync(path.join(profile,"Default"),{recursive:true});
    fs.writeFileSync(path.join(profile,"Default","Preferences"),JSON.stringify({extensions:{ui:{developer_mode:true}}}));
    browser=spawn("chromium",["--headless","--no-sandbox","--disable-gpu","--disable-background-networking","--no-first-run","--no-default-browser-check",`--load-extension=${extension}`,`--disable-extensions-except=${extension}`,"--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:"ignore"});
    let endpoint;for(let i=0;i<100;i++){try{endpoint=fs.readFileSync(path.join(profile,"DevToolsActivePort"),"utf8").trim().split("\n");break;}catch{await sleep(100);}}
    assert.ok(endpoint,"fixture browser started");
    cdp=new WebSocket(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);await once(cdp,"open");
    let counter=0;const pending=new Map();const contexts=new Map();
    const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++counter;pending.set(id,{resolve,reject});cdp.send(JSON.stringify({id,method,params,sessionId}));});
    const html=`<!doctype html><title>Isolated reattach fixture</title><main><article data-message-author-role="user" data-message-id="00000000-0000-4000-8000-000000000001">Fixture request</article><article data-message-author-role="assistant">Working</article><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><button data-testid="stop-button">Stop generating</button></main><script>window.fixtureTicks=0;window.fixtureSends=0;setInterval(()=>window.fixtureTicks++,100);document.querySelector('[data-testid="send-button"]').onclick=()=>window.fixtureSends++;</script>`;
    cdp.on("message",bytes=>{const m=JSON.parse(bytes);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result);}
      if(m.method==="Runtime.executionContextCreated") contexts.set(m.params.context.id,m.params.context);
      if(m.method==="Fetch.requestPaused") void call("Fetch.fulfillRequest",{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:"Content-Type",value:"text/html"}],body:Buffer.from(html).toString("base64")},m.sessionId).catch(()=>{});
    });
    async function evaluate(session,expression){const r=await call("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true},session);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
    async function waitFor(fn,label){for(let i=0;i<150;i++){try{const r=await fn();if(r)return r;}catch{}await sleep(100);}throw Error("Timed out: "+label);}
    async function worker(){const t=await waitFor(async()=> (await call("Target.getTargets")).targetInfos.find(t=>t.type==="service_worker"&&t.url.endsWith("/service-worker.js")),"extension worker");const {sessionId}=await call("Target.attachToTarget",{targetId:t.targetId,flatten:true});return {sessionId,id:new URL(t.url).hostname,targetId:t.targetId};}
    let w=await worker();
    const {targetId}=await call("Target.createTarget",{url:"about:blank"});const {sessionId:page}=await call("Target.attachToTarget",{targetId,flatten:true});
    await call("Runtime.enable",{},page);await call("Page.enable",{},page);await call("Fetch.enable",{patterns:[{urlPattern:"*"}]},page);
    const url="https://chatgpt.com/g/g-p-00000000000000000000000000000001-fixture/c/00000000-0000-4000-8000-000000000002";
    await call("Page.navigate",{url},page);
    const tabId=await waitFor(()=>evaluate(w.sessionId,`chrome.tabs.query({url:${JSON.stringify(url)}}).then(t=>t[0]?.id)`),"fixture tab");
    const send=r=>evaluate(w.sessionId,`chrome.tabs.sendMessage(${tabId},${JSON.stringify(r)},{frameId:0})`);
    await waitFor(()=>send({type:"AT_PING"}),"content loaded");
    // Start a loop while a simulated response is still streaming; no send can occur.
    const started=await send({type:"START_LOGIC",message:"Continue",limit:25,rolloverEnabled:true});assert.equal(started.running,true);
    const {targetId:settingsTarget}=await call("Target.createTarget",{url:`chrome-extension://${w.id}/options.html`});
    const {sessionId:settingsPage}=await call("Target.attachToTarget",{targetId:settingsTarget,flatten:true});
    const schedule=await waitFor(()=>evaluate(settingsPage,`chrome.runtime.sendMessage({type:"HB_SAVE",tabId:${tabId},configuration:{kind:"interval",intervalMinutes:60,timeZone:"UTC",prompt:"Invented scheduled check",message:"Continue",limit:25,rolloverEnabled:true}})`),"save fixture heartbeat");
    assert.equal(schedule.ok,true,JSON.stringify(schedule));
    // A failed message ping must not destroy a healthy controller. Execute the
    // fallback probe in the real isolated world, including its live run state.
    const beforeProbe=await send({type:"DB_SNAPSHOT"});
    await evaluate(w.sessionId,`globalThis.originalFixtureSend=chrome.tabs.sendMessage;chrome.tabs.sendMessage=(...args)=>args[1]?.type==='AT_PING'?Promise.reject(new Error('Fixture lost ping')):globalThis.originalFixtureSend.apply(chrome.tabs,args);true`);
    try {
      const attached=await evaluate(settingsPage,`chrome.runtime.sendMessage({type:'AT_ATTACH',tabId:${tabId}})`);
      assert.equal(attached.ok,true,JSON.stringify(attached));assert.equal(attached.attached,false);
    } finally {await evaluate(w.sessionId,`chrome.tabs.sendMessage=globalThis.originalFixtureSend;delete globalThis.originalFixtureSend;true`);}
    const afterProbe=await send({type:"DB_SNAPSHOT"});
    assert.equal(afterProbe.instanceId,beforeProbe.instanceId);assert.equal(afterProbe.running,true);
    await call("Target.closeTarget",{targetId:settingsTarget});
    const snapshot=await send({type:"DB_SNAPSHOT"});
    const queued=await send({type:"DB_EXECUTE",commandId:"fixture-queue",action:"queue_append",target:{instanceId:snapshot.instanceId,url:snapshot.url,revision:snapshot.revision},payload:{text:"Invented queued instruction"}});
    assert.equal(queued.ok,true,JSON.stringify(queued));
    await evaluate(page,'document.querySelector("textarea").value="Unsaved fixture draft"; window.fixtureDocumentToken="unchanged"');
    const initialTicks=await evaluate(page,"window.fixtureTicks");
    for(let cycle=0;cycle<2;cycle++){
      await evaluate(w.sessionId,"setTimeout(()=>chrome.runtime.reload(),50); true");
      await sleep(500);w=await worker();
      await waitFor(async()=>{const s=await send({type:"DB_SNAPSHOT"});return s.logicPhase==="update_paused"&&s.instanceId!==snapshot.instanceId;},"automatic reattachment");
      const state=await send({type:"DB_SNAPSHOT"});assert.equal(state.running,false);assert.equal(state.paused,true);assert.equal(state.queuedPrompts.length,1);assert.equal(state.queuedPrompts[0].text,"Invented queued instruction");
      await waitFor(async()=>{const s=await send({type:"GET_STATUS"});return s.heartbeat?.phase==="paused";},"heartbeat paused after reattachment");
      assert.equal(await evaluate(page,'document.querySelector("textarea").value'),"Unsaved fixture draft");
      assert.equal(await evaluate(page,'document.querySelectorAll("#chatgpt-continue-loop-quick-actions").length'),1);
      assert.equal(await evaluate(page,'document.querySelectorAll("#chatgpt-continue-loop-status").length'),1);
      assert.equal(await evaluate(page,"window.fixtureDocumentToken"),"unchanged");
      assert.equal(await evaluate(page,"window.fixtureSends"),0);
    }
    assert.ok(await evaluate(page,"window.fixtureTicks")>initialTicks,"page response loop kept running");
    // If an old startup loop survived, making the composer ready would send.
    await evaluate(page,`document.querySelector('[data-testid="stop-button"]').remove();document.querySelector("textarea").value=""`);
    await sleep(2500);assert.equal(await evaluate(page,"window.fixtureSends"),0,"retired loops cannot send when the page becomes ready");
    // New checkpoints allow later reloads to resume an already-submitted turn.
    await evaluate(page,`const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop generating';document.querySelector('main').append(stop);`);
    await send({type:"RESUME_LOGIC",message:"Continue",limit:25,rolloverEnabled:true});
    const checkpoint=()=>evaluate(w.sessionId,`chrome.storage.local.get('logicUpdateCheckpoints').then(v=>v.logicUpdateCheckpoints?.[${tabId}]?.settings)`);
    for(let cycle=0;cycle<2;cycle++) {
      await waitFor(async()=>{const c=await checkpoint();return c?.active && c.phase==='monitoring';},"verified update checkpoint");
      const before=await send({type:"DB_SNAPSHOT"});
      await evaluate(w.sessionId,"setTimeout(()=>chrome.runtime.reload(),50); true");await sleep(500);w=await worker();
      const resumed=await waitFor(async()=>{const s=await send({type:"DB_SNAPSHOT"});return s.instanceId!==before.instanceId && s.running && !s.paused && s.logicPhase==='monitoring' ? s : null;},"automatic Logic resume");
      assert.equal(resumed.count,before.count);assert.equal(resumed.limit,before.limit);
      assert.equal(resumed.queuedPrompts.length,1);assert.equal(await evaluate(page,"window.fixtureSends"),0);
      assert.equal(await evaluate(page,"window.fixtureDocumentToken"),"unchanged");
      assert.equal(await evaluate(page,'document.querySelectorAll("#chatgpt-continue-loop-quick-actions").length'),1);
    }
    await send({type:"TOGGLE_LOGIC_PAUSE"});
    await waitFor(async()=>{const c=await checkpoint();return c && !c.active && c.paused;},"durable manual pause");
    const pausedBefore=await send({type:"DB_SNAPSHOT"});
    await evaluate(w.sessionId,"setTimeout(()=>chrome.runtime.reload(),50); true");await sleep(500);w=await worker();
    await waitFor(async()=>{const s=await send({type:"DB_SNAPSHOT"});return s.instanceId!==pausedBefore.instanceId && !s.running && s.paused;},"manual pause preserved");
    assert.equal(await evaluate(page,"window.fixtureSends"),0);
    // A forged page event may stop automation, but cannot start it or send.
    await evaluate(page,'document.dispatchEvent(new Event("threadlamp:detach"))');
    await sleep(300);assert.equal(await evaluate(page,"window.fixtureSends"),0);
    console.log("PASS: lost ping preserves live controller; five real extension reloads; safe draft fallback, two automatic resumes, preserved manual pause, unchanged page and queue, no duplicate sends.");
  }finally{cdp?.close();browser?.kill("SIGTERM");}
})().catch(error=>{console.error(error);process.exitCode=1;});
