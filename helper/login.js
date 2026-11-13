/* Copyright (c) 2026 Phosphoros Research and contributors. SPDX-License-Identifier: MPL-2.0 */
"use strict";
document.getElementById("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.target.querySelector("button"); button.disabled = true;
  try {
    const response = await fetch("/login", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("access-key").value})});
    if (!response.ok) throw new Error("Sign-in failed. Check your access key or wait a minute before trying again.");
    document.getElementById("access-key").value = ""; location.replace("/");
  } catch (error) { document.getElementById("status").textContent = error.message; }
  finally { button.disabled = false; }
});
