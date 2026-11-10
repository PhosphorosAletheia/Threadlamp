/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
// Paste the whole file into the affected ChatGPT tab's DevTools Console.
// Run after the incomplete SERVER_READY reply has finished.
// Read-only: no clicks, edits, sends, storage, network, or other-tab access.
// Reports counts/booleans only; no transcript, identifiers, addresses, or secrets.
(() => {
  "use strict";
  // Reader copied from source 1.8.5; this is not the installed version.
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
        return (clone.textContent || "").trim();
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  function messageElements(role) {
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
      return [...new Set(roleNodes.map((node) => {
        const isAssistantAccessibilityLabel = role === "assistant"
          && node.matches("[data-conversation-role='assistant']")
          && /^H[1-6]$/.test(node.tagName);

        // The current UI puts data-conversation-role="assistant" on a
        // screen-reader heading. Its immediate parent contains that label and
        // the actual assistant response, while feedback/actions remain outside.
        return isAssistantAccessibilityLabel && node.parentElement
          ? node.parentElement
          : node;
      }))];
    }

    // Older ChatGPT versions used article/section conversation-turn wrappers.
    // Keep these as fallbacks for legacy and staged rollouts.
    const turnSelectors = [
      `[data-turn='${role}']`,
      `[data-role='${role}'][data-testid*='conversation-turn']`,
      `[data-testid='${role}-turn']`
    ];

    return [...new Set(turnSelectors.flatMap((selector) => [
      ...document.querySelectorAll(selector)
    ]))];
  }


  function inspectText(value) {
    const text = String(value || "");
    const starts = [...text.matchAll(/\[\[SERVER_READY:/g)];
    const strict = [...text.matchAll(/^\[\[SERVER_READY:(\{[^\r\n]+\})\]\]$/gm)];
    return {
      length: text.length,
      markerStartCount: starts.length,
      strictSingleLineBlockCount: strict.length,
      markers: starts.slice(-5).map(match => {
        const suffix = text.slice(match.index + match[0].length);
        const end = suffix.indexOf("]]");
        const payload = end < 0 ? suffix : suffix.slice(0, end);
        let parsed = null;
        let jsonValid = false;
        if (end >= 0) {
          try { parsed = JSON.parse(payload); jsonValid = true; } catch {}
        }
        const object = jsonValid && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
        let allowedEndpointShape = false;
        if (object && typeof parsed.endpoint === "string") {
          try {
            const url = new URL(parsed.endpoint);
            allowedEndpointShape = url.protocol === "ws:"
              && ["localhost", "127.0.0.1"].includes(url.hostname)
              && Number(url.port) >= 1024 && Number(url.port) <= 65535
              && !url.username && !url.password && !url.search && !url.hash
              && url.pathname === "/.well-known/continue-loop";
          } catch {}
        }
        return {
          suffixLength: suffix.length,
          onlyWhitespaceAfterOpener: !suffix.trim(),
          closingDelimiterPresent: end >= 0,
          payloadLength: payload.length,
          payloadHasLineBreaks: /[\r\n]/.test(payload),
          payloadBeginsWithObject: payload.trimStart().startsWith("{"),
          jsonValid,
          protocolIsOne: Boolean(object && parsed.protocol === 1),
          setupIdIsNonemptyString: Boolean(object && typeof parsed.setupId === "string" && parsed.setupId.length),
          projectIdIsNonemptyString: Boolean(object && typeof parsed.projectId === "string" && parsed.projectId.length),
          allowedEndpointShape
        };
      })
    };
  }
  const nodes = messageElements("assistant");
  const report = {
    diagnostic: "chatgpt-continue-loop/server-ready-rendering",
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    readerBaselineVersion: "1.8.5",
    assistantNodeCount: nodes.length,
    candidates: nodes.slice(-3).map((node, index, selected) => {
      const read = messageText(node);
      return {
        offsetFromLatest: selected.length - 1 - index,
        extensionReader: inspectText(read),
        innerText: inspectText(node.innerText),
        textContent: inspectText(node.textContent),
        readerEqualsInnerText: read === String(node.innerText || "").trim(),
        readerEqualsTextContent: read === String(node.textContent || "").trim(),
        codeBlockCount: node.querySelectorAll("pre").length,
        contentRoots: [...new Set(MESSAGE_CONTENT_SELECTORS.flatMap(selector => [
          ...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)
        ]))].slice(-10).map(root => ({
          innerText: inspectText(root.innerText),
          textContent: inspectText(root.textContent)
        }))
      };
    }),
    limits: [
      "Only the last three rendered assistant containers in this tab were read. Nested content roots may overlap.",
      "Snapshot cannot prove what the model generated, server stored, or clipboard copied; absent DOM text may have been omitted earlier.",
      "Reader baseline is source 1.8.5, not a detection of the installed extension version.",
      "Valid JSON and endpoint shape do not verify attempt identity, server reachability, or authentication.",
      "No transcript, field values, IDs, addresses, or credentials are included. No state was changed."
    ]
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
})();
