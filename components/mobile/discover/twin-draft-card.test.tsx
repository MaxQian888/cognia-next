/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TwinDraftCard } from "./twin-draft-card"
import type { TwinDraft } from "@/types/twin"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mkDraft = (p: Partial<TwinDraft> = {}): TwinDraft =>
  ({
    id: "d1",
    twinId: "default",
    jobId: "j1",
    kind: "character",
    payload: { data: { name: "Draft Persona", description: "a summary" } },
    provenance: {},
    status: "pending",
    createdAt: 1_700_000_000_000,
    ...p,
  }) as unknown as TwinDraft

describe("TwinDraftCard", () => {
  it("renders the payload name, kind badge and summary", () => {
    render(<TwinDraftCard draft={mkDraft()} />)
    expect(screen.getByText("Draft Persona")).toBeInTheDocument()
    expect(screen.getByText("kindCharacter")).toBeInTheDocument()
    expect(screen.getByText("a summary")).toBeInTheDocument()
  })

  it("falls back to the untitled / noSummary labels when payload is empty", () => {
    render(<TwinDraftCard draft={mkDraft({ payload: { data: {} } as never })} />)
    expect(screen.getByText("untitled")).toBeInTheDocument()
    expect(screen.getByText("noSummary")).toBeInTheDocument()
  })

  it("marks accepted drafts via the data-accepted attribute", () => {
    render(<TwinDraftCard draft={mkDraft({ status: "accepted" })} />)
    expect(screen.getByTestId("twin-draft-card-d1")).toHaveAttribute("data-accepted", "true")
    expect(screen.getByText("statusAccepted")).toBeInTheDocument()
  })

  it("uses the skill kind label for skill drafts", () => {
    render(<TwinDraftCard draft={mkDraft({ kind: "skill" })} />)
    expect(screen.getByText("kindSkill")).toBeInTheDocument()
  })

  it("invokes onSelect with the draft when clicked", async () => {
    const onSelect = jest.fn()
    const user = userEvent.setup()
    const draft = mkDraft()
    render(<TwinDraftCard draft={draft} onSelect={onSelect} />)
    await user.click(screen.getByTestId("twin-draft-card-d1"))
    expect(onSelect).toHaveBeenCalledWith(draft)
  })
})
