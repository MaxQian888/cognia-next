/**
 * Metadata provider contract (M3). A provider answers a lookup with the
 * EXACT response bytes it observed (or a canonical error record) plus the
 * candidates it extracted. `itemHash`/`rawItem` bind each candidate to real
 * observed content — propose-import re-verifies these hashes before it
 * writes anything, so a tampered record fails DIGEST_MISMATCH.
 */
import type { CitationCandidate } from "@latexwb/contracts";

export type ProviderQuery =
  | { kind: "query"; query: string }
  | { kind: "identifier"; identifier: string }
  /** Exact bibliography-key match (resolve path). */
  | { kind: "key"; key: string };

export interface RawCandidate {
  /** Provider-extracted metadata (id/retrievedAt/metadataHash/provider are
   * filled by the orchestrator). */
  candidate: Omit<CitationCandidate, "id" | "retrievedAt" | "metadataHash" | "provider">;
  /** sha256 over the item's raw observed form — becomes metadataHash. */
  itemHash: string;
  /** Raw BibTeX entry text when the provider is bib-backed. */
  bibEntry?: string;
  /** canonicalJson of the provider's raw item — stored for tamper checks. */
  rawItemJson?: string;
}

export interface ProviderResponse {
  status: "ok" | "not-found" | "unavailable" | "denied";
  /** Human-readable reason for non-ok statuses (never hidden). */
  warning: string | null;
  /** The response body bytes, or a canonical JSON error record. */
  rawBytes: Uint8Array;
  candidates: RawCandidate[];
  /**
   * Network attempts actually made (network providers only). Persisted in
   * the evidence record so a retried call is distinguishable from a
   * first-try answer.
   */
  attempts?: number;
}

export interface MetadataProvider {
  readonly id: string;
  lookup(
    query: ProviderQuery,
    opts: { signal: AbortSignal },
  ): Promise<ProviderResponse>;
}
