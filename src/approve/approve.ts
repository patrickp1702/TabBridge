/**
 * approve.ts — the approval window. Reads its request id from the URL hash,
 * fetches the request from the worker, renders it in full, counts down, and
 * reports Allow / Deny. Closing the window = Deny (handled by the worker).
 */
import type { ConfirmRequest } from "../background/confirm";

const id = location.hash.slice(1);
const $ = <T extends HTMLElement>(sel: string): T => document.getElementById(sel) as T;

function decide(allowed: boolean): void {
  $<HTMLButtonElement>("btn-allow").disabled = true; // No I18N
  $<HTMLButtonElement>("btn-deny").disabled = true; // No I18N
  void chrome.runtime.sendMessage({ type: "CONFIRM_DECISION", id, allowed }).catch(() => {}); // No I18N
  setTimeout(() => window.close(), 150);
}

async function init(): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: "GET_CONFIRM", id }).catch(() => null)) as { request?: ConfirmRequest | null } | null; // No I18N
  const req = res?.request;
  if (!req) {
    $("title").textContent = "This request has already been decided or has expired."; // No I18N
    $("title").classList.add("gone"); // No I18N
    $("warn").style.display = "none"; // No I18N
    $<HTMLButtonElement>("btn-allow").disabled = true; // No I18N
    $("btn-deny").textContent = "Close"; // No I18N
    $("btn-deny").addEventListener("click", () => window.close()); // No I18N
    return;
  }
  document.title = `TabBridge — ${req.title}`; // No I18N
  $("title").textContent = req.title; // No I18N
  $("caller").textContent = req.caller; // No I18N
  const dl = $("fields"); // No I18N
  for (const [k, v] of Object.entries(req.fields)) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    dl.append(dt, dd);
  }
  if (req.code) {
    $("code-wrap").style.display = ""; // No I18N
    $("code-label").textContent = req.codeLabel ?? "Code"; // No I18N
    $("code").textContent = req.code; // No I18N
  }
  const tick = (): void => {
    const left = Math.max(0, Math.ceil((req.deadline - Date.now()) / 1000));
    $("countdown").textContent = left > 0 ? `auto-deny in ${left}s` : "expired"; // No I18N
    if (left <= 0) { $<HTMLButtonElement>("btn-allow").disabled = true; } // No I18N
  };
  tick(); setInterval(tick, 500);
  $("btn-allow").addEventListener("click", () => decide(true)); // No I18N
  $("btn-deny").addEventListener("click", () => decide(false)); // No I18N
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") decide(false); }); // No I18N
}

void init();
