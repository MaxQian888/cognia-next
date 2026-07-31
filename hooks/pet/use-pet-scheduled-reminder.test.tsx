import { renderHook, waitFor } from "@testing-library/react"

import { usePetScheduledReminder } from "./use-pet-scheduled-reminder"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetEvent } from "@/types/pet"

// next-intl: echo the key back (and stringify vars) so we can assert routing
// without loading the real message bundle.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

function emitDue(meta?: Record<string, unknown>) {
  const event: PetEvent = { source: "scheduler", kind: "scheduledRunDue", at: 1, meta }
  getPetEventBus().emit(event)
}

describe("usePetScheduledReminder", () => {
  beforeEach(() => {
    usePetStore.setState({ oneShotQueue: [] })
  })

  it("reminds on a due task: surprised flourish + notification with the resolved name", async () => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    const resolveTaskName = jest.fn().mockResolvedValue("Backup DB")
    renderHook(() => usePetScheduledReminder(true, { resolveTaskName, notifyDue }))

    emitDue({ taskId: "t1" })

    // The flourish is enqueued synchronously in the bus callback.
    expect(usePetStore.getState().oneShotQueue).toContain("surprised")

    await waitFor(() => expect(notifyDue).toHaveBeenCalled())
    expect(resolveTaskName).toHaveBeenCalledWith("t1")
    expect(notifyDue).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        title: "notifications.scheduledDue.title",
        body: 'notifications.scheduledDue.body:{"taskName":"Backup DB"}',
      })
    )
  })

  it("uses the generic body when there is no task id", async () => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    const resolveTaskName = jest.fn()
    renderHook(() => usePetScheduledReminder(true, { resolveTaskName, notifyDue }))

    emitDue(undefined)

    await waitFor(() => expect(notifyDue).toHaveBeenCalled())
    expect(resolveTaskName).not.toHaveBeenCalled()
    expect(notifyDue).toHaveBeenCalledWith(
      "unknown",
      expect.objectContaining({ body: "notifications.scheduledDue.bodyGeneric" })
    )
  })

  it("degrades to the generic body when the name lookup fails", async () => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    const resolveTaskName = jest.fn().mockRejectedValue(new Error("cold db"))
    renderHook(() => usePetScheduledReminder(true, { resolveTaskName, notifyDue }))

    emitDue({ taskId: "t9" })

    await waitFor(() => expect(notifyDue).toHaveBeenCalled())
    expect(notifyDue).toHaveBeenCalledWith(
      "t9",
      expect.objectContaining({ body: "notifications.scheduledDue.bodyGeneric" })
    )
  })

  it("ignores non-due pet events", async () => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    renderHook(() => usePetScheduledReminder(true, { notifyDue, resolveTaskName: jest.fn() }))

    getPetEventBus().emit({
      source: "scheduler",
      kind: "scheduledRun",
      at: 1,
      meta: { taskId: "t1" },
    })

    await Promise.resolve()
    expect(notifyDue).not.toHaveBeenCalled()
    expect(usePetStore.getState().oneShotQueue).not.toContain("surprised")
  })

  it("does not subscribe when disabled", async () => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    renderHook(() => usePetScheduledReminder(false, { notifyDue, resolveTaskName: jest.fn() }))

    emitDue({ taskId: "t1" })

    await Promise.resolve()
    expect(notifyDue).not.toHaveBeenCalled()
    expect(usePetStore.getState().oneShotQueue).not.toContain("surprised")
  })
})
