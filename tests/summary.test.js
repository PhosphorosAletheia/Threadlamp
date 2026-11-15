/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { harness, sourceUrl, popup } = require("./heartbeat.test.js");
const { fixture } = require("./delivery-timeout.test.js");
const CONFIG = "logicSummaryConfig", RECORDS = "logicRunSummaries";
const saved = { [CONFIG]: { enabled: true, apiKey: "invented-test-key" } };
const completion = (id = "output-1", output = "Implemented the requested change.\n[[LOGIC:SUMMARY: Change implemented and checked.]]\n[[LOGIC:IDLE]]") => ({ type: "SUM_COMPLETE", url: sourceUrl, completion: id, output, flag: "idle" });
const sender = h => ({ id: popup.id, frameId: 0, url: sourceUrl, tab: { ...h.tabs.get(17) } });
const result = text => ({ ok: true, json: async () => ({ model: "test/free", choices: [{ message: { content: text } }] }) });
async function setup(fetch = async () => result("Implemented and checked the requested change."), initial = saved, configure = () => {}) {
  const calls = [];
  const h = await harness(structuredClone(initial), { configureContext(context) {
    context.AbortController = AbortController;
    context.fetch = async (...args) => { calls.push(args); return fetch(...args); };
    configure(context);
  } });
  await h.context.SummaryWorker.list();
  return Object.assign(h, { calls, summary: () => h.local.values[RECORDS]?.[sourceUrl] });
}

test("content captures only each finished response regardless of its Logic tag", async () => {
  const f = fixture(); f.hide();
  const requests = [];
  f.setRequestHandler(async r => { requests.push(r); return { ok: true, enabled: false }; });
  for (const flag of ["continue", "wait", "user_input", "idle", "invalid_wait"]) {
    const text = `Output only for ${flag}. [[LOGIC:${flag.toUpperCase()}]]`;
    f.api.publishOutputSummary({ element: f.assistant(), text }, flag);
    const request = requests.at(-1);
    assert.equal(request.type, "SUM_COMPLETE");
    assert.equal(request.output, text);
    assert.equal(JSON.stringify(request).includes(f.user().textContent), false);
    assert.equal(JSON.stringify(request).includes("Previous completed reply"), false);
  }
  const count = requests.length;
  f.api.publishOutputSummary({ text: "Unfinished" }, "missing");
  assert.equal(requests.length, count, "wait for a completed tag");
  requests.length = 0;
  await f.run();
  const outputs = requests.filter(r => r.type === "SUM_COMPLETE");
  assert.deepEqual(outputs.map(r => r.flag), ["continue", "idle"], "real Logic loop emits each completed output separately");
  assert.equal(outputs[1].output, "Recovered.\n[[LOGIC:IDLE]]");
});

test("Logic summaries are local, bounded, deduplicated and independent of provider settings", async () => {
  const h = await setup(async () => {throw new Error("must not call provider");}, {});
  await h.dispatch(completion(), sender(h));
  assert.equal(h.summary().last.text, "Change implemented and checked.");
  assert.equal(h.summary().last.model, "Logic Mode");
  assert.equal((await h.dispatch(completion(), sender(h))).deduplicated, true);
  assert.equal(h.calls.length, 0);
  assert.equal(JSON.stringify(h.local.values).includes("Implemented the requested change."), false);
  for (const [id, output] of [
    ["old", "Done.\n[[LOGIC:IDLE]]"],
    ["long", `[[LOGIC:SUMMARY: ${"a".repeat(601)}]]\n[[LOGIC:IDLE]]`],
    ["duplicate", "[[LOGIC:SUMMARY: First]]\n[[LOGIC:SUMMARY: Second]]\n[[LOGIC:IDLE]]"],
    ["trailing", "[[LOGIC:SUMMARY: Done]]\n[[LOGIC:IDLE]]\nMore"],
    ["wrongflag", "[[LOGIC:SUMMARY: Done]]\n[[LOGIC:CONTINUE]]"]
  ]) {
    await h.dispatch(completion(id,output), sender(h));
    assert.equal(h.summary().status, "error", id);
    assert.equal(h.summary().last.text, "Change implemented and checked.");
  }
  await h.dispatch(completion("boundary", `[[LOGIC:SUMMARY: ${"a".repeat(600)}]]\n[[LOGIC:IDLE]]`), sender(h));
  assert.equal(h.summary().last.text.length, 600);
  await h.dispatch(completion("rendered-paragraphs", "[[LOGIC:SUMMARY: Paragraph spacing.]]\n\n[[LOGIC:IDLE]]"),sender(h));
  assert.equal(h.summary().last.text,"Paragraph spacing.");
  await h.dispatch({type:"SUM_CLEAR"});
  assert.equal(h.summary(), undefined);
  assert.equal(h.calls.length, 0);
});

test("all control endings permit SUMMARY and BRIEF still reaches input notifications", async () => {
  const h = await setup();
  for (const [tag,flag] of [["CONTINUE","continue"],["WAIT:15m","wait"],["WAIT:999m","invalid_wait"],["IDLE","idle"],["USER_INPUT","user_input"]]) {
    await h.dispatch({...completion(tag, `Result.\n[[LOGIC:BRIEF: Choose a format.]]\n[[LOGIC:SUMMARY: Waiting for a format.]]\n[[LOGIC:${tag}]]`),flag}, sender(h));
    assert.equal(h.summary().status,"ready",tag);
  }
  const f = fixture();
  f.api.setResponseForTest("Choose a format.\n[[LOGIC:BRIEF: Choose PDF or text.]]\n[[LOGIC:SUMMARY: Waiting for format selection.]]\n[[LOGIC:USER_INPUT]]");
  await f.api.runLogicMode(f.api.state.runId,true);
  assert.equal(f.api.state.userInputBrief,"Choose PDF or text.");
});

test("only an explicit trusted Rewrite request sends the selected draft and keeps results out of storage", async () => {
  const h = await setup(async () => result("Please inspect the current queue."));
  const req = {type:"SUM_REWRITE",text:"inspect teh que",limit:4000};
  assert.equal((await h.dispatch(req,sender(h))).ok,false);
  for (const source of [popup,{...sender(h),frameId:1},{...sender(h),id:"foreign"}]) {
    assert.equal((await h.dispatch(completion(),source)).ok,false);
  }
  const r = await h.dispatch(req); assert.equal(r.text,"Please inspect the current queue.");
  const body = JSON.parse(h.calls[0][1].body);
  assert.equal(body.messages[1].content,req.text); assert.equal(body.model,"openrouter/free");
  assert.equal(body.max_completion_tokens,4096);
  assert.equal(h.calls[0][1].redirect,"error");
  assert.equal(JSON.stringify(h.local.values).includes(req.text),false);
  assert.equal(JSON.stringify(h.local.values).includes(r.text),false);
  assert.equal((await h.dispatch({...req,text:"x".repeat(4001)})).ok,false);
  assert.equal(h.calls.length,1);
  assert.equal((await h.context.DashboardWorker.remote({...req,text:"A LAN draft"})).ok,true);
});

test("Rewrite failures preserve privacy and shared cooldown survives worker restart", async () => {
  let now=Date.now(); class Clock extends Date {static now(){return now;}}
  const configure=c=>{c.Date=Clock;};
  const h=await setup(async()=>({ok:false,status:429,headers:{get:()=>"120"}}),saved,configure);
  const req={type:"SUM_REWRITE",text:"private draft",limit:8000};
  assert.match((await h.dispatch(req)).error,/rate limit/);
  assert.match((await h.dispatch(req)).error,/cooling down/); assert.equal(h.calls.length,1);
  const restarted=await setup(async()=>result("Clear request"),h.local.values,configure);
  assert.match((await restarted.dispatch(req)).error,/cooling down/); assert.equal(restarted.calls.length,0);
  now+=120001;
  assert.equal((await restarted.dispatch(req)).text,"Clear request");
  for (const response of [{ok:true,json:async()=>({error:{message:"private provider body"}})},result("x".repeat(8001)),{ok:true,json:async()=>{throw new SyntaxError("private body");}}]) {
    const failing=await setup(async()=>response);
    const r=await failing.dispatch(req); assert.equal(r.ok,false); assert.equal(r.error.includes("private"),false);
  }
  const network=await setup(async()=>{throw new Error("private network detail");});
  assert.match((await network.dispatch(req)).error,/network/);
  const report = (await network.dispatch({type:"DG_EXPORT"})).report;
  assert.ok(report.events.some(e=>e.event==="rewrite_error" && e.reason==="rewrite_network"));
  assert.equal(JSON.stringify(report).includes(req.text),false);
  const timed=await setup((_u,o)=>new Promise((_r,reject)=>o.signal.addEventListener("abort",()=>reject(new Error("aborted")))),saved,c=>{c.setTimeout=(fn,ms)=>setTimeout(fn,ms===25000?5:ms);});
  assert.match((await timed.dispatch(req)).error,/timed out/);
});

test("Rewrite limits concurrency and rejects cancellation after settings change", async()=>{
  const pending=[];
  const h=await setup((_u,o)=>new Promise(resolve=>pending.push({resolve,o})));
  const req={type:"SUM_REWRITE",text:"Clarify this",limit:4000};
  const first=h.dispatch(req),second=h.dispatch(req);
  while(pending.length<2) await h.flush();
  assert.match((await h.dispatch(req)).error,/already in progress/);
  await h.dispatch({type:"SUM_FORGET"});
  pending.forEach(p=>p.resolve(result("Late rewrite")));
  for(const r of await Promise.all([first,second])) assert.match(r.error,/cancelled/);
  assert.equal((await h.dispatch({type:"SUM_GET"})).keySaved,false);
  assert.equal(h.calls.length,2);
});

test("a delayed authorization cannot replace a newer local summary",async()=>{
  const h=await setup();let release,first=true;
  h.context.isTrustedChatSender=async()=>{if(first){first=false;await new Promise(r=>{release=r;});}return true;};
  const old=h.dispatch(completion("old","[[LOGIC:SUMMARY: Older result.]]\n[[LOGIC:IDLE]]"),sender(h));
  while(!release)await h.flush();
  await h.dispatch(completion("new","[[LOGIC:SUMMARY: Newer result.]]\n[[LOGIC:IDLE]]"),sender(h));
  release();await old;
  assert.equal(h.summary().last.text,"Newer result.");
});


test("upgrade removes retired provider errors, preserves summaries and keeps cooldown beside rewriting", async () => {
  let now = Date.now(); class Clock extends Date {static now(){return now;}}
  const localError = "No valid SUMMARY tag in the latest response. Start Logic Mode with the updated instructions (600 characters maximum).";
  const last = {text:"Saved useful summary",model:"example/free",completedAt:now};
  const records = {
    [sourceUrl]:{status:"error",error:"OpenRouter free-model rate limit reached. The next completed output will try again.",last},
    network:{status:"error",error:"Summary unavailable: network failure or request timeout",last:null},
    pending:{status:"pending",last},
    local:{status:"error",error:localError,last},
    current:{source:"chat",status:"error",error:"A local summary notice",last},
  };
  const h = await setup(undefined, {...saved,[RECORDS]:records,logicSummaryCooldown:{until:now+120000,strikes:1}}, c=>{c.Date=Clock;});
  const migrated = h.local.values[RECORDS];
  assert.equal(migrated[sourceUrl].status,"ready");
  assert.equal(migrated[sourceUrl].last.text,last.text);
  assert.equal(migrated[sourceUrl].error,"");
  assert.equal(migrated.network.status,"waiting");
  assert.equal(migrated.network.error,"");
  assert.equal(migrated.pending.status,"ready");
  assert.equal(migrated.local.error,localError);
  assert.equal(migrated.local.source,"chat");
  assert.equal(migrated.current.error,"A local summary notice");
  const listing = await h.context.DashboardWorker.remote({type:"DB_LIST"});
  assert.equal(listing.rewriteStatus.retryAt,now+120000);
  assert.equal(JSON.stringify(listing).includes("invented-test-key"),false);
  assert.equal(JSON.stringify(listing).includes("next completed output"),false);
  now += 120001;
  assert.equal((await h.context.SummaryWorker.rewriteStatus()).retryAt,0);
  assert.equal(h.calls.length,0,"Reading status never calls OpenRouter");
  const restarted = await setup(undefined,h.local.values);
  assert.equal(restarted.summary().last.text,last.text,"Migration is safe to repeat");
});
