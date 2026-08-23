import {
  loadRemoteHostCredential,
  type RemoteHostCredential,
} from "@/lib/remote-host/credential-vault"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { CompanionTransport } from "@/lib/tauri/transport-companion"
import type { Transport } from "@/lib/tauri/transport-types"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

type DisposableTransport = Transport & { destroy?: () => void }

export interface RemoteHostTarget {
  host: RemoteHost
  transport: Transport
  close: () => void
}

export interface RemoteHostTargetDeps {
  loadCredential?: (hostId: string) => Promise<RemoteHostCredential | null>
  createTransport?: (configProvider: () => CompanionConfig) => DisposableTransport
}

/**
 * Open an isolated transport to a configured Host without changing the app's
 * active routing target. Placement probes and dispatch must not make the whole
 * desktop start driving whichever candidate is being evaluated.
 */
export async function openRemoteHostTarget(
  stableHostRef: string,
  deps: RemoteHostTargetDeps = {}
): Promise<RemoteHostTarget> {
  const host = useRemoteHostStore.getState().hosts.find((candidate) => {
    const manifestRef =
      candidate.featureManifest?.schemaVersion === 2
        ? candidate.featureManifest.hostIdentity.id
        : undefined
    return candidate.id === stableHostRef || manifestRef === stableHostRef
  })
  if (!host) throw new Error(`Remote Host ${stableHostRef} is not configured`)

  const credential =
    host.config.devicePrivateKeyJwk !== undefined
      ? {
          devicePrivateKeyJwk: host.config.devicePrivateKeyJwk,
          ...(host.config.signalingPrivateKeyJwk
            ? { signalingPrivateKeyJwk: host.config.signalingPrivateKeyJwk }
            : {}),
        }
      : await (deps.loadCredential ?? loadRemoteHostCredential)(host.id)
  if (!credential?.devicePrivateKeyJwk) {
    throw new Error(`Remote Host ${host.label} credential is unavailable; pair it again`)
  }

  const config: CompanionConfig = {
    ...host.config,
    devicePrivateKeyJwk: credential.devicePrivateKeyJwk,
    signalingPrivateKeyJwk: credential.signalingPrivateKeyJwk,
  }
  const transport = (
    deps.createTransport ??
    ((provider: () => CompanionConfig) => new CompanionTransport({ configProvider: provider }))
  )(() => config)
  return {
    host,
    transport,
    close: () => transport.destroy?.(),
  }
}
