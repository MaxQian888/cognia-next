/**
 * Whether pnpm on this machine can install into a worktree without that
 * worktree sharing a mutable directory with the user's checkout.
 *
 * pnpm 11.23 added `virtualStoreType: global` — dependencies live once on the
 * machine and every project links to them, so a fresh worktree's `pnpm install`
 * is near-instant AND independent. That is strictly better than the fallback
 * (symlinking the source checkout's `node_modules` into the worktree), which is
 * fast but makes two checkouts write one directory. So the answer here changes
 * what `inferProvisioning` proposes.
 *
 * The setting is not written for the user. `pnpm config set --global` edits a
 * machine-wide config that affects every project on this computer, including
 * ones Cognia has never opened; that is the user's file to change. The card
 * shows the command and reports the state, which is the honest division.
 *
 * The legacy `enableGlobalVirtualStore` counts as enabled: 11.23 replaced it
 * but kept it working, so a machine configured before the rename is not
 * "unsupported".
 */

import { PNPM_GLOBAL_STORE_MIN_VERSION, type PnpmVirtualStore } from "./provisioning-inference"

const VIRTUAL_STORE_TYPE_MARKER = "cognia-vst:"
const LEGACY_FLAG_MARKER = "cognia-egvs:"

/**
 * One shell line, so the probe costs a single process rather than two.
 *
 * Each value is echoed behind a marker instead of being read as "the whole of
 * stdout": pnpm prints update notices and workspace warnings of its own, and a
 * bare `pnpm config get` output is not reliably one clean line.
 */
export function pnpmProbeCommand(binary: string): string {
  const pnpm = binary.includes('"') ? '"pnpm"' : `"${binary}"`
  return [
    `echo "${VIRTUAL_STORE_TYPE_MARKER}$(${pnpm} config get virtualStoreType)"`,
    `echo "${LEGACY_FLAG_MARKER}$(${pnpm} config get enableGlobalVirtualStore)"`,
  ].join("; ")
}

function markedValue(stdout: string, marker: string): string {
  const match = stdout.match(new RegExp(`^${marker}(.*)$`, "m"))
  return (match?.[1] ?? "").trim().toLowerCase()
}

/** Classify a probe result. `stdout` may be empty when the command failed. */
export function readVirtualStoreState(
  version: string | null,
  supported: boolean,
  stdout: string
): PnpmVirtualStore {
  if (!version) return "unsupported"
  if (!supported) return "unsupported"
  const virtualStoreType = markedValue(stdout, VIRTUAL_STORE_TYPE_MARKER)
  const legacyFlag = markedValue(stdout, LEGACY_FLAG_MARKER)
  if (virtualStoreType === "global" || legacyFlag === "true") return "enabled"
  return "available"
}

export interface ProbePnpmDeps {
  detect: (
    name: string
  ) => Promise<{ available: boolean; version: string | null; path: string | null }>
  meetsMinimum: (version: string | null, minimum: string) => Promise<boolean>
  run: (command: string, cwd: string) => Promise<string>
}

const DEFAULT_DEPS: ProbePnpmDeps = {
  detect: async (name) => {
    const { detectCli } = await import("@/lib/cli-bridge/detect-cli")
    const result = await detectCli(name)
    return { available: result.available, version: result.version, path: result.path }
  },
  meetsMinimum: async (version, minimum) => {
    const { satisfiesMinVersion } = await import("@/lib/cli-bridge/detect-cli")
    return satisfiesMinVersion(version, minimum)
  },
  run: async (command, cwd) => {
    const { executeShell } = await import("@/lib/shell/exec")
    const result = await executeShell(command, cwd, 20)
    return result.stdout
  },
}

/**
 * Probe, never throwing. An unknown answer degrades to proposing the cache
 * link, which is what happened before this existed — a slower default, not a
 * broken one.
 */
export async function probePnpmVirtualStore(
  root: string,
  deps?: Partial<ProbePnpmDeps>
): Promise<PnpmVirtualStore> {
  const resolved: ProbePnpmDeps = { ...DEFAULT_DEPS, ...deps }
  try {
    const detected = await resolved.detect("pnpm")
    if (!detected.available || !detected.version) return "unsupported"
    const supported = await resolved.meetsMinimum(detected.version, PNPM_GLOBAL_STORE_MIN_VERSION)
    if (!supported) return "unsupported"
    const stdout = await resolved.run(pnpmProbeCommand(detected.path ?? "pnpm"), root)
    return readVirtualStoreState(detected.version, supported, stdout)
  } catch {
    return "unknown"
  }
}
