"use client"

import { transport } from "@/lib/tauri"

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
  await call("terminal_host_service", {
    action: {
      kind: "syncProfiles",
      profiles: buildSynchronizedTerminalProfiles(profiles, defaults),
      sshProfiles: buildSynchronizedSshProfiles(defaults.sshProfiles),
    },
  })
}
