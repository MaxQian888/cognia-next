/** Desktop discovery only supplies a port; the shared API client verifies identity. */
import { isTauri, transport } from "@/lib/tauri"
import { discoverMagpieModels, type MagpieCatalog } from "@cognia/provider-core/providers/magpie"

export async function discoverLocalMagpie(signal?: AbortSignal): Promise<MagpieCatalog> {
  const port = isTauri() ? await transport.call<number>("magpie_gateway_port") : 3425
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid Magpie gateway port")
  return discoverMagpieModels({ baseURL: `http://127.0.0.1:${port}/v1`, signal })
}
