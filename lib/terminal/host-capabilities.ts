"use client"

/**
 * What the *host* said about itself, cached for the renderer.
 *
 * `lib/terminal/shell-detect.ts` answers "which shell should I spawn?" from
 * `navigator.userAgent`. On the desktop that is correct by accident — the
 * client and the host are the same machine. Over `ws` / `webrtc` they are not,
 * so a macOS browser paired to a Linux `cognia-server` asked it for `/bin/zsh`
 * and a Windows browser asked for `pwsh.exe`. Both spawns failed, and the only
 * clue was the host's `spawn_command failed`.
 *
 * The host now answers the question itself: `TerminalHostCapabilities` rides
 * the hello ack and the host snapshot (`crates/cognia-terminal/src/host_capabilities.rs`),
 * which are the two frames the renderer already receives before it can spawn
 * anything. This module holds the answer for the surfaces that need it — the
 * spawn default and the shell picker — and lets them re-render when it lands.
 *
 * Deliberately NOT persisted: the pairing can be repointed at a different
 * server between reloads, and a stale platform is worse than no platform (it
 * silently produces the exact wrong shell this module exists to prevent). The
 * cache is re-warmed on the first list/hello of every session, which the
 * reattach path performs at mount anyway.
 */

/** Mirrors Rust `HostPlatform` — same four values as `ShellPlatform`. */
export type TerminalHostPlatform = "windows" | "macos" | "linux" | "other"

/** Mirrors Rust `HostShellCandidate`. */
export interface TerminalHostShell {
  /** Spawnable path / PATH-resolvable name, for `SpawnRequest.shell`. */
  path: string
  /** Shell family, in the same vocabulary as `ShellKind`. */
  kind: string
}

/** Mirrors Rust `TerminalHostCapabilities`. */
export interface TerminalHostCapabilities {
  platform: TerminalHostPlatform
  defaultShell: string
  availableShells: TerminalHostShell[]
  homeDir?: string | null
}

type Listener = () => void

let cached: TerminalHostCapabilities | null = null
const listeners = new Set<Listener>()
let inFlight: Promise<TerminalHostCapabilities | null> | null = null

const PLATFORMS: ReadonlySet<string> = new Set(["windows", "macos", "linux", "other"])

/**
 * Accept only a complete, usable answer.
 *
 * A partially-decoded capability blob is worse than none: `defaultShell: ""`
 * would be handed to the host as the shell to spawn, and the caller has no way
 * to tell that apart from a deliberate choice.
 */
export function parseHostCapabilities(value: unknown): TerminalHostCapabilities | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const platform = record.platform
  const defaultShell = record.defaultShell
  if (typeof platform !== "string" || !PLATFORMS.has(platform)) return null
  if (typeof defaultShell !== "string" || defaultShell.trim() === "") return null
  const shells = Array.isArray(record.availableShells) ? record.availableShells : []
  const availableShells: TerminalHostShell[] = []
  for (const entry of shells) {
    if (!entry || typeof entry !== "object") continue
    const shell = entry as Record<string, unknown>
    if (typeof shell.path !== "string" || shell.path.trim() === "") continue
    availableShells.push({
      path: shell.path,
      kind: typeof shell.kind === "string" ? shell.kind : "unknown",
    })
  }
  return {
    platform: platform as TerminalHostPlatform,
    defaultShell,
    availableShells,
    homeDir: typeof record.homeDir === "string" ? record.homeDir : null,
  }
}

/** Record what a hello ack or host snapshot reported. Ignores junk. */
export function recordHostCapabilities(value: unknown): void {
  const parsed = parseHostCapabilities(value)
  if (!parsed) return
  if (
    cached &&
    cached.platform === parsed.platform &&
    cached.defaultShell === parsed.defaultShell &&
    cached.availableShells.length === parsed.availableShells.length &&
    cached.availableShells.every(
      (shell, index) => shell.path === parsed.availableShells[index].path
    )
  ) {
    return
  }
  cached = parsed
  for (const listener of listeners) listener()
}

/** The last answer, or null when no remote host has introduced itself yet. */
export function getHostCapabilities(): TerminalHostCapabilities | null {
  return cached
}

export function subscribeHostCapabilities(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The cached answer, asking the host once when it is cold.
 *
 * Callers are on the spawn path, so this must never throw: a host that cannot
 * be reached returns `null` and the caller falls back to its own guess, which
 * is exactly the pre-existing behaviour.
 *
 * Concurrent callers share one probe — the dock's "+ New" and the shell picker
 * opening together must not each pay a socket ticket and a WebSocket.
 */
export async function ensureHostCapabilities(): Promise<TerminalHostCapabilities | null> {
  if (cached) return cached
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const { selectTerminalTransportChain } = await import("./pick-transport")
      const chain = selectTerminalTransportChain()
      // The local PTY is the host; `shell-detect` is already right there, and
      // opening a remote probe would be nonsense.
      if (chain.length === 0 || chain[0] === "tauri-channel") return null
      const { RemoteTerminalSession } = await import("./transport-ws")
      await RemoteTerminalSession.describeHost()
      return cached
    } catch {
      return null
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/**
 * Protocol features the host advertised in its hello ack.
 *
 * Rust holds the list in `crates/cognia-terminal/src/host_wire.rs:PROTOCOL_FEATURES`
 * and `protocol.rs` makes it load-bearing: a client rejects an unmapped frame
 * discriminant outright, so a newer host must not push a kind an older client
 * has never heard of. The negotiation channel has been on the wire since the
 * beginning and nothing in TypeScript read it, which meant "does this host
 * speak frames 24/25?" could only be answered by trying and failing.
 *
 * Only the hello ack carries this (Rust pins that with
 * `only_the_hello_ack_carries_the_host_description`), so it warms on the same
 * probe as the host description and shares its in-flight promise.
 */
export type TerminalProtocolFeature = "pathInjection" | "flowControl" | "history" | "sshForwarding"

let features: readonly string[] | null = null

/**
 * Record the ack's feature list.
 *
 * An unknown string is kept rather than dropped: the question callers ask is
 * "did the host name this feature", and a build that has not heard of a newer
 * feature name still answers that correctly for the ones it knows.
 */
export function recordProtocolFeatures(value: unknown): void {
  if (!Array.isArray(value)) return
  const next = value.filter((entry): entry is string => typeof entry === "string")
  if (features && features.length === next.length && features.every((f, i) => f === next[i])) {
    return
  }
  features = next
  for (const listener of listeners) listener()
}

/**
 * What the host said it speaks, or `null` when no host has introduced itself.
 *
 * `null` is deliberately not the empty list. "The host has not said" and "the
 * host named nothing" lead to opposite decisions: the first should fall back to
 * trying, the second should not.
 */
export function getProtocolFeatures(): readonly string[] | null {
  return features
}

/**
 * Whether the host named `feature`.
 *
 * Unknown hosts answer `true`. A host that never introduced itself is the
 * local PTY or a probe that has not run yet, and refusing a capability the
 * host may well have would turn a missing probe into a missing feature.
 */
export function hostSupportsProtocolFeature(feature: TerminalProtocolFeature): boolean {
  if (features === null) return true
  return features.includes(feature)
}

/** The cached feature list, running the host probe once when it is cold. */
export async function ensureProtocolFeatures(): Promise<readonly string[] | null> {
  if (features) return features
  await ensureHostCapabilities()
  return features
}

/** Test-only: forget the host so a re-stubbed one is observed. */
export function __resetHostCapabilitiesForTests(): void {
  cached = null
  features = null
  inFlight = null
  listeners.clear()
}
