/**
 * options.ts — entry for the full-tab settings page (chrome.runtime.openOptionsPage()).
 *
 * Two tabs, routed by URL hash:
 *   #domains[/<name>]  → domains_view.ts  (browse / run / edit every tool)
 *   #profiles          → profiles_view.ts (which tools a profile exposes)
 *   #mcp               → mcp_panel.ts     (connector scripts + page access)
 */
import { initDomainsView, selectFromHash } from "./domains_view";
import { initMcpPanel } from "./mcp_panel";
import { initProfilesView } from "./profiles_view";

type TabId = "domains" | "profiles" | "mcp"; // No I18N

function activeTabFromHash(): TabId {
  if (location.hash.startsWith("#mcp")) return "mcp"; // No I18N
  if (location.hash.startsWith("#profiles")) return "profiles"; // No I18N
  return "domains"; // No I18N
}

function showTab(tab: TabId): void {
  for (const id of ["domains", "profiles", "mcp"] as const) { // No I18N
    document.getElementById(`tab-${id}`)!.style.display = id === tab ? "" : "none"; // No I18N
  }
  document.querySelectorAll<HTMLAnchorElement>(".tab").forEach((a) => { // No I18N
    a.classList.toggle("tab--active", a.dataset["tab"] === tab); // No I18N
  });
}

/** Warn when the running worker was built from different sources than this page (unpacked extension not reloaded). */
async function checkWorkerBuild(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: "GET_BUILD_ID" })) as { ok?: boolean; buildId?: string } | undefined; // No I18N
    const worker = res?.buildId ?? "(no answer — worker predates build ids)"; // No I18N
    if (worker === __BUILD_ID__) return;
    document.getElementById("stale-worker")!.textContent = worker; // No I18N
    document.getElementById("stale-page")!.textContent = __BUILD_ID__; // No I18N
    document.getElementById("stale-banner")!.style.display = ""; // No I18N
  } catch {
    document.getElementById("stale-worker")!.textContent = "(unreachable)"; // No I18N
    document.getElementById("stale-page")!.textContent = __BUILD_ID__; // No I18N
    document.getElementById("stale-banner")!.style.display = ""; // No I18N
  }
}

async function init(): Promise<void> {
  showTab(activeTabFromHash());
  void checkWorkerBuild();
  await Promise.all([initDomainsView(), initProfilesView(), initMcpPanel()]);
  window.addEventListener("hashchange", () => {
    showTab(activeTabFromHash());
    selectFromHash(location.hash);
  });
}

void init();
