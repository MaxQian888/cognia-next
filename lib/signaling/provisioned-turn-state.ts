"use client"

/**
 * Latest short-lived TURN credentials minted by the host provisioner.
 *
 * The provider configuration and its long-lived secret remain host-only.
 * Desktop sync reads this snapshot and mirrors only the resulting ephemeral
 * ICE servers to paired clients.
 */
export interface ProvisionedTurnSnapshot {
  servers: RTCIceServer[]
  updatedAt: number
}

let snapshot: ProvisionedTurnSnapshot = { servers: [], updatedAt: 0 }

function cloneServers(servers: readonly RTCIceServer[]): RTCIceServer[] {
  return servers.map((server) => ({
    ...server,
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
  }))
}

export function publishProvisionedTurnServers(
  servers: readonly RTCIceServer[],
  now = Date.now()
): void {
  snapshot = {
    servers: cloneServers(servers),
    updatedAt: Math.max(snapshot.updatedAt + 1, now),
  }
}

export function getProvisionedTurnSnapshot(): ProvisionedTurnSnapshot {
  return {
    servers: cloneServers(snapshot.servers),
    updatedAt: snapshot.updatedAt,
  }
}

export function resetProvisionedTurnServersForTests(): void {
  snapshot = { servers: [], updatedAt: 0 }
}
