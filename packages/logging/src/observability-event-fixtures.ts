import crash from "./schemas/fixtures/crash.json"
import lifecycle from "./schemas/fixtures/lifecycle.json"
import logFull from "./schemas/fixtures/log-full.json"
import logMinimal from "./schemas/fixtures/log-minimal.json"
import metric from "./schemas/fixtures/metric.json"
import span from "./schemas/fixtures/span.json"
import type { ObservabilityEventV1 } from "./observability-event"

/**
 * Golden `ObservabilityEventV1` fixtures — the shared parity corpus.
 *
 * The exact same JSON files are read by the Rust suite in
 * `crates/cognia-observability/src/event.rs`, so "the renderer and the native
 * runtime write the same shape" is a property the build proves rather than a
 * claim the ADR makes. Every registered producer's contract test asserts
 * against this corpus; adding a fixture here extends both runtimes at once.
 */
export interface ObservabilityGoldenFixture {
  /** File name under `schemas/fixtures/`, used in failure messages. */
  file: string
  event: ObservabilityEventV1
}

export const OBSERVABILITY_GOLDEN_FIXTURES: readonly ObservabilityGoldenFixture[] = [
  { file: "crash.json", event: crash as ObservabilityEventV1 },
  { file: "lifecycle.json", event: lifecycle as ObservabilityEventV1 },
  { file: "log-full.json", event: logFull as ObservabilityEventV1 },
  { file: "log-minimal.json", event: logMinimal as ObservabilityEventV1 },
  { file: "metric.json", event: metric as ObservabilityEventV1 },
  { file: "span.json", event: span as ObservabilityEventV1 },
]

/** The single fixture exercising every optional field. */
export function maximalGoldenFixture(): ObservabilityEventV1 {
  return logFull as ObservabilityEventV1
}

/** The single fixture carrying only the required fields. */
export function minimalGoldenFixture(): ObservabilityEventV1 {
  return logMinimal as ObservabilityEventV1
}
