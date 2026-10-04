/**
 * Lookup orchestrator: runs the allowed providers in order (local-bib first
 * — offline, deterministic — then crossref when policy admits it), builds
 * contract CitationCandidate rows, and returns the evidence records that
 * must be persisted by the surrounding service job. Provider failures are
 * never silent: they become warnings AND evidence rows whose content is the
 * real error record.
 */
import {
  canonicalJson,
  sha256Hex,
  utf8Bytes,
  utcNowIso,
  type CitationCandidate,
  type CitationLookupResult,
  type HostPolicy,
} from "@latexwb/contracts";
import type { EvidenceInput } from "../evidence.ts";
import { localBibProvider, type LocalBibSource } from "./local-bib.ts";
import { crossrefProvider, type Fetcher } from "./crossref.ts";
import type { MetadataProvider, ProviderQuery } from "./types.ts";

export type { LocalBibSource } from "./local-bib.ts";
export type { Fetcher } from "./crossref.ts";
export type { MetadataProvider, ProviderQuery, ProviderResponse } from "./types.ts";

export interface LookupOptions {
  snapshotId: string;
  query: ProviderQuery;
  /** Snapshot .bib sources for the local-bib provider (tool path), or the
   * approved reference corpus (workflow resolve path). */
  bibSources: LocalBibSource[];
  /** Restrict providers; default tries local-bib then crossref. */
  providers?: string[];
  /** When the lookup answers for a specific missing citekey. */
  forCitekey?: string | undefined;
  hostPolicy: HostPolicy | null;
  /** Test seam for the crossref transport only. */
  fetchImpl?: Fetcher | undefined;
  /** Test seam: crossref retry backoff sleep. */
  sleepImpl?: ((ms: number) => Promise<void>) | undefined;
}

export interface StoredCandidate {
  id: string;
  provider: string;
  itemHash: string;
  bibEntry?: string;
  rawItemJson?: string;
  forCitekey?: string;
  candidate: CitationCandidate;
}

export interface LookupOutcome {
  result: CitationLookupResult;
  evidence: EvidenceInput[];
  stored: StoredCandidate[];
}

export function candidateId(providerId: string, itemHash: string): string {
  return `cand-${sha256Hex(utf8Bytes(`${providerId}\n${itemHash}`)).slice(0, 24)}`;
}

export async function runLookups(options: LookupOptions): Promise<LookupOutcome> {
  const { query, snapshotId } = options;
  const wanted = options.providers ?? ["local-bib", "crossref"];
  const providers: MetadataProvider[] = [];
  if (wanted.includes("local-bib") && options.bibSources.length > 0) {
    providers.push(localBibProvider(options.bibSources));
  }
  if (wanted.includes("crossref")) {
    providers.push(
      crossrefProvider({
        policy: options.hostPolicy,
        fetchImpl: options.fetchImpl,
        sleepImpl: options.sleepImpl,
      }),
    );
  }

  const candidates: CitationCandidate[] = [];
  const stored: StoredCandidate[] = [];
  const warnings: string[] = [];
  const evidence: EvidenceInput[] = [];

  for (const provider of providers) {
    const resp = await provider.lookup(query, { signal: new AbortController().signal });
    const retrievedAt = utcNowIso();
    const storedEntries = resp.candidates.map((rc) => {
      const id = candidateId(provider.id, rc.itemHash);
      const candidate: CitationCandidate = {
        ...rc.candidate,
        id,
        provider: provider.id,
        retrievedAt,
        metadataHash: rc.itemHash,
      };
      return {
        id,
        provider: provider.id,
        itemHash: rc.itemHash,
        ...(rc.bibEntry !== undefined ? { bibEntry: rc.bibEntry } : {}),
        ...(rc.rawItemJson !== undefined ? { rawItemJson: rc.rawItemJson } : {}),
        ...(options.forCitekey !== undefined ? { forCitekey: options.forCitekey } : {}),
        candidate,
      } satisfies StoredCandidate;
    });
    for (const s of storedEntries) {
      candidates.push(s.candidate);
      stored.push(s);
    }
    if (resp.warning !== null) warnings.push(`${provider.id}: ${resp.warning}`);
    evidence.push({
      snapshotId,
      kind: "metadata-lookup",
      sourceLocator: `provider:${provider.id}`,
      // The provider's exact response bytes — or its canonical error record.
      content: resp.rawBytes.length > 0 ? resp.rawBytes : utf8Bytes(canonicalJson({ status: resp.status })),
      accessStatus:
        resp.status === "ok"
          ? provider.id === "local-bib"
            ? "fulltext"
            : "metadata-only"
          : "none",
      record: {
        provider: provider.id,
        query,
        status: resp.status,
        warning: resp.warning,
        retrievedAt,
        // Network retry count is part of the record — a retried response is
        // distinguishable from a first-try answer.
        ...(resp.attempts !== undefined ? { attempts: resp.attempts } : {}),
        ...(options.forCitekey !== undefined ? { forCitekey: options.forCitekey } : {}),
        candidates: storedEntries.map((s) => ({
          id: s.id,
          provider: s.provider,
          itemHash: s.itemHash,
          ...(s.bibEntry !== undefined ? { bibEntry: s.bibEntry } : {}),
          ...(s.rawItemJson !== undefined ? { rawItemJson: s.rawItemJson } : {}),
          ...(s.forCitekey !== undefined ? { forCitekey: s.forCitekey } : {}),
          candidate: s.candidate,
        })),
      },
    });
  }

  return {
    result: { kind: "citation-lookup", candidates, warnings },
    evidence,
    stored,
  };
}
