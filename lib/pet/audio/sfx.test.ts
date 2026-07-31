import { playPetSfx } from "./sfx"

// jsdom has no AudioContext, so these exercise the SSR/no-context no-op path
// and the disabled-settings early return — the player must never throw.
describe("playPetSfx", () => {
  it("is a no-op (no throw) when sound is disabled", () => {
    expect(() =>
      playPetSfx(
        "touch",
        { enabled: false },
        {
          reducedMotion: false,
          nowHour: 12,
          isUserGesture: true,
        }
      )
    ).not.toThrow()
  })

  it("is a no-op (no throw) when enabled but no AudioContext exists", () => {
    expect(() =>
      playPetSfx(
        "reaction",
        { enabled: true, volume: 0.5 },
        {
          reducedMotion: false,
          nowHour: 12,
          isUserGesture: false,
        }
      )
    ).not.toThrow()
  })
})
