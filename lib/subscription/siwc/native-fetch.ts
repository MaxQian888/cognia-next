import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import {
  createSiwcFetch,
  decodeSiwcReference,
  type SiwcNativeCall,
} from "../../../sidecar/src/providers/siwc-fetch"

export { encodeSiwcReference, decodeSiwcReference } from "../../../sidecar/src/providers/siwc-fetch"

/** Refuses web/headless execution; an SIWC selection never becomes a direct fetch. */
export function createNativeSiwcFetch(baseURL: string | undefined): typeof globalThis.fetch {
  const ref = decodeSiwcReference(baseURL)
  if (!isTauri()) throw new Error("SIWC requires the native Cognia Host")
  const call: SiwcNativeCall = (method, params) => {
    if (!isTauri()) return Promise.reject(new Error("SIWC native Host is unavailable"))
    const commands: Record<string, string> = {
      "siwc.responses.open": "siwc_responses_open",
      "siwc.responses.read": "siwc_responses_read",
      "siwc.responses.cancel": "siwc_responses_cancel",
    }
    const command = commands[method]
    if (!command) return Promise.reject(new Error("Unsupported SIWC native operation"))
    return invoke(command, params)
  }
  return createSiwcFetch(ref, call)
}
