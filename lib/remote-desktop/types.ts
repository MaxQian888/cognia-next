/**
 * Wire types for the Host's remote desktop commands (ADR-0234 Phase 2),
 * mirroring `crates/cognia-remote-desktop`. Credentials are write-only: no
 * type here ever carries one back.
 */

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

export interface RemoteDesktopSessionOpened {
  sessionId: string
  /** Loopback WebSocket URL carrying a one-shot ticket. Never persist it. */
  url: string
  mode: RemoteDesktopSessionMode
  expiresAt: number
  lease?: RemoteDesktopControlLease
}

export interface RemoteDesktopSessionRenewed {
  expiresAt: number
  lease?: RemoteDesktopControlLease
}
