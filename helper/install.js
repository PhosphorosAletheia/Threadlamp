/* Copyright (c) 2026 Phosphoros Research and contributors. SPDX-License-Identifier: MPL-2.0 */
(() => {
  "use strict";
  let prompt = null;
  const installed = () => matchMedia("(display-mode: fullscreen)").matches || matchMedia("(display-mode: standalone)").matches;
  const section = document.createElement("section"); section.className = "lan-install";
  const title = document.createElement("h3"); title.textContent = "Install on this device";
  const button = document.createElement("button"); button.type = "button"; button.textContent = "Install Threadlamp";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const guidance = "On Android, open Chrome’s menu and choose Add to Home screen → Install. If only a shortcut is offered, check that the HTTPS certificate is trusted without a warning, then reopen this page. Installation options vary by browser.";
  status.textContent = "Open Threadlamp from your home screen in full screen. Your host computer and LAN connection are still required.";
  function refresh() {
    button.hidden = installed();
    if (installed()) status.textContent = "Threadlamp is running as an installed app.";
  }
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); prompt = event; refresh(); });
  window.addEventListener("appinstalled", () => { prompt = null; button.hidden = true; status.textContent = "Installed. Open Threadlamp from your home screen."; });
  button.addEventListener("click", async () => {
    if (!prompt) { status.textContent = guidance; return; }
    const pending = prompt; prompt = null; button.disabled = true;
    try {
      await pending.prompt();
      const choice = await pending.userChoice;
      status.textContent = choice.outcome === "accepted" ? "Installation requested. Open Threadlamp from your home screen when it is ready." : "Installation dismissed. You can install later from your browser’s menu.";
    } catch { status.textContent = guidance; }
    finally { button.disabled = false; refresh(); }
  });
  section.append(title, button, status);
  (document.querySelector(".preferences-body") || document.querySelector("main")).append(section);
  refresh();
})();
