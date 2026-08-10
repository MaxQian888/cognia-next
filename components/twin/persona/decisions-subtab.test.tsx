/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import React from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
  AlertDialogCancel: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
}))

import { DecisionsSubtab } from "./decisions-subtab"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { addDecision, getTwinProfile } from "@/lib/db/twin-profile"
import type { DecisionRecord } from "@/types/twin"

const TWIN_ID = "twin-decisions"
const decision: DecisionRecord = {
  id: "d1",
  context: "Choose a queue",
  choice: "Kafka",
  rationale: "Durability",
  sourceChunkIds: [],
  timestamp: 1,
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

it("adds a pinned manual decision", async () => {
  render(<DecisionsSubtab twinId={TWIN_ID} decisions={[]} />)
  await userEvent.click(screen.getByTestId("decisions-add"))
  const dialog = screen.getByTestId("decision-editor-dialog")
  await userEvent.type(within(dialog).getByTestId("decision-context"), "Choose a queue")
  await userEvent.type(within(dialog).getByTestId("decision-choice"), "Kafka")
  await userEvent.type(within(dialog).getByTestId("decision-rationale"), "Durability")
  await userEvent.click(within(dialog).getByTestId("decision-save"))
  await waitFor(async () => {
    expect(await getTwinProfile(TWIN_ID)).toMatchObject({
      decisions: [expect.objectContaining({ choice: "Kafka", pinned: true })],
    })
  })
})

it("blocks a manual decision containing PII", async () => {
  render(<DecisionsSubtab twinId={TWIN_ID} decisions={[]} />)
  await userEvent.click(screen.getByTestId("decisions-add"))
  const dialog = screen.getByTestId("decision-editor-dialog")
  await userEvent.type(within(dialog).getByTestId("decision-context"), "Email Alice")
  await userEvent.type(within(dialog).getByTestId("decision-choice"), "alice@example.com")
  await userEvent.click(within(dialog).getByTestId("decision-save"))
  expect(await within(dialog).findByRole("alert")).toBeInTheDocument()
  expect((await getTwinProfile(TWIN_ID))?.decisions ?? []).toEqual([])
})

it("pins and deletes an existing decision", async () => {
  await addDecision(TWIN_ID, decision)
  const { rerender } = render(<DecisionsSubtab twinId={TWIN_ID} decisions={[decision]} />)
  await userEvent.click(screen.getByTestId("decision-pin-d1"))
  await waitFor(async () => {
    expect((await getTwinProfile(TWIN_ID))?.decisions[0].pinned).toBe(true)
  })
  rerender(<DecisionsSubtab twinId={TWIN_ID} decisions={[{ ...decision, pinned: true }]} />)
  await userEvent.click(screen.getByTestId("decision-delete-d1"))
  await userEvent.click(screen.getByTestId("decision-delete-confirm"))
  await waitFor(async () => {
    expect((await getTwinProfile(TWIN_ID))?.decisions).toEqual([])
  })
})
