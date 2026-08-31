/**
 * Attest a per-call policy request against the container a machine actually
 * got (ADR-0020 remote-target).
 *
 * Docker fixes network mode, the cpu ceiling, the memory ceiling and the set
 * of visible host paths when the container is created. `docker exec` cannot
 * tighten any of them for a single command. So a request that asks for
 * something stricter than the container was built with has exactly two honest
 * outcomes, and running it anyway is not one of them: it would execute under a
 * weaker confinement than the caller believes it obtained, which is precisely
 * the failure the sandbox exists to prevent.
 *
 * This module therefore only ever answers "the container already satisfies
 * this" or "it does not, and here is which part". The caller refuses on the
 * second answer. The same shape as the e2b microvm tier, which stamps a
 * ceiling onto the payload and lets its adapter raise `policy-not-attested`.
 */

import type { MicrovmRequest } from "@cognia/plugin-sdk/api/sandbox"
import type { DockerSandboxConfig } from "@/types/sandbox"
import { isPathUnderRoot } from "./policy-bridge"

export type SandboxAttestationFailure =
  | "network-not-confined"
  | "cpu-not-capped"
  | "memory-not-capped"
  | "no-workspace-mount"
  | "path-outside-workspace"

export interface SandboxAttestation {
  attested: boolean
  /** Every unmet part, so the operator sees the whole gap in one refusal. */
  failures: SandboxAttestationFailure[]
  /** Operator-facing explanation. Empty when attested. */
  reason: string
}

const ATTESTED: SandboxAttestation = Object.freeze({
  attested: true,
  failures: [],
  reason: "",
})

/** One nano-cpu is a billionth of a cpu. Docker's `--cpus` unit on the wire. */
const NANO_CPUS_PER_CPU = 1_000_000_000
const BYTES_PER_MIB = 1024 * 1024

const EXPLANATIONS: Record<SandboxAttestationFailure, string> = {
  "network-not-confined":
    "the request needs the network off, but the container was created with it on",
  "cpu-not-capped": "the request needs a cpu ceiling the container was not created with",
  "memory-not-capped": "the request needs a memory ceiling the container was not created with",
  "no-workspace-mount":
    "the request names writable paths, but no host directory is mounted into the container",
  "path-outside-workspace":
    "the request names a path outside the directory mounted into the container",
}

/**
 * Does the container this row describes already satisfy `request`?
 *
 * `cpus` is the string Docker was given (`"1.5"`). It is compared against the
 * request's `maxCpuSeconds`, which is a ceiling on cpu-seconds rather than on
 * parallelism, so the check is deliberately conservative: any cpu cap at all
 * counts as satisfying a request that asks for one, and a request that asks
 * for none is satisfied by anything.
 */
export function attestDockerPolicy(
  config: DockerSandboxConfig,
  request: MicrovmRequest
): SandboxAttestation {
  const failures: SandboxAttestationFailure[] = []

  // "off" is the only network setting a container can be built to guarantee.
  // "allowlist" cannot be honoured by a container flag at all, so it is
  // treated as a confinement the container does not provide rather than
  // silently downgraded to "off" or to "on".
  if (request.network !== "on" && !networkIsConfined(config.networkMode)) {
    failures.push("network-not-confined")
  }
  if (request.maxCpuSeconds > 0 && !hasCpuCeiling(config)) {
    failures.push("cpu-not-capped")
  }
  if (request.maxMemoryMb > 0 && !hasMemoryCeiling(config)) {
    failures.push("memory-not-capped")
  }

  const paths = [...request.writable, ...request.targetFiles]
  if (paths.length > 0) {
    const mount = config.workspaceMount
    if (!mount) {
      failures.push("no-workspace-mount")
    } else if (!paths.every((path) => isPathUnderRoot(path, mount.hostPath))) {
      failures.push("path-outside-workspace")
    }
  }

  if (failures.length === 0) return ATTESTED
  return Object.freeze({
    attested: false,
    failures,
    reason: `The container cannot attest this request: ${failures
      .map((failure) => EXPLANATIONS[failure])
      .join("; ")}.`,
  })
}

/** Only `none` isolates the container from the network. */
function networkIsConfined(networkMode: string | undefined): boolean {
  return networkMode === "none"
}

function hasCpuCeiling(config: DockerSandboxConfig): boolean {
  const parsed = Number.parseFloat(config.cpus ?? "")
  return Number.isFinite(parsed) && parsed > 0
}

function hasMemoryCeiling(config: DockerSandboxConfig): boolean {
  return typeof config.memoryMb === "number" && config.memoryMb > 0
}

/**
 * Translate a host path to its path inside the container.
 *
 * Returns null when the path is not under the mount, which is a refusal rather
 * than a fallback: guessing a container path for an unmounted host path would
 * write somewhere the caller never named.
 */
export function containerPathFor(config: DockerSandboxConfig, hostPath: string): string | null {
  const mount = config.workspaceMount
  if (!mount || !isPathUnderRoot(hostPath, mount.hostPath)) return null
  const suffix = hostPath.slice(mount.hostPath.replace(/[\\/]+$/, "").length)
  const normalized = suffix.replace(/\\/g, "/")
  const base = mount.containerPath.replace(/\/+$/, "")
  if (normalized === "") return base
  return `${base}${normalized.startsWith("/") ? "" : "/"}${normalized}`
}

/** What Docker reports for a cpu ceiling, so an inspect result can be compared. */
export function nanoCpusFor(cpus: string | undefined): number {
  const parsed = Number.parseFloat(cpus ?? "")
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * NANO_CPUS_PER_CPU) : 0
}

/** What Docker reports for a memory ceiling, in bytes. */
export function memoryBytesFor(memoryMb: number | undefined): number {
  return typeof memoryMb === "number" && memoryMb > 0 ? memoryMb * BYTES_PER_MIB : 0
}
