/* Copyright (c) 2026 Phosphoros Research and contributors. SPDX-License-Identifier: MPL-2.0 */
// Real DOM regression in a disposable Chromium profile; no live chats or extension.
"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const {execFileSync} = require("node:child_process"), assert = require("node:assert/strict");
const {contentHarness} = require("./rollover.test.js");
const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
function slice(start, end) {
  const a=source.indexOf(start), b=source.indexOf(end,a);
  assert.ok(a>=0 && b>a); return source.slice(a,b);
}
const project="g-p-0123456789abcdef0123456789abcdef";
const home=`https://chatgpt.com/g/${project}/project`, saved=`https://chatgpt.com/g/${project}/c/saved`;
const prompt=contentHarness().api.buildRolloverPrompt("Example work",`https://chatgpt.com/g/${project}/c/previous`);
const functions=[
  slice("  const MESSAGE_CONTENT_SELECTORS =", "  const LOGIC_START_PROMPT ="),
  slice("  function verifiedResourceRows(", "  function elementComesAfter("),
  slice("  function messageSnapshotId(", "  async function reconnectUserHash("),
  slice("  function rolloverRenderedText(", "  async function rolloverDraftFingerprint("),
  slice("  function projectSegmentFromLocation(", "  function projectSlugFromSegment("),
  slice("  function sameRolloverProject(", "  function findProjectRolloverButton("),
  slice("  function chatIdentity(", "  async function waitForLogicResume(")
].join("\n");
const test=`(async function(window) {
  ${functions}
  const expected=${JSON.stringify(prompt)}, home=${JSON.stringify(home)}, saved=${JSON.stringify(saved)};
  const check=(ok,label)=>{if(!ok)throw Error(label)};
  let clock=0; const Date={now:()=>clock}, SEND_ENABLE_TIMEOUT_MS=8000, POLL_MS=250;
  const sleep=async()=>{clock+=9000}, state={running:true,runId:1}, queuedPrompts=[];
  let runOwnership=null;
  const wrapper=document.createElement('div');wrapper.setAttribute('data-chatgpt-search-message-ids','01234567-89ab-4cde-8f01-23456789abcd');
  const user=document.createElement('div');user.setAttribute('data-user-message-bubble','true');wrapper.append(user);document.body.append(wrapper);
  function render(text) {
    user.replaceChildren();const inner=document.createElement('div');user.append(inner);
    for(const paragraph of text.split('\\n\\n')) {
      const p=document.createElement('p');inner.append(p);
      paragraph.split('\\n').forEach((line,i)=>{if(i)p.append(document.createElement('br'));p.append(line)});
    }
  }
  render(expected);
  const original=user.innerHTML;
  check(rolloverRenderedText(user.textContent)!==rolloverRenderedText(expected),'fixture must reproduce joined raw text');
  check(rolloverRenderedText(messageText(user))===rolloverRenderedText(expected),'reader must preserve paragraph and BR separators');
  check(user.innerHTML===original,'reading must not mutate the live message');
  for(const scenario of ['match','wrong-text','wrong-id','wrong-project','removed-space']) {
    render(expected);wrapper.setAttribute('data-chatgpt-search-message-ids','01234567-89ab-4cde-8f01-23456789abcd');
    window.location=new URL(home);
    runOwnership={runId:1,identity:chatIdentity(),url:home,submitted:{text:expected,before:{element:null,text:''},deadline:clock-1}};
    await assertRunLocation(1);
    check(!!runOwnership.submitted.verifiedUserId,'observed delivery retains a message ID');
    window.location=new URL(scenario==='wrong-project' ? saved.replace('0123','abcd') : saved);
    if(scenario==='wrong-text')render(expected.replace('unfinished','different'));
    if(scenario==='removed-space')render(expected.replace('unfinished task','unfinishedtask'));
    if(scenario==='wrong-id')wrapper.setAttribute('data-chatgpt-search-message-ids','abcdef01-2345-4678-9abc-def012345678');
    let accepted=true;try{await assertRunLocation(1)}catch(error){check(/chat changed/.test(error.message),'expected ownership error');accepted=false}
    check(accepted===(scenario==='match'),'saved URL adoption: '+scenario);
  }
  user.innerHTML='<p>un<span>broken</span> inline</p><p>Keep\\tthis\\u00a0space\\u200b.</p><button>Copy</button>';
  check(rolloverRenderedText(messageText(user))==='unbroken inline Keep\\tthis\\u00a0space\\u200b.','inline text, tabs, Unicode and UI stripping');
  user.style.display='none';
  check(rolloverRenderedText(messageText(user))==='unbroken inline Keep\\tthis\\u00a0space\\u200b.','detached or hidden rendering does not remove separators');
  document.getElementById('result').textContent='PASS: real paragraph/BR reader, immutable DOM, delayed URL adoption, wrong text/ID/project guards, inline boundaries and significant whitespace';
})({location:new URL(${JSON.stringify(home)}),getComputedStyle:window.getComputedStyle.bind(window)}).catch(error=>{document.getElementById('result').textContent='FAIL: '+error.message});`;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"threadlamp-handoff-reader-"));
try {
  const html=path.join(dir,"test.html");fs.writeFileSync(html,`<!doctype html><meta charset="utf-8"><body><pre id="result">RUNNING</pre><script>${test}</script>`);
  const dom=execFileSync("chromium",["--headless","--no-sandbox","--disable-gpu","--disable-extensions","--disable-background-networking","--no-first-run","--no-default-browser-check",`--user-data-dir=${dir}/profile`,"--dump-dom","--virtual-time-budget=2000",`file://${html}`],{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:30000});
  const result=dom.match(/<pre id="result">([^<]*)<\/pre>/)?.[1];
  assert.match(result||"",/^PASS:/);console.log(result);
} finally { fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200}); }
