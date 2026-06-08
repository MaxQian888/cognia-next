import { usePetStore } from "./pet-store"

function reset() {
  usePetStore.setState({
    visualState: "idle",
    oneShotQueue: [],
    bubble: null,
    minimized: false,
    position: null,
    lastGrewStats: [],
    careAlert: null,
  })
}

beforeEach(reset)

describe("usePetStore", () => {
  it("sets the visual state", () => {
    usePetStore.getState().setVisualState("thinking")
    expect(usePetStore.getState().visualState).toBe("thinking")
  })

  it("enqueues and dequeues one-shots FIFO", () => {
    const s = usePetStore.getState()
    s.enqueueOneShot("wave")
    s.enqueueOneShot("happy")
    expect(usePetStore.getState().oneShotQueue).toEqual(["wave", "happy"])
    expect(usePetStore.getState().dequeueOneShot()).toBe("wave")
    expect(usePetStore.getState().dequeueOneShot()).toBe("happy")
    expect(usePetStore.getState().dequeueOneShot()).toBeNull()
  })

  it("clears the one-shot queue", () => {
    usePetStore.getState().enqueueOneShot("fed")
    usePetStore.getState().clearOneShots()
    expect(usePetStore.getState().oneShotQueue).toEqual([])
  })

  it("sets and clears the bubble", () => {
    usePetStore.getState().setBubble({ text: "hi", origin: "template" })
    expect(usePetStore.getState().bubble).toEqual({ text: "hi", origin: "template" })
    usePetStore.getState().setBubble(null)
    expect(usePetStore.getState().bubble).toBeNull()
  })

  it("tracks minimized + position", () => {
    usePetStore.getState().setMinimized(true)
    usePetStore.getState().setPosition({ x: 10, y: 20 })
    expect(usePetStore.getState().minimized).toBe(true)
    expect(usePetStore.getState().position).toEqual({ x: 10, y: 20 })
  })

  it("tracks the last grown stats", () => {
    usePetStore.getState().setLastGrewStats(["debugging", "wisdom"])
    expect(usePetStore.getState().lastGrewStats).toEqual(["debugging", "wisdom"])
  })

  it("sets and clears the care alert signal", () => {
    usePetStore.getState().setCareAlert({ at: 123, petName: "Pip" })
    expect(usePetStore.getState().careAlert).toEqual({ at: 123, petName: "Pip" })
    usePetStore.getState().setCareAlert(null)
    expect(usePetStore.getState().careAlert).toBeNull()
  })
})
