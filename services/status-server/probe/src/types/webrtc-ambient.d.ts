/**
 * `lib/signaling/relay-health.ts` (the shared pure health parser) imports its
 * protocol constant from `lib/signaling/types.ts`, whose other declarations
 * mention two WebRTC dictionary types from the DOM lib. The probe compiles
 * without the DOM lib on purpose (so DOM-only APIs cannot creep into the
 * portable core), so declare just the shapes those type positions need. They
 * are type-only: nothing in the bundle references them at runtime.
 */

interface RTCIceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

interface RTCIceCandidateInit {
  candidate?: string
  sdpMLineIndex?: number | null
  sdpMid?: string | null
  usernameFragment?: string | null
}
