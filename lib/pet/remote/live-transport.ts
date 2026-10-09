// The remote pet console's view of the companion transport (ADR-0219).
//
// The process-wide `transport` is a live binding that pairing (or a host
// switch on the desktop) replaces with `setTransport`. A client bound once
// would keep calling the destroyed instance, and a subscription made once
// would keep listening to it, which is how a status bar once read "Offline"
// forever while the host answered every call. Both helpers here read the
// binding at the moment they are used and re-subscribe on every swap.

import { onTransportChange, transport } from "@/lib/tauri/transport-instance"
import { createPetRemoteClient, type PetRemoteClient } from "./client"

/** A client over whichever transport is installed right now. */
export function livePetRemoteClient(): PetRemoteClient {
  return createPetRemoteClient(transport)
}

export type PetTransportSubscribe = <T>(event: string, handler: (payload: T) => void) => () => void

/** Subscribe to a host event and follow the transport across swaps. */
export const subscribeLivePetTransport: PetTransportSubscribe = (event, handler) => {
  let unsubscribe = transport.subscribe(event, handler)
  const stopFollowing = onTransportChange(() => {
    unsubscribe()
    unsubscribe = transport.subscribe(event, handler)
  })
  return () => {
    stopFollowing()
    unsubscribe()
  }
}
