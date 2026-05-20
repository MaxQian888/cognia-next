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

import { StyleSamplesSubtab } from "./style-samples-subtab"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { appendStyleSamples, getTwinProfile } from "@/lib/db/twin-profile"
import type { StyleSample } from "@/types/twin"

const TWIN_ID = "twin_style"

function makeStyleSample(id: string, extras: Partial<StyleSample> = {}): StyleSample {
  return {
    id,
    contextLabel: `Sample ${id}`,
    original: "original text body",
    summary: "compressed summary",
    sourceChunkId: "chunk-1",
    tone: [],
    addedAt: Date.now(),
    addedBy: "distill",
    ...extras,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("StyleSamplesSubtab", () => {
  it("renders empty hint when no samples", () => {
    render(<StyleSamplesSubtab twinId={TWIN_ID} styleSamples={[]} />)
    expect(screen.getByText(/No style samples yet/i)).toBeInTheDocument()
  })

  it("adds a new style sample through the editor", async () => {
    render(<StyleSamplesSubtab twinId={TWIN_ID} styleSamples={[]} />)
    await userEvent.click(screen.getByTestId("style-samples-add"))
    const dialog = screen.getByTestId("style-sample-editor-dialog")
    await userEvent.type(within(dialog).getByTestId("style-editor-context"), "PR description")
    await userEvent.type(
      within(dialog).getByTestId("style-editor-original"),
      "We chose Kafka because durability"
    )
    await userEvent.type(within(dialog).getByTestId("style-editor-summary"), "concise rationale")
    await userEvent.type(within(dialog).getByTestId("style-editor-tone"), "concise, decisive")
    await userEvent.click(within(dialog).getByTestId("style-editor-save"))
    await waitFor(async () => {
      const profile = await getTwinProfile(TWIN_ID)
      expect(profile?.styleSamples).toHaveLength(1)
      expect(profile?.styleSamples[0].contextLabel).toBe("PR description")
      expect(profile?.styleSamples[0].tone).toEqual(["concise", "decisive"])
      expect(profile?.styleSamples[0].pinned).toBe(true)
    })
  })

  it("blocks save when the original carries PII", async () => {
    render(<StyleSamplesSubtab twinId={TWIN_ID} styleSamples={[]} />)
    await userEvent.click(screen.getByTestId("style-samples-add"))
    const dialog = screen.getByTestId("style-sample-editor-dialog")
    await userEvent.type(within(dialog).getByTestId("style-editor-context"), "Slack")
    await userEvent.type(
      within(dialog).getByTestId("style-editor-original"),
      "ping me at alice@example.com"
    )
    await userEvent.type(within(dialog).getByTestId("style-editor-summary"), "summary")
    await userEvent.click(within(dialog).getByTestId("style-editor-save"))
    await waitFor(() =>
      expect(within(dialog).getByTestId("style-editor-error")).toBeInTheDocument()
    )
    const profile = await getTwinProfile(TWIN_ID)
    expect(profile?.styleSamples ?? []).toEqual([])
  })

  it("deletes a style sample through the AlertDialog confirm", async () => {
    await appendStyleSamples(TWIN_ID, [makeStyleSample("s1")])
    const profile = await getTwinProfile(TWIN_ID)
    render(<StyleSamplesSubtab twinId={TWIN_ID} styleSamples={profile!.styleSamples} />)
    await userEvent.click(screen.getByTestId("style-sample-delete-s1"))
    await userEvent.click(screen.getByTestId("style-sample-delete-confirm"))
    await waitFor(async () => {
      const next = await getTwinProfile(TWIN_ID)
      expect(next?.styleSamples ?? []).toEqual([])
    })
  })
})
