import { isTauri } from "@/lib/tauri"

interface NativeSandboxResult {
  exit_code: number
  stdout: string
  stderr: string
  duration: number
  timed_out: boolean
}

export interface ConfinedSiteBuildInput {
  argv: string[]
  cwd: string
  writableRoots: string[]
  readableRoots: string[]
  env?: Record<string, string>
  /** Empty/undefined means no network. Hosts require explicit user approval upstream. */
  networkHosts?: string[]
  timeoutSeconds?: number
  maxCpuSeconds?: number
  maxMemoryMb?: number
  maxOutputBytes?: number
}

export interface ConfinedSiteBuildResult {
  exitCode: number
  stdout: string
  stderr: string
  durationSeconds: number
  timedOut: boolean
  outputTruncated: boolean
}

const CREDENTIAL_ENV_KEY =
  /(^|_)(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)(_|$)/i

function validatedHosts(hosts: readonly string[]): string[] {
  const normalized = [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))]
  for (const host of normalized) {
    if (
      host.includes("://") ||
      host.includes("/") ||
      !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)
    ) {
      throw new Error(`invalid Sites build network host: ${host}`)
    }
  }
  return normalized.sort()
}

function validatedEnv(env: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_ENV_KEY.test(key) || key.toUpperCase().startsWith("CLOUDFLARE_")) {
      throw new Error(`credential-like environment key is forbidden in Sites builds: ${key}`)
    }
  }
  return { ...env }
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) return { value, truncated: false }
  return {
    value: new TextDecoder().decode(bytes.slice(0, maxBytes)),
    truncated: true,
  }
}

/**
 * Run untrusted Site install/build code through Cognia's existing OS sandbox.
 * This path is pinned to the local Tauri process, defaults to zero network,
 * has explicit filesystem roots and resource ceilings, and never accepts a
 * provider credential in the child environment.
 */
export async function runConfinedSiteBuild(
  input: ConfinedSiteBuildInput
): Promise<ConfinedSiteBuildResult> {
  if (!isTauri()) throw new Error("Sites builds require the local Tauri sandbox host")
  if (input.argv.length === 0 || !input.argv[0]?.trim()) {
    throw new Error("Sites build argv is required")
  }
  if (!input.cwd.trim()) throw new Error("Sites build cwd is required")
  if (input.writableRoots.length === 0) {
    throw new Error("Sites build requires an explicit writable root")
  }
  const networkHosts = validatedHosts(input.networkHosts ?? [])
  const env = validatedEnv(input.env ?? {})
  const timeoutSeconds = input.timeoutSeconds ?? 600
  const maxCpuSeconds = input.maxCpuSeconds ?? 600
  const maxMemoryMb = input.maxMemoryMb ?? 4096
  const maxOutputBytes = input.maxOutputBytes ?? 1024 * 1024
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    !Number.isFinite(maxCpuSeconds) ||
    maxCpuSeconds <= 0 ||
    !Number.isFinite(maxMemoryMb) ||
    maxMemoryMb <= 0 ||
    !Number.isFinite(maxOutputBytes) ||
    maxOutputBytes <= 0
  ) {
    throw new Error("Sites build resource limits must be positive")
  }

  const { invoke } = await import("@tauri-apps/api/core")
  const result = await invoke<NativeSandboxResult>("sandbox_exec", {
    tool: "sandbox_bash",
    command: {
      argv: [...input.argv],
      cwd: input.cwd,
      env,
      stdin: null,
      timeout: timeoutSeconds,
    },
    request: {
      writable: [...input.writableRoots],
      readable: [...input.readableRoots],
      targetFiles: [],
      maxCpuSeconds,
      maxMemoryMb,
      network: networkHosts.length > 0 ? "allowlist" : "off",
      networkHosts,
    },
  })
  const stdout = truncateUtf8(result.stdout, maxOutputBytes)
  const stderr = truncateUtf8(result.stderr, maxOutputBytes)
  return {
    exitCode: result.exit_code,
    stdout: stdout.value,
    stderr: stderr.value,
    durationSeconds: result.duration,
    timedOut: result.timed_out,
    outputTruncated: stdout.truncated || stderr.truncated,
  }
}
