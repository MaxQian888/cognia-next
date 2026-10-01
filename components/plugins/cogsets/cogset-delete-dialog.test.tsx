/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
const uninstall = jest.fn(async () => true)
jest.mock("@/hooks/plugins/use-plugin-uninstall", () => ({ usePluginUninstall: () => uninstall }))
const removeCogset = jest.fn(async (_id: string) => undefined)
const listPluginsOnlyIn = jest.fn(async (_id: string) => ["lonely"])
jest.mock("@/lib/plugin/cogset/actions", () => {
  class CogsetInUseError extends Error {
    constructor(readonly reason: "applied" | "global") {
      super(reason)
    }
  }
  return {
    CogsetInUseError,
    removeCogset: (id: string) => removeCogset(id),
    listPluginsOnlyIn: (id: string) => listPluginsOnlyIn(id),
  }
})
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: (...a: unknown[]) => toastError(...a) },
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { CogsetInUseError } from "@/lib/plugin/cogset/actions"
import type { CogsetRow } from "@/types/plugin/plugin-cogset"

import { CogsetDeleteDialog } from "./cogset-delete-dialog"

const cogset: CogsetRow = {
  id: "c",
  name: "Games",
  members: [],
  source: { kind: "manual" },
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => jest.clearAllMocks())

describe("CogsetDeleteDialog", () => {
  it("deletes and uninstalls only the plugins the user ticked", async () => {
    const onOpenChange = jest.fn()
    render(
      <CogsetDeleteDialog
        cogset={cogset}
        onOpenChange={onOpenChange}
        displayName={(c) => c.name}
        pluginName={(id) => `n:${id}`}
      />
    )
    await waitFor(() => expect(screen.getByText("n:lonely")).toBeTruthy())
    fireEvent.click(screen.getByLabelText("n:lonely"))
    fireEvent.click(screen.getByTestId("cogset-delete-confirm"))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(removeCogset).toHaveBeenCalledWith("c")
    expect(uninstall).toHaveBeenCalledWith({ pluginId: "lonely", name: "n:lonely" })
  })

  it("leaves plugins installed unless ticked", async () => {
    render(
      <CogsetDeleteDialog
        cogset={cogset}
        onOpenChange={jest.fn()}
        displayName={(c) => c.name}
        pluginName={(id) => id}
      />
    )
    await waitFor(() => expect(screen.getByText("lonely")).toBeTruthy())
    fireEvent.click(screen.getByTestId("cogset-delete-confirm"))
    await waitFor(() => expect(removeCogset).toHaveBeenCalled())
    expect(uninstall).not.toHaveBeenCalled()
  })

  it("explains why the running cogset cannot be deleted", async () => {
    removeCogset.mockRejectedValueOnce(new CogsetInUseError("applied"))
    render(
      <CogsetDeleteDialog
        cogset={cogset}
        onOpenChange={jest.fn()}
        displayName={(c) => c.name}
        pluginName={(id) => id}
      />
    )
    fireEvent.click(screen.getByTestId("cogset-delete-confirm"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('failed:{"name":"Games"}', {
        description: "inUseApplied",
      })
    )
  })
})
