"use client"

/**
 * Push the user's terminal profiles to the host that will spawn them.
 *
 * This is load-bearing over `ws` / `webrtc`, not a nicety. A remote spawn frame
 * carries a profile **id and nothing else** — `TerminalHost::spawn_local`
 * refuses non-local identities — so the shell, cwd and env a client resolved
 * never cross the wire. Before the host knew the profile, every id a browser
 * picked came back "unknown terminal profile", and the picker's selection was
 * silently replaced by whatever the host had bootstrapped.
 *
 * Two commands, because they are two different authorities:
 *
 *   * local PTY → `terminal_host_service`, the desktop's own command, which
 *     also owns `provision` and the login-service registration;
 *   * remote host → `terminal_host_sync_profiles`, capability-gated on
 *     `terminal.open` and scoped to the calling device, so one device's sync
 *     cannot erase another's.
 *
 * SSH profiles go only to the local host. An SSH profile names a destination
 * and a credential, and installing one from a paired device would let it drive
 * outbound connections from the host; the Rust arm refuses them for the same
 * reason.
 */

import { transport } from "@/lib/tauri"

import { selectTerminalTransportChain } from "./pick-transport"

import { profileToSpawnFields, type TerminalProfile } from "./profiles"
import {
  sshHostToConnectRequest,
  type SshConnectRequest,
  type SshHostProfile,
} from "./ssh-profiles"
import type { SpawnRequest } from "./types"

export interface TerminalProfileHostDefaults {
  enableShellIntegration?: boolean
  forceUtf8?: boolean
  sandboxed?: boolean
  sshProfiles?: SshHostProfile[]
  /**
   * A one-off spawn to install under {@link ADHOC_PROFILE_ID}, so a shell the
   * user picked in the dock can be named by a remote spawn. Ignored on the
   * local PTY, which sends the request itself.
   */
  adHoc?: SpawnRequest
}

export interface SynchronizedTerminalProfile {
  profileId: string
  request: SpawnRequest
}

export interface SynchronizedSshProfile {
  profileId: string
  request: SshConnectRequest
}

export function buildSynchronizedTerminalProfiles(
  profiles: TerminalProfile[] | undefined,
  defaults: TerminalProfileHostDefaults = {}
): SynchronizedTerminalProfile[] {
  return (profiles ?? []).flatMap((profile) => {
    const fields = profileToSpawnFields(profile)
    if (!fields) return []
    return [
      {
        profileId: profile.id,
        request: {
          ...fields,
          rows: 24,
          cols: 80,
          enableShellIntegration: defaults.enableShellIntegration ?? true,
          forceUtf8: defaults.forceUtf8 ?? true,
          sandboxed: defaults.sandboxed ?? false,
          sandboxNetwork: true,
        },
      },
    ]
  })
}

export function buildSynchronizedSshProfiles(
  profiles: SshHostProfile[] | undefined
): SynchronizedSshProfile[] {
  return (profiles ?? []).flatMap((profile) => {
    const request = sshHostToConnectRequest(profile, 24, 80)
    return request ? [{ profileId: profile.id, request }] : []
  })
}

export async function syncTerminalHostProfiles(
  profiles: TerminalProfile[] | undefined,
  defaults: TerminalProfileHostDefaults = {},
  call: typeof transport.call = transport.call.bind(transport)
): Promise<void> {
  const synchronized = buildSynchronizedTerminalProfiles(profiles, defaults)
  if (selectTerminalTransportChain()[0] !== "tauri-channel") {
    const remote = defaults.adHoc
      ? [
          ...synchronized.filter((entry) => entry.profileId !== ADHOC_PROFILE_ID),
          { profileId: ADHOC_PROFILE_ID, request: defaults.adHoc },
        ]
      : synchronized
    await call("terminal_host_sync_profiles", { profiles: remote })
    return
  }
  await call("terminal_host_service", {
    action: {
      kind: "syncProfiles",
      profiles: synchronized,
      sshProfiles: buildSynchronizedSshProfiles(defaults.sshProfiles),
    },
  })
}

/**
 * Make sure the host knows this device's profiles, once per page load.
 *
 * Split from {@link syncTerminalHostProfiles} because the two callers want
 * different things: settings screens push a set they just edited, while boot
 * and the spawn path only need the host to be caught up before a profile id is
 * named. Sharing one promise means the spawn does not re-push on every click,
 * and a spawn firing before boot finished still waits for the same sync rather
 * than racing it into "unknown terminal profile".
 *
 * A no-op on the local PTY: `TerminalBridgeInitializer` owns that path, where
 * the push is ordered against the VS Code bridge setup.
 */
let profileSync: Promise<void> | null = null

export function ensureTerminalHostProfilesSynced(): Promise<void> {
  if (profileSync) return profileSync
  profileSync = (async () => {
    if (selectTerminalTransportChain()[0] === "tauri-channel") return
    if (selectTerminalTransportChain().length === 0) return
    try {
      const terminal = (await settingsLoaded()).terminal
      await syncTerminalHostProfiles(terminal?.profiles, {
        enableShellIntegration: terminal?.enableShellIntegration,
        forceUtf8: terminal?.forceUtf8,
        sandboxed: terminal?.sandboxed,
      })
    } catch {
      // Best-effort. An unpaired or unreachable host, or one with remote access
      // switched off, refuses this exactly as it refuses everything else — and
      // the dock's host-state banner is where the user learns that, not a
      // failed boot.
    }
  })()
  return profileSync
}

/** Settings as soon as they are loaded, or immediately if they already are. */
async function settingsLoaded(): Promise<SettingsSnapshot> {
  const { useSettingsStore } = await import("@/stores/settings/settings-store")
  const state = useSettingsStore.getState()
  if (state.loaded) return (state.settings ?? {}) as SettingsSnapshot
  return new Promise<SettingsSnapshot>((resolve) => {
    const stop = useSettingsStore.subscribe((next) => {
      if (!next.loaded) return
      stop()
      resolve((next.settings ?? {}) as SettingsSnapshot)
    })
  })
}

interface SettingsSnapshot {
  terminal?: {
    profiles?: TerminalProfile[]
    enableShellIntegration?: boolean
    forceUtf8?: boolean
    sandboxed?: boolean
  }
}

/** Test-only: allow a second sync against a re-stubbed shell. */
export function __resetTerminalHostProfileSyncForTests(): void {
  profileSync = null
}

/**
 * The profile id a remote spawn should name for `request`.
 *
 * A remote Spawn frame carries a profile id and nothing else — the host's
 * `spawn_local` refuses non-local identities, so `shell`, `cwd` and `env` are
 * dropped on the way. That is deliberate: it stops a paired device smuggling an
 * environment into a host PTY through the streaming socket. But it also meant a
 * shell the user picked was silently replaced by whatever the host had
 * bootstrapped, with no error to explain it.
 *
 * So an ad-hoc spawn becomes a profile like any other, installed through the
 * `terminal.open`-gated sync RPC rather than smuggled down the spawn frame.
 * Same exposure as a saved profile, through the channel that is audited and
 * capability-checked, and the streaming socket keeps its narrow contract.
 *
 * The ad-hoc entry is pushed *alongside* the saved profiles because the host
 * replaces a device's set wholesale; sending it alone would delete them.
 */
export const ADHOC_PROFILE_ID = "__adhoc"

export async function ensureRemoteSpawnProfile(request: SpawnRequest): Promise<string> {
  if (request.profileId && request.profileId.trim().length > 0) {
    await ensureTerminalHostProfilesSynced()
    return request.profileId
  }
  const terminal = (await settingsLoaded()).terminal
  await syncTerminalHostProfiles(terminal?.profiles, {
    enableShellIntegration: terminal?.enableShellIntegration,
    forceUtf8: terminal?.forceUtf8,
    sandboxed: terminal?.sandboxed,
    adHoc: request,
  })
  return ADHOC_PROFILE_ID
}
