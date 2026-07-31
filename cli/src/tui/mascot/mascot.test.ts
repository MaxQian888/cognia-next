import { MASCOT_STYLES } from "../../config/schema"
import { selectMascotMood, mascotView, MASCOT_MOODS, type MascotMood } from "./mascot"

describe("selectMascotMood", () => {
  it("is idle when nothing is happening", () => {
    expect(
      selectMascotMood({ turnStatus: "idle", hasThinking: false, activityRunning: false })
    ).toBe("idle")
  })

  it("is working while a turn streams", () => {
    expect(
      selectMascotMood({ turnStatus: "streaming", hasThinking: false, activityRunning: false })
    ).toBe("working")
  })

  it("is thinking while a streaming turn is reasoning", () => {
    expect(
      selectMascotMood({ turnStatus: "streaming", hasThinking: true, activityRunning: false })
    ).toBe("thinking")
  })

  it("is stopping while aborting (even mid-thought)", () => {
    expect(
      selectMascotMood({ turnStatus: "aborting", hasThinking: true, activityRunning: false })
    ).toBe("stopping")
  })

  it("is working when a background activity runs but no turn streams", () => {
    expect(
      selectMascotMood({ turnStatus: "idle", hasThinking: false, activityRunning: true })
    ).toBe("working")
  })
})

describe("mascotView", () => {
  it("renders every style × mood with a non-empty creature and a color", () => {
    for (const style of MASCOT_STYLES) {
      for (const mood of MASCOT_MOODS) {
        const view = mascotView(style, mood, 0)
        expect(view.creature.length).toBeGreaterThan(0)
        expect(view.color.length).toBeGreaterThan(0)
        expect(typeof view.animated).toBe("boolean")
      }
    }
  })

  it("animates thinking + working but not idle/stopping", () => {
    const animated: Record<MascotMood, boolean> = {
      idle: false,
      thinking: true,
      working: true,
      stopping: false,
    }
    for (const mood of MASCOT_MOODS) {
      expect(mascotView("clawd", mood, 0).animated).toBe(animated[mood])
    }
  })

  it("cycles the creature frame by tick for animated moods", () => {
    const f0 = mascotView("clawd", "working", 0).creature
    const f1 = mascotView("clawd", "working", 1).creature
    // working has multiple frames, so consecutive ticks differ.
    expect(f0).not.toBe(f1)
  })

  it("rotates the status word by tick while animated", () => {
    const words = new Set<string>()
    for (let t = 0; t < 6; t++) words.add(mascotView("clawd", "thinking", t).word)
    expect(words.size).toBeGreaterThan(1)
  })

  it("is frame-stable for static moods regardless of tick", () => {
    expect(mascotView("clawd", "idle", 0).creature).toBe(mascotView("clawd", "idle", 9).creature)
    expect(mascotView("clawd", "idle", 0).word).toBe(mascotView("clawd", "idle", 9).word)
  })

  it("maps moods to the shared palette", () => {
    expect(mascotView("clawd", "idle", 0).color).toBe("gray")
    expect(mascotView("clawd", "thinking", 0).color).toBe("magenta")
    expect(mascotView("clawd", "working", 0).color).toBe("yellow")
    expect(mascotView("clawd", "stopping", 0).color).toBe("red")
  })

  it("uses a negative-safe modulo (never throws on a wrapped tick)", () => {
    expect(() => mascotView("clawd", "working", -1)).not.toThrow()
    expect(mascotView("clawd", "working", -1).creature.length).toBeGreaterThan(0)
  })
})
