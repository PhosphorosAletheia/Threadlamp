/* Copyright (c) 2026 Phosphoros Research and contributors. SPDX-License-Identifier: MPL-2.0 */
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), https = require("node:https"), net = require("node:net");
const {once} = require("node:events"), {WebSocket} = require("ws");
const {init,privateHost} = require("../helper/cli.js"), {createHelper} = require("../helper/server.js");
const protocol = require("../lan-protocol.js");
async function freePort() { const server=net.createServer(); server.listen(0,"127.0.0.1"); await once(server,"listening"); const port=server.address().port; await new Promise(r=>server.close(r)); return port; }
test("LAN helper authenticates, restricts authority, and never replays uncertain commands", async t => {
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),"threadlamp-lan-test-")), dir=path.join(parent,"private");
  const port=await freePort(), bridgePort=await freePort();
  init(dir,"127.0.0.1",port,bridgePort);
  const config=JSON.parse(fs.readFileSync(path.join(dir,"config.json"))), pairing=fs.readFileSync(path.join(dir,"pairing.txt"),"utf8");
  const password=pairing.match(/Dashboard access key: (.+)/)[1];
  assert.equal(fs.statSync(dir).mode & 0o777,0o700);
  assert.equal(fs.statSync(path.join(dir,"pairing.txt")).mode & 0o777,0o600);
  assert.throws(()=>init(dir,"127.0.0.1"),/already exists/);
  for(const ip of ["0.0.0.0","8.8.8.8","localhost","::1","172.32.0.1"]) assert.equal(privateHost(ip),false);
  const helper=createHelper(config,{key:fs.readFileSync(path.join(dir,"server-key.pem")),cert:fs.readFileSync(path.join(dir,"server-cert.pem"))},{rpcTimeout:100,authTimeout:500});
  t.after(async()=>{await helper.close();fs.rmSync(parent,{recursive:true,force:true});}); await helper.start();
  const req=(url,body,cookie="",extra={})=>new Promise((resolve,reject)=>{
    const bytes=body===undefined?undefined:JSON.stringify(body);
    const request=https.request(config.origin+url,{rejectUnauthorized:false,method:bytes===undefined?"GET":"POST",headers:{Origin:config.origin,"Content-Type":"application/json",...(bytes?{"Content-Length":Buffer.byteLength(bytes)}:{}),...(cookie?{Cookie:cookie}:{}),...extra}},res=>{
      const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()}));
    });request.on("error",reject);request.end(bytes);
  });
  assert.equal((await req("/")).status,303);
  assert.equal((await req("/dashboard.js")).status,303);
  assert.equal((await req("/rpc",{type:"DB_LIST"})).status,401);
  assert.equal((await req("/login",{password},"",{Origin:"https://evil.example"})).status,403);
  assert.equal((await req("/login",{password},"",{Host:"evil.example"})).status,421);
  assert.equal((await req("/login",{password:"incorrect"})).status,401);
  const login=await req("/login",{password}); assert.equal(login.status,200);
  assert.match(login.headers["set-cookie"][0],/HttpOnly; Secure; SameSite=Strict/);
  const cookie=login.headers["set-cookie"][0].split(";")[0];
  const page=await req("/",undefined,cookie);assert.match(page.text,/src="\/lan-client.js"/);assert.match(page.headers["content-security-policy"],/frame-ancestors 'none'/);
  assert.equal((await req("/helper/server.js",undefined,cookie)).status,404);
  assert.equal((await req("/config.json",undefined,cookie)).status,404);
  for(const type of ["HA_EXPORT_SETTINGS","HA_SAVE_SETTINGS","LAN_SAVE","DB_RECORD","SL_SETUP"]) {
    assert.equal((await req("/rpc",{type},cookie)).status,403);
  }
  assert.equal((await req("/rpc",{type:"DB_COMMAND",action:"arbitrary"},cookie)).status,403);
  assert.equal((await req("/rpc",{type:"DB_LIST"},cookie,{Origin:"https://evil.example"})).status,403);
  assert.match((await req("/rpc",{type:"DB_LIST"},cookie)).text,/offline/);
  async function connect(token=config.bridgeToken) {
    const ws=new WebSocket(`ws://127.0.0.1:${bridgePort}/threadlamp/bridge`,{origin:`chrome-extension://${"a".repeat(32)}`});
    await once(ws,"open"); const result=Promise.race([once(ws,"message").then(([data])=>JSON.parse(data)),once(ws,"close").then(()=>null)]);
    ws.send(JSON.stringify({type:"auth",protocol:1,token}));return {ws,result:await result};
  }
  const bad=await connect("x".repeat(43));assert.equal(bad.result,null);
  const first=await connect();assert.equal(first.result.type,"ready");
  const duplicate=await connect();assert.equal(duplicate.result,null,"a second bridge cannot replace the owner");
  let received=[];first.ws.on("message",data=>{const message=JSON.parse(data);received.push(message);if(message.request?.type==="DB_LIST")first.ws.send(JSON.stringify({type:"response",id:message.id,response:{ok:true,agents:[]}}));});
  assert.deepEqual(JSON.parse((await req("/rpc",{type:"DB_LIST"},cookie)).text),{ok:true,agents:[]});
  const timedOut=JSON.parse((await req("/rpc",{type:"DB_COMMAND",action:"queue_append"},cookie)).text);
  assert.equal(timedOut.uncertain,true);assert.match(timedOut.error,/not be replayed/);
  const closed=once(first.ws,"close");first.ws.close();await closed;
  const second=await connect();assert.equal(second.result.type,"ready");
  const replay=[];second.ws.on("message",data=>replay.push(JSON.parse(data)));await new Promise(r=>setTimeout(r,150));assert.equal(replay.length,0);
  const pending=req("/rpc",{type:"DB_COMMAND",action:"stop"},cookie);await once(second.ws,"message");second.ws.terminate();assert.equal(JSON.parse((await pending).text).uncertain,true);
  const malformed=await connect();malformed.ws.send("null");await once(malformed.ws,"close");
  assert.equal((await req("/login")).status,200,"malformed bridge JSON cannot crash the server");
  assert.equal((await req("/logout",{},cookie)).status,200);assert.equal((await req("/rpc",{type:"DB_LIST"},cookie)).status,401);
  for(let i=0;i<4;i++) await req("/login",{password:"incorrect"});
  assert.equal((await req("/login",{password})).status,429);
  assert.equal(received.filter(m=>m.request?.action==="queue_append").length,1);
  assert.equal(protocol.allowed({type:"DB_COMMAND",action:"heartbeat_run"}),true);
});
