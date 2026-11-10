/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
// Paste this ENTIRE file into the affected ChatGPT tab's DevTools Console.
// Leave the chat as it is. Do not click Recover again to run this inspection.
// Read-only: no clicks, sends, focus, edits, network, extension storage, or other tabs.
// Tokens and prompt text are read locally for comparison but NEVER included in output.
(() => {
  "use strict";
  const VERSION = 1;
  const PATH = "/.well-known/continue-loop";
  // Frozen recovery-prompt template from 1.8.3; comparison is inferred from DOM
  // fields, not proof of what the isolated content script originally sent.
  function recoveryPrompt(record, extensionId, previousSetupId) {
    return `Recover the EXISTING local server connection for Threadlamp protocol ${VERSION}. This is recovery of an interrupted setup, not a new installation.
Project ID: ${record.projectId}
${previousSetupId ? `Previous setup ID: ${previousSetupId}` : "No earlier setup record is available in this extension. Find the existing integration in this chat, your persistent framework, and saved server configuration. Missing extension settings do not mean the server is missing."}
Recovery setup ID: ${record.setupId}
Allowed WebSocket Origin: chrome-extension://${extensionId}
${record.endpoint ? `Previously verified/discovered endpoint: ${record.endpoint}` : "The extension did not save the endpoint. Locate it in your previous setup work and persistent server configuration."}

Inspect your previous work, framework documentation, saved configuration, and existing running service before making changes. Reuse the SAME server, port, code, submissions, outbox, processed IDs, and completed work. Do not create another server, choose a different port, reset application data, or repeat completed operations. If the existing service is stopped, start that same service using its saved configuration; if the port belongs to another process, or multiple candidate services make the identity unclear, report the conflict and end with [[LOGIC:USER_INPUT]]. If there is no identifiable existing server, request human input instead of creating one.
Check the existing ${PATH} WebSocket integration. Only repair missing or broken integration pieces on that server, using protocol ${VERSION} from the earlier setup instructions. Do not reinstall or rebuild working components.

${record.credential
    ? "The extension retained its paired credential. Keep the existing backend credential unchanged. The extension will authenticate using the existing auth handshake, then perform the transport test. No new pairing is requested; never print credentials."
    : `The extension has no saved pairing credential. Re-pair ONLY the existing integration using this recovery setup ID and this new one-time pairing token: ${record.pairingToken}
Replace only the incomplete/obsolete pairing authorization for this project. For the pair handshake, use the new setup ID and token with the original protocol: lowercase hex HMAC-SHA256 keyed by the UTF-8 token (not hex-decoded), signing compact JSON [role,projectId,setupId,challenge,credential]. The pair-client credential field is "". Generate and securely save the backend credential on a valid pair, then sign pair-server with that credential included. Consume the token after pairing. Preserve server data and the fixed port. Never print the backend credential or put the token in general framework documentation.`}

When this existing endpoint is listening and ready for verification, output exactly one standalone line using this recovery setup ID and its actual fixed address:
[[SERVER_READY:{"protocol":1,"setupId":"${record.setupId}","projectId":"${record.projectId}","endpoint":"${record.endpoint || `ws://localhost:PORT${PATH}`}"}]]
Do not wrap the line in a code block. Do not copy the old setup ID into it. The extension will verify the connection and send confirmation. Use [[LOGIC:CONTINUE]] only for another recovery round, [[LOGIC:WAIT:1m]] for an already started operation, or [[LOGIC:USER_INPUT]] if blocked. Do not work on unrelated tasks.`;
  }

  const all = selector => Array.from(document.querySelectorAll(selector));
  const selector = "[data-message-author-role='user'], [data-user-message-bubble='true']";
  const currentNodes = all(selector).filter(node => !node.parentElement?.closest(selector));
  const current = currentNodes.at(-1) || null;
  const alternateSelector = "[data-conversation-role='user'], [data-turn='user'], [data-role='user'][data-testid*='conversation-turn'], [data-testid='user-turn']";
  const alternates = all(alternateSelector).slice(-3).map(node => /^H[1-6]$/.test(node.tagName) ? node.parentElement || node : node);
  const candidates = [...new Set([...currentNodes.slice(-3), ...alternates])];
  const contentSelectors = ["[data-message-content]", ".markdown", ".prose"];
  const uiSelector = "button,[role='button'],textarea,input,[contenteditable='true'],svg,script,style,noscript";
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const invisible = value => String(value || "").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  function readLikeExtension(node) {
    const found = [...new Set(contentSelectors.flatMap(s => [...(node.matches(s) ? [node] : []), ...node.querySelectorAll(s)]))];
    const roots = found.filter(child => !found.some(other => other !== child && other.contains(child)));
    if (roots.length) return roots.map(root => (root.innerText || root.textContent || "").trim()).filter(Boolean).join("\n\n").trim();
    const clone = node.cloneNode(true);
    clone.querySelectorAll(uiSelector).forEach(child => child.remove());
    return (clone.textContent || "").trim();
  }
  function reconstruct(text) {
    if (!text.includes("Recover the EXISTING local server connection")) return null;
    const projectId = text.match(/Project ID:\s*(g-p-[a-f0-9]{32})/i)?.[1];
    const setupId = text.match(/Recovery setup ID:\s*([a-f0-9-]{36})/i)?.[1];
    const previousSetupId = text.match(/Previous setup ID:\s*([a-f0-9-]{36})/i)?.[1];
    const extensionId = text.match(/Allowed WebSocket Origin:\s*chrome-extension:\/\/([a-p]{32})/)?.[1];
    const endpoint = text.match(/Previously verified\/discovered endpoint:\s*(ws:\/\/(?:localhost|127\.0\.0\.1):\d+\/\.well-known\/continue-loop)/)?.[1];
    const retainedCredential = text.includes("The extension retained its paired credential.");
    const pairingToken = text.match(/new one-time pairing token:\s*([a-f0-9-]{72})/i)?.[1];
    if (!projectId || !setupId || !extensionId || (!retainedCredential && !pairingToken)) return null;
    if (text.includes("Previous setup ID:") && !previousSetupId) return null;
    if (text.includes("Previously verified/discovered endpoint:") && !endpoint) return null;
    return recoveryPrompt({ projectId, setupId, endpoint, pairingToken, credential: retainedCredential }, extensionId, previousSetupId);
  }
  function characterKind(text, index) {
    const ch = text[index];
    if (!ch) return "end";
    if (/\s/.test(ch)) return "whitespace";
    if (/[\u200B-\u200D\u2060\uFEFF]/.test(ch)) return "invisible-format";
    if (/[\p{L}\p{N}]/u.test(ch)) return "letter-or-number";
    return "punctuation-or-symbol";
  }
  function compare(actual, expected) {
    if (!expected) return null;
    const a = normalize(actual), b = normalize(expected), flat = normalize(expected.replace(/\r?\n/g, ""));
    let prefix = 0, suffix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
    const included = a.indexOf(b);
    return {
      exactTrimmed: actual.trim() === expected.trim(),
      matchesExtensionNormalization: a === b || a === flat,
      matchesRemovingInvisibleCharacters: normalize(invisible(actual)) === normalize(invisible(expected)),
      matchesUnicodeNfc: a.normalize("NFC") === b.normalize("NFC"),
      normalizedLength: a.length, expectedNormalizedLength: b.length,
      commonPrefixLength: prefix, commonSuffixLength: suffix,
      firstDifferenceActualKind: characterKind(a, prefix), firstDifferenceExpectedKind: characterKind(b, prefix),
      includesCompleteExpected: included >= 0,
      extraPrefixLength: included >= 0 ? included : null,
      extraSuffixLength: included >= 0 ? a.length - included - b.length : null
    };
  }
  const report = {
    diagnostic: "chatgpt-continue-loop/recovery-prompt-rendering", schemaVersion: 1,
    capturedAt: new Date().toISOString(), templateVersion: "1.8.3",
    supportedOrigin: ["https://chatgpt.com", "https://chat.openai.com"].includes(location.origin),
    selectors: Object.fromEntries(["[data-message-author-role='user']", "[data-user-message-bubble='true']", "[data-conversation-role='user']", "[data-turn='user']", "[data-role='user'][data-testid*='conversation-turn']", "[data-testid='user-turn']"].map(s => [s, all(s).length])),
    currentSelectorFoundUser: Boolean(current),
    candidates: candidates.map((node, index) => {
      const text = readLikeExtension(node), inner = node.innerText || "", raw = node.textContent || "";
      const expected = [text, inner, raw].map(reconstruct).find(Boolean) || null;
      return {
        index, selectedByCurrentSelectors: node === current, tag: node.tagName,
        visible: Boolean(node.getBoundingClientRect().width && node.getBoundingClientRect().height),
        sourceFlags: {
          authorRoleUser: node.matches("[data-message-author-role='user']"),
          userBubble: node.matches("[data-user-message-bubble='true']"),
          conversationRoleUser: node.matches("[data-conversation-role='user']")
        },
        expectedPromptReconstructed: Boolean(expected),
        recoveryPreamblePresent: [text, inner, raw].some(t => t.includes("Recover the EXISTING local server connection")),
        textLengths: { extensionReader: text.length, innerText: inner.length, textContent: raw.length },
        requestTagCounts: Object.fromEntries([["extensionReader", text], ["innerText", inner], ["textContent", raw]]
          .map(([key, value]) => [key, [...value.matchAll(/\[\[SERVER_SETUP_REQUEST:[^\]\r\n]+\]\]/g)].length])),
        comparison: { extensionReader: compare(text, expected), innerText: compare(inner, expected), textContent: compare(raw, expected) },
        contentRootCounts: contentSelectors.map(s => ({ selector: s, count: (node.matches(s) ? 1 : 0) + node.querySelectorAll(s).length })),
        uiControlCount: node.querySelectorAll(uiSelector).length,
        expandedControlCounts: { collapsed: node.querySelectorAll('[aria-expanded="false"]').length, expanded: node.querySelectorAll('[aria-expanded="true"]').length },
        formatCodePoints: [...new Set([...raw].filter(ch => /[\u200B-\u200D\u2060\uFEFF]/.test(ch)))].map(ch => "U+" + ch.codePointAt(0).toString(16).toUpperCase()),
        children: Array.from(node.children).slice(0, 20).map(child => ({ tag: child.tagName, textLength: (child.textContent || "").length }))
      };
    }),
    limits: [
      "Only this tab's current user-message DOM was read. No clicks, edits, focus changes, network, storage access or chat sends.",
      "Prompt text, pairing tokens, credentials, IDs, URLs, titles and project names are omitted. Only counts, structure and comparison results are reported.",
      "Expected text is reconstructed from the 1.8.3 template and visible fields, not recovered from isolated extension state. A match does not prove original send acceptance.",
      "Current DOM can differ from what existed at failure time. No automatic recovery was attempted."
    ]
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  return report;
})();
