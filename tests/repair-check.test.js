/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {analyze,compareVersions,collect,readReport}=require("../scripts/repair_check.js");
const now=1800000000000;
const event=(extra={})=>({at:now-1000,tabId:1,event:"error",reason:"reconnect_sender",contentVersion:"1.17.0",workerVersion:"1.17.0",phase:"recovery_paused",...extra});
const report=(extra={})=>({schema:1,generatedAt:now,enabled:true,workerVersion:"1.17.0",events:[event()],incidents:[{at:now-1000,tabId:1,reason:"reconnect_sender",events:[event()]}],...extra});

test("triage separates deployed versions, historical errors and last observations",()=>{
  const out=analyze(report({events:[event(),event({at:now,event:"state",phase:"monitoring",reason:"none",contentVersion:"1.17.2"})]}),"1.17.2",now).summary;
  assert.equal(out.versionStatus,"update_not_loaded");assert.equal(out.freshness,"fresh");
  assert.equal(out.errorGroups.length,1);assert.equal(out.errorGroups[0].occurrenceCount,1,"incident copies do not duplicate the same failure");
  assert.equal(out.observedTabs[0].phase,"monitoring","an older incident does not become a current error state");
  assert.equal(out.observedTabs[0].contentVersion,"1.17.2");
  assert.equal(compareVersions("1.9.9","1.10.0"),-1);assert.equal(compareVersions("1.17.2.0","1.17.2"),0);
  assert.equal(compareVersions("unknown","1.17.2"),null);
});

test("stale, future, missing, disabled and bounded reports are not clean health claims",()=>{
  for(const [generatedAt,freshness] of [[now-120001,"stale"],[now+60001,"clock_mismatch"],[0,"unknown"]]){
    const out=analyze(report({generatedAt}),"1.17.0",now).summary;
    assert.equal(out.freshness,freshness);assert.ok(out.warnings.includes(`report_${freshness}`));
  }
  const out=analyze(report({enabled:false,dropped:2,events:Array.from({length:400},(_,i)=>event({at:now-i}))}),"1.16.0",now).summary;
  assert.ok(out.warnings.includes("diagnostics_disabled"));assert.ok(out.warnings.includes("events_dropped"));
  assert.ok(out.warnings.includes("bounded_history_may_be_incomplete"));assert.equal(out.versionStatus,"source_older_than_runtime");
});

test("bundles only sanitized metadata and preserves the source report",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"threadlamp-repair-test-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,"input.json"),out=path.join(root,"private-reports");
  const raw=JSON.stringify(report({token:"SECRET_TOKEN",events:[event({message:"PRIVATE_CHAT",url:"PRIVATE_URL",frames:[{file:"content.js",line:2,column:4},{file:"PRIVATE_PATH",line:2,column:1}]})]}));
  await fs.writeFile(source,raw);
  const result=await collect({reportPath:source,outputDirectory:out,sourceVersion:"1.17.2",now});
  assert.equal(await fs.readFile(source,"utf8"),raw);
  for(const filename of ["diagnostics.json","summary.json"]){
    const p=path.join(result.evidenceDirectory,filename),text=await fs.readFile(p,"utf8");
    assert.doesNotMatch(text,/SECRET_TOKEN|PRIVATE_/);assert.equal((await fs.stat(p)).mode&0o777,0o600);
  }
  assert.equal((await fs.stat(result.evidenceDirectory)).mode&0o777,0o700);
  assert.equal(result.errorGroups[0].frames.length,1);
});

test("malformed, oversized, missing and symlinked inputs fail without a healthy report",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"threadlamp-repair-input-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,"input"),link=path.join(root,"link");
  await assert.rejects(readReport(file),e=>e.code==="ENOENT");
  await fs.writeFile(file,"PRIVATE invalid JSON");await assert.rejects(readReport(file),e=>e.code==="invalid_report_json" && !e.message.includes("PRIVATE"));
  await fs.writeFile(file,"x".repeat(2*1024*1024+1));await assert.rejects(readReport(file),e=>e.code==="invalid_report_file");
  await fs.writeFile(file,JSON.stringify(report()));await fs.symlink(file,link);await assert.rejects(readReport(link),e=>e.code==="ELOOP");
  await fs.writeFile(file,"{}");await assert.rejects(collect({reportPath:file,outputDirectory:path.join(root,"output"),sourceVersion:"1.17.2",now}),e=>e.code==="invalid_diagnostic_report");
});

test("evidence cannot be written through symlinks or into a shared output directory",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"threadlamp-repair-output-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,"input.json"),shared=path.join(root,"shared"),link=path.join(root,"link");
  await fs.writeFile(source,JSON.stringify(report()));await fs.mkdir(shared,{mode:0o755});await fs.chmod(shared,0o755);
  await fs.symlink(shared,link);
  for(const outputDirectory of [shared,path.join(link,"nested")])await assert.rejects(collect({reportPath:source,outputDirectory,sourceVersion:"1.17.2",now}),/output_directory/);
  assert.deepEqual(await fs.readdir(shared),[]);
});
