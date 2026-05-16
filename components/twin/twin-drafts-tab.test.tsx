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

import { TwinDraftsTab } from "./twin-drafts-tab"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createTwinDraft } from "@/lib/db/twin-drafts"

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
