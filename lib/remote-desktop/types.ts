import type {
  RemoteDesktopAdapter,
  RemoteDesktopConsoleProfile,
  RemoteDesktopLauncher,
  RemoteDesktopSessionMode,
} from "@cognia/plugin-contract/lib/remote-desktop/types"
export type {
  RemoteDesktopAdapter,
  RemoteDesktopConsoleProfile,
  RemoteDesktopLauncher,
  RemoteDesktopSessionMode,
} from "@cognia/plugin-contract/lib/remote-desktop/types"

/**
 * Wire types for the Host's remote desktop commands (ADR-0234 Phases 2 and
 * 3), mirroring `crates/cognia-remote-desktop`. Credentials are write-only: no
 * type here ever carries one back.
 */

/**
 * Which Host a call goes to: this desktop's own (the local owner), or a Host
 * this client manages or is paired to, by the ref
 * `lib/remote-host/management-channel.ts` accepts (a store Host id or
 * `companion:<hostId>`).
 */
export type RemoteDesktopHostRef = { kind: "local" } | { kind: "remote"; hostRef: string }

export const LOCAL_REMOTE_DESKTOP_HOST: RemoteDesktopHostRef = { kind: "local" }

/**
 * How a client reaches the machine (ADR-0234 Phase 5): the Host bridges it
 * (VNC), the client opens the user's own web console, or the client hands an
 * ID to a local app. Only `bridge` has sessions, a lease or credentials; the
 * others are "permissions managed by the provider".
 */
export type RemoteDesktopAccess = "bridge" | "web-console" | "external-app"

export interface RemoteDesktopConsole {
  /** Absent when the caller may only view: opening needs control. */
  url?: string
  profile: RemoteDesktopConsoleProfile
}

/** No password, ever. Only `launcher` reaches a caller that may only view. */
export interface RemoteDesktopAppLaunch {
  launcher: RemoteDesktopLauncher
  peerId?: string
  /** A self-hosted ID server, `host[:port]`. */
  server?: string
  /** That server's public key. Not a secret. */
  key?: string
}

/** `private` is a LAN address; `public` is plaintext over the internet. */
export type RemoteDesktopEndpointClass = "private" | "public"

export type RemoteDesktopCredentialKind = "control" | "view"

export interface RemoteDesktopEndpoint {
  host: string
  port: number
  /** The only address the Host dials. */
  pinnedIp: string
  class: RemoteDesktopEndpointClass
  confirmedAt: number
}

export interface RemoteDesktopBinding {
  id: string
  providerId: string
  /** Absent from a Host older than Phase 5, which only bridges. */
  access?: RemoteDesktopAccess
  adapter: RemoteDesktopAdapter
  priority: number
  enabled: boolean
  /** What the user confirmed reaching; null only for an external app. */
  endpoint: RemoteDesktopEndpoint | null
  console?: RemoteDesktopConsole
  launch?: RemoteDesktopAppLaunch
  /** The server enforces a separate view-only password. */
  viewOnly: boolean
  config: Record<string, unknown> | null
  hasControlCredential: boolean
  hasViewCredential: boolean
}

export interface RemoteDesktopTarget {
  id: string
  name: string
  bindings: RemoteDesktopBinding[]
  createdAt: number
  updatedAt: number
}

export interface RemoteDesktopBindingDraft {
  /** Only ids the Host minted; omit for a new binding. */
  id?: string
  providerId: string
  access?: RemoteDesktopAccess
  adapter: RemoteDesktopAdapter
  priority?: number
  enabled?: boolean
  /** `bridge` only. A web console's endpoint comes from its link. */
  host?: string
  port?: number
  console?: { url: string; profile: RemoteDesktopConsoleProfile }
  launch?: { launcher: RemoteDesktopLauncher; peerId: string; server?: string; key?: string }
  viewOnly?: boolean
  config?: Record<string, unknown> | null
  /** The user acknowledged reaching this endpoint. */
  confirm?: boolean
}

export interface RemoteDesktopTargetDraft {
  id?: string
  name: string
  bindings: RemoteDesktopBindingDraft[]
}

export interface RemoteDesktopTargetPage {
  items: RemoteDesktopTarget[]
  nextPageToken?: string
}

export type RemoteDesktopProbeRequest =
  | {
      kind: "draft"
      host: string
      port: number
      adapter: RemoteDesktopAdapter
      /** Resolution only until true; then the Host connects. */
      confirm?: boolean
    }
  | { kind: "saved"; targetId: string; bindingId: string }

export interface RemoteDesktopRfbProbe {
  protocolVersion: string
  securityTypes: number[]
  /** The Host can authenticate with what it supports (None, VncAuth). */
  supported: boolean
  /** VncAuth is the only supported type on offer. */
  requiresPassword: boolean
}

export interface RemoteDesktopProbeOutcome {
  pinnedIp: string
  class: RemoteDesktopEndpointClass
  connected: boolean
  rfb?: RemoteDesktopRfbProbe
}

export interface RemoteDesktopControlLease {
  token: string
  fence: number
  expiresAt: number
}

/**
 * How the viewer reaches the bridge: the desktop renderer's loopback
 * WebSocket, or the Companion transport a paired device called over.
 */
export type RemoteDesktopSessionTransport = "loopback" | "companion"

export interface RemoteDesktopSessionOpened {
  sessionId: string
  transport: RemoteDesktopSessionTransport
  /** Loopback only: the WebSocket URL carrying a one-shot ticket. Never persist it. */
  url?: string
  mode: RemoteDesktopSessionMode
  expiresAt: number
  lease?: RemoteDesktopControlLease
}

export interface RemoteDesktopSessionRenewed {
  expiresAt: number
  lease?: RemoteDesktopControlLease
}

/** Where a client goes for a binding the Host does not bridge. */
export type RemoteDesktopLaunched =
  | { kind: "web-console"; url: string; profile: RemoteDesktopConsoleProfile }
  | { kind: "external-app"; launcher: RemoteDesktopLauncher; uri: string }
