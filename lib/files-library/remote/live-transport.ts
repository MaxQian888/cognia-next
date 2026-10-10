// The Files client's view of the companion transport (ADR-0223 §9).
//
// The process-wide `transport` is a live binding that pairing replaces with
// `setTransport`; a client bound to the instance once would keep calling the
// destroyed one (remote pet care hit exactly that, `lib/pet/remote/
// live-transport.ts`). This forwards every call to whichever transport is
// installed at the moment of the call.

import { transport } from "@/lib/tauri/transport-instance"
import type { Transport } from "@/lib/tauri/transport-types"
import { createFilesRemoteClient, FilesRemoteError, type FilesRemoteClient } from "./client"

export const liveFilesTransport: Pick<Transport, "call" | "readBinary"> = {
  call: (name, args, options) => transport.call(name, args, options),
  readBinary: (resource) => {
    if (!transport.readBinary) {
      return Promise.reject(new FilesRemoteError("files_remote_media_unavailable"))
    }
    return transport.readBinary(resource)
  },
}

/** A client over whichever transport is installed when each call is made. */
export function liveFilesRemoteClient(): FilesRemoteClient {
  return createFilesRemoteClient(liveFilesTransport)
}
