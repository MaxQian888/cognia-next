"use client"

/**
 * File a freshly paired Host in this desktop's registry: the one write every
 * "add a host" path makes once an invitation has been redeemed.
 *
 * Two callers share it: the add-host form (a scanned or pasted invitation)
 * and the Host installer (ADR-0235 P5), which redeems the invitation the
 * machine it just installed printed. A label, the always-on role (ADR-0224)
 * and, for an installed Host, the machine it runs on are recorded with the
 * config. Driving the Host straight away is a host switch, so it goes
 * through the shared in-flight guard and `onRegistered` waits for that
 * answer; an always-on Host is a peer and is never switched to.
 */

import { useCallback, type ReactElement } from "react"

import { useExecutionHostSwitch } from "@/hooks/devices/use-execution-host-switch"
import type { CompanionConfig } from "@/lib/tauri/transport-companion"
import {
  useRemoteHostStore,
  type HostInstallBinding,
  type RemoteHost,
} from "@/stores/remote-host/remote-host-store"

export interface RegisterPairedHostOptions {
  label: string
  alwaysOn: boolean
  /** Switch this window to the Host. Ignored for an always-on Host. */
  connectAfter: boolean
  installBinding?: HostInstallBinding
}

export interface RegisterPairedHost {
  /**
   * Record the Host and return it. `onRegistered` runs once the Host is filed
   * and, when this window switches to it, once that switch has settled.
   */
  register: (
    config: CompanionConfig,
    options: RegisterPairedHostOptions,
    onRegistered?: (host: RemoteHost) => void
  ) => RemoteHost
  /** The switch confirmation. Render it once, in the caller's tree. */
  dialog: ReactElement
}

export function useRegisterPairedHost(): RegisterPairedHost {
  const addHost = useRemoteHostStore((s) => s.addHost)
  const { requestSwitch, dialog } = useExecutionHostSwitch()

  const register = useCallback<RegisterPairedHost["register"]>(
    (config, options, onRegistered) => {
      const host = addHost({
        label: options.label.trim() || undefined,
        config,
        ...(options.alwaysOn ? { alwaysOn: true } : {}),
        ...(options.installBinding ? { installBinding: options.installBinding } : {}),
      })
      if (options.alwaysOn || !options.connectAfter) {
        onRegistered?.(host)
        return host
      }
      // Fire-and-forget on purpose. The pairing succeeded the moment `addHost`
      // returned; whether this window also starts driving the Host is a
      // separate question the user may still be answering.
      void requestSwitch(host.id, { onSettled: () => onRegistered?.(host) })
      return host
    },
    [addHost, requestSwitch]
  )

  return { register, dialog }
}
