/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
// Run the WHOLE file in the failed NEW chat's DevTools Console; keep its draft intact.
// Read-only DOM inspection. No clicks, focus, edits, sends, storage or network.
// Output contains only lengths, comparisons and UI-state booleans, not message text.
// The compact JSON is copied to your clipboard when DevTools copy() is available.
(() => {
  "use strict";
  const MESSAGE_CONTENT_SELECTORS = [
    "[data-message-content]",
    ".markdown",
    ".prose"
  ];
  const MESSAGE_UI_SELECTOR = [
    "button",
    "[role='button']",
    "textarea",
    "input",
    "[contenteditable='true']",
    "svg",
    "script",
    "style",
    "noscript"
  ].join(",");
  const RESOURCE_PREVIEW_BUTTON_SELECTOR = "button[aria-label^='Open preview of ']";
  const RESOURCE_DOWNLOAD_BUTTON_SELECTOR = "button[aria-label='Download file']";
  const RESOURCE_ROW_MAX_ANCESTOR_DEPTH = 3;
  const RESOURCE_ROW_EXTRA_TEXT_LIMIT = 100;
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

  function verifiedResourceRows(root) {
    if (!root?.querySelectorAll) return [];

    return [...new Set([...root.querySelectorAll(RESOURCE_PREVIEW_BUTTON_SELECTOR)]
      .map((previewButton) => {
        const ariaLabel = previewButton.getAttribute("aria-label") || "";
        const fileName = ariaLabel.replace(/^Open preview of\s+/i, "").trim();
        if (!fileName) return null;

        let candidate = previewButton.parentElement;
        for (
          let depth = 0;
          candidate && candidate !== root && depth < RESOURCE_ROW_MAX_ANCESTOR_DEPTH;
          depth += 1, candidate = candidate.parentElement
        ) {
          const text = (candidate.innerText || candidate.textContent || "").trim();
          const downloadButton = candidate.querySelector?.(RESOURCE_DOWNLOAD_BUTTON_SELECTOR);
          if (!text || !downloadButton) continue;

          const boundedResourceText = (
            text.includes(fileName)
            && text.length <= fileName.length + RESOURCE_ROW_EXTRA_TEXT_LIMIT
            && !text.includes("[[LOGIC:")
          );
          return boundedResourceText ? candidate : null;
        }
        return null;
      })
      .filter(Boolean))];
  }

  function whitespaceFlexibleSuffix(text) {
    return text
      .trim()
      .split(/\s+/)
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
  }

  function stripTrailingResourceCardText(root, text) {
    let cleaned = String(text || "").trim();
    const rows = verifiedResourceRows(root);

    for (const row of [...rows].reverse()) {
      const rowText = (row.innerText || row.textContent || "").trim();
      if (!rowText) continue;
      const suffix = whitespaceFlexibleSuffix(rowText);
      if (!suffix) continue;
      const pattern = new RegExp(`\\s*${suffix}\\s*$`);
      if (pattern.test(cleaned)) cleaned = cleaned.replace(pattern, "").trimEnd();
    }

    return cleaned;
  }

  function messageText(element) {
    if (!element) return "";

    const candidates = MESSAGE_CONTENT_SELECTORS.flatMap((selector) => [
      ...(element.matches?.(selector) ? [element] : []),
      ...element.querySelectorAll(selector)
    ]);

    // A Markdown block commonly also matches .prose.
    // Keep only outermost unique roots so response text is not duplicated.
    const uniqueCandidates = [...new Set(candidates)];
    const contentRoots = uniqueCandidates.filter((candidate) => (
      !uniqueCandidates.some((other) => other !== candidate && other.contains(candidate))
    ));
    const roots = contentRoots.length ? contentRoots : [element];
    const isNormalizedAssistantContainer = [...element.children].some((child) => (
      child.matches?.("[data-conversation-role='assistant']")
      && /^H[1-6]$/.test(child.tagName)
    ));

    return roots
      .map((root) => {
        if (contentRoots.length) {
          return (root.innerText || root.textContent || "").trim();
        }

        if (isNormalizedAssistantContainer) {
          return stripTrailingResourceCardText(
            root,
            root.innerText || root.textContent || ""
          );
        }

        // The September 2026 UI no longer exposes a dedicated Markdown root.
        // When reading its role container, remove action controls from a clone
        // so Copy/feedback labels cannot appear after the final Logic marker.
        const clone = root.cloneNode(true);
        verifiedResourceRows(clone).forEach((row) => row.remove());
        clone.querySelectorAll(MESSAGE_UI_SELECTOR).forEach((node) => node.remove());
        if (element.matches?.("[data-message-author-role='user'], [data-user-message-bubble='true'], [data-turn='user'], [data-role='user'], [data-testid='user-turn']")) {
          // textContent joins paragraphs and drops BRs in newer user bubbles.
          // Restore structural breaks on the detached clone, without changing
          // inline word boundaries or relaxing submitted-message comparisons.
          clone.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
          clone.querySelectorAll("p, div, li, blockquote, pre, h1, h2, h3, h4, h5, h6")
            .forEach((node) => { node.prepend("\n"); node.append("\n"); });
        }
        return (clone.textContent || "").trim();
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  function messageElements(role, includeInactive = false) {
    // ChatGPT retains prior routes in display:none subtrees after navigation.
    // Read the active route, without dropping offscreen/virtualized turns or
    // screen-reader headings just because they have a small or empty rectangle.
    const activeCache = new Map();
    const active = node => {
      if (!node) return true;
      if (activeCache.has(node)) return activeCache.get(node);
      const result = window.getComputedStyle(node).display !== "none" && active(node.parentElement);
      activeCache.set(node, result);
      return result;
    };
    const retained = nodes => includeInactive ? nodes : nodes.filter(active);
    const roleSelectors = role === "assistant"
      ? [
          "[data-message-author-role='assistant']",
          "[data-conversation-role='assistant']"
        ]
      : [
          "[data-message-author-role='user']",
          "[data-user-message-bubble='true']"
        ];
    const roleSelector = roleSelectors.join(",");
    const roleNodes = [...document.querySelectorAll(roleSelector)]
      .filter((node) => !node.parentElement?.closest(roleSelector));

    if (roleNodes.length) {
      const messages = retained([...new Set(roleNodes.map((node) => {
        const isAssistantAccessibilityLabel = role === "assistant"
          && node.matches("[data-conversation-role='assistant']")
          && /^H[1-6]$/.test(node.tagName);

        // The current UI puts data-conversation-role="assistant" on a
        // screen-reader heading. Its immediate parent contains that label and
        // the actual assistant response, while feedback/actions remain outside.
        return isAssistantAccessibilityLabel && node.parentElement
          ? node.parentElement
          : node;
      }))]);
      if (messages.length) return messages;
    }

    // Older ChatGPT versions used article/section conversation-turn wrappers.
    // Keep these as fallbacks for legacy and staged rollouts.
    const turnSelectors = [
      `[data-turn='${role}']`,
      `[data-role='${role}'][data-testid*='conversation-turn']`,
      `[data-testid='${role}-turn']`
    ];

    return retained([...new Set(turnSelectors.flatMap((selector) => [
      ...document.querySelectorAll(selector)
    ]))]);
  }

  function composerText(composer) {
    if (!composer) return "";
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      return composer.value.trim();
    }
    return (composer.innerText || composer.textContent || "").trim();
  }

  function isEmptyComposerDecoration(node) {
    if (node.nodeType !== 1 || node.tagName !== "SPAN"
      || node.getAttribute("contenteditable") !== "false"
      || node.getAttribute("aria-hidden") !== "true" || node.textContent !== "") return false;
    // Rich editors can insert an empty icon beside plain text. Accept only a
    // bounded span/SVG/path decoration, never text, attachments, or labeled UI.
    const pending = [node];
    let count = 0, svgCount = 0, pathCount = 0;
    while (pending.length) {
      const current = pending.pop();
      if (++count > 32 || current.nodeType !== 1
        || !["SPAN", "SVG", "PATH"].includes(current.tagName.toUpperCase())
        || current.textContent !== ""
        || ["aria-label", "aria-labelledby", "title", "alt", "src", "href", "role"]
          .some(name => current.getAttribute(name) !== null)) return false;
      if (current.tagName.toUpperCase() === "SVG") svgCount += 1;
      if (current.tagName.toUpperCase() === "PATH") pathCount += 1;
      pending.push(...current.childNodes);
    }
    return svgCount === 1 && pathCount > 0;
  }

  function composerDraftMatches(composer, expected) {
    const normalize = text => String(text).replace(/\r\n?/g, "\n").trim();
    if (!composer) return false;
    if (normalize(composerText(composer)) === normalize(expected)) return true;
    // innerText adds layout separators between paragraphs. Read only simple
    // editor paragraphs as logical lines; do not collapse arbitrary whitespace,
    // strip invisible characters, or ignore extra text/attachments.
    const blocks = [...(composer.childNodes || [])];
    if (!blocks.length || !blocks.every(node => node.nodeType === 1 && /^(P|DIV)$/.test(node.tagName))) return false;
    const inlineText = node => {
      if (node.nodeType === 3) return node.nodeValue;
      if (isEmptyComposerDecoration(node)) return "";
      if (node.nodeType !== 1 || node.getAttribute("contenteditable") === "false") return null;
      if (node.tagName === "BR") return "\n";
      if (!/^(P|DIV|SPAN)$/.test(node.tagName)) return null;
      const children = [...node.childNodes];
      if (/^(P|DIV)$/.test(node.tagName) && children.length === 1 && children[0].tagName === "BR") return "";
      if (children.some(child => /^(P|DIV)$/.test(child.tagName))) return null;
      const parts = children.map(inlineText);
      return parts.includes(null) ? null : parts.join("");
    };
    const lines = blocks.map(inlineText);
    return !lines.includes(null) && normalize(lines.join("\n")) === normalize(expected);
  }

  const all = selector => [...document.querySelectorAll(selector)];
  const normalize = text => String(text || "").replace(/\r\n?/g, "\n").trim();
  const compact = text => normalize(text).replace(/\s+/g, " ");
  const composer = findComposer();
  const draft = composerText(composer);
  const primary = messageElements("user");
  const alternateSelector = "[data-conversation-role='user']";
  const alternate = all(alternateSelector).filter(node => !node.parentElement?.closest(alternateSelector));
  // Role headings describe a message; their parent may contain its actual body.
  // These are diagnostic candidates, not a new runtime selector or ownership rule.
  const alternateContainers = [...new Set(alternate.map(node => /^H[1-6]$/.test(node.tagName)
    ? node.parentElement || node : node))];
  const assistant = messageElements("assistant").at(-1);
  const notice = "you've reached the maximum length for this conversation, but you can keep talking by starting a new chat.";
  const isNotice = node => String(node?.textContent || "").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim().toLowerCase().includes(notice);
  const summarize = node => {
    if (!node) return null;
    const read = messageText(node);
    const raw = node.innerText || node.textContent || "";
    return {
      tag: node.tagName, visible: isVisible(node),
      extensionReaderLength: normalize(read).length, domTextLength: normalize(raw).length,
      readerEqualsDraft: Boolean(draft && normalize(read) === normalize(draft)),
      domTextEqualsDraft: Boolean(draft && normalize(raw) === normalize(draft)),
      readerEqualsDraftIgnoringWhitespace: Boolean(draft && compact(read) === compact(draft)),
      logicalComposerEqualsReader: Boolean(draft && composerDraftMatches(composer, read))
    };
  };
  const url = new URL(window.location.href);
  const lastPrimary = primary.at(-1), lastAlternate = alternate.at(-1);
  const projectButton = all("button[aria-label^='Change project:']").find(isVisible);
  const composerProject = composer?.getAttribute("aria-label")?.match(/^New chat in (.+)$/i)?.[1] || "";
  const buttonProject = projectButton?.getAttribute("aria-label")?.replace(/^Change project:\s*/i, "") || "";
  const name = text => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const report = {
    diagnostic: "chatgpt-continue-loop/rollover-draft-match", schemaVersion: 2,
    sourceBaseline: "1.8.9", capturedAt: new Date().toISOString(),
    page: { root: url.pathname === "/", savedChat: /\/c\/[^/]+/.test(url.pathname),
      composerFound: Boolean(composer), matchingProjectLabels: Boolean(composerProject && buttonProject && name(composerProject) === name(buttonProject)) },
    draft: { length: draft.length, innerTextAndTextContentAgree: composer ? composer.innerText === composer.textContent : null,
      childTags: [...(composer?.children || [])].slice(0, 12).map(node => node.tagName),
      specialWhitespacePresent: /[\u00a0\u200b-\u200d\u202f\u2060\ufeff]/.test(draft) },
    currentUserSelectorCount: primary.length, alternateUserSelectorCount: alternate.length,
    latestCurrentUser: summarize(lastPrimary), latestAlternateUser: summarize(lastAlternate),
    latestAlternateContainer: summarize(alternateContainers.at(-1)),
    alternateContainerDraftComparison: alternateContainers.map((node, index) => {
      const read = normalize(messageText(node));
      const raw = normalize(node.innerText || node.textContent || "");
      const target = normalize(draft);
      const readerOffset = target ? read.indexOf(target) : -1;
      const rawOffset = target ? raw.indexOf(target) : -1;
      return { index, tag: node.tagName, readerLength: read.length, rawLength: raw.length,
        readerEqualsDraft: Boolean(target && read === target),
        readerContainsDraft: readerOffset >= 0,
        rawContainsDraft: rawOffset >= 0,
        extraReaderPrefixLength: readerOffset >= 0 ? readerOffset : null,
        extraReaderSuffixLength: readerOffset >= 0 ? read.length - readerOffset - target.length : null,
        currentSelectorInside: primary.some(current => node === current || node.contains(current)) };
    }).filter(item => item.readerContainsDraft || item.rawContainsDraft || item.index >= alternateContainers.length - 3).slice(-8),
    latestSelectorsPointToSameNode: Boolean(lastPrimary && lastPrimary === lastAlternate),
    draftMatchesAnyCurrentUser: Boolean(draft && primary.some(node => normalize(messageText(node)) === normalize(draft))),
    draftMatchesAnyAlternateUser: Boolean(draft && alternate.some(node => normalize(messageText(node)) === normalize(draft))),
    maximumLengthNotice: { inLatestAssistant: isNotice(assistant), latestAssistantVisible: Boolean(assistant && isVisible(assistant)),
      visibleAlerts: all("[role='alert']").filter(node => isVisible(node) && isNotice(node)).length },
    limits: ["Current DOM only; retained old messages do not prove new-chat history or server acceptance.",
      "Comparisons do not prove draft ownership. The original saved source fingerprint and extension error are inaccessible from this page console.",
      "Source baseline is not the installed version. No message, draft, title, URL, project name, hash or credential is included."]
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (typeof copy === "function") copy(json);
  return report;
})();
