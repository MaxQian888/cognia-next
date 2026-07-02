import {
  deriveMood,
  restingFromNeeds,
  restingWithCare,
  withCareCondition,
  isTransientState,
  reducePetVisualState,
} from "./reducer"
import type { PetEvent, PetEventKind, PetNeeds } from "@/types/pet"

function needs(partial: Partial<PetNeeds> = {}): PetNeeds {
  return { energy: 70, mood: 70, bond: 50, lastTickAt: new Date(0).toISOString(), ...partial }
}

function event(kind: PetEventKind): PetEvent {
  return { source: "system", kind, at: 1 }
}

describe("deriveMood", () => {
  it("classifies by the dominant need", () => {
    expect(deriveMood(needs({ energy: 10 }))).toBe("tired")
    expect(deriveMood(needs({ mood: 10 }))).toBe("grumpy")
    expect(deriveMood(needs({ bond: 0 }))).toBe("lonely")
    expect(deriveMood(needs({ mood: 90, energy: 90 }))).toBe("happy")
    expect(deriveMood(needs())).toBe("content")
  })
})

describe("restingFromNeeds", () => {
  it("sleeps when tired, looks sad when grumpy, else idles", () => {
    expect(restingFromNeeds(needs({ energy: 5 }))).toBe("sleeping")
    expect(restingFromNeeds(needs({ mood: 10 }))).toBe("sad")
    expect(restingFromNeeds(needs())).toBe("idle")
  })
})

describe("isTransientState", () => {
  it("flags celebratory/interaction states as transient", () => {
    expect(isTransientState("happy")).toBe(true)
    expect(isTransientState("greeting")).toBe(true)
    expect(isTransientState("interacting")).toBe(true)
    expect(isTransientState("review")).toBe(true)
    expect(isTransientState("idle")).toBe(false)
    expect(isTransientState("thinking")).toBe(false)
  })
})

describe("reducePetVisualState", () => {
  it("maps radar events directly", () => {
    expect(reducePetVisualState(event("thinking"), needs())).toBe("thinking")
    expect(reducePetVisualState(event("waiting"), needs())).toBe("waiting")
    expect(reducePetVisualState(event("review"), needs())).toBe("review")
    expect(reducePetVisualState(event("error"), needs())).toBe("error")
  })

  it("celebrates success-like milestones", () => {
    for (const k of ["success", "goalComplete", "levelUp", "evolved"] as PetEventKind[]) {
      expect(reducePetVisualState(event(k), needs())).toBe("happy")
    }
  })

  it("greets on hatch/greeting and interacts on direct actions", () => {
    expect(reducePetVisualState(event("hatched"), needs())).toBe("greeting")
    expect(reducePetVisualState(event("greeting"), needs())).toBe("greeting")
    for (const k of [
      "fed",
      "played",
      "petted",
      "talked",
      "slept",
      "cleaned",
      "treated",
    ] as PetEventKind[]) {
      expect(reducePetVisualState(event(k), needs())).toBe("interacting")
    }
  })

  it("treats background work as thinking and idle/passive events as needs-resting", () => {
    expect(reducePetVisualState(event("teamRun"), needs())).toBe("thinking")
    expect(reducePetVisualState(event("workflowRun"), needs())).toBe("thinking")
    expect(reducePetVisualState(event("goalProgress"), needs())).toBe("thinking")
    expect(reducePetVisualState(event("idle"), needs({ energy: 5 }))).toBe("sleeping")
    expect(reducePetVisualState(event("inboundMessage"), needs())).toBe("idle")
    expect(reducePetVisualState(event("scheduledRun"), needs())).toBe("idle")
  })

  it("reflects ambient twin activity: busy reads as thinking, a milestone as happy", () => {
    expect(reducePetVisualState(event("twinBusy"), needs())).toBe("thinking")
    expect(reducePetVisualState(event("twinMilestone"), needs())).toBe("happy")
  })

  it("maps the controller-emitted unwell edge to the unwell state", () => {
    expect(reducePetVisualState(event("unwell"), needs())).toBe("unwell")
  })
})

describe("restingWithCare", () => {
  it("holds the unwell state when the condition is unwell", () => {
    expect(restingWithCare(needs(), "unwell")).toBe("unwell")
  })

  it("falls back to the needs-derived resting state when well", () => {
    expect(restingWithCare(needs({ energy: 5 }), "well")).toBe("sleeping")
    expect(restingWithCare(needs(), "well")).toBe("idle")
  })

  it("does not auto-revert the unwell state", () => {
    expect(isTransientState("unwell")).toBe(false)
  })
})

describe("withCareCondition", () => {
  it("overlays unwell onto needs-derived resting states", () => {
    expect(withCareCondition("idle", "unwell")).toBe("unwell")
    expect(withCareCondition("sleeping", "unwell")).toBe("unwell")
    expect(withCareCondition("sad", "unwell")).toBe("unwell")
    expect(withCareCondition("unwell", "unwell")).toBe("unwell")
  })

  it("leaves expressive event states untouched even when unwell", () => {
    expect(withCareCondition("thinking", "unwell")).toBe("thinking")
    expect(withCareCondition("happy", "unwell")).toBe("happy")
    expect(withCareCondition("interacting", "unwell")).toBe("interacting")
    expect(withCareCondition("greeting", "unwell")).toBe("greeting")
  })

  it("is a no-op when the condition is well", () => {
    expect(withCareCondition("idle", "well")).toBe("idle")
    expect(withCareCondition("sleeping", "well")).toBe("sleeping")
  })
})
