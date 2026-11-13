/* Copyright (c) 2026 Phosphoros Research and contributors. SPDX-License-Identifier: MPL-2.0 */
"use strict";
const test=require("node:test"), assert=require("node:assert/strict"), vm=require("node:vm");
const {harness,sourceUrl,popup}=require("./heartbeat.test.js");
test("paired LAN worker revokes stale sockets and preserves dashboard identity checks",async()=>{
  const sockets=[];
  class Socket {
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this);}
    send(text){this.sent.push(JSON.parse(text));}
    close(){this.readyState=3;this.onclose?.();}
    open(){this.readyState=1;this.onopen();}
    async receive(message){await this.onmessage({data:JSON.stringify(message)});}
  }
  const h=await harness({}, {configureContext:c=>{c.WebSocket=Socket;}});
  assert.equal((await h.dispatch({type:"LAN_GET"})).phase,"disabled");
  const token="a".repeat(43);
  assert.equal((await h.dispatch({type:"LAN_SAVE",enabled:true,token,port:3211},{id:"attacker",url:popup.url})).ok,false);
  assert.equal(sockets.length,0);
  const saved=await h.dispatch({type:"LAN_SAVE",enabled:true,token,port:3211});assert.equal(saved.ok,true);assert.equal(saved.token,undefined);
  const socket=sockets[0];assert.equal(socket.url,"ws://127.0.0.1:3211/threadlamp/bridge");socket.open();
  assert.equal(socket.sent[0].token,token);await socket.receive({type:"ready",protocol:1});
  assert.equal((await h.dispatch({type:"LAN_GET"})).phase,"connected");
  const snapshot={url:sourceUrl,instanceId:"agent-A",revision:"current",running:true,online:true};
  let executed=0;h.setPageHandler(async(id,message)=>{
    if(message.type==="DB_SNAPSHOT")return snapshot;
    if(message.type==="DB_EXECUTE"){executed++;return {ok:true};}
    throw Error("Unexpected page request");
  });
  const request={type:"DB_COMMAND",action:"queue_append",commandId:"lan-command-1",target:{tabId:17,...snapshot,revision:"stale"},payload:{text:"test instruction"}};
  await socket.receive({type:"request",id:"stale",request});
  assert.match(socket.sent.at(-1).response.error,/agent changed/);assert.equal(executed,0);
  request.target.revision="current";request.commandId="lan-command-2";
  await socket.receive({type:"request",id:"fresh",request});assert.equal(socket.sent.at(-1).response.ok,true);assert.equal(executed,1);
  await socket.receive({type:"request",id:"repeat",request});assert.equal(executed,1,"receipt prevents duplicate dispatch");
  await socket.receive({type:"request",id:"settings",request:{type:"HA_GET_SETTINGS"}});
  assert.deepEqual(Object.keys(socket.sent.at(-1).response).sort(),["approvalMessage","connection","enabled"]);
  // Hold initialization so a request cannot enter the command router before disabling.
  vm.runInContext("globalThis.previousInitialization = initializationPromise; initializationPromise = new Promise(resolve => globalThis.releaseInitialization = resolve)",h.context);
  request.commandId="lan-command-3";
  const waiting=socket.receive({type:"request",id:"revoked",request});
  assert.equal((await h.dispatch({type:"LAN_SAVE",enabled:false})).phase,"disabled");
  h.context.releaseInitialization();await waiting;assert.equal(executed,1);
  vm.runInContext("initializationPromise = previousInitialization",h.context);
  await socket.receive({type:"request",id:"old-socket",request});assert.equal(executed,1);
  await h.dispatch({type:"LAN_SAVE",enabled:true});const next=sockets[1];next.open();await next.receive({type:"ready",protocol:1});
  await next.receive({type:"request",id:"forbidden",request:{type:"SETTINGS_EXPORT"}});assert.equal(next.readyState,3);assert.equal(executed,1);
  await h.dispatch({type:"LAN_SAVE",enabled:false});
});
