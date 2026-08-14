import {
  DATACHANNEL_LABEL,
  DEFAULT_SIGNALING_URL,
  REPLAY_CLOCK_SKEW_MS,
  REPLAY_LRU_CAPACITY,
  SIGNALING_BACKOFF_MS,
  SIGNALING_PING_INTERVAL_MS,
} from "./types"

it("exports bounded signaling protocol defaults", () => {
  expect(DATACHANNEL_LABEL).toBe("cognia.signaling")
  expect(DEFAULT_SIGNALING_URL).toMatch(/^wss:\/\//)
  expect(REPLAY_CLOCK_SKEW_MS).toBe(5 * 60 * 1000)
  expect(REPLAY_LRU_CAPACITY).toBe(256)
  expect(SIGNALING_PING_INTERVAL_MS).toBe(20_000)
  expect([...SIGNALING_BACKOFF_MS]).toEqual(
    [...SIGNALING_BACKOFF_MS].sort((left, right) => left - right)
  )
  expect(SIGNALING_BACKOFF_MS.at(-1)).toBeLessThanOrEqual(60_000)
})
