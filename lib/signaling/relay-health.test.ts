import {
  RELAY_HEALTH_PROTOCOL_VERSION,
  classifyHealthz,
  relayHealthUrl,
  relayProtocolMatches,
} from "./relay-health"
import * as relayProbe from "./relay-probe"
import { SIGNALING_PROTOCOL_VERSION } from "./types"

// The parser's own behaviour is tested beside it in cognia-services; these pin
// the app to it.
describe("relay-health (shared with the status service)", () => {
  it("speaks the same protocol generation as the signaling client", () => {
    expect(RELAY_HEALTH_PROTOCOL_VERSION).toBe(SIGNALING_PROTOCOL_VERSION)
  })

  it("is the same implementation the platform probe re-exports", () => {
    expect(relayProbe.classifyHealthz).toBe(classifyHealthz)
    expect(relayProbe.relayHealthUrl).toBe(relayHealthUrl)
    expect(relayProbe.relayProtocolMatches).toBe(relayProtocolMatches)
  })
})
