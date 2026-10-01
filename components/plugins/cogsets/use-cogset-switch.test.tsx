/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
const switchCogset = jest.fn()
const retryAppliedCogset = jest.fn()
jest.mock("@/lib/plugin/cogset/actions", () => ({
  switchCogset: (...args: unknown[]) => switchCogset(...args),
  retryAppliedCogset: (...args: unknown[]) => retryAppliedCogset(...args),
}))
let legs: unknown[] = []
jest.mock("@/lib/execution/broker", () => ({ getExecutionBroker: () => ({ list: () => legs }) }))
const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

import { useEffect } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { CogsetRow } from "@/types/plugin/plugin-cogset"

import { useCogsetSwitch, type CogsetSwitchController } from "./use-cogset-switch"

const cogset: CogsetRow = {
  id: "w",
  name: "Writing",
  members: [],
  source: { kind: "manual" },
  createdAt: 1,
  updatedAt: 1,
}

const holder: { current?: CogsetSwitchController } = {}
function Harness() {
  const controller = useCogsetSwitch({ displayName: (c) => c.name, pluginName: (id) => `n:${id}` })
  useEffect(() => {
    holder.current = controller
  })
  return <>{controller.element}</>
}

const partial = {
  cogsetId: "w",
  plan: {},
  applied: {
    status: "partial",
    at: 1,
    outcomes: [{ pluginId: "pdf", action: "enable", ok: false, reason: "enable-failed" }],
  },
}

beforeEach(() => {
  jest.clearAllMocks()
  legs = []
})

describe("useCogsetSwitch", () => {
  it("switches immediately and toasts when every plugin switched", async () => {
    switchCogset.mockResolvedValueOnce({
      queued: false,
      result: { cogsetId: "w", plan: {}, applied: { status: "applied", at: 1, outcomes: [] } },
    })
    render(<Harness />)
    act(() => holder.current!.request(cogset))
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('switcher.switched:{"name":"Writing"}')
    )
    expect(switchCogset).toHaveBeenCalledWith(
      "w",
      expect.objectContaining({ onProgress: expect.any(Function) })
    )
  })

  it("asks first while agents run, and does nothing when cancelled", async () => {
    legs = [{ id: "leg" }]
    render(<Harness />)
    act(() => holder.current!.request(cogset))
    expect(screen.getByText("confirmRuns.title")).toBeTruthy()
    fireEvent.click(screen.getByText("confirmRuns.cancel"))
    expect(switchCogset).not.toHaveBeenCalled()
  })

  it("switches after the user confirms", async () => {
    legs = [{ id: "leg" }]
    switchCogset.mockResolvedValueOnce({ queued: true })
    render(<Harness />)
    act(() => holder.current!.request(cogset))
    fireEvent.click(screen.getByTestId("cogset-confirm-switch"))
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('switcher.queued:{"name":"Writing"}')
    )
  })

  it("shows the outcomes of a partial switch and retries", async () => {
    switchCogset.mockResolvedValueOnce({ queued: false, result: partial })
    retryAppliedCogset.mockResolvedValueOnce({
      ...partial,
      applied: { status: "applied", at: 2, outcomes: [] },
    })
    render(<Harness />)
    act(() => holder.current!.request(cogset))
    await waitFor(() => expect(screen.getByText("n:pdf")).toBeTruthy())
    fireEvent.click(screen.getByTestId("cogset-retry"))
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('switcher.switched:{"name":"Writing"}')
    )
  })

  it("toasts a failed switch", async () => {
    switchCogset.mockRejectedValueOnce(new Error("gone"))
    render(<Harness />)
    act(() => holder.current!.request(cogset))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('switcher.switchFailed:{"name":"Writing"}', {
        description: "gone",
      })
    )
  })
})
