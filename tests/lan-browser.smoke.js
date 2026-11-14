/* Copyright (c) 2026 Phosphoros Research and contributors. SPDX-License-Identifier: MPL-2.0 */
/* Isolated Chromium profile and invented agent; never uses the installed extension. */
"use strict";
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),net=require("node:net");
const {spawn,execFileSync}=require("node:child_process"),{once}=require("node:events"),assert=require("node:assert/strict"),{WebSocket}=require("ws");
const {init}=require("../helper/cli.js"),{createHelper}=require("../helper/server.js");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();s.listen(0,"127.0.0.1");await once(s,"listening");const p=s.address().port;await new Promise(r=>s.close(r));return p;}
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"threadlamp-lan-browser-"));let chrome,helper,bridge,cdp;
  try {
    const webPort=await port(),bridgePort=await port(),privateDir=path.join(dir,"private");init(privateDir,"127.0.0.1",webPort,bridgePort);
    const config=JSON.parse(fs.readFileSync(path.join(privateDir,"config.json"))),password=fs.readFileSync(path.join(privateDir,"pairing.txt"),"utf8").match(/Dashboard access key: (.+)/)[1];
    helper=createHelper(config,{key:fs.readFileSync(path.join(privateDir,"server-key.pem")),cert:fs.readFileSync(path.join(privateDir,"server-cert.pem"))});await helper.start();
    bridge=new WebSocket(`ws://127.0.0.1:${bridgePort}/threadlamp/bridge`,{origin:`chrome-extension://${"a".repeat(32)}`});await once(bridge,"open");const ready=once(bridge,"message");bridge.send(JSON.stringify({type:"auth",protocol:1,token:config.bridgeToken}));await ready;
    const agent={tabId:17,instanceId:"invented-agent",revision:"1",url:"https://chatgpt.com/c/example",title:"Example Project",chatTitle:"Example chat",online:true,running:false,mode:"idle",logicPhase:"idle",queuedPrompts:[],capabilities:{queue:true,queue_append:true,cancel_queue:true,start_logic:true}};
    const actions=[];
    bridge.on("message",bytes=>{
      const message=JSON.parse(bytes);if(message.type!=="request")return;
      const r=message.request;let response={ok:true};
      if(r.type==="DB_LIST")response={ok:true,agents:[agent,{...agent,tabId:18,instanceId:"other-invented-agent",title:"Other Project",url:"https://chatgpt.com/c/other-example"}],events:[],version:"1.13.0"};
      if(r.type==="DB_INSPECT")response={ok:true,schedule:null,connection:null,defaultPrompt:"Check scheduled work."};
      if(r.type==="HA_GET_SETTINGS")response={enabled:false,approvalMessage:"Approved",connection:{phase:"disconnected"}};
      if(r.type==="ALERT_GET_SETTINGS")response={soundEnabled:true};
      if(r.type==="DB_COMMAND"){actions.push(r);if(["queue","queue_append"].includes(r.action))agent.queuedPrompts.push({id:String(actions.length),text:r.payload.text});}
      bridge.send(JSON.stringify({type:"response",id:message.id,response}));
    });
    const profile=path.join(dir,"chrome");
    chrome=spawn("chromium",["--headless","--no-sandbox","--disable-gpu","--disable-extensions","--disable-background-networking","--no-first-run","--no-default-browser-check","--ignore-certificate-errors","--allow-file-access-from-files","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:"ignore"});
    let endpoint;for(let i=0;i<100;i++){try{endpoint=fs.readFileSync(path.join(profile,"DevToolsActivePort"),"utf8").trim().split("\n");break;}catch{await sleep(100);}}assert.ok(endpoint,"isolated Chromium started");
    cdp=new WebSocket(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);await once(cdp,"open");
    let counter=0;const pending=new Map(),errors=[];
    cdp.on("message",bytes=>{const m=JSON.parse(bytes);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result);}if(m.method==="Runtime.exceptionThrown")errors.push(m.params.exceptionDetails.text);});
    const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++counter;pending.set(id,{resolve,reject});cdp.send(JSON.stringify({id,method,params,sessionId}));});
    const {targetId}=await call("Target.createTarget",{url:"about:blank"});const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
    const command=(method,params)=>call(method,params,sessionId);await command("Runtime.enable");await command("Page.enable");
    const evaluate=async expression=>{const r=await command("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);return r.result.value;};
    const waitFor=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await sleep(100);}throw Error("Browser condition timed out: "+expression);};
    await command("Page.navigate",{url:config.origin});await waitFor('!!document.getElementById("login-form")');
    await waitFor('!!document.querySelector(".lan-install button")');
    const appManifest=await command("Page.getAppManifest");
    assert.deepEqual(appManifest.errors,[]);assert.equal(JSON.parse(appManifest.data).display,"fullscreen");
    await evaluate('document.querySelector(".lan-install button").click()');
    assert.match(await evaluate('document.querySelector(".lan-install p").textContent'),/Add to Home screen/);
    await evaluate(`window.installCalls=0;const installEvent=new Event("beforeinstallprompt",{cancelable:true});installEvent.prompt=async()=>{window.installCalls++};installEvent.userChoice=Promise.resolve({outcome:"dismissed"});window.dispatchEvent(installEvent);document.querySelector(".lan-install button").click()`);
    assert.equal(await evaluate('window.installCalls'),1);
    assert.match(await evaluate('document.querySelector(".lan-install p").textContent'),/dismissed/);
    await evaluate('document.querySelector(".lan-install button").click()');
    assert.equal(await evaluate('window.installCalls'),1,"dismissed prompt cannot be reused");
    await evaluate(`document.getElementById("access-key").value=${JSON.stringify(password)};document.getElementById("login-form").requestSubmit()`);
    await waitFor('document.querySelectorAll(".agent-select").length === 2');
    assert.equal(await evaluate('typeof chrome.runtime'),"undefined","LAN UI needs no extension API");
    assert.equal(await evaluate('!!document.querySelector(".preferences-body .lan-install")'),true);
    assert.equal(await evaluate('!!document.querySelector(".preferences-body #lan-sign-out")'),true);
    assert.equal(await evaluate('!!document.querySelector(".top-actions #lan-sign-out")'),false);
    assert.equal(await evaluate('document.getElementById("lan-camera-layout").value'),"safe");
    await evaluate('document.getElementById("lan-camera-layout").value="right";document.getElementById("lan-camera-layout").dispatchEvent(new Event("change"))');
    await evaluate('window.dispatchEvent(new Event("appinstalled"))');
    assert.equal(await evaluate('document.querySelector(".lan-install button").hidden'),true);

    await evaluate('document.querySelector(".agent-select").click()');
    await waitFor('document.getElementById("agent-title").textContent === "Example Project"');
    await evaluate('document.getElementById("queued").value="Example LAN message";document.querySelector(\'[data-action="queue"]\').click()');
    await waitFor('document.getElementById("queued").value === ""');assert.equal(actions.length,1);assert.equal(actions[0].payload.text,"Example LAN message");assert.equal(actions[0].target.instanceId,"invented-agent");
    assert.equal(await evaluate('document.getElementById("refresh").getAttribute("aria-label")'),"Reload dashboard");
    await evaluate('window.reloadSentinel=true;window.confirm=message=>{window.reloadWarning=message;return false};document.getElementById("queued").value="Keep this draft";document.getElementById("queued").dispatchEvent(new Event("input",{bubbles:true}));document.querySelectorAll(".agent-select")[1].click();document.getElementById("refresh").click()');
    assert.match(await evaluate('window.reloadWarning'),/Unsent dashboard drafts/);
    assert.equal(await evaluate('window.reloadSentinel'),true,"cancelled reload preserves document");
    assert.equal(await evaluate('document.getElementById("queued").value'),"","warning covers a different agent's draft");
    await evaluate('document.querySelector(".agent-select").click()');
    assert.equal(await evaluate('document.getElementById("queued").value'),"Keep this draft");
    await evaluate('LanDashboardAPI.reloadDashboard({pending:true})');
    assert.match(await evaluate('window.reloadWarning'),/command is still pending/);
    await evaluate('window.confirm=()=>true;setTimeout(()=>document.getElementById("refresh").click(),0)');
    await waitFor('!window.reloadSentinel && document.querySelectorAll(".agent-select").length === 2');
    assert.equal(actions.length,1,"reload never replays a queued command");
    assert.equal(await evaluate('performance.getEntriesByType("navigation")[0].type'),"reload");
    assert.equal(await evaluate('document.getElementById("lan-camera-layout").value'),"right","camera choice survives reload");
    await evaluate('document.getElementById("lan-camera-layout").value="safe";document.getElementById("lan-camera-layout").dispatchEvent(new Event("change"))');
    await command("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'),"reload control fits Android dashboard width");
    assert.ok(await evaluate('document.getElementById("refresh").getBoundingClientRect().right <= innerWidth'),"reload remains visible");
    const fullscreen=await command("Runtime.evaluate",{expression:"document.documentElement.requestFullscreen()",awaitPromise:true,userGesture:true});
    assert.equal(fullscreen.exceptionDetails,undefined);
    await waitFor('document.documentElement.classList.contains("lan-installed")');
    for(const [height,top,bottom] of [[820,24,16],[844,0,0],[820,24,16],[540,0,0],[844,0,0]]) {
      await command("Emulation.setSafeAreaInsetsOverride",{insets:{top,bottom,left:0,right:0}});
      await command("Emulation.setDeviceMetricsOverride",{width:390,height,deviceScaleFactor:1,mobile:true});
      await waitFor('Math.abs(document.body.getBoundingClientRect().height - visualViewport.height) < 1');
      const geometry=await evaluate('({top:document.querySelector(".topbar").getBoundingClientRect().top,header:document.querySelector(".topbar").getBoundingClientRect().height,bottom:document.querySelector(".app-status").getBoundingClientRect().bottom,viewport:visualViewport.height,padding:getComputedStyle(document.body).paddingTop})');
      assert.equal(geometry.top,0,"header paints from the viewport edge without a blank strip");
      assert.equal(geometry.header,58+top,"safe inset stays inside the header and updates dynamically");
      assert.equal(geometry.padding,"0px");
      assert.ok(Math.abs(geometry.bottom-geometry.viewport)<1,"footer fills the changing viewport");
    }
    // Generic corner camera: 43 CSS px high and 58 px wide, with a visible badge.
    for (const side of ["right", "left"]) {
      await evaluate(`document.getElementById("lan-camera-layout").value=${JSON.stringify(side)};document.getElementById("lan-camera-layout").dispatchEvent(new Event("change"))`);
      for (const width of [411,390,360]) {
        await command("Emulation.setSafeAreaInsetsOverride",{insets:{top:43,bottom:0,left:0,right:0}});
        await command("Emulation.setDeviceMetricsOverride",{width,height:869,deviceScaleFactor:1,mobile:true});
        await waitFor('Math.abs(document.body.getBoundingClientRect().height-visualViewport.height)<1');
        const g=await evaluate(`(() => {
          const badge=document.getElementById("activity-count");badge.hidden=false;badge.textContent="999";
          const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height}};
          return {header:rect(document.querySelector(".topbar")),controls:[...document.querySelectorAll(".top-actions button")].map(rect),brand:rect(document.querySelector(".brand")),overflow:document.documentElement.scrollWidth>innerWidth};
        })()`);
        assert.equal(g.header.height,58,"corner camera no longer adds an empty top row");
        assert.equal(g.overflow,false);
        for (const r of [...g.controls,g.brand]) {
          assert.ok(side==="right" ? r.right<=width-58 : r.left>=58,"header stays beside the corner cutout");
          assert.ok(r.top>=0 && r.bottom<=58 && r.left>=0 && r.right<=width,"controls remain on screen");
        }
        for (let i=1;i<g.controls.length;i++) assert.ok(g.controls[i].left>=g.controls[i-1].right,"header buttons do not overlap");
        assert.ok(g.controls[0].left>=g.brand.right,"brand and controls do not overlap");
        if(side==="right" && width===411 && process.env.THREADLAMP_CAMERA_SCREENSHOT) {
          const shot=await command("Page.captureScreenshot",{format:"png"});fs.writeFileSync(process.env.THREADLAMP_CAMERA_SCREENSHOT,Buffer.from(shot.data,"base64"));
        }
      }
    }
    await command("Emulation.setDeviceMetricsOverride",{width:320,height:844,deviceScaleFactor:1,mobile:true});
    assert.equal(await evaluate('document.querySelector(".topbar").getBoundingClientRect().height'),101,"narrow display retains full camera clearance");
    await command("Emulation.setSafeAreaInsetsOverride",{insets:{top:0,bottom:0,left:43,right:0}});
    await command("Emulation.setDeviceMetricsOverride",{width:700,height:390,deviceScaleFactor:1,mobile:true});
    assert.ok(await evaluate('document.querySelector(".brand").getBoundingClientRect().left >= 43'),"landscape retains side clearance");
    await command("Emulation.setSafeAreaInsetsOverride",{insets:{top:0,bottom:0,left:0,right:0}});
    await command("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await command("Emulation.setPageScaleFactor",{pageScaleFactor:2});
    await waitFor('Math.abs(document.body.getBoundingClientRect().height-innerHeight)<1');
    await command("Emulation.setPageScaleFactor",{pageScaleFactor:1});
    await waitFor('Math.abs(document.body.getBoundingClientRect().height-visualViewport.height)<1');
    if(process.env.THREADLAMP_VIEWPORT_SCREENSHOT) {
      const shot=await command("Page.captureScreenshot",{format:"png"});fs.writeFileSync(process.env.THREADLAMP_VIEWPORT_SCREENSHOT,Buffer.from(shot.data,"base64"));
    }
    await evaluate('document.exitFullscreen()');
    await waitFor('!document.documentElement.classList.contains("lan-installed")');
    assert.equal(await evaluate('document.documentElement.style.getPropertyValue("--lan-viewport-height")'),"");
    if(process.env.THREADLAMP_RELOAD_SCREENSHOT) {
      const shot=await command("Page.captureScreenshot",{format:"png"});fs.writeFileSync(process.env.THREADLAMP_RELOAD_SCREENSHOT,Buffer.from(shot.data,"base64"));
    }
    await command("Emulation.setDeviceMetricsOverride",{width:500,height:900,deviceScaleFactor:1,mobile:true});
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'),"mobile LAN dashboard has no horizontal overflow");
    await evaluate('document.getElementById("queued").value="Unsent draft";document.getElementById("queued").dispatchEvent(new Event("input",{bubbles:true}));fetch("/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})');
    await evaluate('LanDashboardAPI.sendMessage({type:"DB_LIST"}).catch(()=>{})');
    assert.equal(await evaluate('document.getElementById("queued").value'),"Unsent draft");assert.equal(await evaluate('document.getElementById("lan-sign-in").hidden'),false);
    assert.equal(new URL(await evaluate('location.href')).pathname,"/","expired session preserves drafts");
    await command("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await command("Page.navigate",{url:config.origin+"/login"});await waitFor('!!document.querySelector(".lan-install button")');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'),"Android-sized sign-in/install page has no overflow");
    if(process.env.THREADLAMP_SMOKE_SCREENSHOT) {
      const shot=await command("Page.captureScreenshot",{format:"png"});fs.writeFileSync(process.env.THREADLAMP_SMOKE_SCREENSHOT,Buffer.from(shot.data,"base64"));
    }
    await evaluate('window.loginReloadSentinel=true;document.getElementById("access-key").value="unsent-key";window.confirm=()=>false;document.getElementById("lan-reload").click()');
    assert.equal(await evaluate('document.getElementById("access-key").value'),"unsent-key");
    await evaluate('document.getElementById("access-key").value="";setTimeout(()=>document.getElementById("lan-reload").click(),0)');
    await waitFor('!window.loginReloadSentinel && !!document.getElementById("lan-reload")');
    const local=path.join(dir,"local");execFileSync(process.execPath,[path.join(__dirname,"dashboard-ui.fixture.js"),local]);
    for(const width of [1440,500]) {
      await command("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:false});
      await command("Page.navigate",{url:`file://${local}/index.html`});await waitFor('!!document.getElementById("smoke-result")');
      const results=await evaluate('[...document.querySelectorAll("#smoke-result")].map(n=>n.textContent)');assert.equal(results.length,1);assert.match(results[0],/^PASS:/);
    }
    assert.deepEqual(errors,[]);console.log("PASS: saved camera layout, compact corner headers with activity badge, narrow/landscape fallback, Sign out in Settings; full-screen dynamic viewport/insets, keyboard-sized viewport, zoom and fullscreen exit; dashboard/login reload, hidden-agent draft cancellation, pending-command warning, no replay; PWA manifest, install prompt and dismissal, installed state, Android-sized login; HTTPS login, real LAN RPC, queue target, mobile layout, session expiry preserves drafts; local dashboard desktop/mobile regression.");
  } finally {
    cdp?.close();bridge?.terminate();if(chrome && chrome.exitCode === null && chrome.signalCode === null){const closed=once(chrome,"exit");chrome.kill("SIGTERM");await closed;}
    if(helper)await helper.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
