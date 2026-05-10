"use client"

/**
 * Discover the device's private LAN IPv4 address(es) without a Capacitor
 * plugin, using the WebRTC ICE-candidate trick. Returns an empty list on
 * platforms where `RTCPeerConnection` is unavailable, where the user
 * blocks Local-Network permission (iOS 14+), or where the only candidates
 * are mDNS-anonymised hostnames.
 *
 * Used by `lan-scanner.ts` as the seed for the IP-segment fallback probe;
 * the mDNS path inside Capacitor (`@jonz94/capacitor-mdns`) does not
 * require this and is preferred when available.
 *
 * The implementation is intentionally bare:
 *   1. open an `RTCPeerConnection` with no STUN servers (so candidates
 *      are gathered from local interfaces only — no network round-trip);
 *   2. create a dummy data channel to force the host candidates;
 *   3. setLocalDescription(createOffer()) to start ICE gathering;
 *   4. collect host candidates until end-of-candidates or the timeout fires.
 *
 * Privacy: candidate strings can also expose mDNS-anonymised
 * `<uuid>.local` hostnames in modern browsers; we discard those because
 * they aren't useful as a /24 base.
 */

const PRIVATE_IPV4_PATTERNS: readonly RegExp[] = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/,
]

const IP_FROM_CANDIDATE =
  /(?:typ host )?(?:raddr [^ ]+ rport \d+ )?(?:[^ ]+ )*?(\d{1,3}(?:\.\d{1,3}){3})\b/

export interface GetPrivateLocalIpsOptions {
  /** Hard deadline for the gather phase. Default 1200 ms. */
  timeoutMs?: number
  /** Caller cancellation. */
  signal?: AbortSignal
  /**
   * Override the `RTCPeerConnection` constructor — only here for tests.
   */
  rtcImpl?: typeof RTCPeerConnection
}

/**
 * Gather a deduplicated list of the device's private IPv4 addresses.
 * Resolves to `[]` (never throws) on unsupported runtimes or aborts.
 */
export function getPrivateLocalIps(opts: GetPrivateLocalIpsOptions = {}): Promise<string[]> {
  const { timeoutMs = 1200, signal } = opts
  const RTC = opts.rtcImpl ?? (typeof RTCPeerConnection !== "undefined" ? RTCPeerConnection : null)
  if (!RTC) return Promise.resolve([])
  if (signal?.aborted) return Promise.resolve([])

  return new Promise<string[]>((resolve) => {
    const found = new Set<string>()
    let pc: RTCPeerConnection | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let onAbort: (() => void) | null = null
    let settled = false

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (onAbort && signal) {
        signal.removeEventListener("abort", onAbort)
        onAbort = null
      }
      if (pc) {
        try {
          pc.close()
        } catch {
          // Best-effort.
        }
        pc = null
      }
    }

    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Array.from(found))
    }

    try {
      pc = new RTC({ iceServers: [] })
    } catch {
      finish()
      return
    }

    try {
      pc.createDataChannel("cognia-lan-probe")
    } catch {
      // Some constrained webviews refuse data channels; we can still
      // sometimes get host candidates from the offer alone.
    }

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      const candidate = event.candidate
      if (!candidate || !candidate.candidate) {
        finish()
        return
      }
      const ip = extractPrivateIpv4(candidate.candidate)
      if (ip) found.add(ip)
    }

    pc.onicegatheringstatechange = () => {
      if (pc?.iceGatheringState === "complete") finish()
    }

    timer = setTimeout(finish, timeoutMs)
    if (signal) {
      onAbort = () => finish()
      signal.addEventListener("abort", onAbort, { once: true })
    }

    void (async () => {
      try {
        const offer = await pc!.createOffer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: false,
        })
        if (settled) return
        await pc!.setLocalDescription(offer)
      } catch {
        finish()
      }
    })()
  })
}

/**
 * Pull the first private-range IPv4 out of an ICE-candidate string. Returns
 * null when the candidate is mDNS-anonymised (`<uuid>.local`), IPv6, or
 * outside the RFC 1918 private space.
 */
export function extractPrivateIpv4(candidate: string): string | null {
  const match = candidate.match(IP_FROM_CANDIDATE)
  if (!match) return null
  const ip = match[1]
  if (!isPrivateIpv4(ip)) return null
  return ip
}

export function isPrivateIpv4(ip: string): boolean {
  return PRIVATE_IPV4_PATTERNS.some((rx) => rx.test(ip))
}

/**
 * Expand a private IPv4 like `192.168.1.55` into its `/24` bucket
 * `[192.168.1.1, …, 192.168.1.254]`, skipping the source IP itself.
 */
export function enumerateSlash24(ip: string): string[] {
  const parts = ip.split(".")
  if (parts.length !== 4) return []
  const [a, b, c] = parts
  const self = Number(parts[3])
  const out: string[] = []
  for (let i = 1; i <= 254; i++) {
    if (i === self) continue
    out.push(`${a}.${b}.${c}.${i}`)
  }
  return out
}
