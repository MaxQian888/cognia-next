/**
 * The desktop's "Remote sandboxes" settings (ADR-0221 G7, G10).
 *
 * Two local Tauri commands, `remote_sandboxes_get` and `remote_sandboxes_set`
 * (`crates/cognia-companion/src/remote_sandboxes.rs`). Desktop only: a server
 * names its providers in `COGNIA_SANDBOX_PROVIDERS_FILE`, which no client
 * edits. Credentials go in through `secrets` and never come back — the view
 * lists which ids have a stored value, not the values.
 */

import { transport } from "@/lib/tauri/transport-instance"
import type {
  DesktopRemoteSandboxes,
  RemoteSandboxesUpdate,
  RemoteSandboxesView,
  SandboxProviderConfig,
} from "@/types/sandbox/remote-sandboxes"

export function remoteSandboxesGet(): Promise<RemoteSandboxesView> {
  return transport.call<RemoteSandboxesView>("remote_sandboxes_get")
}

export function remoteSandboxesSet(update: RemoteSandboxesUpdate): Promise<RemoteSandboxesView> {
  return transport.call<RemoteSandboxesView>("remote_sandboxes_set", { update })
}

/** The secret-store id a provider's credential is saved under. */
export function providerSecretId(providerId: string): string {
  return `remote-sandbox:${providerId}`
}

/**
 * A provider's credential id, when it reads one from the secret store.
 * `undefined` for a provider with no credential, or one read from the
 * environment or a file.
 */
export function providerCredentialSecretId(provider: SandboxProviderConfig): string | undefined {
  return provider.credential && "secretId" in provider.credential
    ? provider.credential.secretId
    : undefined
}

/**
 * Remove a provider and everything that only it referenced: the default
 * pointer, and its stored credential (returned as a `null` secret so the save
 * deletes it).
 */
export function withoutProvider(
  settings: DesktopRemoteSandboxes,
  providerId: string
): { settings: DesktopRemoteSandboxes; secrets: Record<string, null> } {
  const removed = settings.providers.providers.find((provider) => provider.id === providerId)
  const providers = settings.providers.providers.filter((provider) => provider.id !== providerId)
  const secretId = removed ? providerCredentialSecretId(removed) : undefined
  const stillReferenced =
    secretId !== undefined &&
    providers.some((provider) => providerCredentialSecretId(provider) === secretId)
  const defaultProviderId =
    settings.providers.defaultProviderId === providerId
      ? undefined
      : settings.providers.defaultProviderId
  return {
    settings: {
      ...settings,
      providers: {
        version: 1,
        providers,
        ...(defaultProviderId ? { defaultProviderId } : {}),
      },
    },
    secrets: secretId && !stillReferenced ? { [secretId]: null } : {},
  }
}

/** The empty settings a desktop starts with. */
export function emptyRemoteSandboxes(): DesktopRemoteSandboxes {
  return { version: 1, providers: { version: 1, providers: [] }, registryAllowlist: [] }
}
