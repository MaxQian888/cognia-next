import { isTauri } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"

/** True when workspace filesystem commands can reach a desktop backend. */
export function hasWorkspaceFsBackend(): boolean {
  return isTauri() || loadCompanionConfig() != null
}
