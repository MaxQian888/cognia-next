/**
 * Renderer half of `src-tauri/src/companion_api/mesh.rs`: the shape the
 * `companion_mesh_status` command returns, and the pure choices the settings
 * surface makes over it.
 */

export type MeshProvider = "tailscale" | "zerotier"

export const MESH_PROVIDERS: readonly MeshProvider[] = Object.freeze(["tailscale", "zerotier"])

export interface MeshAddress {
  interface: string
  address: string
}

export interface MeshNetwork {
  provider: MeshProvider
  installed: boolean
  addresses: MeshAddress[]
}

export interface MeshStatus {
  networks: MeshNetwork[]
}

/** What a provider row is, in one word the UI can key copy off. */
export type MeshProviderState = "connected" | "installed" | "absent"

export function meshProviderState(network: MeshNetwork): MeshProviderState {
  if (network.addresses.length > 0) return "connected"
  return network.installed ? "installed" : "absent"
}

/**
 * The address to offer as the Host's advertised host. IPv4 before IPv6, in
 * provider order, the same rule as the Rust `preferred_address`.
 */
export function preferredMeshAddress(
  status: MeshStatus | null | undefined
): { provider: MeshProvider; address: string } | null {
  if (!status) return null
  const pick = (v4: boolean) => {
    for (const network of status.networks) {
      const hit = network.addresses.find((entry) => entry.address.includes(":") !== v4)
      if (hit) return { provider: network.provider, address: hit.address }
    }
    return null
  }
  return pick(true) ?? pick(false)
}

/**
 * Whether a saved advertise host is one of the mesh addresses this machine
 * currently carries. A host that is saved but no longer carried (the daemon
 * is down, the machine left the network) is the state worth a warning: the
 * invitation would name an address nothing answers on.
 */
export function advertisedHostIsCarried(
  status: MeshStatus | null | undefined,
  advertiseHost: string | null | undefined
): boolean {
  const host = advertiseHost?.trim()
  if (!host || !status) return false
  return status.networks.some((network) =>
    network.addresses.some((entry) => entry.address === host)
  )
}
