import os from "node:os"

/**
 * What this machine advertises so a host can wake it.
 *
 * A worker that goes to sleep looks exactly like one that was decommissioned:
 * the socket drops, placement rejects it as offline, and nothing ever tries it
 * again. Reporting the machine's own MAC addresses at hello time is what lets
 * the host send a magic packet instead of writing the worker off.
 *
 * Only physical, non-loopback IPv4 interfaces are reported. Virtual interfaces
 * (docker bridges, VPN tunnels, loopback) either have no NIC to wake or are not
 * reachable from the host's broadcast domain, and listing them would just make
 * the host broadcast to addresses that can never respond.
 */

export interface WorkerWakeIdentity {
  macAddresses: string[]
  broadcastAddress?: string
}

const EMPTY_MAC = "00:00:00:00:00:00"

interface NetworkInterfaceLike {
  address: string
  netmask: string
  family: string | number
  mac: string
  internal: boolean
}

/** IPv4 directed broadcast for an address/netmask pair. */
export function directedBroadcast(address: string, netmask: string): string | null {
  const addressOctets = address.split(".").map(Number)
  const maskOctets = netmask.split(".").map(Number)
  if (addressOctets.length !== 4 || maskOctets.length !== 4) return null
  if (
    [...addressOctets, ...maskOctets].some(
      (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255
    )
  ) {
    return null
  }
  return addressOctets.map((octet, index) => octet | (~maskOctets[index]! & 0xff)).join(".")
}

export function resolveWakeIdentity(
  interfaces: Record<string, NetworkInterfaceLike[] | undefined> = os.networkInterfaces() as never
): WorkerWakeIdentity | undefined {
  const macAddresses: string[] = []
  let broadcastAddress: string | undefined
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const isIpv4 = entry.family === "IPv4" || entry.family === 4
      if (!isIpv4 || entry.internal) continue
      const mac = entry.mac?.toLowerCase()
      if (!mac || mac === EMPTY_MAC) continue
      if (!macAddresses.includes(mac)) macAddresses.push(mac)
      broadcastAddress ??= directedBroadcast(entry.address, entry.netmask) ?? undefined
    }
  }
  if (macAddresses.length === 0) return undefined
  return { macAddresses, ...(broadcastAddress ? { broadcastAddress } : {}) }
}
