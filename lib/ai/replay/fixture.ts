/**
 * Replay fixture loading and admission (ADR-0118).
 *
 * A fixture is one scenario plus the tapes that answer it. Loading validates
 * both and then applies three checks that exist because each one, left out,
 * fails in a way that is expensive to diagnose later:
 *
 *   1. Every tape must name an actor the scenario declares. A typo in
 *      `actorRef` otherwise produces a fixture that loads cleanly, matches
 *      nothing, and reports "the model was never called".
 *   2. No two tapes may share a match key with different behaviour. Checked
 *      here as well as in the ledger so a bad fixture is rejected at authoring
 *      time rather than on someone else's CI run.
 *   3. A fixture admitted into the repository must be synthetic. Real
 *      recordings stay encrypted in the eval asset store; committing one is how
 *      a prompt, and eventually a secret, ends up in git history.
 */

import {
  findAmbiguousTapes,
  validateReplayScenario,
  validateReplayTape,
} from "@cognia/agent-config-types/model-request-surface"
import type {
  ReplayScenarioV1,
  ReplayTapeV1,
} from "@cognia/agent-config-types/model-request-surface"
import type { ValidationResult } from "@cognia/agent-config-types/agent-execution"

export interface ReplayFixtureV1 {
  scenario: ReplayScenarioV1
  tapes: ReplayTapeV1[]
  /**
   * Inline stream bodies, keyed by the `chunksRef` a tape points at.
   *
   * A synthetic fixture carries its own text so the file is self-contained and
   * reviewable in a diff. A real recording leaves this empty and resolves the
   * same refs against the encrypted eval asset store instead.
   */
  assets?: Record<string, string[]>
}

export interface LoadReplayFixtureOptions {
  /**
   * Refuse any tape that is not marked synthetic.
   *
   * On for anything read from the repository; off when replaying an encrypted
   * recording the user made locally and never intends to commit.
   */
  requireSynthetic?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function loadReplayFixture(
  raw: unknown,
  options: LoadReplayFixtureOptions = {}
): ValidationResult<ReplayFixtureV1> {
  if (!isRecord(raw)) return { ok: false, errors: ["fixture must be an object"] }

  const errors: string[] = []

  const scenarioResult = validateReplayScenario(raw.scenario)
  if (!scenarioResult.ok) {
    errors.push(...scenarioResult.errors.map((error) => `scenario: ${error}`))
  }

  if (!Array.isArray(raw.tapes)) {
    errors.push("tapes must be an array")
    return { ok: false, errors }
  }

  const tapes: ReplayTapeV1[] = []
  raw.tapes.forEach((entry, index) => {
    const result = validateReplayTape(entry)
    if (result.ok) tapes.push(result.value)
    else errors.push(...result.errors.map((error) => `tapes[${index}]: ${error}`))
  })

  // Only worth checking once both sides parsed — cross-referencing a malformed
  // scenario against malformed tapes produces noise, not information.
  if (scenarioResult.ok && tapes.length === raw.tapes.length) {
    const declared = new Set(scenarioResult.value.actors.map((actor) => actor.actorRef))
    for (const tape of tapes) {
      if (!declared.has(tape.match.actorRef)) {
        errors.push(
          `tape ${tape.tapeId} names actor ${tape.match.actorRef}, which the scenario does not declare`
        )
      }
    }

    for (const key of findAmbiguousTapes(tapes)) {
      errors.push(`ambiguous tapes for ${key}`)
    }

    if (options.requireSynthetic) {
      for (const tape of tapes) {
        if (!tape.synthetic) {
          errors.push(`tape ${tape.tapeId} is a real recording and cannot be admitted`)
        }
      }
    }

    if (raw.assets !== undefined) {
      if (!isRecord(raw.assets)) {
        errors.push("assets must be an object keyed by chunk reference")
      } else {
        for (const [ref, chunks] of Object.entries(raw.assets)) {
          if (!Array.isArray(chunks) || chunks.some((chunk) => typeof chunk !== "string")) {
            errors.push(`assets["${ref}"] must be an array of strings`)
          }
        }
      }
    }

    // A stream tape whose body is missing fails at request time, deep inside a
    // run, with a resolver error that reads like an infrastructure fault. Catch
    // it while the fixture is still just a file.
    const assets = isRecord(raw.assets) ? raw.assets : undefined
    if (assets) {
      for (const tape of tapes) {
        if (tape.behavior.kind !== "stream") continue
        if (!Object.hasOwn(assets, tape.behavior.chunksRef)) {
          errors.push(
            `tape ${tape.tapeId} streams "${tape.behavior.chunksRef}", which the fixture does not carry`
          )
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      scenario: scenarioResult.ok ? scenarioResult.value : (raw.scenario as ReplayScenarioV1),
      tapes,
      assets: isRecord(raw.assets) ? (raw.assets as Record<string, string[]>) : undefined,
    },
  }
}

/**
 * Resolve stream bodies from a fixture's inline assets.
 *
 * Throws rather than returning empty on a missing ref: an empty stream is a
 * valid recording (a model that produced nothing), so silently substituting one
 * would turn a broken fixture into a passing run.
 */
export function createInlineChunkResolver(
  fixture: ReplayFixtureV1
): (ref: string) => Promise<string[]> {
  const assets = fixture.assets ?? {}
  return async (ref: string) => {
    if (!Object.hasOwn(assets, ref)) {
      throw new Error(`fixture has no inline asset for chunk reference "${ref}"`)
    }
    return assets[ref]
  }
}

/**
 * Whether this host can run the fixture.
 *
 * Returns a reason rather than a boolean so a disabled Run button can say why
 * — "runtime replay needs the desktop app" is actionable, a greyed-out control
 * is not.
 */
export function replayAvailability(
  scenario: ReplayScenarioV1,
  host: { platform: "browser" | "tauri" | "headless" }
): { runnable: true } | { runnable: false; reason: string } {
  if (scenario.level === "canonical") return { runnable: true }
  if (host.platform === "browser") {
    return {
      runnable: false,
      reason:
        "runtime replay runs the real agent loop, tool pipeline and permission system, which a browser cannot host — open this scenario in the desktop app or run it headless",
    }
  }
  if (scenario.platform !== host.platform) {
    return {
      runnable: false,
      reason: `this scenario was recorded for ${scenario.platform} and cannot be replayed on ${host.platform}`,
    }
  }
  return { runnable: true }
}
