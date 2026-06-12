/**
 * @jest-environment jsdom
 *
 * Coverage for the Drafts tab: empty state, ordering (pending first, then
 * worst quality), accept / reject buttons, and status badge variants.
 */

import "fake-indexeddb/auto"
import React from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("motion/react", () => ({
  motion: {
    li: ({ children, className, ...props }: React.LiHTMLAttributes<HTMLLIElement>) => (
      <li className={className} {...props}>
        {children}
      </li>
    ),
    span: ({ children, className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span className={className} {...props}>
        {children}
      </span>
    ),
  },
  useReducedMotion: () => true,
}))

// `previewUnredact` decrypts on-disk redaction maps — out of scope for these
// DOM tests. Mock only the preview (default: no restorable PII) and keep
// `applyUnredactSelection` real so the restore round-trip is exercised end-to-end.
jest.mock("@/lib/twin/distill/unredact-draft", () => {
  const actual = jest.requireActual("@/lib/twin/distill/unredact-draft")
  return {
    ...actual,
    previewUnredact: jest.fn(async () => ({ redactedJson: "", placeholders: [] })),
  }
})

import { TwinDraftsTab } from "./twin-drafts-tab"
import { previewUnredact } from "@/lib/twin/distill/unredact-draft"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createTwinDraft } from "@/lib/db/twin-drafts"

const mockPreviewUnredact = previewUnredact as jest.MockedFunction<typeof previewUnredact>

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await Promise.all([
    getDb().twinDrafts.clear(),
    getDb().characters.clear(),
    getDb().skills.clear(),
  ])
})

describe("TwinDraftsTab", () => {
  it("renders the empty hint when there are no drafts", async () => {
    render(<TwinDraftsTab twinId="twin_alice" />)
    expect(await screen.findByText(/No drafts yet/i)).toBeInTheDocument()
  })

  it("renders a pending skill draft with status badge + accept / reject", async () => {
    const draft = await createTwinDraft({
      twinId: "twin_alice",
      jobId: "j1",
      kind: "skill",
      payload: {
        kind: "skill",
        data: { name: "Spec writing", description: "writes specs", content: "Steps…" },
      },
      provenance: { chunkIds: ["c1"], rationale: "demo" },
      evaluation: { qualityScore: 0.4, concerns: [], suggestions: [] },
    })
    render(<TwinDraftsTab twinId="twin_alice" />)
    await screen.findByText("Spec writing")
    const statusBadge = screen.getByTestId(`twin-draft-${draft.id}-status`)
    expect(statusBadge.textContent).toMatch(/Pending/i)
    expect(statusBadge.getAttribute("data-variant")).toBe("outline")
    expect(screen.getByRole("button", { name: /accept/i })).toBeEnabled()
    expect(screen.getByRole("button", { name: /reject/i })).toBeEnabled()
  })

  it("sorts pending drafts before completed ones", async () => {
    await createTwinDraft({
      twinId: "twin_alice",
      jobId: "j1",
      kind: "skill",
      payload: {
        kind: "skill",
        data: { name: "Accepted draft", description: "", content: "x" },
      },
      provenance: { chunkIds: [], rationale: "" },
      status: "accepted",
    })
    await createTwinDraft({
      twinId: "twin_alice",
      jobId: "j2",
      kind: "skill",
      payload: {
        kind: "skill",
        data: { name: "Pending draft", description: "", content: "y" },
      },
      provenance: { chunkIds: [], rationale: "" },
    })
    render(<TwinDraftsTab twinId="twin_alice" />)
    await screen.findByText("Pending draft")
    // The pending row's <li> should appear before the accepted row's <li>.
    const allRows = screen.getAllByRole("listitem")
    const pendingIdx = allRows.findIndex((li) => li.textContent?.includes("Pending draft"))
    const acceptedIdx = allRows.findIndex((li) => li.textContent?.includes("Accepted draft"))
    expect(pendingIdx).toBeGreaterThanOrEqual(0)
    expect(acceptedIdx).toBeGreaterThanOrEqual(0)
    expect(pendingIdx).toBeLessThan(acceptedIdx)
  })

  it("accepts directly without the unredact dialog when there is no restorable PII", async () => {
    const draft = await createTwinDraft({
      twinId: "twin_alice",
      jobId: "j4",
      kind: "skill",
      payload: {
        kind: "skill",
        data: { name: "Clean skill", description: "", content: "no pii here" },
      },
      provenance: { chunkIds: [], rationale: "" },
    })
    render(<TwinDraftsTab twinId="twin_alice" />)
    await screen.findByText("Clean skill")
    await userEvent.click(screen.getByRole("button", { name: /accept/i }))
    await waitFor(async () => {
      const updated = await getDb().twinDrafts.get(draft.id)
      expect(updated?.status).toBe("accepted")
    })
    expect(screen.queryByTestId("twin-unredact-dialog")).not.toBeInTheDocument()
    const skills = await getDb().skills.toArray()
    expect(skills).toHaveLength(1)
    expect(skills[0].content).toBe("no pii here")
  })

  it("opens the unredact dialog and restores PII before accepting when the draft has placeholders", async () => {
    mockPreviewUnredact.mockResolvedValueOnce({
      redactedJson: "",
      placeholders: [
        { placeholder: "<EMAIL_001>", original: "alice@example.com", kind: "EMAIL", keep: true },
      ],
    })
    const draft = await createTwinDraft({
      twinId: "twin_alice",
      jobId: "j5",
      kind: "character",
      payload: {
        kind: "character",
        data: {
          name: "Alice twin",
          description: "",
          systemPrompt: "Reach me at <EMAIL_001> for specs.",
        },
      },
      provenance: { chunkIds: [], rationale: "" },
    })
    render(<TwinDraftsTab twinId="twin_alice" />)
    await screen.findByText("Alice twin")
    await userEvent.click(screen.getByRole("button", { name: /accept/i }))

    // Dialog appears with the placeholder row instead of creating the row.
    await screen.findByTestId("twin-unredact-dialog")
    expect(await getDb().characters.toArray()).toHaveLength(0)

    await userEvent.click(screen.getByTestId("twin-unredact-confirm"))

    await waitFor(async () => {
      const updated = await getDb().twinDrafts.get(draft.id)
      expect(updated?.status).toBe("accepted")
    })
    const characters = await getDb().characters.toArray()
    expect(characters).toHaveLength(1)
    expect(characters[0].systemPrompt).toBe("Reach me at alice@example.com for specs.")
    expect(characters[0].systemPrompt).not.toContain("<EMAIL_001>")
  })

  it("falls back to an untitled name and the content body when accepting a nameless skill draft", async () => {
    const draft = await createTwinDraft({
      twinId: "twin_alice",
      jobId: "j6",
      kind: "skill",
      payload: { kind: "skill", data: { content: "do the steps" } },
      provenance: { chunkIds: [], rationale: "" },
    })
    render(<TwinDraftsTab twinId="twin_alice" />)
    await screen.findByText(/Untitled/i)
    await userEvent.click(screen.getByRole("button", { name: /accept/i }))
    await waitFor(async () => {
      const updated = await getDb().twinDrafts.get(draft.id)
      expect(updated?.status).toBe("accepted")
    })
    const skills = await getDb().skills.toArray()
    expect(skills).toHaveLength(1)
    expect(skills[0].content).toBe("do the steps")
    expect(skills[0].name).toMatch(/Untitled/i)
  })

  it("accepts a bodyless character draft, writing an empty system prompt", async () => {
    const draft = await createTwinDraft({
      twinId: "twin_alice",
      jobId: "j6b",
      kind: "character",
      payload: { kind: "character", data: { name: "Bodyless" } },
      provenance: { chunkIds: [], rationale: "" },
    })
    render(<TwinDraftsTab twinId="twin_alice" />)
    await screen.findByText("Bodyless")
    await userEvent.click(screen.getByRole("button", { name: /accept/i }))
    await waitFor(async () => {
      const updated = await getDb().twinDrafts.get(draft.id)
      expect(updated?.status).toBe("accepted")
    })
    const characters = await getDb().characters.toArray()
    expect(characters).toHaveLength(1)
    expect(characters[0].systemPrompt).toBe("")
  })

  it("surfaces an error when accepting fails", async () => {
    mockPreviewUnredact.mockRejectedValueOnce(new Error("decrypt boom"))
    await createTwinDraft({
      twinId: "twin_alice",
      jobId: "j6c",
      kind: "skill",
      payload: { kind: "skill", data: { name: "Boom", content: "x" } },
      provenance: { chunkIds: [], rationale: "" },
    })
    render(<TwinDraftsTab twinId="twin_alice" />)
    await screen.findByText("Boom")
    await userEvent.click(screen.getByRole("button", { name: /accept/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent("decrypt boom")
  })

  it("renders evaluation concerns and suggestions for a scored draft", async () => {
    await createTwinDraft({
      twinId: "twin_alice",
      jobId: "j7",
      kind: "character",
      payload: { kind: "character", data: { name: "Scored", systemPrompt: "x" } },
      provenance: { chunkIds: [], rationale: "needs work" },
      evaluation: {
        qualityScore: 0.8,
        concerns: ["too terse"],
        suggestions: ["add examples"],
      },
    })
    render(<TwinDraftsTab twinId="twin_alice" />)
    expect(await screen.findByText("too terse")).toBeInTheDocument()
    expect(screen.getByText("add examples")).toBeInTheDocument()
  })

  it("edits a draft payload and persists it via the editor dialog", async () => {
    const draft = await createTwinDraft({
      twinId: "twin_alice",
      jobId: "j8",
      kind: "skill",
      payload: { kind: "skill", data: { name: "Before", content: "original body" } },
      provenance: { chunkIds: [], rationale: "" },
    })
    render(<TwinDraftsTab twinId="twin_alice" />)
    await screen.findByText("Before")
    await userEvent.click(screen.getByTestId(`twin-draft-edit-${draft.id}`))
    const nameInput = await screen.findByTestId("twin-draft-editor-name")
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, "After")
    await userEvent.click(screen.getByTestId("twin-draft-editor-save"))
    await waitFor(async () => {
      const updated = await getDb().twinDrafts.get(draft.id)
      expect((updated?.payload.data as Record<string, unknown>).name).toBe("After")
    })
  })

  it("blocks an edit that reintroduces raw PII and leaves the draft unchanged", async () => {
    const draft = await createTwinDraft({
      twinId: "twin_alice",
      jobId: "j9",
      kind: "skill",
      payload: { kind: "skill", data: { name: "Guarded", content: "clean body" } },
      provenance: { chunkIds: [], rationale: "" },
    })
    render(<TwinDraftsTab twinId="twin_alice" />)
    await screen.findByText("Guarded")
    await userEvent.click(screen.getByTestId(`twin-draft-edit-${draft.id}`))
    const bodyInput = await screen.findByTestId("twin-draft-editor-body")
    await userEvent.clear(bodyInput)
    await userEvent.type(bodyInput, "reach me at alice@example.com")
    await userEvent.click(screen.getByTestId("twin-draft-editor-save"))
    // The PII guard throws before persisting — the body stays clean.
    await waitFor(() => {
      expect(screen.getByTestId("twin-draft-editor-dialog")).toBeInTheDocument()
    })
    const after = await getDb().twinDrafts.get(draft.id)
    expect((after?.payload.data as Record<string, unknown>).content).toBe("clean body")
  })

  it("clicking reject flips the draft to rejected", async () => {
    const draft = await createTwinDraft({
      twinId: "twin_alice",
      jobId: "j3",
      kind: "skill",
      payload: {
        kind: "skill",
        data: { name: "Rejectable", description: "", content: "x" },
      },
      provenance: { chunkIds: [], rationale: "" },
    })
    render(<TwinDraftsTab twinId="twin_alice" />)
    await screen.findByText("Rejectable")
    await userEvent.click(screen.getByRole("button", { name: /reject/i }))
    await waitFor(async () => {
      const updated = await getDb().twinDrafts.get(draft.id)
      expect(updated?.status).toBe("rejected")
    })
  })
})
