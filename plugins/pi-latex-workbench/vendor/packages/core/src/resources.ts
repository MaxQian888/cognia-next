/**
 * Approved resource access (M3). The ONLY channel for registry content:
 * `resources/profiles/resource-registry.json` is host-owned and every entry
 * pins a sha256 that is verified against the real bytes before they are
 * returned — a registry whose file drifted answers DIGEST_MISMATCH, not
 * stale content. There is no lookup by path, no prefix scan, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ERROR_CODES,
  sha256Hex,
  WorkbenchError,
  type ResourceResult,
} from "@latexwb/contracts";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";

export interface ResourceRegistryEntry {
  id: string;
  /** Path relative to <repoRoot>/resources/. */
  path: string;
  sha256: string;
  trust: string;
}

interface ResourceRegistryFile {
  schemaVersion: number;
  resources: ResourceRegistryEntry[];
}

export function loadResourceRegistry(repoRoot: string): ResourceRegistryEntry[] {
  const path = join(repoRoot, "resources", "profiles", "resource-registry.json");
  let raw: ResourceRegistryFile;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as ResourceRegistryFile;
  } catch {
    return [];
  }
  return (raw.resources ?? []).filter(
    (r) =>
      typeof r.id === "string" &&
      typeof r.path === "string" &&
      typeof r.sha256 === "string",
  );
}

/** `skill:foo` ↔ `skill:foo:guide` are declared companions. */
function relatedIds(entry: ResourceRegistryEntry, all: ResourceRegistryEntry[]): string[] {
  const m = /^skill:([A-Za-z0-9_.:-]+?)(:guide)?$/.exec(entry.id);
  if (m === null) return [];
  const base = `skill:${m[1]}`;
  const want = m[2] === undefined ? `${base}:guide` : base;
  return all.filter((r) => r.id === want).map((r) => r.id);
}

export function getApprovedResource(options: {
  ctx: RequestContext;
  repoRoot: string;
  resourceId: string;
}): ResourceResult {
  const { ctx, repoRoot, resourceId } = options;
  requireCapability(ctx, "skill.resource.read");
  const registry = loadResourceRegistry(repoRoot);
  const entry = registry.find((r) => r.id === resourceId);
  if (entry === undefined) {
    // Suggest registry ids, never resolve them implicitly: "latex-tables"
    // → "skill:latex-tables".
    const needle = resourceId.toLowerCase();
    const suggestions = registry
      .map((r) => r.id)
      .filter((id) => id.toLowerCase().endsWith(`:${needle}`) || id.toLowerCase().includes(needle))
      .slice(0, 5);
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `resource ${JSON.stringify(resourceId)} is not in the approved registry` +
        (suggestions.length > 0 ? `; did you mean ${suggestions.map((s) => JSON.stringify(s)).join(" or ")}?` : ""),
    );
  }
  const filePath = join(repoRoot, "resources", entry.path);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(filePath));
  } catch {
    throw new WorkbenchError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      `approved resource ${resourceId} file ${entry.path} is missing`,
    );
  }
  const actual = sha256Hex(bytes);
  if (actual !== entry.sha256) {
    throw new WorkbenchError(
      ERROR_CODES.DIGEST_MISMATCH,
      `approved resource ${resourceId} digest mismatch: file hashes to ${actual}, registry says ${entry.sha256}`,
    );
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `resource ${resourceId} is not UTF-8 text`,
    );
  }
  return {
    kind: "resource",
    resourceId,
    origin: "approved-registry",
    sha256: actual,
    content,
    relatedResourceIds: relatedIds(entry, registry),
  };
}
