export type LocalCloudProviderId = "google-drive" | "dropbox" | "onedrive" | "icloud-drive"

export interface LocalCloudProvider {
  id: LocalCloudProviderId
  docsUrl: string
}

/**
 * These providers expose a desktop-synced folder rather than a WebDAV API.
 * Cognia writes its encrypted files locally; the provider's supported desktop
 * client owns upload, retry, conflict handling, and account authentication.
 */
export const LOCAL_CLOUD_PROVIDERS: readonly LocalCloudProvider[] = [
  {
    id: "google-drive",
    docsUrl: "https://support.google.com/drive/answer/13401938?hl=en",
  },
  {
    id: "dropbox",
    docsUrl: "https://help.dropbox.com/installs/download-dropbox",
  },
  {
    id: "onedrive",
    docsUrl:
      "https://support.microsoft.com/en-us/onedrive/sync-your-computer-s-files-and-folders-with-onedrive",
  },
  {
    id: "icloud-drive",
    docsUrl: "https://support.apple.com/en-us/102314",
  },
] as const

const PROVIDERS_BY_ID = new Map(LOCAL_CLOUD_PROVIDERS.map((provider) => [provider.id, provider]))

export function getLocalCloudProvider(id: LocalCloudProviderId): LocalCloudProvider {
  const provider = PROVIDERS_BY_ID.get(id)
  if (!provider) throw new Error(`Unknown local cloud provider: ${id}`)
  return provider
}
