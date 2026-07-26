export type WebDavProviderId =
  "generic" | "nextcloud" | "owncloud" | "nutstore" | "koofr" | "pcloud-us" | "pcloud-eu" | "yandex"

export interface WebDavProviderPreset {
  id: WebDavProviderId
  /** Fixed hosted endpoint. Self-hosted providers intentionally omit it. */
  baseUrl?: string
  baseUrlPlaceholder: string
  docsUrl: string
  credentialKind: "password" | "app-password" | "password-or-app-password"
}

/**
 * Provider contract verified against each provider's official documentation.
 * Labels and usage hints live in i18n; this module owns only protocol metadata.
 */
export const WEBDAV_PROVIDER_PRESETS: readonly WebDavProviderPreset[] = [
  {
    id: "generic",
    baseUrlPlaceholder: "https://dav.example.com",
    docsUrl: "https://www.rfc-editor.org/rfc/rfc4918",
    credentialKind: "password-or-app-password",
  },
  {
    id: "nextcloud",
    baseUrlPlaceholder: "https://cloud.example.com/remote.php/dav/files/USERNAME",
    docsUrl:
      "https://docs.nextcloud.com/server/stable/developer_manual/client_apis/WebDAV/basic.html",
    credentialKind: "password-or-app-password",
  },
  {
    id: "owncloud",
    baseUrlPlaceholder: "https://cloud.example.com/remote.php/dav/files/USERNAME",
    docsUrl: "https://doc.owncloud.com/server/next/classic_ui/files/access_webdav.html",
    credentialKind: "password-or-app-password",
  },
  {
    id: "nutstore",
    baseUrl: "https://dav.jianguoyun.com/dav",
    baseUrlPlaceholder: "https://dav.jianguoyun.com/dav",
    docsUrl: "https://help.jianguoyun.com/?tag=webdav",
    credentialKind: "app-password",
  },
  {
    id: "koofr",
    baseUrl: "https://app.koofr.net/dav/Koofr",
    baseUrlPlaceholder: "https://app.koofr.net/dav/Koofr",
    docsUrl:
      "https://koofr.eu/help/koofr_with_webdav/how-do-i-connect-a-service-to-koofr-through-webdav/",
    credentialKind: "app-password",
  },
  {
    id: "pcloud-us",
    baseUrl: "https://webdav.pcloud.com",
    baseUrlPlaceholder: "https://webdav.pcloud.com",
    docsUrl: "https://help.pcloud.com/article/webdav",
    credentialKind: "password",
  },
  {
    id: "pcloud-eu",
    baseUrl: "https://ewebdav.pcloud.com",
    baseUrlPlaceholder: "https://ewebdav.pcloud.com",
    docsUrl: "https://help.pcloud.com/article/webdav",
    credentialKind: "password",
  },
  {
    id: "yandex",
    baseUrl: "https://webdav.yandex.ru",
    baseUrlPlaceholder: "https://webdav.yandex.ru",
    docsUrl: "https://yandex.com/support/yandex-360/customers/disk/web/en/webdav",
    credentialKind: "app-password",
  },
] as const

const PRESETS_BY_ID = new Map(WEBDAV_PROVIDER_PRESETS.map((preset) => [preset.id, preset]))

export function getWebDavProviderPreset(id: WebDavProviderId): WebDavProviderPreset {
  const preset = PRESETS_BY_ID.get(id)
  if (!preset) throw new Error(`Unknown WebDAV provider: ${id}`)
  return preset
}

export function detectWebDavProvider(baseUrl: string): WebDavProviderId {
  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase()
  const hosted = WEBDAV_PROVIDER_PRESETS.find(
    (preset) => preset.baseUrl?.toLowerCase() === normalized
  )
  return hosted?.id ?? "generic"
}
