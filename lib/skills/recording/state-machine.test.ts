import {
  canGenerate,
  hasLiveCapture,
  INITIAL_SNAPSHOT,
  interruptIsRetriable,
  recoveryPhaseFor,
  reduceRecorder,
  sheetDismissKeepsSession,
  stageForPhase,
  STAGES,
  unconfirmedVariableCount,
  type GeneratedDraft,
  type RecorderEvent,
  type RecorderPhase,
  type RecorderSnapshot,
} from "./state-machine"
import type { InterruptReason } from "./types"

const ALL_PHASES: RecorderPhase[] = [
  "idle",
  "setup",
  "preflight",
  "recording",
  "paused",
  "stopping",
  "review",
  "generating",
  "draft",
  "saving",
  "saved",
  "interrupted",
]

function at(phase: RecorderPhase, patch: Partial<RecorderSnapshot> = {}): RecorderSnapshot {
  return { ...INITIAL_SNAPSHOT, phase, ...patch }
}

const DRAFT: GeneratedDraft = {
  name: "Recorded skill",
  description: "d",
  content: "## Steps\n1. do it",
  tags: [],
  category: "custom",
  allowedTools: [],
}

const started: RecorderEvent = {
  type: "NATIVE_STARTED",
  recordingId: "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01",
  startedAt: 1,
  scope: { kind: "desktop" },
  limits: {
    maxDurationMs: 1,
    maxSteps: 1,
    maxBundleBytes: 1,
    maxGlobalBytes: 1,
  },
}

describe("reduceRecorder — the happy path", () => {
  it("walks setup → recording → review → draft → saved", () => {
    let state = reduceRecorder(at("idle"), { type: "OPEN", source: "toolbar" })!
    expect(state.phase).toBe("setup")

    state = reduceRecorder(state, { type: "PREFLIGHT_START" })!
    expect(state.phase).toBe("preflight")

    state = reduceRecorder(state, started)!
    expect(state.phase).toBe("recording")
    expect(state.recordingId).toBe(started.recordingId)
    expect(state.bundleId).toBe(started.recordingId)

    state = reduceRecorder(state, { type: "STOP_REQUESTED" })!
    expect(state.phase).toBe("stopping")

    state = reduceRecorder(state, {
      type: "STOPPED",
      steps: [],
      ignoredCount: 3,
      bundleId: started.recordingId,
    })!
    expect(state.phase).toBe("review")
    expect(state.ignoredCount).toBe(3)

    state = reduceRecorder(state, { type: "GENERATE_REQUESTED" })!
    expect(state.phase).toBe("generating")

    state = reduceRecorder(state, {
      type: "GENERATED",
      draft: DRAFT,
      provenance: {
        provider: "anthropic",
        model: "m",
        locale: "en",
        redacted: false,
        generatedAt: 2,
        promptHash: "h",
      },
      asCandidate: false,
    })!
    expect(state.phase).toBe("draft")
    expect(state.draft).toEqual(DRAFT)

    state = reduceRecorder(state, { type: "SAVE_REQUESTED" })!
    expect(state.phase).toBe("saving")

    state = reduceRecorder(state, { type: "SAVED", skillId: "sk_1" })!
    expect(state.phase).toBe("saved")
    expect(state.savedSkillId).toBe("sk_1")
  })

  it("pauses and resumes", () => {
    const recording = at("recording")
    const paused = reduceRecorder(recording, { type: "PAUSE" })!
    expect(paused.phase).toBe("paused")
    expect(reduceRecorder(paused, { type: "RESUME" })!.phase).toBe("recording")
  })
})

describe("reduceRecorder — illegal transitions", () => {
  it("returns null rather than inventing a state", () => {
    expect(reduceRecorder(at("idle"), { type: "PAUSE" })).toBeNull()
    expect(reduceRecorder(at("review"), { type: "STEP", step: {} as never })).toBeNull()
    expect(reduceRecorder(at("setup"), { type: "SAVE_REQUESTED" })).toBeNull()
    expect(reduceRecorder(at("saved"), { type: "PREFLIGHT_OK" })).toBeNull()
    expect(reduceRecorder(at("recording"), { type: "RESUME" })).toBeNull()
  })

  it("refuses to start capture from anywhere but preflight", () => {
    for (const phase of ALL_PHASES.filter((p) => p !== "preflight")) {
      expect(reduceRecorder(at(phase), started)).toBeNull()
    }
  })

  it("refuses to save from anywhere but draft", () => {
    for (const phase of ALL_PHASES.filter((p) => p !== "draft")) {
      expect(reduceRecorder(at(phase), { type: "SAVE_REQUESTED" })).toBeNull()
    }
  })
})

describe("the single-live-session invariant", () => {
  it("treats OPEN from a non-idle phase as a reattach, never a second recording", () => {
    for (const phase of ALL_PHASES.filter((p) => p !== "idle")) {
      const state = at(phase, { recordingId: "existing" })
      const next = reduceRecorder(state, { type: "OPEN", source: "palette" })
      expect(next).toBe(state)
      expect(next?.recordingId).toBe("existing")
      expect(next?.phase).toBe(phase)
    }
  })

  it("starts fresh only from idle", () => {
    const next = reduceRecorder(at("idle", { savedSkillId: "stale" }), {
      type: "OPEN",
      source: "shortcut",
    })!
    expect(next.phase).toBe("setup")
    expect(next.savedSkillId).toBeNull()
  })
})

describe("interrupts", () => {
  it("is legal from every phase except idle", () => {
    for (const phase of ALL_PHASES.filter((p) => p !== "idle")) {
      const next = reduceRecorder(at(phase), {
        type: "INTERRUPT",
        reason: "nativeFailure",
      })!
      expect(next.phase).toBe("interrupted")
      expect(next.interrupt?.from).toBe(phase)
    }
  })

  it("is a no-op from idle — there is nothing to interrupt", () => {
    const idle = at("idle")
    expect(reduceRecorder(idle, { type: "INTERRUPT", reason: "killSwitch" })).toBe(idle)
  })

  it("marks permission loss and the kill switch non-retriable", () => {
    for (const reason of ["permissionLost", "killSwitch"] as InterruptReason[]) {
      expect(interruptIsRetriable(reason)).toBe(false)
      const state = reduceRecorder(at("recording"), { type: "INTERRUPT", reason })!
      expect(state.interrupt?.retriable).toBe(false)
      // RETRY is legal to dispatch but must not move: recovering silently from a
      // kill switch would undo an explicit "stop".
      expect(reduceRecorder(state, { type: "RETRY" })!.phase).toBe("interrupted")
    }
  })

  it("marks the recoverable reasons retriable", () => {
    for (const reason of [
      "limitReached",
      "scopeLost",
      "userInterrupt",
      "appShutdown",
      "nativeFailure",
    ] as InterruptReason[]) {
      expect(interruptIsRetriable(reason)).toBe(true)
    }
  })
})

describe("recoveryPhaseFor", () => {
  it("sends an interrupted recording with steps to review", () => {
    for (const from of ["recording", "paused", "stopping"] as RecorderPhase[]) {
      expect(recoveryPhaseFor(from, true)).toBe("review")
    }
  })

  it("sends an interrupted recording with no steps back to setup", () => {
    for (const from of ["recording", "paused", "stopping"] as RecorderPhase[]) {
      expect(recoveryPhaseFor(from, false)).toBe("setup")
    }
  })

  it("returns generation to review and a failed save to the draft", () => {
    expect(recoveryPhaseFor("generating", true)).toBe("review")
    expect(recoveryPhaseFor("saving", true)).toBe("draft")
  })

  it("returns preflight to setup", () => {
    expect(recoveryPhaseFor("preflight", false)).toBe("setup")
  })

  it("drives RETRY", () => {
    const interrupted = reduceRecorder(at("saving", { draft: DRAFT }), {
      type: "INTERRUPT",
      reason: "nativeFailure",
    })!
    const retried = reduceRecorder(interrupted, { type: "RETRY" })!
    expect(retried.phase).toBe("draft")
    expect(retried.interrupt).toBeNull()
    expect(retried.draft).toEqual(DRAFT)
  })
})

describe("draft staleness", () => {
  it("marks the draft stale when the timeline changes", () => {
    const withDraft = at("draft", { draft: DRAFT })
    const edited = reduceRecorder(withDraft, {
      type: "EDIT_STEPS",
      edits: { bySeq: {}, manual: [] },
    })!
    expect(edited.draftStale).toBe(true)
    expect(edited.draft).toEqual(DRAFT)
  })

  it("does not mark stale when there is no draft yet", () => {
    const edited = reduceRecorder(at("review"), {
      type: "EDIT_STEPS",
      edits: { bySeq: {}, manual: [] },
    })!
    expect(edited.draftStale).toBe(false)
  })

  it("marks stale when variables change", () => {
    const next = reduceRecorder(at("draft", { draft: DRAFT }), {
      type: "SET_VARIABLES",
      variables: [],
    })!
    expect(next.draftStale).toBe(true)
  })
})

describe("regeneration", () => {
  const provenance = {
    provider: "anthropic",
    model: "m",
    locale: "en",
    redacted: false,
    generatedAt: 1,
    promptHash: "h",
  }

  it("parks a regeneration as a candidate instead of overwriting", () => {
    const edited: GeneratedDraft = { ...DRAFT, content: "hand written" }
    const state = at("generating", { draft: edited, manualEdits: true })
    const next = reduceRecorder(state, {
      type: "GENERATED",
      draft: { ...DRAFT, content: "fresh" },
      provenance,
      asCandidate: true,
    })!
    expect(next.draft?.content).toBe("hand written")
    expect(next.candidateDraft?.content).toBe("fresh")
    expect(next.manualEdits).toBe(true)
  })

  it("clears staleness and manual edits on a first generation", () => {
    const next = reduceRecorder(at("generating", { draftStale: true, manualEdits: true }), {
      type: "GENERATED",
      draft: DRAFT,
      provenance,
      asCandidate: false,
    })!
    expect(next.draftStale).toBe(false)
    expect(next.manualEdits).toBe(false)
    expect(next.generation).toEqual(provenance)
  })

  it("adopts a merged candidate and clears it", () => {
    const state = at("draft", { draft: DRAFT, candidateDraft: DRAFT, draftStale: true })
    const merged = reduceRecorder(state, {
      type: "MERGE_CANDIDATE",
      draft: { ...DRAFT, content: "merged" },
    })!
    expect(merged.draft?.content).toBe("merged")
    expect(merged.candidateDraft).toBeNull()
    expect(merged.draftStale).toBe(false)
  })

  it("discards a candidate without touching the draft", () => {
    const state = at("draft", { draft: DRAFT, candidateDraft: { ...DRAFT, content: "x" } })
    const next = reduceRecorder(state, { type: "DISCARD_CANDIDATE" })!
    expect(next.candidateDraft).toBeNull()
    expect(next.draft).toEqual(DRAFT)
  })

  it("returns a failed generation to review with the timeline intact", () => {
    const next = reduceRecorder(at("generating"), {
      type: "GENERATE_FAILED",
      error: { code: "modelUnavailable", retriable: true },
    })!
    expect(next.phase).toBe("review")
    expect(next.error?.code).toBe("modelUnavailable")
  })
})

describe("save failures", () => {
  it("returns to the draft with everything the user wrote", () => {
    const state = at("saving", { draft: DRAFT, manualEdits: true })
    const next = reduceRecorder(state, {
      type: "SAVE_FAILED",
      error: { code: "transactionRolledBack", retriable: true },
    })!
    expect(next.phase).toBe("draft")
    expect(next.draft).toEqual(DRAFT)
    expect(next.manualEdits).toBe(true)
    expect(next.savedSkillId).toBeNull()
  })
})

describe("the controlled trial", () => {
  it("records the trial session and requires an explicit confirmation", () => {
    const saved = at("saved", { savedSkillId: "sk_1" })
    const started = reduceRecorder(saved, { type: "TRIAL_STARTED", sessionId: "s1" })!
    expect(started.trialSessionId).toBe("s1")
    expect(started.trialConfirmed).toBe(false)
    expect(reduceRecorder(started, { type: "TRIAL_CONFIRMED" })!.trialConfirmed).toBe(true)
  })
})

describe("close and reattach", () => {
  it("CLOSE resets to the initial snapshot", () => {
    expect(reduceRecorder(at("draft", { draft: DRAFT }), { type: "CLOSE" })).toEqual(
      INITIAL_SNAPSHOT
    )
  })

  it("REATTACH adopts a snapshot wholesale from any phase", () => {
    const restored = at("review", { recordingId: "r1" })
    expect(reduceRecorder(at("idle"), { type: "REATTACH", snapshot: restored })).toEqual(restored)
  })
})

describe("stage mapping", () => {
  it("maps every phase to one of the five stages", () => {
    for (const phase of ALL_PHASES) {
      expect(STAGES).toContain(stageForPhase(phase))
    }
  })

  it("groups capture phases under the recording stage", () => {
    expect(stageForPhase("recording")).toBe("recording")
    expect(stageForPhase("paused")).toBe("recording")
    expect(stageForPhase("stopping")).toBe("recording")
  })

  it("shows an interrupt over the review stage", () => {
    expect(stageForPhase("interrupted")).toBe("review")
  })
})

describe("live-capture predicates", () => {
  it("identifies the phases where a native session exists", () => {
    expect(hasLiveCapture("recording")).toBe(true)
    expect(hasLiveCapture("paused")).toBe(true)
    expect(hasLiveCapture("stopping")).toBe(true)
    expect(hasLiveCapture("review")).toBe(false)
    expect(hasLiveCapture("idle")).toBe(false)
  })

  it("keeps the session alive when the Sheet is dismissed mid-capture", () => {
    // Closing the Sheet must not stop a recording — the floating controller is
    // the surface while it runs.
    expect(sheetDismissKeepsSession("recording")).toBe(true)
    expect(sheetDismissKeepsSession("review")).toBe(false)
  })
})

describe("usage and step events", () => {
  it("records limit usage without changing phase", () => {
    const usage = [{ kind: "steps" as const, used: 8, limit: 10 }]
    const next = reduceRecorder(at("recording"), { type: "USAGE", usage })!
    expect(next.usage).toEqual(usage)
    expect(next.phase).toBe("recording")
  })

  it("leaves STEP and UNDONE to the controller — the reducer holds no step list", () => {
    const state = at("recording")
    expect(reduceRecorder(state, { type: "STEP", step: {} as never })).toBe(state)
    expect(reduceRecorder(state, { type: "UNDONE", seq: 1 })).toBe(state)
  })
})

describe("the variable-confirmation gate", () => {
  const suggestion = (seq: number, confirmed: boolean) => ({
    seq,
    name: `input_${seq}`,
    kind: "variable" as const,
    sample: "acme corp",
    confirmed,
  })

  it("counts only the suggestions still awaiting an answer", () => {
    const state = at("review", {
      inputVariables: [suggestion(1, true), suggestion(2, false), suggestion(3, false)],
    })
    expect(unconfirmedVariableCount(state)).toBe(2)
  })

  it("refuses generation while a suggestion is unanswered", () => {
    // Not cosmetic: the envelope falls back to the raw recorded text for an
    // unconfirmed variable, so generating now would ship what the user typed to
    // the model and hard-code it into the skill.
    const state = at("review", { inputVariables: [suggestion(1, false)] })
    expect(reduceRecorder(state, { type: "GENERATE_REQUESTED" })).toBeNull()
    expect(canGenerate(state)).toBe(false)
  })

  it("refuses regeneration from the draft phase on the same grounds", () => {
    const state = at("draft", { draft: DRAFT, inputVariables: [suggestion(1, false)] })
    expect(reduceRecorder(state, { type: "GENERATE_REQUESTED" })).toBeNull()
  })

  it("allows generation once every suggestion is answered", () => {
    const state = at("review", { inputVariables: [suggestion(1, true), suggestion(2, true)] })
    expect(canGenerate(state)).toBe(true)
    expect(reduceRecorder(state, { type: "GENERATE_REQUESTED" })?.phase).toBe("generating")
  })

  it("allows generation when the recording produced no suggestions at all", () => {
    const state = at("review")
    expect(canGenerate(state)).toBe(true)
    expect(reduceRecorder(state, { type: "GENERATE_REQUESTED" })?.phase).toBe("generating")
  })

  it("does not gate any other transition", () => {
    // The gate belongs to generation only — an unanswered suggestion must not
    // block saving a draft the user already has, or stopping a recording.
    const state = at("draft", { draft: DRAFT, inputVariables: [suggestion(1, false)] })
    expect(reduceRecorder(state, { type: "SAVE_REQUESTED" })?.phase).toBe("saving")
    expect(
      reduceRecorder(at("recording", { inputVariables: [suggestion(1, false)] }), {
        type: "STOP_REQUESTED",
      })?.phase
    ).toBe("stopping")
  })

  it("is still phase-gated — an unanswered-free snapshot cannot generate from setup", () => {
    expect(canGenerate(at("setup"))).toBe(false)
  })
})
