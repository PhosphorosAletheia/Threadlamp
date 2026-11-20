/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), net = require("node:net");
const crypto = require("node:crypto"), {execFileSync} = require("node:child_process");
const {createHelper,hash,reloadProof} = require("./server.js");
function privateHost(host) {
  if (net.isIP(host) !== 4) return false;
  const [a,b] = host.split(".").map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
function init(directory, host, port = 8443, bridgePort = 3211) {
  if (!privateHost(host)) throw new Error("Use this computer's private IPv4 LAN address (or 127.0.0.1 for local testing).");
  for (const number of [port,bridgePort]) if (!Number.isInteger(number) || number < 1024 || number > 65535) throw new Error("Ports must be 1024–65535.");
  if (host === "127.0.0.1" && port === bridgePort) throw new Error("Use different web and bridge ports.");
  if (fs.existsSync(directory)) throw new Error("Setup directory already exists. Use it with start or choose a new directory; existing credentials were not changed.");
  fs.mkdirSync(directory,{recursive:true,mode:0o700}); fs.chmodSync(directory,0o700);
  const key = path.join(directory,"server-key.pem"), cert = path.join(directory,"server-cert.pem");
  execFileSync("openssl",["req","-x509","-newkey","rsa:3072","-sha256","-nodes","-days","365","-subj","/CN=Threadlamp LAN",
    "-addext",`subjectAltName=IP:${host}`,"-keyout",key,"-out",cert],{stdio:"ignore"});
  fs.chmodSync(key,0o600);
  const accessKey = crypto.randomBytes(32).toString("base64url"), bridgeToken = crypto.randomBytes(32).toString("base64url");
  const config = {version:1,origin:`https://${host}:${port}`,bridgePort,bridgeToken,passwordHash:hash(accessKey)};
  fs.writeFileSync(path.join(directory,"config.json"),JSON.stringify(config,null,2)+"\n",{mode:0o600,flag:"wx"});
  const fingerprint = new crypto.X509Certificate(fs.readFileSync(cert)).fingerprint256;
  fs.writeFileSync(path.join(directory,"pairing.txt"),`Threadlamp LAN dashboard: ${config.origin}\nDashboard access key: ${accessKey}\nExtension pairing token: ${bridgeToken}\nLocal bridge port: ${bridgePort}\nCertificate SHA-256: ${fingerprint}\n`,{mode:0o600,flag:"wx"});
  return {origin:config.origin,directory,fingerprint};
}
async function reloadExtension(config) {
  const url = `http://127.0.0.1:${config.bridgePort}/threadlamp/reload`;
  async function request(options, timeout) {
    let response;
    try {
      response = await fetch(url, {...options, redirect:"error", signal:AbortSignal.timeout(timeout)});
    } catch {
      throw new Error(options.method === "POST" ? "Connection lost. The reload is unconfirmed." : "Cannot reach the local Threadlamp helper.");
    }
    if (response.status === 404) throw new Error("Restart the local helper to enable its reload command.");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Helper rejected the reload request.");
    return result;
  }
  const {challenge} = await request({method:"GET"},5000);
  if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error("Invalid helper challenge.");
  const result = await request({method:"POST",headers:{Authorization:"Bearer " + reloadProof(config.bridgeToken,challenge)}},65000);
  if (result.ok !== true || !result.version) throw new Error("Extension reload is unconfirmed.");
  return result.version;
}
async function main() {
  const [command,...args] = process.argv.slice(2); const flags = {};
  for (let i=0;i<args.length;i+=2) {
    if (!["--dir","--host","--port","--bridge-port"].includes(args[i]) || !args[i+1]) throw new Error("Unknown or incomplete option.");
    flags[args[i]] = args[i+1];
  }
  const directory = path.resolve(flags["--dir"] || path.join(os.homedir(),".config/threadlamp-lan"));
  if (command === "init") {
    const result = init(directory,flags["--host"],Number(flags["--port"]||8443),Number(flags["--bridge-port"]||3211));
    console.log(`Helper setup created for ${result.origin}\nPrivate credentials: ${path.join(directory,"pairing.txt")}\nCertificate SHA-256: ${result.fingerprint}`); return;
  }
  if (!["start","reload-extension"].includes(command)) throw new Error("Usage: npm run lan -- init --host <private-LAN-IP> [--dir <private-directory>] [--port 8443] [--bridge-port 3211]\n       npm run lan -- start [--dir <private-directory>]\n       npm run lan -- reload-extension [--dir <private-directory>]");
  const configPath = path.join(directory,"config.json");
  for (const file of [directory,configPath,path.join(directory,"server-key.pem")]) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Helper credentials must be private to their owner (directory 700, config/key 600).");
  }
  const config = JSON.parse(fs.readFileSync(configPath,"utf8"));
  const url = new URL(config.origin);
  if (!privateHost(url.hostname) || config.version !== 1 || !Number.isInteger(config.bridgePort) || config.bridgePort < 1024 || config.bridgePort > 65535) throw new Error("Invalid helper configuration.");
  if (command === "reload-extension") {
    const version = await reloadExtension(config);
    console.log(`Threadlamp ${version} reloaded and reconnected.`); return;
  }
  const helper = createHelper(config,{key:fs.readFileSync(path.join(directory,"server-key.pem")),cert:fs.readFileSync(path.join(directory,"server-cert.pem"))}, {diagnosticsDirectory:path.join(directory,"diagnostics")});
  const result = await helper.start();
  console.log(`Threadlamp LAN dashboard: ${result.origin}\nExtension bridge: 127.0.0.1:${result.bridgePort}\nLocal diagnostic report: ${path.join(directory,"diagnostics/latest.json")}\nKeep this helper and Chrome running. Press Ctrl+C to stop.`);
  for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,() => void helper.close().then(() => process.exit(0)));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode=1; });
module.exports = {init,privateHost,reloadExtension};
