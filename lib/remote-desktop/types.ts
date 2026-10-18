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

/** The Host handshake adapter a binding uses. Closed list (ADR-0234 §4). */
export type RemoteDesktopAdapter = "vnc" | "none"

/** `private` is a LAN address; `public` is plaintext over the internet. */
export type RemoteDesktopEndpointClass = "private" | "public"

export type RemoteDesktopSessionMode = "view" | "control"

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
  adapter: RemoteDesktopAdapter
  priority: number
  enabled: boolean
  endpoint: RemoteDesktopEndpoint
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
  adapter: RemoteDesktopAdapter
  priority?: number
  enabled?: boolean
  host: string
  port: number
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
