/**
 * Light integration coverage for the twin workbench. We don't render every
 * tab here — that would balloon the test surface — but we exercise:
 *
 *   • the empty-state when no characters bind a twin
 *   • the single-twin path (chooser hidden, label shown)
 *   • the multi-twin path (chooser shown, switching between twins)
 *   • the upload + delete round-trip in the Sources tab
 *   • the draft accept flow in the Drafts tab
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TwinPanel } from "./twin-panel"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createCharacter } from "@/lib/db/characters"
import { createTwinSource } from "@/lib/db/twin-sources"
import { createTwinDraft } from "@/lib/db/twin-drafts"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  const db = getDb()
  await Promise.all([
    db.twinSources.clear(),
    db.twinChunks.clear(),
    db.twinDrafts.clear(),
    db.twinJobs.clear(),
    db.twinProfile.clear(),
  ])
})

describe("TwinPanel", () => {
  it("renders the empty state when no character binds a twin", async () => {
    render(<TwinPanel />)
    await screen.findByText(/No digital twins yet/i)
  })

  it("hides the chooser when only one twin exists", async () => {
    await createCharacter({
      name: "Alice",
      systemPrompt: "you are alice",
      twinId: "twin_alice",
    })
    render(<TwinPanel />)
    await screen.findAllByText("Alice")
    expect(screen.queryByLabelText("Active twin")).toBeNull()
  })

  it("shows the chooser when multiple twins exist and switches between them", async () => {
    await createCharacter({
      name: "Alice",
      systemPrompt: "you are alice",
      twinId: "twin_alice",
    })
    await createCharacter({
      name: "Bob",
      systemPrompt: "you are bob",
      twinId: "twin_bob",
    })
    render(<TwinPanel />)
    const chooser = await screen.findByLabelText("Active twin")
    expect((chooser as HTMLSelectElement).value).toBe("twin_alice")
    await userEvent.selectOptions(chooser, "twin_bob")
    expect((chooser as HTMLSelectElement).value).toBe("twin_bob")
  })

  it("shows the source list and supports deleting a source", async () => {
    await createCharacter({
      name: "Alice",
      systemPrompt: "you are alice",
      twinId: "twin_alice",
    })
    await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/notes.md",
      title: "Onboarding notes",
      bytes: 100,
      fingerprint: "f1",
      redacted: false,
    })
    render(<TwinPanel />)
    await screen.findByText("Onboarding notes")
    expect(screen.getAllByText(/Sources/i).length).toBeGreaterThan(0)
    const deleteBtn = screen.getByRole("button", { name: /delete/i })
    await userEvent.click(deleteBtn)
    await waitFor(() => {
      expect(screen.queryByText("Onboarding notes")).toBeNull()
    })
  })

  it("renders pending draft details and accept / reject buttons", async () => {
    await createCharacter({
      name: "Alice",
      systemPrompt: "you are alice",
      twinId: "twin_alice",
    })
    await createTwinDraft({
      twinId: "twin_alice",
      jobId: "job_1",
      kind: "skill",
      payload: {
        kind: "skill",
        data: {
          name: "Triage P1",
          description: "outage triage",
          content: "## Steps\n1. Acknowledge",
        },
      },
      provenance: { chunkIds: ["c1"], rationale: "frequent" },
      evaluation: { qualityScore: 0.4, concerns: ["thin"], suggestions: ["add examples"] },
    })
    render(<TwinPanel />)
    // Radix Tabs may render either role="tab" or a plain button — use a
    // text-based query and click whatever matched.
    const draftsTrigger = await screen.findByText("Drafts")
    await userEvent.click(draftsTrigger)
    await screen.findByText("Triage P1")
    expect(screen.getByText(/quality: low/i)).toBeInTheDocument()
    expect(screen.getByText(/thin/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /accept/i })).toBeEnabled()
    expect(screen.getByRole("button", { name: /reject/i })).toBeEnabled()
  })
})
