/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))
jest.mock("@/components/ui/select")
jest.mock("@/components/ui/switch")
jest.mock("@/components/ui/dialog")

const mockToastSuccess = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => mockToastSuccess(...a) } }))

const mockCreate = jest.fn()
jest.mock("@/lib/issues/wakeups/service", () => {
  class IssueWakeupWriteError extends Error {
    constructor(
      readonly reason: string,
      message: string
    ) {
      super(message)
    }
  }
  return {
    IssueWakeupWriteError,
    createIssueWakeup: (...args: unknown[]) => mockCreate(...args),
  }
})

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { IssueWakeupWriteError } from "@/lib/issues/wakeups/service"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import {
  INITIAL_WAKEUP_FORM,
  WakeupCreateDialog,
  describeWakeupWriteError,
  wakeupSpecFromForm,
  wakeupTriggerFromForm,
} from "./wakeup-create-dialog"

const form = (over: Partial<typeof INITIAL_WAKEUP_FORM>) => ({ ...INITIAL_WAKEUP_FORM, ...over })

describe("wakeupTriggerFromForm", () => {
  it("maps each preset onto a trigger spec", () => {
    expect(wakeupTriggerFromForm(form({ preset: "comment" }))).toEqual({
      on: "event",
      kinds: ["commented"],
      actorKinds: ["human"],
    })
    expect(wakeupTriggerFromForm(form({ preset: "comment", peopleOnly: false }))).toEqual({
      on: "event",
      kinds: ["commented"],
    })
    expect(wakeupTriggerFromForm(form({ preset: "status", toStatus: "done" }))).toEqual({
      on: "event",
      kinds: ["status_changed"],
      toStatuses: ["done"],
    })
    expect(wakeupTriggerFromForm(form({ preset: "children-done" }))).toEqual({
      on: "children-done",
    })
    expect(wakeupTriggerFromForm(form({ preset: "children-done", stage: " 2 " }))).toEqual({
      on: "children-done",
      stage: 2,
    })
    expect(wakeupTriggerFromForm(form({ preset: "pr-merged" }))).toEqual({ on: "pr-merged" })
    expect(wakeupTriggerFromForm(form({ preset: "pr-checks" }))).toEqual({ on: "pr-checks" })
    expect(wakeupTriggerFromForm(form({ preset: "pr-checks", checkResult: "failing" }))).toEqual({
      on: "pr-checks",
      result: "failing",
    })
    expect(wakeupTriggerFromForm(form({ preset: "issue-finished", targetIssueId: "i2" }))).toEqual({
      on: "issue-finished",
      targetIssueId: "i2",
    })
    expect(wakeupTriggerFromForm(form({ preset: "daily", dailyAt: "07:05" }))).toMatchObject({
      on: "cron",
      cronExpression: "5 7 * * *",
    })
    expect(wakeupTriggerFromForm(form({ preset: "interval", intervalHours: 3 }))).toEqual({
      on: "interval",
      intervalMs: 3 * 3_600_000,
    })
    expect(wakeupTriggerFromForm(form({ preset: "at", at: "2030-01-01T09:00" }))).toMatchObject({
      on: "at",
    })
  })

  it("answers null for an incomplete form", () => {
    expect(wakeupTriggerFromForm(form({ preset: "issue-finished" }))).toBeNull()
    expect(wakeupTriggerFromForm(form({ preset: "daily", dailyAt: "25:00" }))).toBeNull()
    expect(wakeupTriggerFromForm(form({ preset: "interval", intervalHours: 0 }))).toBeNull()
    expect(wakeupTriggerFromForm(form({ preset: "at", at: "" }))).toBeNull()
    expect(wakeupTriggerFromForm(form({ preset: "children-done", stage: "0" }))).toBeNull()
    expect(wakeupTriggerFromForm(form({ preset: "children-done", stage: "1.5" }))).toBeNull()
  })
})

describe("wakeupSpecFromForm", () => {
  it("needs an instruction and a budget in range, and offers once only where it means something", () => {
    expect(wakeupSpecFromForm("i1", form({ instruction: "  " }))).toBeNull()
    expect(wakeupSpecFromForm("i1", form({ instruction: "x", maxFires: 0 }))).toBeNull()
    expect(wakeupSpecFromForm("i1", form({ instruction: " Look ", once: true }))).toEqual({
      issueId: "i1",
      instruction: "Look",
      trigger: { on: "event", kinds: ["commented"], actorKinds: ["human"] },
      maxFires: 20,
      once: true,
      author: { kind: "human" },
    })
    expect(
      wakeupSpecFromForm("i1", form({ preset: "children-done", instruction: "x", once: true }))
    ).not.toHaveProperty("once")
  })

  it("turns a deadline preset into an instant from now, and says whether to wake at it", () => {
    const now = Date.UTC(2030, 0, 1)
    expect(
      wakeupSpecFromForm("i1", form({ instruction: "x", expiresInHours: "24" }), now)
    ).toMatchObject({ expiresAt: new Date(now + 24 * 3_600_000), onTimeout: "drop" })
    expect(
      wakeupSpecFromForm(
        "i1",
        form({ instruction: "x", expiresInHours: "4", wakeOnTimeout: true }),
        now
      )
    ).toMatchObject({ expiresAt: new Date(now + 4 * 3_600_000), onTimeout: "wake" })
    // Waking without a deadline means nothing, so no deadline sends neither.
    const open = wakeupSpecFromForm("i1", form({ instruction: "x", wakeOnTimeout: true }), now)
    expect(open).not.toHaveProperty("expiresAt")
    expect(open).not.toHaveProperty("onTimeout")
  })
})

describe("describeWakeupWriteError", () => {
  const t = (key: string) => `T:${key}`
  it("keys tracker refusals and passes the policy's own sentence through", () => {
    expect(
      describeWakeupWriteError(new IssueWakeupWriteError("issue-finished" as never, "raw"), t)
    ).toBe("T:error.issue-finished")
    expect(
      describeWakeupWriteError(new IssueWakeupWriteError("policy" as never, "Agents may not."), t)
    ).toBe("Agents may not.")
    expect(describeWakeupWriteError("plain", t)).toBe("plain")
  })
})

describe("WakeupCreateDialog", () => {
  const items = [
    { kind: "local", unifiedId: "local:i1", identifier: "MERC-1", title: "Self", status: "todo" },
    { kind: "local", unifiedId: "local:i2", identifier: "MERC-2", title: "Other", status: "todo" },
    { kind: "local", unifiedId: "local:i3", identifier: "MERC-3", title: "Done", status: "done" },
    { kind: "github", unifiedId: "github:x", identifier: "o/r#1", title: "Mirror", status: "todo" },
  ] as unknown as UnifiedIssueItem[]

  beforeEach(() => {
    mockCreate.mockReset()
    mockToastSuccess.mockReset()
  })

  function renderDialog(onOpenChange = jest.fn()) {
    render(
      <WakeupCreateDialog
        open
        onOpenChange={onOpenChange}
        issueId="i1"
        identifier="MERC-1"
        items={items}
      />
    )
    return onOpenChange
  }

  it("keeps submit disabled until the instruction is written, then creates as the user", async () => {
    mockCreate.mockResolvedValue({ id: "wk" })
    const onOpenChange = renderDialog()
    const submit = screen.getByTestId("wakeup-create-submit")
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByTestId("wakeup-instruction"), { target: { value: "Reply" } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      issueId: "i1",
      instruction: "Reply",
      source: "user",
      createdBy: { kind: "user" },
      trigger: { on: "event", kinds: ["commented"] },
    })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(mockToastSuccess).toHaveBeenCalledWith("createdToast:MERC-1")
  })

  it("offers waking at the deadline only once a deadline is picked, and submits it", async () => {
    mockCreate.mockResolvedValue({ id: "wk" })
    renderDialog()
    expect(screen.queryByTestId("wakeup-wake-on-timeout")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("option", { name: "expiresIn.72" }))
    fireEvent.click(screen.getByTestId("wakeup-wake-on-timeout"))
    expect(screen.getByText("wakeOnTimeoutHint")).toBeInTheDocument()
    fireEvent.change(screen.getByTestId("wakeup-instruction"), { target: { value: "Chase" } })
    const before = Date.now()
    fireEvent.click(screen.getByTestId("wakeup-create-submit"))
    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    const sent = mockCreate.mock.calls[0][0] as { expiresAt: Date; onTimeout: string }
    expect(sent.onTimeout).toBe("wake")
    expect(sent.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 72 * 3_600_000)
  })

  it("offers only other open local issues as a watch target", () => {
    renderDialog()
    fireEvent.click(screen.getByRole("option", { name: "preset.issue-finished" }))
    const select = screen
      .getByTestId("wakeup-target")
      .closest('[data-testid="select"]') as HTMLElement
    const targets = within(select)
      .getAllByRole("option")
      .map((option) => option.getAttribute("data-value"))
    expect(targets).toEqual(["i2"])
  })

  it("shows a refusal inline and stays open", async () => {
    mockCreate.mockRejectedValue(new IssueWakeupWriteError("issue-finished" as never, "raw"))
    const onOpenChange = renderDialog()
    fireEvent.change(screen.getByTestId("wakeup-instruction"), { target: { value: "Reply" } })
    fireEvent.click(screen.getByTestId("wakeup-create-submit"))
    expect(await screen.findByTestId("wakeup-create-error")).toHaveTextContent(
      "error.issue-finished"
    )
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
