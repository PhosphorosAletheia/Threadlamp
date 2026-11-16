/* Copyright (c) 2026 Phosphoros Research and contributors.
 * SPDX-License-Identifier: MPL-2.0 */
/* Content-side sequencing; a failed save fences sending until a page reload. */
globalThis.ThreadlampQueueStore = class {
  constructor(onLoad, onError) {
    this.url = window.location.href;
    this.version = 0; this.loaded = false; this.error = null;
    this.onError = onError; this.onLoad = onLoad;
    this.chain = Promise.resolve();
    this.ready = this.enqueue(async () => {
      if (!/\/c\/[^/]+|\/g\/g-p-[a-f0-9]{32}|^\/$/i.test(new URL(this.url).pathname)) {
        this.loaded = true; return;
      }
      await this.loadCurrent();
    });
  }
  async loadCurrent() {
    // Reads are safe to repeat when ChatGPT changes its route during startup.
    // Never apply the old page's queue, and never retry mutations this way.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const destination = window.location.href;
      this.url = destination;
      let result;
      try {result = await this.request("Q_LOAD");}
      catch (error) {if (window.location.href !== destination) continue; throw error;}
      if (window.location.href !== destination) continue;
      this.loaded = true; this.onLoad(result.items.map(item => ({...item, url:destination}))); return;
    }
    throw Object.assign(new Error("The chat kept changing while restoring its queue. Wait for the destination to settle and reload before resuming."),
      {queueOperation:"Q_LOAD",queueFailure:"route"});
  }
  close() {this.closed = true; this.onLoad = this.onError = () => {};}
  async request(type, extra = {}) {
    if (this.closed) throw new Error("The old queue controller has stopped.");
    const result = await chrome.runtime.sendMessage({type, url:this.url, version:this.version, ...extra});
    if (!result?.ok || !Number.isInteger(result.version) || !Array.isArray(result.items)) throw Object.assign(new Error(result?.error || "The queue could not be saved. Reload the chat before resuming."), {queueOperation:type,queueFailure:result?.queueFailure || "storage"});
    if (this.closed) throw new Error("The old queue controller has stopped.");
    this.version = result.version; return result;
  }
  enqueue(work) {
    this.chain = this.chain.then(() => {if (this.error) throw this.error; return work();}).catch(error => {
      if (!this.error) {this.error = error; this.onError(error);}
      throw error;
    });
    this.chain.catch(() => {}); return this.chain;
  }
  attach() {
    const destination = window.location.href;
    if (!this.loaded || this.error || destination === this.url) return this.chain;
    this.loaded = false;
    return this.enqueue(() => this.loadCurrent());
  }
  save(items) {
    const url = window.location.href, snapshot = items.map(({id,text}) => ({id,text}));
    return this.enqueue(async () => {
      if (url !== this.url || window.location.href !== url) throw new Error("The chat changed before its queue was saved.");
      return this.request("Q_SAVE", {items:snapshot});
    });
  }
  move() {
    const destination = window.location.href;
    return this.enqueue(async () => {
      const previous = this.url;
      if (previous === destination) return;
      this.url = destination;
      await this.request("Q_MOVE", {from:previous});
    });
  }
  handoff(requestId) {
    return this.enqueue(async () => {
      this.url = window.location.href;
      return this.request("Q_HANDOFF", {requestId});
    });
  }
  flush() {return this.chain;}
};
