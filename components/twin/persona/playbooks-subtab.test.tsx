/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import React from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({
    children,
    onClick,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}))
jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { PlaybooksSubtab } from "./playbooks-subtab"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { appendPlaybooks, getTwinProfile } from "@/lib/db/twin-profile"
import type { Playbook } from "@/types/twin"

const TWIN_ID = "twin_pb"

function makePlaybook(id: string, extras: Partial<Playbook> = {}): Playbook {
  return {
    id,
    title: `Playbook ${id}`,
    trigger: "when X happens",
    steps: [{ order: 1, action: "do thing" }],
    examples: [],
    confidence: 0.6,
    ...extras,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("PlaybooksSubtab", () => {
  it("renders empty hint when no playbooks", () => {
    render(<PlaybooksSubtab twinId={TWIN_ID} playbooks={[]} />)
    expect(screen.getByText(/No playbooks yet/i)).toBeInTheDocument()
  })

  it("sorts pinned first, then by confidence descending", () => {
    render(
      <PlaybooksSubtab
        twinId={TWIN_ID}
        playbooks={[
          makePlaybook("low", { confidence: 0.2, title: "Low confidence" }),
          makePlaybook("high", { confidence: 0.9, title: "High confidence" }),
          makePlaybook("pinned", { confidence: 0.1, title: "Pinned low", pinned: true }),
        ]}
      />
    )
    const rows = screen.getAllByTestId(/^playbook-row-/)
    expect(rows[0]).toHaveAttribute("data-testid", "playbook-row-pinned")
    expect(rows[1]).toHaveAttribute("data-testid", "playbook-row-high")
    expect(rows[2]).toHaveAttribute("data-testid", "playbook-row-low")
  })

  it("adds a new playbook through the editor", async () => {
    render(<PlaybooksSubtab twinId={TWIN_ID} playbooks={[]} />)
    await userEvent.click(screen.getByTestId("playbooks-add"))
    const dialog = screen.getByTestId("playbook-editor-dialog")
    await userEvent.type(within(dialog).getByTestId("playbook-editor-title"), "On-call")
    await userEvent.type(within(dialog).getByTestId("playbook-editor-trigger"), "incident fires")
    await userEvent.type(
      within(dialog).getByTestId("playbook-editor-steps"),
      "ack the page\ncreate a war room"
    )
    await userEvent.click(within(dialog).getByTestId("playbook-editor-save"))
    await waitFor(async () => {
      const profile = await getTwinProfile(TWIN_ID)
      expect(profile?.playbooks).toHaveLength(1)
      expect(profile?.playbooks[0].title).toBe("On-call")
      expect(profile?.playbooks[0].steps).toHaveLength(2)
      expect(profile?.playbooks[0].pinned).toBe(true)
    })
  })

  it("deletes a playbook through the AlertDialog confirm", async () => {
    await appendPlaybooks(TWIN_ID, [makePlaybook("p1")])
    const profile = await getTwinProfile(TWIN_ID)
    render(<PlaybooksSubtab twinId={TWIN_ID} playbooks={profile!.playbooks} />)
    await userEvent.click(screen.getByTestId("playbook-delete-p1"))
    await userEvent.click(screen.getByTestId("playbook-delete-confirm"))
    await waitFor(async () => {
      const next = await getTwinProfile(TWIN_ID)
      expect(next?.playbooks ?? []).toEqual([])
    })
  })
})
