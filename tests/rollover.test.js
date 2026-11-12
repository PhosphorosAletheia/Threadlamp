/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const root = path.resolve(__dirname, "..");

function exposeContentFunctions(source) {
  const marker = "})();";
  const index = source.lastIndexOf(marker);
  assert.notEqual(index, -1, "content script wrapper was not found");
  return `${source.slice(0, index)}
    Object.assign(globalThis.__test, {
      state,
      dashboardSnapshot,
      executeDashboardCommand,
      publishDashboardStatus,
      startServerSetup,
      acceptServerWake,
      bindServerDestination,
      getServerSetupForTest() { return serverSetup; },
      serverSetupStatus,
      setupPromptMatches,
      stopLoop,
      queueAdditionalPrompt,
      cancelAdditionalPrompt,
      updateOverlay,
      updateQuickActions,
      getOverlayForTest() { return overlayHost; },
      getQueuedPromptForTest() { return queuedPrompt; },
      submitMessage,
      sendQuickPrompt,
      startClaimedLogicRollover,
      findDeliveryTimeoutNotice,
      deliveryTimeoutResponse,
      recoverDeliveryTimeout,
      checkpointLogicRun,
      restoreLogicReconnect,
      monitorLogicReconnect,
      reconnectHash,
      reconnectUserHash,
      setReconnectAttemptedForTest(value) { reconnectAttempted = value; reconnectBoundRun = state.runId; },
      waitForAssistantResponse,
      waitForCurrentAssistantResponse,
      waitForUserMessage,
      waitForServerOrUserInput,
      handleHomeAssistantResponse,
      setTimeoutSnapshotsForTest(reader) { latestMessageSnapshot = reader; },
      setTimeoutElementsForTest(reader) { messageElements = reader; },
      setTimeoutWriterForTest(writer) { writeToComposer = writer; },
      ensureHighThinking,
      findThinkingControl,
      composerDraftMatches,
      writeComposerForTest: writeToComposer,
      prepareThinkingSendForTest(composer, writer = null) {
        waitForReady = async () => composer;
        writeToComposer = writer || ((target, text) => { target.innerText = target.textContent = text; return true; });
        waitForUserMessage = async () => null;
      },
      observeStartupForTest(reader) {
        waitForUserMessage = reader;
        waitForAssistantResponse = async () => null;
      },
      publicStatus,
      normalizeText,
      hasMaximumLengthNotice,
      isConversationLimitText,
      projectSegmentFromLocation,
      projectSlugFromSegment,
      normalizeProjectName,
      selectedProjectMatchesSegment,
      selectedProjectNameFromPage,
      destinationMatchesProject,
      currentConversationTitle,
      findMaximumLengthAlert,
      findProjectRolloverButton,
      findProjectRolloverAction,
      buildRolloverPrompt,
      classifyRolloverDraft,
      isGeneratedRolloverDraft,
      rolloverReadinessIssue,
      rolloverDestinationHasMessages,
      messageElements,
      rolloverDraftFingerprint,
      matchesSubmittedRolloverDraft,
      beginProjectRollover,
      configureHeartbeat,
      heartbeatMatchesLocation,
      heartbeatIdentity,
      acceptHeartbeat,
      resumeHeartbeatLocally,
      checkSleepingActivity,
      stopLogicMode,
      getHeartbeatForTest() { return heartbeatSchedule; },
      setHeartbeatSnapshotForTest(text) {
        latestMessageSnapshot = role => ({ element: null, text: role === "assistant" ? text : "" });
      },
      trackLogicRunsForTest() {
        const promises = [], original = runLogicMode;
        runLogicMode = (...args) => { const promise = original(...args); promises.push(promise); return promise; };
        return promises;
      },
      captureHeartbeatRunsForTest() {
        const calls = [];
        runLogicMode = async (...args) => { calls.push(args); };
        return calls;
      },
      completeHeartbeatCycleForTest() {
        submitMessage = async () => true;
        waitForUserMessage = async () => ({ element: null, text: "Heartbeat" });
        waitForAssistantResponse = async () => ({ element: null, text: "Finished.\\n[[LOGIC:IDLE]]" });
      },
      requestHomeAssistantError,
      runLogicMode,
      runLoop,
      finishLogicStop,
      failSendsForTest() {
        submitMessage = sendOne = async () => { throw new Error("The Send button is unavailable."); };
      },
      setResponseForTest(text) {
        waitForCurrentAssistantResponse = async () => ({ element: null, text });
        waitForUserMessage = async () => null;
        waitForServerOrUserInput = async () => null;
      },
      stripTrailingResourceCardText,
      parseLogicDirective,
      clearComposer,
      stopForMaximumLength
    });
  ${source.slice(index)}`;
}

function resourceCardRoot(fileNames, includeDownload = true) {
  const rows = fileNames.map((fileName) => {
    const downloadButton = { kind: "download" };
    const row = {
      innerText: `${fileName}\nImage`,
      textContent: `${fileName}\nImage`,
      parentElement: null,
      querySelector(selector) {
        return includeDownload && selector === "button[aria-label='Download file']"
          ? downloadButton
          : null;
      }
    };
    const previewButton = {
      parentElement: row,
      getAttribute(name) {
        return name === "aria-label" ? `Open preview of ${fileName}` : null;
      }
    };
    return { row, previewButton };
  });
  const root = {
    querySelectorAll(selector) {
      return selector === "button[aria-label^='Open preview of ']"
        ? rows.map(({ previewButton }) => previewButton)
        : [];
    }
  };
  rows.forEach(({ row }) => {
    row.parentElement = root;
  });
  return { root, rows };
}

function visibleElement(text = "", attributes = {}) {
  return {
    textContent: text,
    innerText: text,
    isConnected: true,
    matches: () => false,
    closest: () => null,
    getAttribute: (name) => attributes[name] ?? null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
    click() {}
  };
}

function contentHarness(timing = {}) {
  const warnings = [];
  let alerts = [];
  let sentRequest = null;
  let requestHandler = request => String(request.type).startsWith("SL_")
    ? Promise.resolve({ ok: true, event: null }) : new Promise(() => {});
  const selectorResults = new Map();
  const documentElement = {
    appendChild(element) {
      element.isConnected = true;
    }
  };
  const document = {
    title: "ChatGPT",
    documentElement,
    body: {},
    querySelectorAll(selector) {
      if (selector === "[role='alert']") return alerts;
      return selectorResults.get(selector) || [];
    },
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: () => false,
    createElement() {
      const nodes = new Map();
      const shadow = {
        innerHTML: "",
        querySelectorAll: () => [],
        querySelector: selector => {
          if (!nodes.has(selector)) nodes.set(selector, {
          handlers: {},
          value: "",
          addEventListener(type, fn) { this.handlers[type] = fn; },
          setAttribute() {},
          removeAttribute() {},
          classList: { add() {} },
          hidden: false,
          textContent: ""
          });
          return nodes.get(selector);
        }
      };
      const element = {
        id: "",
        style: {},
        isConnected: false,
        shadowRoot: null,
        getBoundingClientRect: () => ({ width: 143, height: 42 }),
        attachShadow() {
          this.shadowRoot = shadow;
          return shadow;
        },
        remove() {
          this.isConnected = false;
        }
      };
      return element;
    }
  };
  const window = {
    location: { href: "https://chatgpt.com/" },
    innerWidth: 1280,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    getSelection: () => ({
      removeAllRanges() {},
      addRange() {}
    }),
    setInterval: () => 1,
    addEventListener() {}
  };
  const context = {
    __test: {},
    console: { ...console, warn: (...args) => warnings.push(args) },
    URL,
    Intl,
    crypto: timing.crypto || webcrypto,
    TextEncoder,
    Date: timing.Date || Date,
    Promise,
    setTimeout: timing.setTimeout || setTimeout,
    clearTimeout,
    window,
    document,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    HTMLElement: class HTMLElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    HTMLInputElement: class HTMLInputElement {},
    InputEvent: class InputEvent {},
    Event: class Event {},
    KeyboardEvent: class KeyboardEvent {
      constructor(type, options) { this.type = type; Object.assign(this, options); }
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(request) {
          sentRequest = request;
          return requestHandler(request);
        }
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "server-link.js"), "utf8"), context, { filename: "server-link.js" });
  // Exercise transitions explicitly, without the startup claim racing the fixtures.
  const source = exposeContentFunctions(fs.readFileSync(path.join(root, "content.js"), "utf8"))
    .replace(/  void restoreLogicReconnect\(\)\.finally\(\(\) => \{[\s\S]*?\n  \}\);/, "");
  vm.runInContext(source, context, { filename: "content.js" });

  return {
    api: context.__test,
    warnings,
    document,
    window,
    setRequestHandler(handler) {
      requestHandler = handler;
    },
    setAlerts(value) {
      alerts = value;
    },
    setSelector(selector, value) {
      selectorResults.set(selector, value);
    },
    sentRequest: () => sentRequest
  };
}

function storageArea() {
  const values = {};
  return {
    values,
    async get(keys) {
      if (typeof keys === "string") return { [keys]: structuredClone(values[keys]) };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, structuredClone(values[key])]));
      }
      return { ...(keys || {}), ...structuredClone(values) };
    },
    async set(update) {
      Object.assign(values, structuredClone(update));
    },
    async remove(key) {
      delete values[key];
    },
    async setAccessLevel() {}
  };
}

async function backgroundHarness(localArea = null) {
  const local = localArea || storageArea();
  const session = storageArea();
  const fetchCalls = [];
  const tabMessages = [];
  let failNextFetch = false;
  let messageListener;
  const context = {
    __test: {},
    console,
    URL,
    Date,
    Promise,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (...args) => {
      fetchCalls.push(args);
      if (failNextFetch) { failNextFetch = false; throw new Error("Simulated network failure"); }
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({}),
        text: async () => ""
      };
    },
    chrome: {
      runtime: {
        id: "extension-test-id",
        getURL: (value) => `chrome-extension://extension-test-id/${value}`,
        getContexts: async () => [],
        onMessage: { addListener(listener) { messageListener = listener; } },
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} },
        sendMessage: async () => ({ ok: true })
      },
      storage: { local, session },
      permissions: {
        contains: async () => true,
        request: async () => true,
        remove: async () => true
      },
      offscreen: { createDocument: async () => {} },
      tabs: { sendMessage: async (...args) => { tabMessages.push(args); return { accepted: true }; } }
    }
  };

  vm.createContext(context);
  const source = `${fs.readFileSync(path.join(root, "background.js"), "utf8")}
    Object.assign(globalThis.__test, {
      projectSegmentFromUrl,
      chatPathFromUrl,
      projectSlugFromSegment,
      normalizeProjectName,
      selectedProjectMatchesSegment,
      sendRolloverFailureNotification,
      handleNotificationAction,
      setConfigForTest(value) { config = { ...config, ...value }; },
      prepareLogicRollover,
      allowNotificationForTest() { waitForSocket = async () => true; },
      claimLogicRollover,
      cancelLogicRollover,
      completeLogicRollover,
      recordChildForTest(id, opener) { rolloverChildTabs.set(id, { opener, createdAt: Date.now() }); }
    });`;
  vm.runInContext(source, context, { filename: "background.js" });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    api: context.__test, session, local, fetchCalls, tabMessages,
    failNextFetch() { failNextFetch = true; },
    dispatch: (request, sender) => new Promise(resolve => messageListener(request, sender, resolve))
  };
}

async function testRuntimeErrorNotifications() {
  for (const operation of ["logic", "loop", "shutdown", "rollover-startup"]) {
    const harness = contentHarness();
    const { api, document } = harness;
    document.title = "Evidence Validation Update";
    const requests = [];
    harness.setRequestHandler(async request => { requests.push(request); return { ok: true, enabled: false }; });
    Object.assign(api.state, { running: true, mode: "logic", logicPhase: "monitoring", runId: 11, limit: 5, count: 0 });
    api.failSendsForTest();
    if (operation === "logic") await api.runLogicMode(11);
    if (operation === "loop") await api.runLoop(11);
    if (operation === "shutdown") await api.finishLogicStop(11);
    if (operation === "rollover-startup") await api.runLogicMode(11, false, "start", "Starting", { previousTitle: "Old chat", failureId: "handoff" });
    const errors = requests.filter(request => request.type === "HA_NOTIFY_ERROR");
    assert.equal(errors.length, operation === "rollover-startup" ? 0 : 1, "rollover must not also send a generic error");
    if (errors.length) {
      assert.equal(errors[0].chatTitle, "Evidence Validation Update");
      assert.match(errors[0].detail, /Send button is unavailable/);
    } else {
      assert.equal(requests.filter(request => request.type === "HA_NOTIFY_ROLLOVER_FAILURE").length, 1);
    }
    assert.equal(api.state.running, false);
    assert.equal(api.state.error, true);
  }

  for (const response of ["No marker", "[[LOGIC:WAIT:999m]]", "[[LOGIC:USER_INPUT]]"]) {
    const harness = contentHarness();
    const { api, document } = harness;
    document.title = "Scheduled research";
    const requests = [];
    harness.setRequestHandler(async request => { requests.push(request); return { ok: true, enabled: false }; });
    Object.assign(api.state, { running: true, mode: "logic", logicPhase: "monitoring", runId: 12, limit: 5, count: 0 });
    api.setResponseForTest(response);
    await api.runLogicMode(12, true);
    assert.equal(api.state.logicPhase, "waiting_user");
    const errors = requests.filter(request => request.type === "HA_NOTIFY_ERROR");
    assert.equal(errors.length, response.includes("USER_INPUT") ? 0 : 1, "human-input requests keep their existing notification path");
    if (errors.length) assert.equal(errors[0].chatTitle, "Scheduled research");
  }

  const harness = contentHarness();
  const { api, document } = harness;
  document.title = "ChatGPT";
  const requests = [];
  harness.setRequestHandler(async request => { requests.push(request); return { ok: false, error: "Home Assistant is offline." }; });
  api.state.detail = "Original send failure.";
  const result = await api.requestHomeAssistantError(api.state.detail, "Source chat name");
  assert.equal(result.ok, false);
  assert.equal(requests.length, 1, "notification delivery failures must not recurse");
  assert.equal(requests[0].chatTitle, "Source chat name", "retain a known title if the page title becomes generic");
  assert.match(api.state.detail, /Original send failure.*Home Assistant is offline/);
  assert.equal(harness.warnings.length, 1);

  let resolveNotification;
  harness.setRequestHandler(() => new Promise(resolve => { resolveNotification = resolve; }));
  const oldFailure = api.requestHomeAssistantError("Old failure");
  api.state.runId += 1;
  api.state.detail = "New run is working.";
  resolveNotification({ ok: false, error: "Late failure" });
  await oldFailure;
  assert.equal(api.state.detail, "New run is working.", "late notification failure must not overwrite a new run");
}

async function testHeartbeatContentFlow() {
  const harness = contentHarness();
  const { api, window } = harness;
  window.location.href = "https://chatgpt.com/c/scheduled";
  window.location.pathname = "/c/scheduled";
  const composer = visibleElement("");
  harness.setSelector("#prompt-textarea", [composer]);
  const messages = [];
  harness.setRequestHandler(async request => { messages.push(request); return { ok: true }; });
  const schedule = { id: "heartbeat-1", url: window.location.href, enabled: true, phase: "armed", initialCycle: true, prompt: "Do the scheduled task", message: "Continue", limit: 7, timeZone: "America/Chicago", nextRunAt: Date.now() + 60000 };
  api.configureHeartbeat(schedule);
  assert.equal(api.state.logicPhase, "sleeping");
  assert.equal(messages.length, 0, "arming a schedule must not send a chat message");
  api.setResponseForTest("Work finished.\n[[LOGIC:IDLE]]");
  api.setHeartbeatSnapshotForTest("Work finished.\n[[LOGIC:IDLE]]");
  api.state.logicPhase = "monitoring";
  await api.runLogicMode(api.state.runId, true);
  assert.equal(api.state.logicPhase, "sleeping");
  assert.ok(messages.some(message => message.type === "HB_STATE" && message.phase === "sleeping"));
  assert.equal(messages.filter(message => message.type === "HA_NOTIFY_ERROR").length, 0);
  const calls = api.captureHeartbeatRunsForTest();
  const wake = { schedule: { ...schedule, initialCycle: false, phase: "sleeping" }, attemptId: "attempt-1", scheduledFor: Date.now() };
  api.state.count = 7;
  const accepted = api.acceptHeartbeat(wake);
  assert.equal(accepted.accepted, true);
  assert.equal(api.state.count, 0, "a new cycle gets its own follow-up budget");
  assert.equal(api.state.limit, 7);
  assert.equal(calls.length, 1);
  assert.match(calls[0][2], /Do the scheduled task/);
  assert.match(calls[0][2], /\[\[LOGIC:IDLE\]\]/);
  assert.equal(api.acceptHeartbeat(wake).accepted, true);
  assert.equal(calls.length, 1, "the same attempt cannot start a second cycle");
  assert.equal(api.acceptHeartbeat({ ...wake, attemptId: "attempt-2" }).busy, true);
  api.state.logicPhase = "sleeping";
  composer.innerText = composer.textContent = "My draft";
  assert.equal(api.acceptHeartbeat({ ...wake, attemptId: "attempt-2" }).accepted, false);
  assert.equal(composer.textContent, "My draft");
  composer.innerText = composer.textContent = "";
  api.setHeartbeatSnapshotForTest("[[LOGIC:USER_INPUT]]");
  assert.match(api.acceptHeartbeat({ ...wake, attemptId: "attempt-2" }).detail, /human input/);
  api.setHeartbeatSnapshotForTest("[[LOGIC:IDLE]]");
  window.location.href = "https://chatgpt.com/c/another-agent";
  window.location.pathname = "/c/another-agent";
  assert.match(api.acceptHeartbeat({ ...wake, attemptId: "attempt-2" }).detail, /scheduled conversation/);
  window.location.href = schedule.url;
  window.location.pathname = "/c/scheduled";
  api.stopLogicMode();
  assert.equal(api.state.running, false);
  assert.equal(api.getHeartbeatForTest().enabled, false);
  assert.ok(messages.some(message => message.type === "HB_DISABLE"));
  assert.equal(api.acceptHeartbeat({ ...wake, attemptId: "attempt-2" }).accepted, false);
  assert.equal(calls.length, 1);

  const noSchedule = contentHarness();
  Object.assign(noSchedule.api.state, { running: true, mode: "logic", runId: 1 });
  noSchedule.api.setResponseForTest("[[LOGIC:IDLE]]");
  noSchedule.setRequestHandler(async () => ({ ok: true, schedule: null }));
  await noSchedule.api.runLogicMode(1, true);
  assert.equal(noSchedule.api.state.running, false, "IDLE also completes an unscheduled cycle cleanly");
}

async function testErrorNotificationRouting() {
  const { api, fetchCalls, dispatch } = await backgroundHarness();
  const sender = { id: "extension-test-id", tab: { id: 17, url: "https://chatgpt.com/c/example", title: "Fallback chat" } };
  const request = { type: "HA_NOTIFY_ERROR", chatTitle: "  Evidence\nValidation Update  ", detail: "The Send button is unavailable." };
  const disabled = await dispatch(request, sender);
  assert.equal(disabled.enabled, false);
  assert.equal(fetchCalls.length, 0);
  api.setConfigForTest({ enabled: true, baseUrl: "https://home-assistant.example", notifyAction: "notify.mobile_app_test_phone", token: "test-token-not-logged", persistent: true });
  const untrusted = await dispatch(request, { ...sender, id: "another-extension" });
  assert.equal(untrusted.ok, false);
  assert.equal(fetchCalls.length, 0);
  const accepted = await dispatch(request, sender);
  assert.equal(accepted.ok, true);
  const payload = JSON.parse(fetchCalls.at(-1)[1].body);
  assert.equal(payload.title, "ChatGPT automation error");
  assert.equal(payload.message, "“Evidence Validation Update”: The Send button is unavailable.");
  assert.equal(payload.data.url, sender.tab.url);
  assert.equal(payload.data.clickAction, sender.tab.url);
  assert.equal(payload.data.tag, "chatgpt_error_17");
  assert.equal(payload.data.persistent, true);
  assert.equal(payload.data.sticky, true);
  assert.equal(payload.data.actions.length, 1);
  assert.equal(payload.data.actions[0].title, "Dismiss");
  assert.match(payload.data.actions[0].action, /^CHATGPT_DISMISS_ERROR_/);
  assert.equal(JSON.stringify(payload).includes("test-token-not-logged"), false);
  await dispatch(request, { ...sender, tab: { ...sender.tab, id: 99 } });
  assert.equal(JSON.parse(fetchCalls.at(-1)[1].body).data.tag, "chatgpt_error_99");
  api.setConfigForTest({ persistent: false });
  await dispatch({ type: "HA_NOTIFY_ERROR", detail: " " }, sender);
  const fallback = JSON.parse(fetchCalls.at(-1)[1].body);
  assert.equal(fallback.message, "“Fallback chat”: The chat automation encountered an error.");
  assert.equal("persistent" in fallback.data, false);
  await dispatch({ type: "HA_NOTIFY_ERROR", chatTitle: "A".repeat(300), detail: "B".repeat(600) }, sender);
  assert.equal(JSON.parse(fetchCalls.at(-1)[1].body).message, `“${"A".repeat(240)}”: ${"B".repeat(500)}`);
}

async function testContentRolloverGuards() {
  const harness = contentHarness();
  const { api, document, window } = harness;
  const project = "g-p-0123456789abcdef0123456789abcdef-example-project";
  const sourceUrl = `https://chatgpt.com/g/${project}/c/source-chat`;

  assert.equal(api.projectSegmentFromLocation(sourceUrl), project);
  assert.equal(api.projectSegmentFromLocation("https://chatgpt.com/c/not-a-project"), "");
  assert.equal(api.projectSegmentFromLocation("https://example.com/g/g-p-fake"), "");
  assert.equal(api.projectSlugFromSegment(project), "example-project");
  assert.equal(api.selectedProjectMatchesSegment("Example Project", project), true);
  assert.equal(api.selectedProjectMatchesSegment("Another Project", project), false);

  const projectComposer = visibleElement("", { "aria-label": "New chat in Example Project" });
  const projectButton = visibleElement("", { "aria-label": "Change project: Example Project" });
  window.location.href = "https://chatgpt.com/";
  window.location.pathname = "/";
  harness.setSelector("#prompt-textarea", [projectComposer]);
  harness.setSelector("button[aria-label^='Change project:']", [projectButton]);
  assert.equal(api.selectedProjectNameFromPage(), "Example Project");
  assert.equal(api.destinationMatchesProject(project), false, "project names cannot authorize routing");

  const wrongProjectButton = visibleElement("", {
    "aria-label": "Change project: Another Project"
  });
  harness.setSelector("button[aria-label^='Change project:']", [wrongProjectButton]);
  assert.equal(api.selectedProjectNameFromPage(), "");
  assert.equal(api.destinationMatchesProject(project), false);

  harness.setSelector("button[aria-label^='Change project:']", []);
  assert.equal(api.selectedProjectNameFromPage(), "");
  assert.equal(api.destinationMatchesProject(project), false);

  harness.setSelector("#prompt-textarea", []);

  document.title = "  Initialize\nExample Research  ";
  assert.equal(api.currentConversationTitle(), "Initialize Example Research");
  assert.equal(
    api.buildRolloverPrompt("Initialize Example Research").includes("[[LOGIC:CONTINUE]]"),
    true
  );
  assert.equal(api.classifyRolloverDraft("", "Continue"), "empty");
  assert.equal(api.classifyRolloverDraft("Continue", "Continue"), "replace_carryover");
  assert.equal(api.classifyRolloverDraft("continue", "Continue"), "replace_carryover");
  assert.equal(api.classifyRolloverDraft("Continue", "continue"), "replace_carryover");
  assert.equal(api.classifyRolloverDraft("  CONTINUE\n", "Continue"), "replace_carryover");
  assert.equal(api.classifyRolloverDraft("My manual draft", "Continue"), "preserve_manual");
  assert.equal(api.classifyRolloverDraft("Continue with this change", "Continue"), "preserve_manual");
  assert.equal(api.classifyRolloverDraft("Continue!", "Continue"), "preserve_manual");
  assert.equal(api.classifyRolloverDraft("Continue\u200b", "Continue"), "preserve_manual");
  assert.equal(api.classifyRolloverDraft("Continue  please", "Continue please"), "preserve_manual");
  const carriedComposer = {
    textContent: "Continue",
    get innerText() {
      return this.textContent;
    },
    focus() {},
    dispatchEvent() {}
  };
  assert.equal(api.clearComposer(carriedComposer), true);
  assert.equal(carriedComposer.textContent, "");
  assert.equal(
    api.buildRolloverPrompt("Initialize Example Research").includes(
      'continuation of the project chat titled "Initialize Example Research"'
    ),
    true
  );

  const button = visibleElement("Start new chat");
  const alert = visibleElement(
    "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat. Start new chat"
  );
  alert.querySelectorAll = () => [button];
  harness.setAlerts([alert]);
  assert.equal(api.findMaximumLengthAlert(), alert);
  assert.equal(api.findProjectRolloverButton(), button);

  Object.assign(api.state, {
    running: true,
    mode: "logic",
    logicPhase: "monitoring",
    rolloverEnabled: false,
    paused: false,
    count: 1,
    limit: 5,
    message: "Continue"
  });
  api.stopForMaximumLength();
  assert.equal(api.state.running, false, "disabled rollover must remain a hard stop");

  window.location.href = sourceUrl;
  window.location.pathname = new URL(sourceUrl).pathname;
  document.title = "Initialize Example Research";
  Object.assign(api.state, {
    running: true,
    mode: "logic",
    logicPhase: "monitoring",
    rolloverEnabled: true,
    paused: false,
    count: 1,
    limit: 5,
    message: "Continue",
    runId: 10
  });
  api.stopForMaximumLength();
  assert.equal(api.state.running, true);
  assert.equal(api.state.logicPhase, "rolling_over");
  assert.equal(harness.sentRequest().type, "LOGIC_ROLLOVER_PREPARE");
  assert.equal(harness.sentRequest().projectSegment, project);
}

async function testRolloverFailureStopsAndPreservesReason() {
  for (const failure of ["claim", "draft"]) {
    const harness = contentHarness();
    const { api, document, window } = harness;
    const project = "g-p-0123456789abcdef0123456789abcdef-job-search";
    window.location.href = `https://chatgpt.com/g/${project}/c/old`;
    window.location.pathname = `/g/${project}/c/old`;
    document.title = "Evidence Validation Update";
    const composer = visibleElement("", { "aria-label": "New chat in Job Search" });
    harness.setSelector("#prompt-textarea", [composer]);
    harness.setSelector("button[aria-label^='Change project:']", [
      visibleElement("", { "aria-label": "Change project: Job Search" })
    ]);
    const button = visibleElement("Start new chat");
    const alert = visibleElement("You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.");
    alert.querySelectorAll = () => [button];
    harness.setAlerts([alert]);
    button.click = () => {
      window.location.href = `https://chatgpt.com/g/${project}`;
      window.location.pathname = `/g/${project}`;
      document.title = "ChatGPT";
      harness.setAlerts([]);
      composer.innerText = composer.textContent = "different manual draft";
    };
    const requests = [];
    harness.setRequestHandler(async (request) => {
      requests.push(request);
      if (request.type === "LOGIC_ROLLOVER_PREPARE") return { ok: true, requestId: "handoff" };
      if (request.type === "LOGIC_ROLLOVER_CLAIM") return failure === "claim"
        ? { ok: false, error: "Claim failed for regression test." }
        : { ok: true, pending: { requestId: "handoff", projectSegment: project, previousTitle: "Evidence Validation Update", message: "Continue", count: 0, limit: 1000 } };
      return { ok: true };
    });
    Object.assign(api.state, { running: true, mode: "logic", logicPhase: "rolling_over", rolloverEnabled: true, message: "Continue", count: 0, limit: 1000, runId: 42 });
    await api.beginProjectRollover(42);
    assert.equal(api.state.running, false, `${failure}: rollover must stop after failure`);
    assert.equal(api.state.logicPhase, "idle");
    assert.equal(api.state.error, true);
    assert.match(api.state.detail, failure === "claim" ? /Claim failed for regression test/ : /different draft/);
    assert.equal(composer.textContent, "different manual draft", "manual draft must remain intact");
    assert.ok(requests.some(request => request.type === "LOGIC_ROLLOVER_CANCEL" && request.requestId === "handoff"));
    const notification = requests.find(request => request.type === "HA_NOTIFY_ROLLOVER_FAILURE");
    assert.equal(notification?.previousTitle, "Evidence Validation Update", "failure retains the source title after navigation");
    assert.equal(notification?.detail, api.state.detail);
  }
}

async function testGpt6TrailingResourceCards() {
  const { api } = contentHarness();
  const firstName = "video17-thumbnail-approved-1280x720.jpg";
  const secondName = "wide_cinematic_news_style_youtube_thumbnail_scen.png";
  const { root, rows } = resourceCardRoot([firstName, secondName]);
  const narrative = [
    "Owner action: download the approved original and reply downloaded.",
    "[[LOGIC:USER_INPUT]]"
  ].join("\n");
  const withResourceCards = [
    narrative,
    ...rows.map(({ row }) => row.innerText)
  ].join("\n");

  const cleaned = api.stripTrailingResourceCardText(root, withResourceCards);
  assert.equal(cleaned, narrative);
  assert.equal(api.parseLogicDirective(cleaned).flag, "user_input");

  const withRealTrailingProse = `${withResourceCards}\nThis is real trailing narrative.`;
  const preserved = api.stripTrailingResourceCardText(root, withRealTrailingProse);
  assert.equal(preserved, withRealTrailingProse);
  assert.equal(api.parseLogicDirective(preserved).flag, "missing");

  const unverified = resourceCardRoot(["unverified-image.jpg"], false);
  const unverifiedText = `${narrative}\n${unverified.rows[0].row.innerText}`;
  assert.equal(api.stripTrailingResourceCardText(unverified.root, unverifiedText), unverifiedText);
  assert.equal(api.parseLogicDirective(unverifiedText).flag, "missing");

  const regexName = "approved (final) [2].jpg";
  const escaped = resourceCardRoot([regexName]);
  const escapedText = `${narrative}\n${escaped.rows[0].row.innerText}`;
  assert.equal(api.stripTrailingResourceCardText(escaped.root, escapedText), narrative);
}

async function testBackgroundRolloverBinding() {
  const { api, fetchCalls } = await backgroundHarness();
  const project = "g-p-0123456789abcdef0123456789abcdef-example-project";
  const sourceUrl = `https://chatgpt.com/g/${project}/c/source-chat`;
  const destinationUrl = `https://chatgpt.com/g/${project}`;
  const sender = {
    id: "extension-test-id",
    tab: { id: 17, url: sourceUrl }
  };

  assert.equal(api.projectSegmentFromUrl(sourceUrl), project);
  assert.equal(api.chatPathFromUrl(`${sourceUrl}?temporary=1`), new URL(sourceUrl).pathname);
  const prepared = await api.prepareLogicRollover({
    projectSegment: project,
    previousTitle: "Initialize Example Research",
    message: "Continue",
    queuedPrompt: "Carry these extra instructions once",
    sourceUserFingerprint: { length: 68, sha256: "a".repeat(64), renderedLength: 67, renderedSha256: "b".repeat(64) },
    limit: 8,
    count: 3
  }, sender);
  assert.equal(prepared.ok, true);

  for (const tab of [
    { id: 99, url: destinationUrl },
    { id: 99, openerTabId: 17, url: destinationUrl },
    { id: 17, url: destinationUrl.replace("chatgpt.com", "chat.openai.com") },
    { id: 17, url: destinationUrl.replace("0123456789abcdef0123456789abcdef", "abcdef0123456789abcdef0123456789") }
  ]) assert.equal((await api.claimLogicRollover({}, { ...sender, tab })).pending, null,
    "only this source tab or its newly created child in the same project and origin can claim");
  assert.equal((await api.claimLogicRollover({ requestId: "missing" }, {
    ...sender, tab: { id: 17, url: destinationUrl }
  })).pending, null, "an explicit missing request must not fall back to another");
  const sourceClaim = await api.claimLogicRollover({}, sender);
  assert.equal(sourceClaim.pending, null, "the source conversation must not claim its own rollover");

  const sourceQueryClaim = await api.claimLogicRollover({}, {
    id: "extension-test-id",
    tab: { id: 17, url: `${sourceUrl}?temporary=1` }
  });
  assert.equal(
    sourceQueryClaim.pending,
    null,
    "a query-string change must not be accepted as a new project chat"
  );

  const wrongRootClaim = await api.claimLogicRollover({
    selectedProjectName: "Another Project"
  }, {
    id: "extension-test-id",
    tab: { id: 17, url: "https://chatgpt.com/" }
  });
  assert.equal(wrongRootClaim.pending, null);

  const rootClaim = await api.claimLogicRollover({
    requestId: prepared.requestId,
    selectedProjectName: "Example Project"
  }, {
    id: "extension-test-id",
    tab: { id: 17, url: "https://chatgpt.com/" }
  });
  assert.equal(rootClaim.pending, null, "a root composer exposes a name, not a stable project ID");
  const verifiedClaim = await api.claimLogicRollover({ requestId: prepared.requestId }, {
    ...sender, tab: { id: 17, url: destinationUrl }
  });
  assert.equal(verifiedClaim.pending.previousTitle, "Initialize Example Research");
  assert.equal(verifiedClaim.pending.count, 3);
  assert.equal(verifiedClaim.pending.limit, 8);
  assert.equal(verifiedClaim.pending.queuedPrompt, "Carry these extra instructions once");
  assert.equal(verifiedClaim.pending.sourceUserFingerprint.sha256, "a".repeat(64));
  assert.equal(verifiedClaim.pending.sourceUserFingerprint.length, 68);
  assert.equal(verifiedClaim.pending.sourceUserFingerprint.renderedLength, 67);
  assert.equal(verifiedClaim.pending.sourceUserFingerprint.renderedSha256, "b".repeat(64));
  for (const rendering of [{ renderedLength: 67 }, { renderedLength: 69, renderedSha256: "b".repeat(64) },
    { renderedLength: 67, renderedSha256: "bad" }]) {
    await assert.rejects(api.prepareLogicRollover({ projectSegment: project, previousTitle: "Old chat", message: "Continue",
      sourceUserFingerprint: { length: 68, sha256: "a".repeat(64), ...rendering }, limit: 8, count: 3
    }, sender), /rendering fingerprint is invalid/);
  }
  await assert.rejects(() => api.prepareLogicRollover({
    projectSegment: project, previousTitle: "Previous chat", message: "Continue",
    sourceUserFingerprint: { length: 68, sha256: "bad" }, limit: 8, count: 3
  }, sender), /fingerprint is invalid/);
  await assert.rejects(() => api.prepareLogicRollover({
    projectSegment: project, previousTitle: "Previous chat", message: "Continue",
    queuedPrompt: "x".repeat(8001), limit: 8, count: 3
  }, sender), /queued prompt is too long/);

  await api.prepareLogicRollover({
    projectSegment: project,
    previousTitle: "Initialize Example Research",
    message: "Continue",
    limit: 8,
    count: 3
  }, sender);
  const destinationSender = { ...sender, tab: { id: 17, url: destinationUrl } };
  const claims = await Promise.all([api.claimLogicRollover({}, destinationSender), api.claimLogicRollover({}, destinationSender)]);
  assert.equal(claims.filter(result => result.pending).length, 1, "claim must be atomic");
  const destinationClaim = claims.find(result => result.pending);
  assert.equal(destinationClaim.pending.previousTitle, "Initialize Example Research");
  assert.equal(destinationClaim.pending.count, 3);
  assert.equal(destinationClaim.pending.limit, 8);

  const second = await api.prepareLogicRollover({
    projectSegment: project,
    previousTitle: "Previous chat",
    message: "Status",
    limit: 4,
    count: 0
  }, sender);
  await assert.rejects(
    () => api.cancelLogicRollover(second, {
      id: "extension-test-id",
      tab: { id: 99, url: destinationUrl }
    }),
    /belongs to another ChatGPT tab/
  );
  const cancelled = await api.cancelLogicRollover(second, sender);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.removed, true);

  api.setConfigForTest({
    enabled: true,
    baseUrl: "https://home-assistant.example",
    notifyAction: "notify.mobile_app_test_phone",
    token: "test-token-not-logged",
    persistent: true
  });
  const failureNotification = await api.sendRolloverFailureNotification({
    previousTitle: "Initialize Example Research",
    detail: "Stopped: the new project chat could not be verified.",
    failureId: "REQUEST-123"
  }, sender);
  assert.equal(failureNotification.ok, true);
  assert.equal(failureNotification.enabled, true);
  const notificationPayload = JSON.parse(fetchCalls.at(-1)[1].body);
  assert.equal(notificationPayload.title, "ChatGPT project continuation failed");
  assert.match(notificationPayload.message, /Initialize Example Research/);
  assert.equal(notificationPayload.data.tag, "chatgpt_rollover_failed_request-123");
  assert.equal(notificationPayload.data.persistent, true);
  assert.equal(notificationPayload.data.sticky, true);
  assert.equal(notificationPayload.data.actions.length, 1);
  assert.equal(notificationPayload.data.actions[0].title, "Dismiss");
  assert.match(notificationPayload.data.actions[0].action, /^CHATGPT_DISMISS_ERROR_/);
}

async function testErrorDismissal() {
  const h = await backgroundHarness();
  h.api.setConfigForTest({ enabled: true, baseUrl: "https://home-assistant.example", notifyAction: "notify.mobile_app_test_phone", token: "test-token", persistent: true });
  const sender = { id: "extension-test-id", tab: { id: 17, url: "https://chatgpt.com/c/example" } };
  const request = { type: "HA_NOTIFY_ERROR", chatTitle: "Example", detail: "An error" };
  const payload = () => JSON.parse(h.fetchCalls.at(-1)[1].body);
  await h.dispatch(request, sender);
  const oldAction = payload().data.actions[0].action;
  await h.dispatch(request, sender);
  const action = payload().data.actions[0].action;
  assert.notEqual(action, oldAction);
  const before = h.fetchCalls.length;
  await h.api.handleNotificationAction({ action: oldAction });
  await h.api.handleNotificationAction({ action: "CHATGPT_DISMISS_ERROR_unknown" });
  assert.equal(h.fetchCalls.length, before, "unknown/stale buttons cannot clear the replacement error");
  h.api.setConfigForTest({ notifyAction: "notify.mobile_app_other_phone" });
  await h.api.handleNotificationAction({ action });
  assert.equal(h.fetchCalls.length, before, "dismissal is bound to the original notification destination");
  h.api.setConfigForTest({ notifyAction: "notify.mobile_app_test_phone" });
  await Promise.all([h.api.handleNotificationAction({ action }), h.api.handleNotificationAction({ action })]);
  assert.equal(h.fetchCalls.length, before + 1, "repeated taps clear once");
  assert.deepEqual(payload(), { message: "clear_notification", data: { tag: "chatgpt_error_17" } });
  assert.equal(h.tabMessages.length, 0, "Dismiss must never route a response to any agent");
  assert.equal(Object.keys(h.local.values.homeAssistantErrorNotifications).length, 0);

  await h.api.sendRolloverFailureNotification({ previousTitle: "Old chat", failureId: "rollover", detail: "Failed" }, sender);
  const rolloverAction = payload().data.actions[0].action;
  await h.api.handleNotificationAction({ action: rolloverAction });
  assert.deepEqual(payload(), { message: "clear_notification", data: { tag: "chatgpt_rollover_failed_rollover" } });
  assert.equal(h.tabMessages.length, 0);

  await h.dispatch(request, sender);
  const retryAction = payload().data.actions[0].action;
  h.failNextFetch();
  await h.api.handleNotificationAction({ action: retryAction });
  assert.equal(h.local.values.homeAssistantErrorNotifications.chatgpt_error_17.action, retryAction,
    "failed clearing preserves the button routing for retry");
  const restarted = await backgroundHarness(h.local);
  restarted.api.setConfigForTest({ enabled: true, baseUrl: "https://home-assistant.example", notifyAction: "notify.mobile_app_test_phone", token: "test-token" });
  await restarted.api.handleNotificationAction({ action: retryAction });
  assert.deepEqual(JSON.parse(restarted.fetchCalls.at(-1)[1].body), { message: "clear_notification", data: { tag: "chatgpt_error_17" } });
  assert.equal(restarted.tabMessages.length, 0);

  h.failNextFetch();
  const failed = await h.dispatch(request, sender);
  assert.equal(failed.ok, false);
  assert.equal(Object.keys(h.local.values.homeAssistantErrorNotifications).length, 0,
    "failed delivery must not leave a dangling action");
}

module.exports = { contentHarness, visibleElement, backgroundHarness };

if (require.main === module) (async () => {
  await testContentRolloverGuards();
  await testRolloverFailureStopsAndPreservesReason();
  await testGpt6TrailingResourceCards();
  await testBackgroundRolloverBinding();
  await testRuntimeErrorNotifications();
  await testHeartbeatContentFlow();
  await testErrorNotificationRouting();
  await testErrorDismissal();
  console.log("rollover tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
