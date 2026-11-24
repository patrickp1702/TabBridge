/**
 * import_export.ts — Export / Import of the domain config as JSON.
 *
 * Import is validated (validateDomains), QUARANTINED (everything comes in
 * disabled + confirmation on), merged without overwriting local edits, and
 * returned as a preview so the UI can show exactly what will change and ask.
 */
import type { StoredDomain } from "../types/plugin.types";
import { normalizeDomains, validateDomains } from "./profiles";

export function exportDomainsJson(domains: StoredDomain[]): string {
  return JSON.stringify({ domains, exportedAt: new Date().toISOString() }, null, 2); // No I18N
}

export function exportFilename(): string {
  return `tabbridge-config-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; // No I18N
}

export interface ImportPreview {
  /** Merged result to save if the user confirms. */
  next: StoredDomain[];
  newDomains: StoredDomain[];
  /** "Domain/tool" for tools appended to existing domains. */
  newTools: string[];
  added: number;
  summary: string;
}

/** Parses + validates a file's text and computes the merge. Throws Error(message) on invalid input. */
export function previewImport(fileText: string, current: StoredDomain[]): ImportPreview {
  let parsed: unknown;
  try { parsed = JSON.parse(fileText); } catch { throw new Error("File is not valid JSON."); } // No I18N
  const root = parsed as { domains?: unknown } | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.domains)) throw new Error('File must contain a top-level "domains" array.'); // No I18N
  const problems = validateDomains(root.domains);
  if (problems.length) throw new Error(`Import rejected: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`); // No I18N
  const imported = normalizeDomains(root.domains as StoredDomain[], true);

  const newDomains = imported.filter((d) => !current.some((x) => x.name === d.name));
  const newTools: string[] = [];
  const next = [...current.map((d) => ({ ...d, tools: [...d.tools] })), ...newDomains];
  for (const incoming of imported) {
    if (newDomains.includes(incoming)) continue;
    const existing = next.find((d) => d.name === incoming.name)!;
    for (const t of incoming.tools) {
      if (existing.tools.some((x) => x.name === t.name)) continue;
      existing.tools.push(t);
      newTools.push(`${incoming.name}/${t.name}`); // No I18N
    }
  }
  const added = newDomains.length + newTools.length;
  const summary = [
    newDomains.length ? `New domains: ${newDomains.map((d) => `${d.name} (${d.tools.length} tools)`).join(", ")}` : "", // No I18N
    newTools.length ? `New tools: ${newTools.join(", ")}` : "", // No I18N
    added ? "Everything imported arrives DISABLED with confirmation on. Review it in Domains & Tools, then enable what you trust." : "", // No I18N
  ].filter(Boolean).join("\n");
  return { next, newDomains, newTools, added, summary };
}
