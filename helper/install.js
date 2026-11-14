/* Copyright (c) 2026 Phosphoros Research and contributors. SPDX-License-Identifier: MPL-2.0 */
(() => {
  "use strict";
  // Reload only this dashboard document; never send an agent command.
  globalThis.ThreadlampReloadDashboard = ({unsaved = false, pending = false} = {}) => {
    const warning = [unsaved ? "Unsent dashboard drafts and unsaved setup changes will be discarded." : "",
      pending ? "A command is still pending and may finish. Check agent status before retrying it." : ""].filter(Boolean).join("\n\n");
    if (warning && !window.confirm(`${warning}\n\nReload the dashboard?`)) return;
    window.location.reload();
  };
  let prompt = null;
  const fullScreenMode = matchMedia("(display-mode: fullscreen)");
  const standaloneMode = matchMedia("(display-mode: standalone)");
  const installed = () => fullScreenMode.matches || standaloneMode.matches;
  const cameraLayouts = ["safe", "right", "left"];
  const cameraKey = "threadlamp.camera-layout";
  let cameraLayout = "safe";
  try {
    const saved = localStorage.getItem(cameraKey);
    if (cameraLayouts.includes(saved)) cameraLayout = saved;
  } catch { /* Keep the safe default when device storage is unavailable. */ }
  document.documentElement.dataset.lanCamera = cameraLayout;
  // Android can resize the visible viewport as system bars or the keyboard move.
  // Paint the full viewport while keeping safe insets inside the edge controls.
  let viewportFrame = 0;
  function syncViewport() {
    viewportFrame = 0;
    const root = document.documentElement;
    root.classList.toggle("lan-installed", installed());
    if (!installed()) { root.style.removeProperty("--lan-viewport-height"); return; }
    const viewport = window.visualViewport;
    // Pinch zoom must not shrink and reflow the application's layout.
    const height = viewport && Math.abs(viewport.scale - 1) < 0.01 ? viewport.height : window.innerHeight;
    if (height > 0) root.style.setProperty("--lan-viewport-height", `${height}px`);
  }
  function scheduleViewport() {
    if (!viewportFrame) viewportFrame = requestAnimationFrame(syncViewport);
  }
  for (const event of ["resize", "orientationchange", "pageshow"]) window.addEventListener(event, scheduleViewport);
  document.addEventListener("visibilitychange", scheduleViewport);
  window.visualViewport?.addEventListener("resize", scheduleViewport);
  fullScreenMode.addEventListener("change", scheduleViewport);
  standaloneMode.addEventListener("change", scheduleViewport);
  syncViewport();
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
  if (document.querySelector(".preferences-body")) {
    const display = document.createElement("section"); display.className = "lan-install";
    const label = document.createElement("label"); label.htmlFor = "lan-camera-layout"; label.textContent = "Installed app header";
    const select = document.createElement("select"); select.id = label.htmlFor;
    for (const [value, text] of [["safe", "Below camera (default)"], ["right", "Beside right camera"], ["left", "Beside left camera"]]) {
      select.add(new Option(text, value));
    }
    select.value = cameraLayout;
    const help = document.createElement("p"); help.id = "lan-camera-help";
    help.textContent = "Choose the side of your camera for a compact header in portrait mode. For a centered or wide notch, keep Below camera. Saved only on this device.";
    select.setAttribute("aria-describedby", help.id);
    select.addEventListener("change", () => {
      cameraLayout = cameraLayouts.includes(select.value) ? select.value : "safe";
      document.documentElement.dataset.lanCamera = cameraLayout;
      try { localStorage.setItem(cameraKey, cameraLayout); }
      catch { help.textContent = "Applied for this page. Device storage is unavailable, so this choice cannot be saved."; }
    });
    display.append(label, select, help);
    section.before(display);
  }
  if (document.getElementById("login-form")) {
    const reload = document.createElement("button"); reload.type = "button";
    reload.id = "lan-reload"; reload.textContent = "Reload page";
    reload.addEventListener("click", () => globalThis.ThreadlampReloadDashboard({unsaved: Boolean(document.getElementById("access-key").value)}));
    section.append(reload);
  }
  refresh();
})();
