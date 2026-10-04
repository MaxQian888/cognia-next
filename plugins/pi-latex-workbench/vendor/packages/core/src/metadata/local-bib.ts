/**
 * local-bib provider: searches an explicit corpus of BibTeX sources —
 * the project's own .bib files (tool lookup path) or the host's approved
 * reference library (workflow resolve path). Everything is offline; the
 * "response bytes" are the matched entries' raw source, hash-bound.
 *
 * Status honesty: local entries are project/host data, not an authority —
 * candidates carry metadataStatus "unverified". Full raw entry text is
 * available, so sourceAccess is "fulltext" for the bib record itself.
 */
import { canonicalJson, sha256Hex, utf8Bytes } from "@latexwb/contracts";
import { parseBibTeX, type BibEntry } from "../bib.ts";
import type {
  MetadataProvider,
  ProviderQuery,
  ProviderResponse,
  RawCandidate,
} from "./types.ts";

export interface LocalBibSource {
  /** Provenance label, e.g. "project:refs.bib" or "resource:shared-refs". */
  locator: string;
  bytes: Uint8Array;
}

function candidateFromEntry(entry: BibEntry, locator: string): RawCandidate {
  const f = entry.fields;
  const authors = (f.get("author") ?? "")
    .split(/\s+and\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const yearRaw = f.get("year") ?? null;
  const year = yearRaw !== null && /^\d{4}$/.test(yearRaw.trim())
    ? Number.parseInt(yearRaw.trim(), 10)
    : null;
  const identifier =
    f.get("doi") ?? f.get("isbn") ?? f.get("url") ?? null;
  const rawText = new TextDecoder().decode(entry.raw);
  const rawItemJson = canonicalJson({
    locator,
    key: entry.key,
    type: entry.type,
    fields: Object.fromEntries(f),
    entryRaw: rawText,
  });
  return {
    candidate: {
      identifier,
      title: f.get("title") ?? "",
      authors,
      year,
      metadataStatus: "unverified",
      sourceAccess: "fulltext",
      sourceLocator: `${locator}#${entry.key}`,
      version: null,
    },
    // Uniform binding: sha256 of the canonical raw-item JSON (the same
    // convention as crossref), so propose-import re-verifies one way.
    itemHash: sha256Hex(utf8Bytes(rawItemJson)),
    bibEntry: rawText,
    rawItemJson,
  };
}

export function localBibProvider(sources: LocalBibSource[]): MetadataProvider {
  return {
    id: "local-bib",
    async lookup(query: ProviderQuery): Promise<ProviderResponse> {
      const candidates: RawCandidate[] = [];
      for (const src of sources) {
        const parsed = parseBibTeX(src.bytes);
        for (const entry of parsed.entries) {
          let match = false;
          if (query.kind === "key") {
            match = entry.key === query.key;
          } else if (query.kind === "identifier") {
            const needle = query.identifier.trim().toLowerCase();
            match =
              entry.key.toLowerCase() === needle ||
              (entry.fields.get("doi") ?? "").toLowerCase() === needle ||
              (entry.fields.get("isbn") ?? "").toLowerCase() === needle;
          } else {
            const q = query.query.trim().toLowerCase();
            match =
              entry.key.toLowerCase() === q ||
              (entry.fields.get("title") ?? "").toLowerCase().includes(q) ||
              (entry.fields.get("author") ?? "").toLowerCase().includes(q);
          }
          if (match) candidates.push(candidateFromEntry(entry, src.locator));
        }
      }
      const rawBytes = utf8Bytes(
        canonicalJson({
          provider: "local-bib",
          query,
          sources: sources.map((s) => ({ locator: s.locator, sha256: sha256Hex(s.bytes) })),
          matchedKeys: candidates.map((c) => c.candidate.sourceLocator),
        }),
      );
      return {
        status: candidates.length > 0 ? "ok" : "not-found",
        warning: candidates.length > 0 ? null : "no local bibliography entry matched",
        rawBytes,
        candidates,
      };
    },
  };
}
