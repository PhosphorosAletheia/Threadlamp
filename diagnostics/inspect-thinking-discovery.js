/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
// Paste this WHOLE file into the affected ChatGPT tab's DevTools Console.
// Captures now and again after 8 seconds. Leave the failed page as it is for the
// first run. Optional second run: open the thinking/model menu during the delay,
// leave it open, and return to Console only after 8 seconds have elapsed.
// Read-only: no clicks, focus changes, edits, sends, storage, network or other tabs.
// Reports UI control labels, which may include project names. Draft/transcript
// text, page title, URLs and extension settings are not included. The extension
// banner text is included and may contain the previous chat title or project name.
(() => {
  "use strict";
  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  function findComposer() {
    const selectors = [
      "#prompt-textarea",
      "textarea[data-id='root']",
      "form textarea",
      "form [contenteditable='true']"
    ];

    return selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .find(isVisible) || null;
  }

  function findSendButton() {
    const selectors = [
      "button[data-testid='send-button']",
      "form button[aria-label='Send prompt']",
      "form button[aria-label='Send message']",
      "form button[aria-label^='Send']"
    ];

    return selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .find(isVisible) || null;
  }

  function buttonIsEnabled(button) {
    return Boolean(
      button &&
      isVisible(button) &&
      !button.disabled &&
      button.getAttribute("aria-disabled") !== "true"
    );
  }

  // Use accessible controls inside this composer's form, never transcript text
  // or a page-wide button named High. Unsupported layouts stop the rollover.
  function thinkingControlName(element) {
    return String(element?.getAttribute("aria-label") || element?.innerText || element?.textContent || "")
      .replace(/\s+/g, " ").trim().toLowerCase();
  }

  function thinkingTriggerName(element) {
    const name = thinkingControlName(element);
    const text = String(element?.innerText || element?.textContent || "")
      .replace(/\s+/g, " ").trim().toLowerCase();
    // User-captured ChatGPT UI: the chip says High or Thinking effort High; its
    // accessible label says Select ChatGPT model. Do not apply this exception
    // to menu options, other labels, or model names that merely contain High.
    if (name === "select chatgpt model" && element?.getAttribute("aria-haspopup") === "menu"
      && /^(?:thinking effort )?(?:low|medium|high)$/.test(text)) return text;
    return name;
  }

  function findThinkingControl(composer) {
    const scope = composer?.closest("form") || (composer && findComposerShell(composer));
    if (!scope) return null;
    const candidates = [...scope.querySelectorAll("button, [role='button']")].filter((element) => {
      if (!buttonIsEnabled(element)) return false;
      const name = thinkingTriggerName(element);
      const popup = element.getAttribute("aria-haspopup");
      return /^(?:thinking|reasoning)(?: (?:effort|level|time))?(?:[:,]? (?:low|medium|high))?$/.test(name)
        || (/^(?:low|medium|high)$/.test(name) && (popup === "menu" || popup === "listbox"));
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function thinkingControlShowsHigh(control) {
    return /^(?:(?:thinking|reasoning)(?: (?:effort|level|time))?[:,]? )?high$/.test(thinkingTriggerName(control));
  }

  function visibleThinkingMenus() {
    return [...document.querySelectorAll("[role='menu'], [role='listbox']")].filter(isVisible);
  }

  function thinkingSliderState(menu, control) {
    if (!menu?.isConnected || !isVisible(menu)
      || thinkingControlName(control) !== "select chatgpt model") return null;
    const sliders = [...menu.querySelectorAll("[role='slider']")].filter(isVisible);
    const powerControls = [...menu.querySelectorAll("[role='menuitem'][aria-label='Power']")].filter(buttonIsEnabled);
    const statuses = [...menu.querySelectorAll("[role='status']")].filter(isVisible);
    if (sliders.length !== 1 || powerControls.length !== 1 || statuses.length !== 1) return null;
    const slider = sliders[0];
    // Captured at both Medium and High by the user. The thumb is aria-hidden
    // and tabindex=-1 but geometrically visible; those attributes are expected.
    if (!buttonIsEnabled(slider) || slider.getAttribute("aria-valuemin") !== "0"
      || slider.getAttribute("aria-valuemax") !== "2"
      || slider.getAttribute("aria-orientation") !== "horizontal") return null;
    const value = slider.getAttribute("aria-valuenow");
    const status = thinkingControlName(statuses[0]);
    if ((value === "1" && status === "medium, 2 of 3.")
      || (value === "2" && status === "high, 3 of 3.")) return { slider, value };
    return null;
  }

  function findComposerShell(composer) {
    const sendButton = findSendButton();

    if (sendButton) {
      let candidate = composer.parentElement;
      while (candidate && candidate !== document.body) {
        if (candidate.contains(sendButton) && isVisible(candidate)) return candidate;
        candidate = candidate.parentElement;
      }
    }

    const form = composer.closest("form");
    return form && isVisible(form) ? form : composer;
  }


  const controlsSelector = "button, [role='button'], [role='combobox'], [aria-haspopup], summary, select";
  const transcriptSelector = "[data-message-author-role], [data-conversation-role], [data-user-message-bubble], [data-turn], [data-testid^='conversation-turn'], [data-testid='assistant-turn'], [data-testid='user-turn']";
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const label = value => String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
  function privateContent(element, composer) {
    if (element === composer || composer?.contains(element) || (composer && element.contains(composer))
      || element.closest("[contenteditable='true'], textarea, input:not([type='range'])") || element.closest(transcriptSelector)) return true;
    // Some current assistant containers expose their role on a sibling heading.
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      if ([...node.children].some(child => /^H[1-6]$/.test(child.tagName)
        && child.matches("[data-conversation-role]"))) return true;
    }
    return Boolean(element.querySelector(transcriptSelector)
      || element.querySelector("[contenteditable='true'], textarea, input:not([type='range'])"));
  }
  function acceptedName(element) {
    const name = thinkingTriggerName(element), popup = element.getAttribute("aria-haspopup");
    return /^(?:thinking|reasoning)(?: (?:effort|level|time))?(?:[:,]? (?:low|medium|high))?$/.test(name)
      || (/^(?:low|medium|high)$/.test(name) && (popup === "menu" || popup === "listbox"));
  }
  function describe(element, scope, selected) {
    const button = element.matches("button, [role='button']");
    const inScope = Boolean(scope?.contains(element));
    const reasons = [];
    if (!inScope) reasons.push("outside_current_composer_scope");
    if (!button) reasons.push("not_a_button_in_current_selector");
    if (!isVisible(element)) reasons.push("not_geometrically_visible");
    if (element.disabled || element.getAttribute("aria-disabled") === "true") reasons.push("disabled");
    if (!acceptedName(element)) reasons.push("name_or_popup_not_supported");
    return {
      tag: element.tagName, role: element.getAttribute("role"),
      text: label(element.innerText || element.textContent),
      ariaLabel: label(element.getAttribute("aria-label")),
      testId: label(element.getAttribute("data-testid")),
      hasPopup: element.getAttribute("aria-haspopup"), expanded: element.getAttribute("aria-expanded"),
      ariaHidden: element.getAttribute("aria-hidden"),
      visible: isVisible(element), enabled: buttonIsEnabled(element),
      inCurrentScope: inScope, selectedByCurrentDetector: element === selected,
      recognizedAsHigh: thinkingControlShowsHigh(element), rejectionReasons: reasons,
      checked: element.getAttribute("aria-checked"), selected: element.getAttribute("aria-selected"),
      slider: element.matches("[role='slider'], input[type='range']") ? {
        min: element.getAttribute("aria-valuemin") || element.getAttribute("min"),
        max: element.getAttribute("aria-valuemax") || element.getAttribute("max"),
        now: element.getAttribute("aria-valuenow"), orientation: element.getAttribute("aria-orientation"),
        valueText: label(element.getAttribute("aria-valuetext"))
      } : null
    };
  }
  function rolloverContext(composer) {
    const url = new URL(window.location.href);
    const draft = composer ? String(typeof composer.value === "string" ? composer.value
      : composer.innerText || composer.textContent || "") : "";
    const banner = document.getElementById("chatgpt-continue-loop-status")?.shadowRoot;
    const send = findSendButton();
    const stop = all("button[data-testid='stop-button'], form button[aria-label^='Stop']").filter(isVisible);
    const count = role => all(`[data-message-author-role='${role}'], [data-conversation-role='${role}'], [data-turn='${role}'], [data-testid='${role}-turn']`).length;
    return {
      page: {
        supportedOrigin: ["https://chatgpt.com", "https://chat.openai.com"].includes(url.origin),
        rootPage: url.pathname === "/", projectPath: /^\/g\/g-p-/.test(url.pathname),
        savedConversation: /\/c\/[^/]+/.test(url.pathname),
        visibleProjectChangeControl: all("button[aria-label^='Change project:']").some(isVisible)
      },
      draft: {
        rawLength: draft.length, trimmedLength: draft.trim().length,
        containsContinuationPreamble: draft.includes("This chat is a continuation of the project chat titled"),
        containsLogicStartup: draft.includes("Start Logic Mode for this conversation.")
      },
      send: { found: Boolean(send), enabled: buttonIsEnabled(send) },
      visibleStopControlCount: stop.length,
      messageNodes: { user: count("user"), assistant: count("assistant") },
      extensionUI: {
        overlayPresent: Boolean(banner),
        headline: label(banner?.querySelector(".headline")?.textContent),
        detail: String(banner?.querySelector(".detail")?.textContent || "").trim().slice(0, 1200)
      }
    };
  }
  function snapshot() {
    const composer = findComposer();
    const form = composer?.closest("form");
    const scope = form || (composer && findComposerShell(composer));
    const selected = findThinkingControl(composer);
    const safe = node => !privateContent(node, composer);
    const scoped = scope ? all(controlsSelector, scope).filter(safe) : [];
    const elsewhere = all(controlsSelector).filter(node => safe(node) && !scope?.contains(node)
      && (/\b(thinking|reasoning|effort|model|gpt|low|medium|high|standard|extended|heavy|light|power|instant)\b/i
        .test(`${node.getAttribute("aria-label") || ""} ${node.innerText || node.textContent || ""}`)
        || ["menu", "listbox"].includes(node.getAttribute("aria-haspopup"))));
    const menus = visibleThinkingMenus().filter(safe);
    const accepted = scoped.filter(node => node.matches("button, [role='button']") && buttonIsEnabled(node) && acceptedName(node));
    const findings = [];
    if (!composer) findings.push("No visible composer matched the extension's selectors.");
    else if (!form) findings.push("No composer form: the detector uses its send-button-based fallback container.");
    if (composer && !scoped.length) findings.push("No reportable controls were found inside the selected composer scope.");
    if (!selected && accepted.length === 0) findings.push("No unique supported thinking trigger was detected; compare scoped controls with controls elsewhere.");
    if (accepted.length > 1) findings.push("Multiple supported controls make the current detector refuse selection.");
    if (selected) findings.push("The current source detector identifies a thinking control in this snapshot; this does not reconstruct the earlier failure.");
    if (menus.length) findings.push("A menu is already open; current rollover code refuses to take over an already-open menu.");
    return {
      rollover: rolloverContext(composer),
      readyState: document.readyState, visibilityState: document.visibilityState,
      composerFound: Boolean(composer), composerTag: composer?.tagName || null,
      composerFormFound: Boolean(form), scopeTag: scope?.tagName || null,
      scopeIsComposer: Boolean(composer && scope === composer),
      detectorFoundControl: Boolean(selected), supportedScopedControlCount: accepted.length,
      scopedControlCount: scoped.length, scopedControls: scoped.slice(0, 40).map(node => describe(node, scope, selected)),
      otherCandidateCount: elsewhere.length, otherCandidates: elsewhere.slice(0, 30).map(node => describe(node, scope, selected)),
      menus: menus.slice(0, 8).map(menu => ({
        role: menu.getAttribute("role"),
        linkedToSelectedTrigger: Boolean(selected && (
          (menu.id && String(selected.getAttribute("aria-controls") || "").split(/\s+/).includes(menu.id))
          || (selected.id && String(menu.getAttribute("aria-labelledby") || "").split(/\s+/).includes(selected.id)))),
        recognizedSliderValue: selected ? thinkingSliderState(menu, selected)?.value || null : null,
        items: all("[role='menuitemradio'], [role='menuitem'], [role='option'], [role='radio'], [role='slider'], [role='status'], input[type='range'], button", menu)
          .filter(safe).slice(0, 40).map(node => describe(node, scope, selected))
      })),
      findings
    };
  }
  const initialUrl = window.location.href;
  const initialComposer = findComposer();
  const initial = snapshot();
  console.log("Read-only capture started. Wait 8 seconds; a JSON report will follow. Optional: open the thinking menu during the delay.");
  setTimeout(() => {
    const samePage = window.location.href === initialUrl;
    const report = {
      diagnostic: "chatgpt-continue-loop/thinking-discovery",
      schemaVersion: 2, selectorBaselineVersion: "1.8.9", capturedAt: new Date().toISOString(),
      captureDelayMs: 8000, pageUnchanged: samePage,
      composerElementReplaced: samePage ? findComposer() !== initialComposer : null,
      initial, delayed: samePage ? snapshot() : null,
      limits: [
        "Read-only snapshots of this tab only; no clicks, focus, edits, sends, storage, network, or other agents.",
        "UI labels and extension banner text may include project names and chat titles. Draft/transcript text, page title, URLs and extension settings are omitted.",
        "Message node counts can include nested or stale DOM nodes; they do not prove sending. Draft markers do not establish ownership or permission to clear it.",
        "Source selector baseline is not a detection of the installed extension version.",
        "No historical clicks/errors or original failure timing can be reconstructed. Hidden shadow-root/frame contents are not inspected.",
        "The delayed snapshot is skipped if the page URL changes. Output is capped to bounded control lists."
      ]
    };
    console.log(JSON.stringify(report, null, 2));
  }, 8000);
})();
