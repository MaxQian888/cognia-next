/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { GenerationEnvelope } from "@/lib/skills/recording/generation-envelope"
import type { GeneratedDraft } from "@/lib/skills/recording/state-machine"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import type { RecordedStep } from "@/lib/skills/recording/types"

import { StageGenerate } from "./stage-generate"

const RECORDING = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"

function envelope(patch: Partial<GenerationEnvelope> = {}): GenerationEnvelope {
  return {
    systemPrompt: "SYSTEM PROMPT TEXT",
    userPrompt: "USER PROMPT TEXT",
    redacted: false,
    truncatedSteps: 0,
    describedSteps: 2,
    ...patch,
  }
}

function draft(patch: Partial<GeneratedDraft> = {}): GeneratedDraft {
  return {
    name: "Monthly export",
    description: "Exports invoices.",
    content: "## Steps\n1. Go",
    tags: [],
    category: "custom",
    allowedTools: [],
    ...patch,
  }
}

function store() {
  return useRecorderStore.getState()
}

function step(seq: number): RecordedStep {
  return { seq, tsMs: seq, kind: "click", element: { name: `Button ${seq}` } }
}

/** Reach the generate stage with a captured, reviewed timeline. */
function reachGenerate() {
  store().dispatch({ type: "OPEN", source: "toolbar" })
  store().dispatch({ type: "PREFLIGHT_START" })
  store().dispatch({ type: "PREFLIGHT_OK" })
  store().dispatch({
    type: "NATIVE_STARTED",
    recordingId: RECORDING,
    startedAt: 1,
    scope: { kind: "desktop" },
    limits: { maxDurationMs: 1, maxSteps: 1, maxBundleBytes: 1, maxGlobalBytes: 1 },
  })
  store().setCapturedSteps([step(1)])
  store().dispatch({ type: "STOP_REQUESTED" })
  store().dispatch({ type: "STOPPED", steps: [step(1)], ignoredCount: 0, bundleId: RECORDING })
}

function applyDraft(next = draft(), asCandidate = false) {
  store().dispatch({ type: "GENERATE_REQUESTED" })
  store().dispatch({
    type: "GENERATED",
    draft: next,
    provenance: {
      provider: "p",
      model: "m",
      locale: "en",
      redacted: false,
      generatedAt: 1,
      promptHash: "h",
    },
    asCandidate,
  })
}

async function renderStage(
  props: Partial<React.ComponentProps<typeof StageGenerate>> = {},
  env = envelope()
) {
  const handlers = {
    onGenerate: jest.fn(),
    onRegenerate: jest.fn(),
    onManualTemplate: jest.fn(),
  }
  render(
    <StageGenerate
      buildEnvelope={async () => env}
      hasModel
      unconfirmedVariables={0}
      toolCatalog={["Read", "Bash"]}
      {...handlers}
      {...props}
    />
  )
  // The envelope is fetched in an effect; wait for it rather than asserting
  // against the spinner.
  await screen.findByText(env.systemPrompt)
  return handlers
}

beforeEach(() => {
  useRecorderStore.getState().reset()
  reachGenerate()
})

describe("outbound preview", () => {
  it("renders the exact strings that will be sent", async () => {
    // Not a summary and not a reconstruction — `generate` sends these two.
    await renderStage()
    expect(screen.getByText("SYSTEM PROMPT TEXT")).toBeInTheDocument()
    expect(screen.getByText("USER PROMPT TEXT")).toBeInTheDocument()
  })

  it("says when redaction altered the transcript", async () => {
    await renderStage({}, envelope({ redacted: true }))
    expect(screen.getByText("generate.redacted")).toBeInTheDocument()
  })

  it("stays quiet about redaction when nothing was changed", async () => {
    await renderStage()
    expect(screen.queryByText("generate.redacted")).not.toBeInTheDocument()
  })

  it("says what was left out of an over-long transcript", async () => {
    await renderStage({}, envelope({ truncatedSteps: 12 }))
    expect(screen.getByText(/generate\.truncated.*"count":12/)).toBeInTheDocument()
  })
})

describe("running generation", () => {
  it("generates, and offers the manual path alongside", async () => {
    const { onGenerate, onManualTemplate } = await renderStage()
    await userEvent.click(screen.getByRole("button", { name: /generate\.run$/ }))
    expect(onGenerate).toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "generate.manualFallback" }))
    expect(onManualTemplate).toHaveBeenCalled()
  })

  it("disables generation while it is in flight", async () => {
    store().dispatch({ type: "GENERATE_REQUESTED" })
    await renderStage()
    expect(screen.getByRole("button", { name: /generate\.running/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: "generate.manualFallback" })).toBeDisabled()
  })

  it("offers the manual template — a complete skill, not a stub — with no model", async () => {
    await renderStage({ hasModel: false })
    expect(screen.getByRole("button", { name: /generate\.run$/ })).toBeDisabled()
    expect(screen.getByText(/generate\.noModel/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "generate.manualFallback" })).toBeEnabled()
  })

  it("switches to regenerate once a draft exists", async () => {
    applyDraft()
    const { onRegenerate } = await renderStage()
    expect(screen.queryByRole("button", { name: /generate\.run$/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "generate.regenerate" }))
    expect(onRegenerate).toHaveBeenCalled()
  })

  it("warns that a draft no longer matches the edited timeline", async () => {
    applyDraft()
    store().dispatch({ type: "EDIT_STEPS", edits: { bySeq: { 1: { intent: "x" } }, manual: [] } })
    await renderStage()
    expect(screen.getByText("generate.stale")).toBeInTheDocument()
  })
})

describe("tool confirmation", () => {
  it("shows nothing until there is a draft to intersect", async () => {
    await renderStage()
    expect(screen.queryByText("generate.tools.title")).not.toBeInTheDocument()
  })

  it("keeps the tools that exist and flags the ones that do not", async () => {
    applyDraft(draft({ allowedTools: ["Read", "Teleport"] }))
    await renderStage()
    expect(screen.getByText("Read")).toBeInTheDocument()
    expect(screen.getByText(/generate\.tools\.unknown.*"count":1/)).toBeInTheDocument()
  })

  it("reports everything unknown when the catalog could not be enumerated", async () => {
    // An empty catalog means "we could not enumerate", not "these are fine".
    applyDraft(draft({ allowedTools: ["Read"] }))
    await renderStage({ toolCatalog: [] })
    expect(screen.getByText(/generate\.tools\.unknown.*"count":1/)).toBeInTheDocument()
    expect(screen.queryByText("Read")).not.toBeInTheDocument()
  })

  it("says so when the model claimed no tools at all", async () => {
    applyDraft()
    await renderStage()
    expect(screen.getByText("generate.tools.none")).toBeInTheDocument()
  })

  it("records the user's confirmation and then stops asking", async () => {
    applyDraft(draft({ allowedTools: ["Read"] }))
    await renderStage()
    await userEvent.click(screen.getByRole("button", { name: "generate.tools.confirm" }))
    expect(store().toolsConfirmed).toBe(true)
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "generate.tools.confirm" })
      ).not.toBeInTheDocument()
    )
  })
})

describe("draft editing", () => {
  it("writes name, description and body edits back to the store", async () => {
    applyDraft()
    await renderStage()

    await userEvent.type(screen.getByLabelText("draft.name"), "!")
    expect(store().draft?.name).toBe("Monthly export!")

    await userEvent.type(screen.getByLabelText("draft.descriptionField"), "!")
    expect(store().draft?.description).toBe("Exports invoices.!")

    await userEvent.type(screen.getByLabelText("draft.content"), "!")
    expect(store().draft?.content).toBe("## Steps\n1. Go!")
  })

  it("marks the draft hand-edited, which is what regeneration must not clobber", async () => {
    applyDraft()
    await renderStage()
    await userEvent.type(screen.getByLabelText("draft.name"), "!")
    expect(store().manualEdits).toBe(true)
  })

  it("shows no editor before a draft exists", async () => {
    await renderStage()
    expect(screen.queryByLabelText("draft.content")).not.toBeInTheDocument()
  })
})

describe("regeneration candidate", () => {
  it("shows the diff instead of replacing the draft", async () => {
    applyDraft()
    applyDraft(draft({ content: "## Steps\n1. Go somewhere else" }), true)
    await renderStage()

    expect(store().draft?.content).toBe("## Steps\n1. Go")
    expect(screen.getByRole("heading", { name: "title" })).toBeInTheDocument()
  })

  it("merges the candidate on accept-all", async () => {
    applyDraft()
    applyDraft(draft({ content: "## Steps\n1. Go somewhere else" }), true)
    await renderStage()

    await userEvent.click(screen.getByRole("button", { name: "acceptAll" }))
    expect(store().draft?.content).toContain("somewhere else")
    expect(store().candidateDraft).toBeNull()
  })

  it("discards the candidate and keeps the user's draft", async () => {
    applyDraft()
    applyDraft(draft({ content: "## Steps\n1. Go somewhere else" }), true)
    await renderStage()

    await userEvent.click(
      within(document.querySelector("header") as HTMLElement).getByRole("button", {
        name: "keepMine",
      })
    )
    expect(store().candidateDraft).toBeNull()
    expect(store().draft?.content).toBe("## Steps\n1. Go")
  })
})

describe("unconfirmed variables", () => {
  it("blocks every path out of this screen and says why", async () => {
    // The reducer refuses GENERATE_REQUESTED while a suggestion is unanswered,
    // so an enabled button here would be a button that does nothing.
    await renderStage({ unconfirmedVariables: 2 })

    expect(screen.getByText(/generate\.blockedByVariables:/)).toBeInTheDocument()
    expect(screen.getByText("generate.blockedByVariablesHint")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /generate\.run/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: "generate.manualFallback" })).toBeDisabled()
  })

  it("blocks regeneration too, not only the first pass", async () => {
    applyDraft()
    await renderStage({ unconfirmedVariables: 1 })
    expect(screen.getByRole("button", { name: "generate.regenerate" })).toBeDisabled()
  })

  it("says nothing once every suggestion is answered", async () => {
    await renderStage({ unconfirmedVariables: 0 })
    expect(screen.queryByText(/generate\.blockedByVariables/)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /generate\.run/ })).not.toBeDisabled()
  })
})
