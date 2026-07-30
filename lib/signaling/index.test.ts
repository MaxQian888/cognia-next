import {
  DATACHANNEL_LABEL,
  REPLAY_LRU_CAPACITY,
  SignalingClient,
  installCompanionSignalingController,
  installDesktopSignalingController,
} from "./index"
import { SignalingClient as LeafSignalingClient } from "./client"

it("keeps the signaling barrel wired to the supported runtime surface", () => {
  expect(SignalingClient).toBe(LeafSignalingClient)
  expect(typeof installCompanionSignalingController).toBe("function")
  expect(typeof installDesktopSignalingController).toBe("function")
  expect(DATACHANNEL_LABEL).toBe("cognia.v2")
  expect(REPLAY_LRU_CAPACITY).toBe(256)
})
