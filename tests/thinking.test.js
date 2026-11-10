/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";
const assert = require("node:assert/strict");
const { contentHarness, visibleElement } = require("./rollover.test.js");
const project = "g-p-0123456789abcdef0123456789abcdef-job-search";

function fixture({ level = "Medium", generic = false, confirms = true, optionName = "High" } = {}) {
  const h = contentHarness();
  const events = [];
  h.window.location = new URL(`https://chatgpt.com/g/${project}`);
  Object.assign(h.api.state, { running: true, mode: "logic", runId: 1, limit: 5 });
  const composer = visibleElement();
  const form = visibleElement();
  composer.closest = selector => selector === "form" ? form : null;
  h.setSelector("#prompt-textarea", [composer]);
  let open = false;
  const attrs = { "aria-haspopup": "menu", "aria-controls": "effort-menu", "aria-expanded": "false" };
  const control = visibleElement(generic ? "Thinking" : level, attrs);
  let checked = level === "High";
  const highAttrs = { role: "menuitemradio", "aria-checked": String(checked) };
  const high = visibleElement(optionName, highAttrs);
  const menu = visibleElement();
  menu.id = "effort-menu";
  menu.getBoundingClientRect = () => ({ width: open ? 100 : 0, height: open ? 100 : 0 });
  let options = [high];
  menu.querySelectorAll = () => options;
  let controls = [control];
  form.querySelectorAll = () => controls;
  h.setSelector("[role='menu'], [role='listbox']", [menu]);
  control.click = () => {
    events.push(open ? "close" : "open");
    open = !open;
    attrs["aria-expanded"] = String(open);
  };
  menu.dispatchEvent = event => {
    assert.equal(event.type, "keydown");
    assert.equal(event.key, "Escape");
    assert.equal(event.bubbles, true);
    assert.equal(event.cancelable, true);
    events.push("escape");
    open = false;
    attrs["aria-expanded"] = "false";
    return false;
  };
  high.click = () => {
    events.push("select-high");
    if (!confirms) return;
    checked = true;
    highAttrs["aria-checked"] = "true";
    if (!generic) {
      control.innerText = control.textContent = "High";
      open = false;
      attrs["aria-expanded"] = "false";
    }
  };
  const send = visibleElement("Send");
  send.click = () => {
    events.push("send");
    assert.equal(checked, true, "High must be selected before Send");
    composer.innerText = composer.textContent = "";
  };
  h.setSelector("button[data-testid='send-button']", [send]);
  h.api.prepareThinkingSendForTest(composer);
  const requests = [];
  h.setRequestHandler(async request => { requests.push(request); return { ok: true, enabled: false }; });
  return Object.assign(h, {
    events, requests, composer, control, high, highAttrs, menu, attrs, send,
    options: value => { options = value; },
    setMenuOpen(value) { open = value; attrs["aria-expanded"] = String(value); },
    controls: value => { controls = value; },
    ensure: () => h.api.ensureHighThinking(1, composer, "", `https://chatgpt.com/g/${project}`, project, 1),
    run: () => h.api.runLogicMode(1, false, "Continuation prompt", "Starting", { previousTitle: "Old chat", failureId: "handoff", projectSegment: project })
  });
}

function sliderFixture({ changesValue = true, changesStatus = true, changesChip = true, prefixed = false } = {}) {
  const chipHigh = prefixed ? "Thinking effort High" : "High";
  const f = fixture({ level: prefixed ? "Thinking effort Medium" : "Medium" });
  f.attrs["aria-label"] = "Select ChatGPT model";
  const attrs = {
    role: "slider", "aria-valuemin": "0", "aria-valuemax": "2", "aria-valuenow": "1",
    "aria-orientation": "horizontal", tabindex: "-1", "aria-hidden": "true"
  };
  const slider = visibleElement("", attrs);
  slider.tagName = "SPAN";
  const status = visibleElement("Medium, 2 of 3.", { role: "status" });
  const power = visibleElement("", { role: "menuitem", "aria-label": "Power" });
  const model = visibleElement("GPT-6", { role: "menuitemradio", "aria-checked": "true" });
  const medium = visibleElement("Medium", { role: "menuitem", "aria-label": "Select model" });
  model.click = medium.click = () => { throw new Error("Must not click a model choice"); };
  f.menu.querySelectorAll = selector => {
    if (selector === "[role='slider']") return [slider];
    if (selector === "[role='status']") return [status];
    if (selector === "[role='menuitem'][aria-label='Power']") return [power];
    return [medium, power, model];
  };
  slider.focus = options => {
    assert.equal(options.preventScroll, true);
    f.events.push("focus-slider");
  };
  slider.dispatchEvent = event => {
    assert.equal(event.key, "End");
    assert.equal(event.bubbles, true);
    assert.equal(event.cancelable, true);
    f.events.push(event.type);
    if (event.type === "keydown") {
      if (changesValue) attrs["aria-valuenow"] = "2";
      if (changesStatus) status.innerText = status.textContent = "High, 3 of 3.";
      if (changesChip) f.control.innerText = f.control.textContent = chipHigh;
    }
    return false;
  };
  const send = visibleElement("Send");
  send.click = () => {
    assert.equal(attrs["aria-valuenow"], "2");
    assert.equal(status.innerText, "High, 3 of 3.");
    assert.equal(f.control.innerText, chipHigh);
    f.events.push("send");
    f.composer.innerText = f.composer.textContent = "";
  };
  f.setSelector("button[data-testid='send-button']", [send]);
  return Object.assign(f, { slider, sliderAttrs: attrs, status, power });
}

function paragraphNodes(text) {
  return text.split("\n").map(line => ({
    nodeType: 1, tagName: "P", getAttribute: () => null,
    childNodes: line ? [{ nodeType: 3, nodeValue: line }] : [{ nodeType: 1, tagName: "BR", getAttribute: () => null, childNodes: [] }]
  }));
}

(async () => {
  let f = fixture();
  assert.equal(await f.ensure(), true);
  assert.deepEqual(f.events, ["open", "select-high"]);
  assert.equal(await f.ensure(), true);
  assert.deepEqual(f.events, ["open", "select-high"], "already High must not toggle");

  // Closed-menu report supplied by the user: High text, generic model label,
  // aria-haspopup=menu, no aria-controls until the menu opens.
  f = fixture({ level: "High" });
  f.attrs["aria-label"] = "Select ChatGPT model";
  delete f.attrs["aria-controls"];
  await f.run();
  assert.deepEqual(f.events, ["send"], "observed High chip is verified without opening it");

  f = fixture();
  f.attrs["aria-label"] = "Select ChatGPT model";
  delete f.attrs["aria-controls"];
  await f.run();
  assert.deepEqual(f.events, ["open", "select-high", "send"], "model-label chip can switch from Medium in a simulated menu");

  for (const mismatch of ["label", "popup", "text", "disabled"]) {
    f = fixture({ level: "High" });
    f.attrs["aria-label"] = "Select ChatGPT model";
    if (mismatch === "label") f.attrs["aria-label"] = "Select priority";
    if (mismatch === "popup") delete f.attrs["aria-haspopup"];
    if (mismatch === "text") f.control.innerText = "GPT High";
    if (mismatch === "disabled") f.control.disabled = true;
    await assert.rejects(f.ensure, /control could not be identified/);
    assert.deepEqual(f.events, []);
  }

  f = fixture({ generic: true });
  assert.equal(await f.ensure(), true);
  assert.deepEqual(f.events, ["open", "select-high", "escape"]);
  assert.equal(await f.ensure(), true);
  assert.deepEqual(f.events.slice(3), ["open", "escape"], "checked menu state is verified again");

  f = fixture({ confirms: false });
  await assert.rejects(f.ensure, /did not confirm High/);
  assert.equal(f.events.includes("send"), false);

  for (const name of ["Heavy", "High priority", "High quality"]) {
    f = fixture({ optionName: name });
    await assert.rejects(f.ensure, /one available High option/);
    assert.deepEqual(f.events, ["open"]);
  }
  f = fixture();
  f.high.disabled = true;
  await assert.rejects(f.ensure, /one available High option/);
  f = fixture();
  f.options([f.high, visibleElement("High")]);
  await assert.rejects(f.ensure, /one available High option/);

  f = fixture();
  f.controls([]);
  // A global High control outside the composer must never be used.
  f.setSelector("button, [role='button']", [visibleElement("High")]);
  await assert.rejects(f.ensure, /control could not be identified/);
  assert.deepEqual(f.events, []);
  f = fixture();
  f.controls([f.control, visibleElement("Thinking")]);
  await assert.rejects(f.ensure, /control could not be identified/);
  f = fixture();
  f.control.click();
  await assert.rejects(f.ensure, /Close the open menu/);
  assert.deepEqual(f.events, ["open"], "pre-existing menu is left untouched");

  f = fixture();
  f.attrs["aria-controls"] = "another-menu";
  await assert.rejects(f.ensure, /did not open unambiguously/);

  for (const change of ["draft", "navigation", "stop", "composer"]) {
    f = fixture();
    const original = f.control.click;
    f.control.click = () => {
      original();
      if (change === "draft") f.composer.innerText = "My manual draft";
      if (change === "navigation") f.window.location = new URL("https://chatgpt.com/c/another");
      if (change === "stop") f.api.state.running = false;
      if (change === "composer") f.setSelector("#prompt-textarea", [visibleElement()]);
    };
    if (change === "stop") assert.equal(await f.ensure(), false);
    else await assert.rejects(f.ensure, /changed/);
    assert.deepEqual(f.events, ["open"], `${change} prevents selecting or sending`);
    if (change === "draft") assert.equal(f.composer.innerText, "My manual draft");
  }

  f = fixture();
  f.api.state.paused = true;
  const waiting = f.ensure();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(f.events, [], "Pause prevents UI clicks");
  f.api.state.running = false;
  assert.equal(await waiting, false);

  f = fixture();
  await f.run();
  assert.deepEqual(f.events, ["open", "select-high", "send"]);
  assert.equal(f.api.state.error, false);

  f = fixture({ generic: true });
  await f.run();
  assert.deepEqual(f.events, ["open", "select-high", "escape", "open", "escape", "send"]);

  f = fixture();
  f.controls([]);
  await f.run();
  assert.equal(f.api.state.running, false);
  assert.equal(f.api.state.error, true);
  assert.equal(f.composer.innerText, "", "no startup draft written without verified High");
  assert.equal(f.events.includes("send"), false);
  const notification = f.requests.find(r => r.type === "HA_NOTIFY_ROLLOVER_FAILURE");
  assert.equal(notification.previousTitle, "Old chat");
  assert.match(notification.detail, /High is required/);

  f = fixture();
  // Lose the High control after writing: the final pre-send check must block.
  Object.defineProperty(f.composer, "innerText", {
    get() { return this.textContent; },
    set(value) { this.textContent = value; if (value) f.controls([]); }
  });
  await f.run();
  assert.equal(f.events.includes("send"), false);
  assert.equal(f.composer.textContent, "Continuation prompt", "unsent draft remains recoverable");
  assert.equal(f.api.state.error, true);

  f = fixture({ level: "High" });
  f.controls([]);
  await f.api.runLogicMode(1, false, "Regular startup", "Starting");
  assert.deepEqual(f.events, ["send"], "ordinary startup has no rollover-only thinking requirement");

  // Exercise the real writer and guard with paragraph layout separators, not
  // just a stub that guarantees innerText remains identical after insertText.
  f = fixture({ level: "High" });
  const multiline = "Continuation of the previous chat.\n\nStart Logic Mode.\n[[LOGIC:IDLE]]";
  let fallbackWrites = 0;
  Object.defineProperty(f.composer, "textContent", {
    get() { return this.childNodes?.map(p => p.childNodes.map(n => n.nodeValue || "").join("")).join("") || ""; },
    set() { fallbackWrites += 1; }
  });
  f.composer.focus = f.composer.dispatchEvent = () => {};
  f.document.createRange = () => ({ selectNodeContents() {}, collapse() {} });
  f.document.execCommand = (command, ui, text) => {
    assert.equal(command, "insertText");
    f.composer.childNodes = paragraphNodes(text);
    f.composer.innerText = text.split("\n").join("\n\n");
    return true;
  };
  f.api.prepareThinkingSendForTest(f.composer, f.api.writeComposerForTest);
  const sendParagraphs = f.send.click;
  f.send.click = () => {
    assert.equal(fallbackWrites, 0, "valid rich editor paragraphs must not be replaced with textContent");
    sendParagraphs();
    f.composer.childNodes = [];
  };
  await f.api.runLogicMode(1, false, multiline, "Starting", { previousTitle: "Old chat", projectSegment: project });
  assert.deepEqual(f.events, ["send"]);
  assert.equal(f.api.state.error, false);

  for (const changed of [false, true]) {
    f = fixture({ level: "High" });
    const replacement = visibleElement();
    replacement.closest = f.composer.closest;
    f.api.prepareThinkingSendForTest(f.composer, (target, text) => {
      replacement.innerText = replacement.textContent = changed ? `${text} manual edit` : text;
      target.isConnected = false;
      f.setSelector("#prompt-textarea", [replacement]);
      return true;
    });
    const sendReplacement = f.send.click;
    f.send.click = () => { replacement.innerText = replacement.textContent = ""; sendReplacement(); };
    await f.run();
    assert.equal(f.events.includes("send"), !changed, "a replacement editor must contain the exact owned draft");
    assert.equal(f.api.state.error, changed);
    if (changed) assert.equal(replacement.innerText, "Continuation prompt manual edit");
  }

  f = fixture({ level: "High" });
  for (const text of ["Line one\n\nLine two", "Line one\nLine two\u200b", "Line ONE\nLine two", "Line  one\nLine two"]) {
    f.composer.childNodes = paragraphNodes(text);
    f.composer.innerText = text.split("\n").join("\n\n");
    assert.equal(f.api.composerDraftMatches(f.composer, "Line one\nLine two"), false,
      "blank lines, invisible characters, case, and internal spaces stay significant");
  }

  f = sliderFixture();
  await f.run();
  assert.deepEqual(f.events, ["open", "focus-slider", "keydown", "keyup", "escape", "send"]);
  assert.equal(f.api.state.error, false);

  // Captured layout: generic model accessibility label, prefixed effort text.
  f = sliderFixture({ prefixed: true });
  await f.run();
  assert.deepEqual(f.events, ["open", "focus-slider", "keydown", "keyup", "escape", "send"]);
  assert.equal(f.api.state.error, false);

  f = fixture({ level: "High" });
  f.attrs["aria-label"] = "Select ChatGPT model";
  f.control.innerText = f.control.textContent = "Thinking effort High";
  await f.run();
  assert.deepEqual(f.events, ["send"], "prefixed High does not need to reopen the menu");

  for (const settings of [{ changesValue: false }, { changesStatus: false }, { changesChip: false }]) {
    f = sliderFixture({ prefixed: true, ...settings });
    await f.run();
    assert.equal(f.events.includes("send"), false, "prefixed chip must still verify High before sending");
    assert.equal(f.api.state.error, true);
  }
  for (const text of ["Thinking effort High priority", "GPT Thinking effort High"]) {
    f = sliderFixture({ prefixed: true });
    f.control.innerText = f.control.textContent = text;
    await assert.rejects(f.ensure, /control could not be identified/);
    assert.deepEqual(f.events, []);
  }

  // Live regression: the original trigger's second click does not dismiss.
  f = sliderFixture();
  const openOnce = f.control.click;
  f.control.click = () => {
    openOnce();
    f.control.click = () => { f.events.push("ignored-trigger-click"); };
  };
  await f.run();
  assert.deepEqual(f.events, ["open", "focus-slider", "keydown", "keyup", "escape", "send"]);

  f = sliderFixture();
  const selectAndReplaceTrigger = f.slider.dispatchEvent;
  f.slider.dispatchEvent = event => {
    selectAndReplaceTrigger(event);
    if (event.type === "keyup") {
      f.control.isConnected = false;
      f.controls([visibleElement("High", f.attrs)]);
    }
  };
  await f.run();
  assert.equal(f.events.at(-1), "send", "dismissal must not depend on an obsolete trigger node");

  f = sliderFixture();
  f.menu.dispatchEvent = () => { f.events.push("ignored-escape"); return true; };
  await assert.rejects(f.ensure, /menu did not close/);
  assert.equal(f.events.includes("send"), false);
  assert.equal(f.composer.innerText, "", "failed dismissal must not write the startup prompt");

  f = sliderFixture();
  const closeButStillExpanded = f.menu.dispatchEvent;
  f.menu.dispatchEvent = event => {
    closeButStillExpanded(event);
    f.attrs["aria-expanded"] = "true";
  };
  await assert.rejects(f.ensure, /menu did not close/);

  f = fixture({ level: "High" });
  f.setMenuOpen(true);
  await assert.rejects(f.ensure, /Close the open menu/);
  assert.deepEqual(f.events, [], "already High does not authorize sending through a user-opened menu");

  f = fixture();
  const chooseWithReplacementMenu = f.high.click;
  f.high.click = () => {
    chooseWithReplacementMenu();
    f.menu.isConnected = false;
    f.setSelector("[role='menu'], [role='listbox']", [visibleElement("Replacement menu")]);
  };
  await assert.rejects(f.ensure, /menu did not close/);
  assert.equal(f.events.includes("escape"), false, "do not dismiss an unverified replacement menu");

  f = sliderFixture();
  const selectWithExtraMenu = f.slider.dispatchEvent;
  f.slider.dispatchEvent = event => {
    selectWithExtraMenu(event);
    f.setSelector("[role='menu'], [role='listbox']", [f.menu, visibleElement("Other menu")]);
  };
  await assert.rejects(f.ensure, /open thinking menu changed/);
  assert.equal(f.events.includes("escape"), false);

  for (const change of ["stop", "draft"]) {
    f = sliderFixture();
    f.menu.dispatchEvent = () => {
      if (change === "stop") f.api.state.running = false;
      else f.composer.innerText = "My manual draft";
    };
    if (change === "stop") assert.equal(await f.ensure(), false);
    else await assert.rejects(f.ensure, /draft was preserved/);
    assert.equal(f.events.includes("send"), false);
  }

  // Neither an event dispatch nor changing ARIA alone proves the UI accepted High.
  for (const settings of [
    { changesValue: false, changesStatus: false, changesChip: false },
    { changesValue: false }, { changesStatus: false }
  ]) {
    f = sliderFixture(settings);
    await assert.rejects(f.ensure, /did not confirm High/);
    assert.equal(f.events.includes("send"), false);
  }
  f = sliderFixture({ changesChip: false });
  await assert.rejects(f.ensure, /did not retain High/);
  assert.equal(f.events.includes("send"), false);

  for (const [name, value] of [
    ["aria-valuemin", "1"], ["aria-valuemax", "3"], ["aria-valuenow", "0"],
    ["aria-valuenow", "2"], ["aria-orientation", "vertical"], ["aria-disabled", "true"]
  ]) {
    f = sliderFixture();
    f.sliderAttrs[name] = value;
    await assert.rejects(f.ensure, /verified Medium\/High slider/);
    assert.deepEqual(f.events, ["open"], "unknown or inconsistent slider must not be changed");
  }
  for (const selector of ["[role='slider']", "[role='status']"]) {
    f = sliderFixture();
    const query = f.menu.querySelectorAll;
    f.menu.querySelectorAll = s => s === selector ? [...query(s), ...query(s)] : query(s);
    await assert.rejects(f.ensure, /verified Medium\/High slider/);
    assert.deepEqual(f.events, ["open"]);
  }
  f = sliderFixture();
  f.power.disabled = true;
  await f.run();
  assert.deepEqual(f.events, ["open"]);
  assert.equal(f.api.state.error, true);
  assert.equal(f.composer.innerText, "");
  assert.equal(f.requests.find(r => r.type === "HA_NOTIFY_ROLLOVER_FAILURE").previousTitle, "Old chat");

  for (const change of ["stop", "draft", "navigation"]) {
    f = sliderFixture();
    f.slider.focus = () => {
      f.events.push("focus-slider");
      if (change === "stop") f.api.state.running = false;
      if (change === "draft") f.composer.innerText = "Manual note";
      if (change === "navigation") f.window.location = new URL("https://chatgpt.com/c/another");
    };
    if (change === "stop") assert.equal(await f.ensure(), false);
    else await assert.rejects(f.ensure, /changed/);
    assert.deepEqual(f.events, ["open", "focus-slider"], "recheck guards after focus before key events");
  }
  console.log("thinking tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
