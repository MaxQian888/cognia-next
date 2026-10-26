/**
 * Crossref provider (api.crossref.org/works), gated by HostPolicy:
 *
 * - `network.metadataProviders` must list "crossref" — otherwise DENIED.
 * - `network.allowPrivateAddresses === false` → the DNS answer is resolved
 *   up front and every address must be public; the request is then pinned
 *   to those verified addresses (no TOCTOU between check and connect).
 * - HTTPS only, no redirects followed, 10s timeout, 1 MiB body cap.
 *
 * `fetchImpl` is the transport seam: production uses the pinned-HTTPS
 * implementation below; tests inject a stub so parsing/hashing/evidence —
 * everything above the wire — is exercised for real without pretending a
 * network call happened.
 */
import {
  canonicalJson,
  sha256Hex,
  utf8Bytes,
  type HostPolicy,
} from "@latexwb/contracts";
import {
  crossrefSearchUrl,
  crossrefWorkUrl,
  matchDoi,
  parseCrossrefWorks,
  renderBibEntry,
  type CrossrefItem,
} from "@latexwb/latex-kit";
import { makePinnedFetcher, type FetchResult, type Fetcher } from "../net.ts";
import type {
  MetadataProvider,
  ProviderQuery,
  ProviderResponse,
  RawCandidate,
} from "./types.ts";

export type { FetchResult, Fetcher } from "../net.ts";

/**
 * Real transport: resolve → verify all addresses public → request pinned
 * to the verified list. Never follows redirects; a 3xx is surfaced as a
 * status for the caller to record, not chased.
 */
function crossrefFetcher(fakeIpCidrs: readonly string[] = []): Fetcher {
  return makePinnedFetcher({
    service: "crossref",
    userAgent: "pi-latex-workbench/0.0 (metadata lookup)",
    accept: "application/json",
    maxBytes: 1024 * 1024,
    timeoutMs: 10_000,
    fakeIpCidrs,
  });
}

export const pinnedHttpsFetch: Fetcher = crossrefFetcher();

function candidateFromItem(item: CrossrefItem): RawCandidate {
  const itemJson = canonicalJson(item);
  const authors = (item.author ?? [])
    .map((a) => [a.given, a.family].filter((s) => s !== undefined && s.length > 0).join(" "))
    .filter((s) => s.length > 0);
  const year = item.issued?.["date-parts"]?.[0]?.[0] ?? null;
  return {
    candidate: {
      identifier: item.DOI ?? null,
      title: item.title?.[0] ?? "",
      authors,
      year: year !== null && year >= 1000 && year <= 3000 ? year : null,
      // Crossref IS the registration authority for this metadata.
      metadataStatus: "verified",
      // Metadata only — Crossref does not serve the fulltext here.
      sourceAccess: "metadata-only",
      sourceLocator: item.URL ?? `https://api.crossref.org/works/${item.DOI ?? ""}`,
      version: null,
    },
    itemHash: sha256Hex(utf8Bytes(itemJson)),
    bibEntry: renderBibEntry(item),
    rawItemJson: itemJson,
  };
}

/**
 * Bounded exponential backoff for transient HTTP failures (429 + 5xx):
 * up to 2 retries after the first attempt, base ~400 ms with jitter, and a
 * ~5 s wall-clock budget for the whole call (a retry is never started past
 * the budget; each attempt still carries the transport's own 10 s timeout).
 * Non-retryable failures — 4xx other than 429, DNS/private-address rejects,
 * timeouts, body-cap aborts — surface on the first attempt with no retry.
 */
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const RETRY_BUDGET_MS = 5_000;

const isRetryableStatus = (status: number): boolean =>
  status === 429 || (status >= 500 && status <= 599);

export function crossrefProvider(options: {
  policy: HostPolicy | null;
  fetchImpl?: Fetcher | undefined;
  /** Test seam: backoff sleep (tests inject a no-op). */
  sleepImpl?: ((ms: number) => Promise<void>) | undefined;
}): MetadataProvider {
  const fetcher = options.fetchImpl ?? crossrefFetcher(options.policy?.network.fakeIpCidrs ?? []);
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const allowed = options.policy?.network.metadataProviders.includes("crossref") === true;
  return {
    id: "crossref",
    async lookup(query: ProviderQuery, opts: { signal: AbortSignal }): Promise<ProviderResponse> {
      const denied = (warning: string): ProviderResponse => ({
        status: "denied",
        warning,
        rawBytes: utf8Bytes(canonicalJson({ provider: "crossref", denied: warning })),
        candidates: [],
      });
      if (!allowed) {
        return denied("provider 'crossref' is not listed in host policy network.metadataProviders");
      }
      // allowPrivateAddresses is `const false` in HostPolicy — the pinned
      // transport enforces it; there is nothing to opt into.
      let url: URL;
      if (query.kind === "identifier") {
        const doi = matchDoi(query.identifier);
        url = new URL(doi !== null ? crossrefWorkUrl(doi) : crossrefSearchUrl(query.identifier));
      } else {
        url = new URL(crossrefSearchUrl(query.kind === "query" ? query.query : query.key));
      }
      let res: FetchResult | null = null;
      let attempts = 0;
      let fetchError: unknown = null;
      const deadline = Date.now() + RETRY_BUDGET_MS;
      while (attempts < RETRY_MAX_ATTEMPTS) {
        attempts += 1;
        try {
          res = await fetcher(url, opts.signal);
        } catch (error) {
          // DNS reject, private-address deny, timeout, body cap — never retried.
          fetchError = error;
          res = null;
          break;
        }
        if (!isRetryableStatus(res.status)) break;
        if (attempts >= RETRY_MAX_ATTEMPTS || opts.signal.aborted) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const backoff = RETRY_BASE_MS * 2 ** (attempts - 1) * (0.5 + Math.random());
        await sleep(Math.min(backoff, remaining));
      }
      if (fetchError !== null) {
        return {
          status: "unavailable",
          warning: `crossref request failed: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
          rawBytes: utf8Bytes(canonicalJson({ provider: "crossref", url: url.toString(), error: String(fetchError) })),
          candidates: [],
          attempts,
        };
      }
      const response = res as FetchResult;
      if (response.status === 404) {
        return {
          status: "not-found",
          warning: "crossref: not found",
          rawBytes: response.body,
          candidates: [],
          attempts,
        };
      }
      if (response.status < 200 || response.status >= 300) {
        return {
          status: "unavailable",
          warning: `crossref returned HTTP ${response.status} after ${attempts} attempt(s)`,
          rawBytes: response.body,
          candidates: [],
          attempts,
        };
      }
      const items = parseCrossrefWorks(new TextDecoder().decode(response.body));
      if (items === null) {
        return {
          status: "unavailable",
          warning: "crossref response was not valid JSON",
          rawBytes: response.body,
          candidates: [],
          attempts,
        };
      }
      return {
        status: items.length > 0 ? "ok" : "not-found",
        warning: items.length > 0 ? null : "crossref returned zero works",
        rawBytes: response.body,
        candidates: items.map(candidateFromItem),
        attempts,
      };
    },
  };
}
