/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const http = require("node:http"), https = require("node:https"), crypto = require("node:crypto");
const fs = require("node:fs"), path = require("node:path");
const {WebSocketServer, WebSocket} = require("ws");
const protocol = require("../lan-protocol.js");
const root = path.resolve(__dirname, "..");
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const equal = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(a), "hex"), Buffer.from(hash(b), "hex"));
const token = () => crypto.randomBytes(32).toString("base64url");
const assets = new Map([
  ["/dashboard.js", ["dashboard.js", "text/javascript"]], ["/dashboard.css", ["dashboard.css", "text/css"]],
  ["/brand.css", ["brand.css", "text/css"]], ["/heartbeat.js", ["heartbeat.js", "text/javascript"]],
  ["/app.webmanifest", ["helper/app.webmanifest", "application/manifest+json"]],
  ["/install.js", ["helper/install.js", "text/javascript"]], ["/install.css", ["helper/install.css", "text/css"]],
  ["/app-192.png", ["assets/icon-192.png", "image/png"]], ["/app-512.png", ["assets/icon-512.png", "image/png"]],
  ["/lan-client.js", ["helper/lan-client.js", "text/javascript"]],
  ["/login.js", ["helper/login.js", "text/javascript"]], ["/login.css", ["helper/login.css", "text/css"]]
]);
// Installation metadata is public; dashboard data and controls still require a session.
const publicAssets = new Set(["/login.js", "/login.css", "/app.webmanifest", "/install.js", "/install.css", "/app-192.png", "/app-512.png"]);
function installableHtml(html) {
  return html.replace(/initial-scale=1/, "initial-scale=1, viewport-fit=cover")
    .replace("</head>", '<link rel="manifest" href="/app.webmanifest"><meta name="theme-color" content="#090506"><link rel="stylesheet" href="/install.css"><script defer src="/install.js"></script></head>');
}
const cookieName = "__Host-threadlamp";
function createHelper(config, tls, {rpcTimeout = 35000, authTimeout = 5000} = {}) {
  const origin = new URL(config.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("A plain HTTPS dashboard origin is required.");
  if (!/^[A-Za-z0-9_-]{43}$/.test(config.bridgeToken) || !/^[a-f0-9]{64}$/.test(config.passwordHash)) throw new Error("Invalid helper credentials.");
  const sessions = new Map(), attempts = new Map(), pending = new Map();
  let peer = null, peerSeen = 0, closing = false;
  const peers = new Set();
  const headers = {
    "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff", "Referrer-Policy":"no-referrer",
    "Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "X-Frame-Options":"DENY", "Cross-Origin-Resource-Policy":"same-origin"
  };
  const reply = (res, status, value, extra = {}) => {
    res.writeHead(status, {...headers, "Content-Type":"application/json", ...extra});
    res.end(JSON.stringify(value));
  };
  function session(req) {
    const value = String(req.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
    const entry = value && sessions.get(value);
    if (!entry || entry.expires <= Date.now()) { if (value) sessions.delete(value); return null; }
    return value;
  }
  function sameOrigin(req) {
    return req.headers.origin === origin.origin && (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin");
  }
  async function body(req, limit) {
    if (String(req.headers["content-type"] || "").split(";")[0] !== "application/json") throw new Error("JSON required.");
    if (Number(req.headers["content-length"]) > limit) throw new Error("Request too large.");
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("Request too large."); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  function rejectPending() {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve({ok:false,uncertain:true,error:"Browser bridge disconnected. A command may have been attempted; inspect the agent before retrying."}); }
    pending.clear();
  }
  function rpc(request) {
    if (!peer || peer.readyState !== WebSocket.OPEN || Date.now() - peerSeen > 45000) return Promise.resolve({ok:false,error:"The browser bridge is offline. Start Chrome and connect the extension's LAN helper."});
    if (pending.size >= 32) return Promise.resolve({ok:false,error:"Too many dashboard requests. Try again after the current requests finish."});
    const id = crypto.randomUUID(), connection = peer;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ok:false,uncertain:true,error:"Browser acknowledgement timed out. Inspect the agent before retrying; this request will not be replayed."});
      }, rpcTimeout);
      pending.set(id, {resolve,timer,connection});
      try { connection.send(JSON.stringify({type:"request",id,request})); }
      catch { clearTimeout(timer); pending.delete(id); resolve({ok:false,uncertain:true,error:"Bridge delivery is uncertain. Inspect the agent before retrying."}); }
    });
  }
  const web = https.createServer({...tls, minVersion:"TLSv1.2"}, async (req, res) => {
    res.on("error", () => {});
    try {
      if (req.headers.host !== origin.host) return reply(res, 421, {ok:false,error:"Unrecognized dashboard address."});
      if (req.url.length > 2048) return reply(res, 414, {ok:false});
      const url = new URL(req.url, origin);
      if (url.origin !== origin.origin) return reply(res, 400, {ok:false});
      if (req.method === "POST") {
        if (!sameOrigin(req)) return reply(res, 403, {ok:false,error:"Same-origin requests only."});
        if (url.pathname === "/login") {
          const address = req.socket.remoteAddress;
          let rate = attempts.get(address);
          if (!rate || rate.until < Date.now()) {
            if (attempts.size >= 1024) return reply(res, 429, {ok:false});
            rate = {count:0,until:Date.now()+60000}; attempts.set(address,rate);
          }
          if (++rate.count > 5) return reply(res, 429, {ok:false});
          const input = await body(req, 2048);
          if (typeof input.password !== "string" || !equal(hash(input.password), config.passwordHash)) return reply(res, 401, {ok:false});
          for (const [id, value] of sessions) if (value.expires <= Date.now()) sessions.delete(id);
          if (sessions.size >= 32) return reply(res, 429, {ok:false,error:"Too many signed-in sessions."});
          const old = session(req); if (old) sessions.delete(old);
          const id = token(); sessions.set(id, {expires:Date.now()+12*60*60*1000});
          return reply(res, 200, {ok:true}, {"Set-Cookie":`${cookieName}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`});
        }
        const id = session(req);
        if (!id) return reply(res, 401, {ok:false,error:"Sign in to the LAN dashboard."});
        if (url.pathname === "/logout") {
          sessions.delete(id); return reply(res, 200, {ok:true}, {"Set-Cookie":`${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`});
        }
        if (url.pathname !== "/rpc") return reply(res, 404, {ok:false});
        const request = await body(req, protocol.requestLimit);
        if (!protocol.allowed(request)) return reply(res, 403, {ok:false,error:"Unsupported dashboard operation."});
        return reply(res, 200, await rpc(request));
      }
      if (req.method !== "GET") return reply(res, 405, {ok:false});
      if (url.pathname === "/login") {
        res.writeHead(200, {...headers,"Content-Type":"text/html; charset=utf-8"}); return res.end(installableHtml(fs.readFileSync(path.join(__dirname,"login.html"),"utf8")));
      }
      if (!publicAssets.has(url.pathname) && !session(req)) {
        res.writeHead(303, {...headers,Location:"/login"}); return res.end();
      }
      if (url.pathname === "/") {
        const html = fs.readFileSync(path.join(root,"dashboard.html"),"utf8")
          .replace('<script src="heartbeat.js">', '<script src="/lan-client.js"></script><script src="heartbeat.js">');
        res.writeHead(200, {...headers,"Content-Type":"text/html; charset=utf-8"}); return res.end(installableHtml(html));
      }
      const asset = assets.get(url.pathname);
      if (!asset) return reply(res,404,{ok:false});
      res.writeHead(200,{...headers,"Content-Type":asset[1] + (asset[1].startsWith("image/") ? "" : "; charset=utf-8")}); res.end(fs.readFileSync(path.join(root,asset[0])));
    } catch { if (!res.headersSent) reply(res,400,{ok:false,error:"Invalid request."}); else res.destroy(); }
  });
  web.requestTimeout = 45000; web.headersTimeout = 10000; web.keepAliveTimeout = 5000; web.maxHeadersCount = 50;
  web.on("tlsClientError", () => {});
  const bridge = http.createServer((req,res) => { res.writeHead(404); res.end(); });
  bridge.headersTimeout = 10000; bridge.requestTimeout = 10000;
  const wss = new WebSocketServer({noServer:true, maxPayload:protocol.responseLimit, perMessageDeflate:false});
  bridge.on("upgrade", (req,socket,head) => {
    if (closing || peers.size >= 4 || req.url !== "/threadlamp/bridge"
      || req.headers.host !== `127.0.0.1:${bridge.address().port}`
      || !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin || "")) { socket.destroy(); return; }
    wss.handleUpgrade(req,socket,head,ws => wss.emit("connection",ws));
  });
  wss.on("connection", ws => {
    peers.add(ws);
    let authenticated = false;
    const authTimer = setTimeout(() => ws.terminate(),authTimeout);
    ws.on("error", () => {});
    ws.on("message", (data,binary) => {
      let message;
      try {
        if (binary || (!authenticated && data.length > 2048)) return ws.terminate();
        message = JSON.parse(data.toString("utf8"));
        if (!message || typeof message !== "object" || Array.isArray(message)) return ws.terminate();
      } catch { return ws.terminate(); }
      if (!authenticated) {
        if (message.type !== "auth" || message.protocol !== protocol.protocol || typeof message.token !== "string"
          || !equal(message.token,config.bridgeToken) || peer) return ws.close();
        clearTimeout(authTimer); authenticated = true; peer = ws; peerSeen = Date.now();
        ws.send(JSON.stringify({type:"ready",protocol:protocol.protocol})); return;
      }
      if (peer !== ws) return ws.terminate();
      peerSeen = Date.now();
      if (message.type === "ping") { ws.send(JSON.stringify({type:"pong"})); return; }
      if (message.type !== "response") return ws.terminate();
      const entry = pending.get(message.id);
      if (entry && entry.connection === ws) {
        clearTimeout(entry.timer); pending.delete(message.id);
        entry.resolve(message.response && typeof message.response === "object" ? message.response : {ok:false,error:"Invalid bridge response."});
      }
    });
    ws.on("close", () => {
      clearTimeout(authTimer); peers.delete(ws);
      if (peer === ws) { peer = null; rejectPending(); }
    });
  });
  const reap = setInterval(() => {
    const now = Date.now();
    for (const [id,rate] of attempts) if (rate.until <= now) attempts.delete(id);
    for (const [id,entry] of sessions) if (entry.expires <= now) sessions.delete(id);
    if (peer && now-peerSeen > 45000) peer.terminate();
  },10000); reap.unref();
  const listen = (server,port,host) => new Promise((resolve,reject) => {
    const failed = error => { server.off("listening",ready); reject(error); };
    const ready = () => { server.off("error",failed); resolve(server.address()); };
    server.once("error",failed); server.once("listening",ready); server.listen(port,host);
  });
  async function close() {
    closing = true; clearInterval(reap); rejectPending();
    for (const ws of peers) ws.terminate();
    await Promise.all([web,bridge].map(server => new Promise(resolve => {
      server.close(resolve); server.closeAllConnections?.();
    })));
    wss.close(); sessions.clear();
  }
  return {web,bridge,close, async start() {
    try {
      await listen(bridge,config.bridgePort,"127.0.0.1");
      await listen(web,Number(origin.port)||443,origin.hostname);
      return {origin:origin.origin,bridgePort:bridge.address().port};
    } catch(error) { await close(); throw error; }
  }};
}
module.exports = {createHelper,hash};
