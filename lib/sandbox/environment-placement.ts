/**
 * Turning a resolved environment into what one spawn carries (ADR-0182).
 *
 * `resolveEnvironmentSpec` answers *which* environment a run should get. This
 * answers *what the spawn does about it* — and those are different questions,
 * because the fault rule lives here: whether an infrastructure fault refuses
 * the run or falls back to the existing path depends on the project's
 * selection, which the sealed spec deliberately does not carry.
 *
 * # Why `isolationMandatory` is not read off the spec
 *
 * Every spec has `isolation.minimum`, because every sandbox runs at some tier.
 * What makes isolation *mandatory* is that the project asked for it —
 * `isolationMinimum` on its runtime selection, or `requireSandbox` on its
 * policy. A spawn that inferred the flag from the spec would make every
 * sandboxed run mandatory and turn every daemon hiccup into a refused run.
 *
 * # Off is not a value
 *
 * A project that selected no runtime environment produces `off`, and the
 * caller must then send no `sandbox` field at all rather than a placement that
 * says "none". That is the Q39 rule the off-path tests pin: with nothing
 * selected, the spawn payload is byte-for-byte what it was before this
 * subsystem existed.
 */

import type {
  EnvironmentRefusalCode,
  EnvironmentSpecResolution,
  ResolutionNotice,
  SandboxFallbackCode,
} from "@/lib/project-environment/resolve-environment-spec"
import type { ProjectEnvironmentPolicy, ProjectRuntimeSelection } from "@/types/project-environment"
import type { SandboxPlacement } from "@/types/sandbox/environment-spec"

/** What the run should do about its environment. */
export type SandboxPlacementOutcome =
  /** No runtime environment. Spawn exactly as before, with no `sandbox`. */
  | { kind: "off" }
  /** Spawn with this placement. */
  | { kind: "placed"; placement: SandboxPlacement; notices: ResolutionNotice[] }
  /**
   * The project opted in, the deployment cannot sandbox right now, and nothing
   * makes isolation mandatory. Spawn as before and show the reason.
   */
  | { kind: "fallback"; code: SandboxFallbackCode; notices: ResolutionNotice[] }
  /** Running would silently do less than was asked. Do not spawn. */
  | {
      kind: "refused"
      code: EnvironmentRefusalCode
      detail?: Record<string, string | number | boolean>
      notices: ResolutionNotice[]
    }

export interface PlacementProjectInput {
  runtime: ProjectRuntimeSelection | undefined
  policy: ProjectEnvironmentPolicy | undefined
  /**
   * Whether this host can run a desktop local container (ADR-0182).
   *
   * **Dormant in Step ① and labeled on all three axes**: documented here,
   * refused with `local_container_unavailable` below, and pinned by
   * `a_project_asking_for_a_local_container_is_refused_until_the_host_offers_one`.
   *
   * It is not a missing feature flag. A desktop has no operator baseline and
   * no agent-bundle digest of its own, so "run this project in a local
   * container" has no image catalog and no bundle to inject until a desktop
   * build ships both. Defaulting it to `true` would give a project that flips
   * the toggle a spawn that refuses deep inside admission with a code about
   * the catalog; refusing here says the actual reason.
   */
  hostRunsLocalContainers?: boolean
}

/**
 * Whether an infrastructure fault must refuse this run instead of falling
 * back.
 *
 * Two independent ways to say it, and either is enough:
 *
 * - `runtime.isolationMinimum` — the project named a tier. Falling back to the
 *   unsandboxed path would run at no tier at all.
 * - `policy.requireSandbox` — the project's execution policy (ADR-0144) says
 *   its work must be sandboxed, which predates runtime environments and still
 *   means what it says.
 *
 * The Host adds its own half: a multi-tenant baseline refuses a fallback
 * whatever the client asked for, because falling back there would run
 * untrusted code in the server container beside another tenant's data.
 */
export function isolationMandatory(input: PlacementProjectInput): boolean {
  return input.runtime?.isolationMinimum != null || input.policy?.requireSandbox === true
}

/** The spawn's verdict for one resolution. */
export function sandboxPlacementFrom(
  resolution: EnvironmentSpecResolution,
  input: PlacementProjectInput
): SandboxPlacementOutcome {
  // Checked before the resolution is read, and only when the project actually
  // asked: a project that never set the toggle is unaffected on every host.
  if (input.runtime?.localContainer === true && input.hostRunsLocalContainers !== true) {
    return {
      kind: "refused",
      code: "local_container_unavailable",
      notices: resolution.kind === "off" ? [] : resolution.notices,
    }
  }
  switch (resolution.kind) {
    case "off":
      return { kind: "off" }
    case "fallback":
      return { kind: "fallback", code: resolution.code, notices: resolution.notices }
    case "refused":
      return {
        kind: "refused",
        code: resolution.code,
        detail: resolution.detail,
        notices: resolution.notices,
      }
    case "resolved":
      return {
        kind: "placed",
        placement: {
          kind: "container",
          spec: resolution.spec,
          isolationMandatory: isolationMandatory(input),
        },
        notices: resolution.notices,
      }
  }
}

/**
 * The `sandbox` field to merge into a spawn config, as an object to spread.
 *
 * Empty for every outcome but `placed`, so the off path adds no key. Written
 * as a spread rather than `sandbox: undefined` because `undefined` survives
 * into the Tauri IPC payload as an explicit `null` on some transports, and the
 * Rust field is `Option<SandboxPlacement>` with `skip_serializing_if` — a
 * payload that names the key at all is a payload this subsystem changed.
 */
export function spawnSandboxField(
  outcome: SandboxPlacementOutcome
): { sandbox: SandboxPlacement } | Record<string, never> {
  return outcome.kind === "placed" ? { sandbox: outcome.placement } : {}
}
