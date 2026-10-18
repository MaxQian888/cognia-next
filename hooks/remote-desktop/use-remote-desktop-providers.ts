import { useSyncExternalStore } from "react"

import {
  listRemoteDesktopProviders,
  subscribeRemoteDesktopProviders,
  type RemoteDesktopProviderRegistration,
} from "@/lib/remote-desktop/provider-registry"

/** Live list of registered remote desktop providers (ADR-0234 §3). */
export function useRemoteDesktopProviders(): readonly RemoteDesktopProviderRegistration[] {
  return useSyncExternalStore(
    subscribeRemoteDesktopProviders,
    listRemoteDesktopProviders,
    listRemoteDesktopProviders
  )
}
