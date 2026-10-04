/**
 * Venue source verification (M5): re-fetches the official URLs recorded in a
 * venue profile's `sources[]` and compares the observed bytes against the
 * profile's pinned `contentHash`. The result is honest —
 *
 * - every fetch goes through the pinned-HTTPS transport (public IPs only,
 *   no redirects, timeout + body cap) and only when the host policy enables
 *   `network.venueVerification`;
 * - the exact observed bytes are persisted as `venue-source` evidence (a
 *   failed fetch persists the canonical error record instead);
 * - a source is "current" only when sha256(observed) === recorded hash;
 *   anything else — changed bytes, transport failure, non-2xx, malformed
 *   profile entry — is reported, never silently passed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  ERROR_CODES,
  sha256Hex,
  utf8Bytes,
  utcNowIso,
  WorkbenchError,
  type HostPolicy,
} from "@latexwb/contracts";
import type { BlobStore, Scope, WorkbenchStore } from "@latexwb/storage";
import { makePinnedFetcher, type Fetcher } from "./net.ts";
import { recordEvidence, failureContent } from "./evidence.ts";
import type { RequestContext } from "./context.ts";
import { requireCapability } from "./capabilities.ts";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export const venueSourceFetcher: Fetcher = makePinnedFetcher({
  service: "venue-source",
  userAgent: "pi-latex-workbench/0.0 (venue verification)",
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
  maxBytes: MAX_SOURCE_BYTES,
  timeoutMs: TIMEOUT_MS,
});

interface VenueSourceEntry {
  id?: string;
  url?: string;
  retrievedAt?: string;
  contentHash?: string;
  locator?: string;
}

interface VenueProfileFile {
  id?: string;
  status?: string;
  sources?: VenueSourceEntry[];
  template?: { origin?: string } | null;
}

export interface VenueSourceVerification {
  sourceId: string;
  url: string | null;
  status: "current" | "changed" | "fetch-failed" | "malformed";
  expectedHash: string | null;
  fetchedHash: string | null;
  httpStatus: number | null;
  evidenceId: string;
  detail: string;
}

export interface VenueVerificationResult {
  venueProfileId: string;
  checkedAt: string;
  /** true only when every declared source re-fetched byte-identical. */
  verified: boolean;
  sources: VenueSourceVerification[];
  evidenceIds: string[];
  /** Why verification is vacuous/failed, for the caller's decision. */
  note: string | null;
}

export interface VenueVerifyDeps {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
  repoRoot: string;
  hostPolicy: HostPolicy | null;
  /** Test seam — production uses the pinned-HTTPS fetcher. */
  fetchImpl?: Fetcher | undefined;
}

export function loadVenueProfile(repoRoot: string, venueProfileId: string): VenueProfileFile | null {
  const path = join(repoRoot, "resources", "profiles", "venues", `${venueProfileId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as VenueProfileFile;
  } catch {
    return null;
  }
}

/**
 * Re-fetch every `sources[]` entry of a venue profile and compare against
 * its recorded contentHash. Throws WorkbenchError(POLICY_DENIED) when the
 * host policy does not enable network.venueVerification — the caller maps
 * that to a blocked step, never a silent pass.
 */
export async function verifyVenueSources(
  deps: VenueVerifyDeps,
  input: { venueProfileId: string; snapshotId: string },
): Promise<VenueVerificationResult> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "project.read");
  const profile = loadVenueProfile(deps.repoRoot, input.venueProfileId);
  if (profile === null) {
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `venue profile ${input.venueProfileId} has no resource file resources/profiles/venues/${input.venueProfileId}.json`,
    );
  }

  const sources = profile.sources ?? [];
  const checkedAt = utcNowIso();
  const results: VenueSourceVerification[] = [];
  const evidenceIds: string[] = [];

  // Internal templates ship no external sources — there is nothing to
  // re-fetch; verification is vacuously satisfied and says so.
  const external = (profile.template?.origin ?? null) !== "internal";
  if (sources.length === 0) {
    return {
      venueProfileId: input.venueProfileId,
      checkedAt,
      verified: !external,
      sources: [],
      evidenceIds: [],
      note: external
        ? `profile declares non-internal template origin but no sources[] — nothing to verify against`
        : `internal template origin — no external sources to verify`,
    };
  }

  // The network gate applies only when there is something to fetch.
  if (deps.hostPolicy?.network.venueVerification !== true) {
    throw new WorkbenchError(
      ERROR_CODES.POLICY_DENIED,
      `host policy does not enable network.venueVerification — ${sources.length} venue source(s) cannot be fetched`,
    );
  }

  const fakeIpCidrs = deps.hostPolicy?.network.fakeIpCidrs ?? [];
  const fetcher = deps.fetchImpl ?? (fakeIpCidrs.length === 0
    ? venueSourceFetcher
    : makePinnedFetcher({
      service: "venue-source",
      userAgent: "pi-latex-workbench/0.0 (venue verification)",
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
      maxBytes: MAX_SOURCE_BYTES,
      timeoutMs: TIMEOUT_MS,
      fakeIpCidrs,
    }));
  for (const [i, src] of sources.entries()) {
    const sourceId = src.id ?? `source-${i}`;
    const url = src.url ?? null;
    const expected = src.contentHash ?? null;
    const fail = (
      status: VenueSourceVerification["status"],
      detail: string,
      content: Uint8Array,
      extra: Record<string, unknown> = {},
    ): void => {
      const evidenceId = recordEvidence({
        store,
        blobs,
        scope,
        input: {
          snapshotId: input.snapshotId,
          kind: "venue-source",
          sourceLocator: url ?? `venue-source:${sourceId}`,
          content,
          accessStatus: "metadata-only",
          record: {
            venueProfileId: input.venueProfileId,
            sourceId,
            url,
            expectedHash: expected,
            status,
            detail,
            retrievedAt: checkedAt,
            ...extra,
          },
        },
      });
      evidenceIds.push(evidenceId);
      results.push({
        sourceId,
        url,
        status,
        expectedHash: expected,
        fetchedHash: null,
        httpStatus: null,
        evidenceId,
        detail,
      });
    };

    if (url === null || expected === null) {
      fail("malformed", "source entry lacks url or contentHash", failureContent({ sourceId, url, expected }));
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail("malformed", `source url is not parseable: ${url}`, failureContent({ sourceId, url }));
      continue;
    }
    if (parsed.protocol !== "https:") {
      fail("malformed", `source url is not https: ${url}`, failureContent({ sourceId, url }));
      continue;
    }
    try {
      const res = await fetcher(parsed, new AbortController().signal);
      const fetchedHash = sha256Hex(res.body);
      if (res.status < 200 || res.status >= 300) {
        const evidenceId = recordEvidence({
          store, blobs, scope,
          input: {
            snapshotId: input.snapshotId,
            kind: "venue-source",
            sourceLocator: url,
            content: res.body.length > 0 ? res.body : failureContent({ httpStatus: res.status }),
            accessStatus: "metadata-only",
            record: {
              venueProfileId: input.venueProfileId,
              sourceId,
              url,
              expectedHash: expected,
              fetchedHash,
              httpStatus: res.status,
              status: "fetch-failed",
              retrievedAt: checkedAt,
            },
          },
        });
        evidenceIds.push(evidenceId);
        results.push({
          sourceId, url, status: "fetch-failed", expectedHash: expected,
          fetchedHash, httpStatus: res.status, evidenceId,
          detail: `HTTP ${res.status} — recorded bytes kept as evidence`,
        });
        continue;
      }
      const status = fetchedHash === expected ? "current" : "changed";
      const evidenceId = recordEvidence({
        store, blobs, scope,
        input: {
          snapshotId: input.snapshotId,
          kind: "venue-source",
          sourceLocator: url,
          content: res.body,
          accessStatus: "fulltext",
          record: {
            venueProfileId: input.venueProfileId,
            sourceId,
            url,
            expectedHash: expected,
            fetchedHash,
            httpStatus: res.status,
            status,
            retrievedAt: checkedAt,
            recordedRetrievedAt: src.retrievedAt ?? null,
            locator: src.locator ?? null,
          },
        },
      });
      evidenceIds.push(evidenceId);
      results.push({
        sourceId, url, status, expectedHash: expected, fetchedHash,
        httpStatus: res.status, evidenceId,
        detail:
          status === "current"
            ? `re-fetched bytes are byte-identical to the recorded source (sha256=${fetchedHash.slice(0, 12)}…)`
            : `re-fetched bytes differ from recorded hash ${expected.slice(0, 12)}… (got ${fetchedHash.slice(0, 12)}…) — the venue source changed since the profile was authored`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail("fetch-failed", `transport failed: ${message}`, failureContent({ sourceId, url, error: message }));
    }
  }

  const verified = results.length > 0 && results.every((r) => r.status === "current");
  return {
    venueProfileId: input.venueProfileId,
    checkedAt,
    verified,
    sources: results,
    evidenceIds,
    note: verified
      ? null
      : `${results.filter((r) => r.status !== "current").length}/${results.length} source(s) are not current`,
  };
}
