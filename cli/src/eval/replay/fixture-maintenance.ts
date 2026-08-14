/**
 * `cognia eval record` and `cognia eval refresh` (ADR-0118).
 *
 * The two halves that are NOT replay: capturing a real session through the
 * recording proxy, and tidying a fixture's derivable parts afterwards.
 *
 * `refresh` is deliberately weak. It may renumber tape ids and drop unreferenced
 * asset bodies, and it may not touch a single behaviour or digest — regenerating
 * those would mean calling a provider, which is what `record` is for and what a
 * refresh must never do silently. Anything it cannot fix it reports.
 */

import { loadReplayFixture, type ReplayFixtureV1 } from "@/lib/ai/replay/fixture"
import {
  createEvalDataKey,
  decryptEvalArtifact,
  encryptEvalArtifact,
  unwrapEvalDataKey,
  wrapEvalDataKey,
  type EvalEncryptedEnvelope,
  type EvalWrappedDataKey,
} from "@/lib/ai/eval/artifact-crypto"
import type { ReplayScenarioV1 } from "@cognia/agent-config-types/model-request-surface"
import { createRecordingProxy, type RecordingProxy } from "./recording-proxy"

export interface EncryptedReplayFixtureBundleV1 {
  schema: "cognia-replay-fixture-bundle/v1"
  wrappedKey: EvalWrappedDataKey
  payload: EvalEncryptedEnvelope
}

export function isEncryptedReplayFixtureBundle(
  value: unknown
): value is EncryptedReplayFixtureBundleV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { schema?: unknown }).schema === "cognia-replay-fixture-bundle/v1" &&
    typeof (value as { wrappedKey?: unknown }).wrappedKey === "object" &&
    typeof (value as { payload?: unknown }).payload === "object"
  )
}

/** Encrypt a real recording before it can reach the filesystem. */
export async function sealReplayFixture(
  fixture: ReplayFixtureV1,
  password: string
): Promise<EncryptedReplayFixtureBundleV1> {
  if (!password) throw new Error("replay fixture encryption requires a password")
  const validated = loadReplayFixture(fixture, { requireSynthetic: false })
  if (!validated.ok) {
    throw new Error(
      `replay fixture cannot be encrypted:\n${validated.errors.map((error) => `  - ${error}`).join("\n")}`
    )
  }
  const dataKey = createEvalDataKey()
  return {
    schema: "cognia-replay-fixture-bundle/v1",
    wrappedKey: await wrapEvalDataKey(dataKey, password),
    payload: await encryptEvalArtifact(dataKey, validated.value),
  }
}

/** Open an encrypted local recording and re-run the normal fixture admission checks. */
export async function openEncryptedReplayFixture(
  bundle: EncryptedReplayFixtureBundleV1,
  password: string
): Promise<ReplayFixtureV1> {
  if (!isEncryptedReplayFixtureBundle(bundle)) {
    throw new Error("unsupported encrypted replay fixture bundle")
  }
  const dataKey = await unwrapEvalDataKey(bundle.wrappedKey, password)
  const decrypted = await decryptEvalArtifact<unknown>(dataKey, bundle.payload)
  const validated = loadReplayFixture(decrypted, { requireSynthetic: false })
  if (!validated.ok) {
    throw new Error(
      `decrypted replay fixture is invalid:\n${validated.errors.map((error) => `  - ${error}`).join("\n")}`
    )
  }
  return validated.value
}

export interface RefreshFixtureResult {
  fixture: ReplayFixtureV1
  /** Human-readable list of what changed; empty means the file was already tidy. */
  changes: string[]
  /** Problems refresh is not allowed to fix on its own. */
  warnings: string[]
}

export function refreshFixture(raw: unknown): RefreshFixtureResult {
  // `requireSynthetic: false` — refresh must work on a local recording too; the
  // admission gate belongs to whoever commits the file, not to tidying it.
  const loaded = loadReplayFixture(raw, { requireSynthetic: false })
  if (!loaded.ok) {
    throw new Error(
      `fixture cannot be refreshed:\n${loaded.errors.map((e) => `  - ${e}`).join("\n")}`
    )
  }

  const fixture = loaded.value
  const changes: string[] = []
  const warnings: string[] = []

  const referenced = new Set(
    fixture.tapes
      .filter((tape) => tape.behavior.kind === "stream")
      .map((tape) => (tape.behavior as { chunksRef: string }).chunksRef)
  )

  const assets: Record<string, string[]> = {}
  for (const [ref, chunks] of Object.entries(fixture.assets ?? {})) {
    if (referenced.has(ref)) assets[ref] = chunks
    else changes.push(`dropped unreferenced asset "${ref}"`)
  }

  const tapes = fixture.tapes.map((tape, index) => {
    const tapeId = `tape-${index + 1}`
    if (tapeId !== tape.tapeId) changes.push(`renumbered ${tape.tapeId} to ${tapeId}`)
    return { ...tape, tapeId }
  })

  const recorded = tapes.filter((tape) => !tape.synthetic)
  if (recorded.length > 0) {
    warnings.push(
      `${recorded.length} tape(s) are still marked as real recordings — scrub them and set ` +
        "`synthetic: true` before committing this fixture"
    )
  }

  const declared = new Set(fixture.scenario.actors.map((actor) => actor.actorRef))
  for (const tape of tapes) {
    if (!declared.has(tape.match.actorRef)) {
      // Not auto-added: silently declaring the actor would turn a typo into a
      // scenario that runs and proves nothing.
      warnings.push(
        `tape ${tape.tapeId} names undeclared actor "${tape.match.actorRef}" — add it to the ` +
          "scenario or fix the reference by hand"
      )
    }
  }

  return {
    fixture: { ...fixture, tapes, assets: Object.keys(assets).length > 0 ? assets : undefined },
    changes,
    warnings,
  }
}

export interface RecordSessionOptions {
  scenario: ReplayScenarioV1
  upstream?: string
  provider?: string
  port?: number
  /** Resolves when the operator is done driving the session. */
  waitForCompletion: (proxy: RecordingProxy) => Promise<void>
}

/**
 * Boot the recording proxy, let the caller drive a real session through it, and
 * return the captured fixture.
 *
 * Every tape it produces is marked `synthetic: false`, so the result cannot be
 * committed until a human has read and scrubbed it.
 */
export async function recordSession(
  options: RecordSessionOptions
): Promise<ReplayFixtureV1 & { actors: string[] }> {
  const proxy = createRecordingProxy({
    upstream: options.upstream,
    provider: options.provider,
    defaultActorRef: options.scenario.actors.find((actor) => actor.role === "root")?.actorRef,
  })

  await proxy.start(options.port)
  try {
    await options.waitForCompletion(proxy)
  } finally {
    await proxy.stop()
  }

  const snapshot = proxy.snapshot()
  return {
    scenario: options.scenario,
    tapes: snapshot.tapes,
    assets: snapshot.assets,
    actors: snapshot.actors,
  }
}
