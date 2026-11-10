/* Copyright (c) 2026 Phosphoros Research and contributors.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * SPDX-License-Identifier: MPL-2.0 */
"use strict";

let audioContext;

function tone(context, destination, frequency, startsAt, duration) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startsAt);
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(0.18, startsAt + 0.025);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration);
}

async function playUserInputSound() {
  audioContext ||= new AudioContext();
  await audioContext.resume();

  const startsAt = audioContext.currentTime + 0.02;
  tone(audioContext, audioContext.destination, 659.25, startsAt, 0.22);
  tone(audioContext, audioContext.destination, 880, startsAt + 0.24, 0.34);
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type !== "OFFSCREEN_PLAY_USER_INPUT_SOUND") return;
  void playUserInputSound().then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Could not play the alert sound."
    })
  );
  return true;
});
