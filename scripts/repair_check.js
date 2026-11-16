/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
// Manual, local-only triage. This tool never controls Chrome or edits source.
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const {constants} = require("node:fs"), crypto = require("node:crypto");
const schema = require("../diagnostics-schema.js");
const ROOT = path.resolve(__dirname,".."), MAX_BYTES = 2 * 1024 * 1024;
const fail = code => Object.assign(new Error(code),{code});
function compareVersions(left,right) {
  if(schema.version(left)==="unknown" || schema.version(right)==="unknown")return null;
  const a=left.split(".").map(Number),b=right.split(".").map(Number);
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const difference=(a[i]||0)-(b[i]||0);if(difference)return Math.sign(difference);
  }
  return 0;
}
function analyze(input,sourceVersion,now=Date.now()) {
  // Reapply the shared allowlist even to a file already exported by the helper.
  const report=schema.report(input);
  const age=now-report.generatedAt;
  const freshness=!report.generatedAt ? "unknown" : age < -60000 ? "clock_mismatch" : age>120000 ? "stale" : "fresh";
  const comparison=compareVersions(report.workerVersion,sourceVersion);
  const versionStatus=comparison===null ? "unknown" : comparison<0 ? "update_not_loaded" : comparison>0 ? "source_older_than_runtime" : "matching";
  const groups=new Map(),seen=new Set(),observations=new Map();
  const eventKey=e=>`${e.at}:${e.tabId}:${e.event}:${e.reason}:${e.contentVersion}:${e.workerVersion}`;
  const errors=new Set(["error","identity_rejected","summary_error","queue_error","rewrite_error"]);
  function observe(event){
    const prior=observations.get(event.tabId);
    if(!prior || event.at>prior.at)observations.set(event.tabId,event);
    if(!errors.has(event.event))return;
    const duplicate=seen.has(eventKey(event));
    seen.add(eventKey(event));
    const key=JSON.stringify([event.reason,event.contentVersion,event.workerVersion]);
    let group=groups.get(key);
    if(!group){group={reason:event.reason,contentVersion:event.contentVersion,workerVersion:event.workerVersion,
      occurrenceCount:0,firstAt:event.at,lastAt:event.at,tabs:new Set(),frames:[]};groups.set(key,group);}
    if(!duplicate)group.occurrenceCount++;
    group.firstAt=Math.min(group.firstAt,event.at);group.lastAt=Math.max(group.lastAt,event.at);group.tabs.add(event.tabId);
    for(const frame of event.frames||[])if(!group.frames.some(f=>f.line===frame.line && f.column===frame.column))group.frames.push(frame);
  }
  // Incident histories can retain useful events that have aged out of the ring.
  for(const incident of report.incidents)for(const event of incident.events)observe(event);
  for(const event of report.events)observe(event);
  const warnings=[];
  if(freshness!=="fresh")warnings.push(`report_${freshness}`);
  if(!report.enabled)warnings.push("diagnostics_disabled");
  if(report.dropped)warnings.push("events_dropped");
  if(versionStatus!=="matching")warnings.push(versionStatus);
  if(report.events.length===400 || report.incidents.length===20)warnings.push("bounded_history_may_be_incomplete");
  return {report,summary:{schema:1,checkedAt:now,generatedAt:report.generatedAt,freshness,sourceVersion:schema.version(sourceVersion),
    workerVersion:report.workerVersion,versionStatus,enabled:report.enabled,warnings,
    eventCount:report.events.length,incidentCount:report.incidents.length,dropped:report.dropped,
    // Historical observations are explicitly NOT a live status inventory.
    observedTabs:[...observations.values()].sort((a,b)=>a.tabId-b.tabId).map(e=>({tabId:e.tabId,lastObservedAt:e.at,
      contentVersion:e.contentVersion,workerVersion:e.workerVersion,phase:e.phase,event:e.event,reason:e.reason,
      projectRef:e.projectRef,chatRef:e.chatRef})),
    errorGroups:[...groups.values()].sort((a,b)=>b.lastAt-a.lastAt).map(g=>({...g,tabs:[...g.tabs].sort((a,b)=>a-b),frames:g.frames.slice(0,5)}))}};
}
async function readReport(filename){
  let handle;
  try{
    handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await handle.stat();
    if(!stat.isFile() || stat.size>MAX_BYTES)throw fail("invalid_report_file");
    const text=await handle.readFile("utf8");
    if(Buffer.byteLength(text)>MAX_BYTES)throw fail("report_too_large");
    try{return JSON.parse(text);}catch{throw fail("invalid_report_json");}
  }finally{await handle?.close();}
}
async function privateDirectory(directory){
  const absolute=path.resolve(directory);
  // Check existing ancestors as well as the final directory for symlink routing.
  let current=path.parse(absolute).root;
  for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    try{const stat=await fs.lstat(current);if(stat.isSymbolicLink() || !stat.isDirectory())throw fail("unsafe_output_directory");}
    catch(error){if(error.code!=="ENOENT")throw error;await fs.mkdir(current,{mode:0o700});}
  }
  const stat=await fs.lstat(absolute);
  if(stat.mode&0o077)throw fail("output_directory_not_private");
}
async function collect({reportPath,outputDirectory,sourceVersion,now=Date.now()}){
  let analysis;
  try{analysis=analyze(await readReport(reportPath),sourceVersion,now);}
  catch(error){if(["ENOENT","EACCES","ELOOP","invalid_report_file","report_too_large","invalid_report_json"].includes(error.code))throw error;
    throw fail("invalid_diagnostic_report");}
  await privateDirectory(outputDirectory);
  const directory=path.join(outputDirectory,new Date(now).toISOString().replace(/[:.]/g,"-")+"-"+crypto.randomBytes(4).toString("hex"));
  await fs.mkdir(directory,{mode:0o700});
  await fs.writeFile(path.join(directory,"diagnostics.json"),JSON.stringify(analysis.report,null,2)+"\n",{flag:"wx",mode:0o600});
  await fs.writeFile(path.join(directory,"summary.json"),JSON.stringify(analysis.summary,null,2)+"\n",{flag:"wx",mode:0o600});
  return {...analysis.summary,evidenceDirectory:directory};
}
async function main(args=process.argv.slice(2)){
  const options={reportPath:path.join(os.homedir(),".config/threadlamp-lan/diagnostics/latest.json"),
    outputDirectory:path.join(ROOT,".threadlamp-lan/repair-reports"),sourceVersion:require("../manifest.json").version};
  for(let i=0;i<args.length;i+=2){
    const key={"--report":"reportPath","--output":"outputDirectory"}[args[i]];
    if(!key || !args[i+1])throw fail("usage: npm run repair:check -- [--report file] [--output private-directory]");
    options[key]=path.resolve(args[i+1]);
  }
  console.log(JSON.stringify(await collect(options),null,2));
}
if(require.main===module)main().catch(error=>{
  const known=new Set(["ENOENT","EACCES","ELOOP","invalid_report_file","report_too_large","invalid_report_json",
    "invalid_diagnostic_report","unsafe_output_directory","output_directory_not_private"]);
  console.error(JSON.stringify({ok:false,error:known.has(error.code)?error.code:"repair_check_failed",
    action:"Check the local diagnostic report and private output directory. No agents or source files were changed."}));process.exitCode=1;
});
module.exports={analyze,compareVersions,collect,readReport};
