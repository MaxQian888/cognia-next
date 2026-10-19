/**
 * Reader connection test — one bounded read through exactly one reader.
 *
 * Separate from the Search connection test on purpose: a successful search
 * probe says nothing about the same vendor's Reader, and vice versa. The test
 * pins the reader strictly (no fallback), reads one stable public page, never
 * distills, never caches, and reports dated evidence — a past success is
 * history, not a guarantee the reader is online now. Nothing runs on load,
 * save or migration; the settings UI calls this only on an explicit click.
 */

import type { CredentialedWebReaderId, WebReaderId } from "@cognia/agent-config-types"
import { MAX_OPERATION_ATTEMPTS, READ_ATTEMPT_BUDGET_MS } from "@cognia/web-search/operation-policy"
import { readWithPolicy, type ReaderHostDeps } from "./configured-reader"
import type { ReaderPolicy } from "./reader-settings"

/** A stable, public, tiny page every reader can read. */
export const READER_TEST_URL = "https://example.com/"

export interface ReaderTestResult {
  reader: WebReaderId
  ok: boolean
  /** Reader-service or origin status, when one was observed. */
  status?: number
  /** Bounded, content-free failure reason (`reader-unavailable`, `all-readers-failed`, …). */
  reason?: string
  /** Epoch ms the test completed. */
  testedAt: number
}

export interface ReaderTestDeps extends Pick<
  ReaderHostDeps,
  "fetchImpl" | "hostReachable" | "allowPrivateHosts" | "admission"
> {
  credentialFor?: (reader: CredentialedWebReaderId) => string | undefined
  signal?: AbortSignal
  now?: () => number
  url?: string
}

/** Run one strict, uncached, undistilled read through `reader`. */
export async function testReaderConnection(
  reader: WebReaderId,
  deps: ReaderTestDeps = {}
): Promise<ReaderTestResult> {
  const policy: ReaderPolicy = {
    defaultReader: reader,
    enabled: new Set([reader]),
    externalOrder: [],
    externalFallback: false,
    distillation: "off",
    timeoutMs: READ_ATTEMPT_BUDGET_MS,
    maxAttempts: Math.min(1, MAX_OPERATION_ATTEMPTS),
    revision: `reader-test|${reader}`,
  }
  const result = await readWithPolicy(
    { url: deps.url ?? READER_TEST_URL, reader },
    {
      policy,
      fetchImpl: deps.fetchImpl,
      credentialFor: deps.credentialFor,
      hostReachable: deps.hostReachable,
      allowPrivateHosts: deps.allowPrivateHosts,
      admission: deps.admission,
      signal: deps.signal,
      scope: "reader-test",
    }
  )
  const testedAt = (deps.now ?? Date.now)()
  if ("code" in result && result.ok === false) {
    const failure = result as { reason?: unknown }
    return {
      reader,
      ok: false,
      ...(typeof failure.reason === "string" ? { reason: failure.reason } : {}),
      testedAt,
    }
  }
  const success = result as { ok?: boolean; status?: number; text?: unknown; body?: unknown }
  const readable =
    (typeof success.text === "string" && success.text.trim() !== "") ||
    (typeof success.body === "string" && success.body.trim() !== "")
  return {
    reader,
    ok: success.ok === true && readable,
    ...(typeof success.status === "number" ? { status: success.status } : {}),
    ...(success.ok === true && readable ? {} : { reason: "no-readable-content" }),
    testedAt,
  }
}
