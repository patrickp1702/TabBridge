/**
 * confirm.ts — user approval through a dedicated extension window (Allow / Deny).
 *
 * Why a window and not chrome.notifications: macOS shows notifications as
 * banners that vanish in seconds with their buttons hidden behind a hover
 * menu, Focus modes swallow them, and they can show ~140 chars — useless for
 * approving a script. The approval window (public/approve/approve.html) is
 * always visible, shows the FULL request (args / script), and counts down.
 *
 * Fails closed: timeout (40 s), the user closing the window, or the window
 * failing to open all count as Deny. The timeout is below MCP clients' ~60 s
 * request timeout so the decision always reaches the agent. Pending requests
 * live only in this worker's memory: a worker restart denies them (the agent
 * sees a timeout and can retry).
 */
export const CONFIRM_TIMEOUT_MS = 40_000;

/** What the approval window shows. */
export interface ConfirmRequest {
  /** Headline, e.g. `test-6d4e1f wants to add tool "askAI"`. */
  title: string;
  /** Who is asking: connector label or page origin. */
  caller: string;
  /** Label → value rows (domain, tool, profile, description, …). */
  fields: Record<string, string>;
  /** Optional code block shown in full (tool script / call arguments as JSON). */
  code?: string;
  codeLabel?: string;
  /** Epoch ms when the request auto-denies. */
  deadline: number;
}

interface Pending { req: ConfirmRequest; resolve: (allowed: boolean) => void; windowId?: number; timer: ReturnType<typeof setTimeout> }
const pending = new Map<string, Pending>();

export function confirmWithUser(input: Omit<ConfirmRequest, "deadline">): Promise<boolean> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const req: ConfirmRequest = { ...input, deadline: Date.now() + CONFIRM_TIMEOUT_MS };
    const settle = (v: boolean): void => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (p.windowId !== undefined) chrome.windows.remove(p.windowId).catch(() => {});
      resolve(v);
    };
    const timer = setTimeout(() => settle(false), CONFIRM_TIMEOUT_MS);
    pending.set(id, { req, resolve: settle, timer });
    chrome.windows.create({
      url: chrome.runtime.getURL(`approve/approve.html#${id}`), // No I18N
      type: "popup", // No I18N
      width: 640,
      height: 720,
      focused: true,
    }).then((w) => {
      const p = pending.get(id);
      if (!p) { if (w?.id !== undefined) chrome.windows.remove(w.id).catch(() => {}); return; }
      if (w?.id === undefined) settle(false); else p.windowId = w.id;
    }).catch(() => settle(false));
  });
}

// The approval page asks for its request and reports the decision.
chrome.runtime.onMessage.addListener((message: { type?: string; id?: string; allowed?: boolean }, sender, sendResponse) => {
  if (!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/approve/`)) return false; // No I18N — only our own page
  if (message?.type === "GET_CONFIRM" && typeof message.id === "string") { // No I18N
    sendResponse({ ok: true, request: pending.get(message.id)?.req ?? null });
    return false;
  }
  if (message?.type === "CONFIRM_DECISION" && typeof message.id === "string") { // No I18N
    pending.get(message.id)?.resolve(message.allowed === true);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// User closed the approval window → Deny.
chrome.windows.onRemoved.addListener((windowId) => {
  for (const p of pending.values()) if (p.windowId === windowId) { p.windowId = undefined; p.resolve(false); }
});
