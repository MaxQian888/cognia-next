// Connector inbox → pet events. Every inbound platform message gives the pet a
// little nudge (and a sliver of XP) so it feels aware of incoming activity.

import { getBus } from "@/lib/connectors/bus"
import type { PetEmit } from "../pet-event-bus"

export function wireConnectorSource(emit: PetEmit): () => void {
  return getBus().subscribeInbound(() => {
    emit({ source: "connector", kind: "inboundMessage", xp: 1 })
  })
}
