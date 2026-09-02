/**
 * Which agent runtimes does the machine that will RUN them already have?
 *
 * The picker used to ask nothing. A user chose a preset, saved it, connected,
 * and only then learned that `codex` is not installed, as a raw spawn error.
 * Everything needed to answer earlier was already on the host: the launch
 * allowlist, the catalogued version probe and a PATH resolver the spawn path
 * itself uses. Nothing asked them.
 *
 * ## Whose PATH is the question about
 *
 * Not this process's. A browser paired to a Host has no PATH at all, and a
 * desktop driving a remote Host would answer about the wrong machine. The
 * question is always "what does the runtime that will spawn the child have",
 * so it goes out over {@link agentInvoke}, which lands on the desktop's own
 * command, the headless brain, or the paired Host, whichever is going to run
 * it. That is also why this is one batched call rather than one per runtime:
 * over the companion plane, per runtime would be a round trip per badge.
 *
 * ## Three answers, not two
 *
 * `installed` and `missing` are the obvious ones. The third, `package-runner`,
 * exists because runtimes like `gemini-cli` launch through `npx -y <package>`:
 * resolving `npx` proves only that Node is here, and running the catalogued
 * probe would DOWNLOAD the package. Reporting either "installed" or "missing"
 * would be a guess, so the host reports the shape of the launch instead and the
 * badge says so.
 *
 * The version STRING is read here, from raw probe output, using the parser the
 * catalog names. Whether that version is certified, supported or stale stays
 * with `assessRuntimeVersion` in ./runtime-version, exactly as for the
 * single-runtime probe.
 */

import { agentInvoke } from "./agent-transport"
import {
  canDetectInstalledAgents,
  externalAgentProcessPlaneScope,
  PROCESS_PLANE_COMMANDS,
} from "./process-plane"
import { findRuntimeById } from "./runtime-catalog"
import { parseProbeVersion } from "./runtime-version"

/** How the host found (or failed to find) a runtime's command. */
export type RuntimeResolution = "installed" | "missing" | "package-runner" | "not-local"

const RESOLUTIONS: readonly RuntimeResolution[] = [
  "installed",
  "missing",
  "package-runner",
  "not-local",
]

export interface InstalledRuntime {
  runtimeId: string
  /** The catalogued system command, absent for a runtime with no local one. */
  command: string | null
  resolution: RuntimeResolution
  /** Where the command resolved to, when it resolved. */
  executablePath: string | null
  /** Parsed from the probe output. Absent when unreadable, never guessed. */
  version: string | null
  /** Non-localized host note, useful in diagnostics rather than in a badge. */
  detail: string | null
}

interface WireRuntime {
  runtimeId?: unknown
  command?: unknown
  resolution?: unknown
  executablePath?: unknown
  versionOutput?: unknown
  detail?: unknown
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function readVersion(runtimeId: string, output: unknown): string | null {
  if (typeof output !== "string" || output.trim().length === 0) return null
  const parser = findRuntimeById(runtimeId)?.versionProbe?.parser
  // An uncatalogued parser is not a reason to drop the version: every shipped
  // probe uses `semver-anywhere`, and reading nothing would make a detected
  // runtime look unreadable when it is simply newer than this build's catalog.
  return parseProbeVersion(parser ?? "semver-anywhere", output) ?? null
}

function fromWire(raw: WireRuntime): InstalledRuntime | null {
  const runtimeId = asText(raw.runtimeId)
  if (!runtimeId) return null
  const resolution = RESOLUTIONS.find((candidate) => candidate === raw.resolution)
  // An unknown resolution means this host speaks a newer vocabulary than this
  // client. Dropping the row is right: a badge is a claim, and there is nothing
  // truthful to render for a state whose meaning is unknown.
  if (!resolution) return null
  return {
    runtimeId,
    command: asText(raw.command),
    resolution,
    executablePath: asText(raw.executablePath),
    version: readVersion(runtimeId, raw.versionOutput),
    detail: asText(raw.detail),
  }
}

let cache: InstalledRuntime[] | null = null
let inFlight: Promise<InstalledRuntime[]> | null = null
/**
 * The machine the cached answer describes.
 *
 * Detection is about a specific host's PATH, and the host can change under a
 * long-lived tab with no event to hang an invalidation off: a companion is
 * repointed at a second Host, a desktop attaches or drops a remote one. A
 * cache keyed on nothing kept badging every preset with the previous
 * machine's answer, which is the "answering about the wrong machine" failure
 * this module exists to prevent.
 */
let detectedScope: string | null = null
/** Monotonic, so a slow load can tell that a newer one has superseded it. */
let issued = 0

/** Drop the cache so the next read re-detects. Reset seam for the tests. */
export function forgetInstalledRuntimes(): void {
  // Bumped, never reset. A request already in flight resolves after this
  // returns, and with no newer stamp to lose to it would write the very entry
  // that was just dropped straight back in.
  issued += 1
  cache = null
  detectedScope = null
  inFlight = null
}

/**
 * Ask the host what it has.
 *
 * Cached for the session because detection spawns `--version` reads: a picker
 * that re-detects on every keystroke would fork a process tree per character.
 * Pass `refresh` after the user installs something.
 */
export async function detectInstalledRuntimes({ refresh = false } = {}): Promise<
  InstalledRuntime[]
> {
  const scope = externalAgentProcessPlaneScope()
  // A cached answer is only about the machine it was read from. Once the host
  // moves, the previous answer is not stale so much as about somebody else.
  if (detectedScope !== null && scope !== detectedScope) forgetInstalledRuntimes()
  if (!refresh && cache) return cache
  if (!refresh && inFlight) return inFlight
  if (!canDetectInstalledAgents()) {
    // No host to ask. Not an empty result: an empty array would tell the picker
    // that every runtime is missing, which is a different and false claim.
    throw new ExternalAgentDetectionUnavailableError()
  }

  // Stamped like `model-surface-cache`, and for the same reason: a `refresh`
  // fired from the retry link races the plain load the dialog opened with, so
  // without this the slower of the two wins whichever it is, and the first
  // `finally` to run frees the slot belonging to the request still
  // outstanding.
  const ticket = (issued += 1)
  const isNewest = () => issued === ticket
  // Claimed now, not on resolve, so a second caller in the same tick shares
  // this request instead of tripping the scope check and opening its own.
  detectedScope = scope

  const request = agentInvoke<{ runtimes?: unknown } | null>(PROCESS_PLANE_COMMANDS.detect, {})
    .then((report) => {
      const rows = report?.runtimes
      const runtimes = Array.isArray(rows)
        ? rows.flatMap((row) => {
            const parsed = fromWire(row as WireRuntime)
            return parsed ? [parsed] : []
          })
        : []
      if (isNewest()) cache = runtimes
      return runtimes
    })
    .finally(() => {
      if (isNewest()) inFlight = null
    })

  inFlight = request
  return request
}

/** Thrown when nothing can be asked, so "missing" would be an invention. */
export class ExternalAgentDetectionUnavailableError extends Error {
  constructor() {
    super("No runtime that can start an external agent is reachable from here.")
    this.name = "ExternalAgentDetectionUnavailableError"
  }
}
