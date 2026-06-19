/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen, act, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

const markSavedMock = jest.fn()
jest.mock("./settings-save-indicator", () => ({
  markSettingsSaved: () => markSavedMock(),
}))

const updateTeamConfigMock = jest.fn()
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (sel: (s: { updateTeamConfig: jest.Mock }) => unknown) =>
    sel({ updateTeamConfig: updateTeamConfigMock }),
}))

// Registry stubs
const listEntriesMock = jest.fn<
  ReturnType<
    typeof import("@/lib/plugin/registries/shared-memory-adapter-registry").listSharedMemoryAdapterEntries
  >,
  []
>()
const getAdapterMock = jest.fn<
  ReturnType<
    typeof import("@/lib/plugin/registries/shared-memory-adapter-registry").getSharedMemoryAdapter
  >,
  [string]
>()
jest.mock("@/lib/plugin/registries/shared-memory-adapter-registry", () => ({
  listSharedMemoryAdapterEntries: (...args: unknown[]) => listEntriesMock(...(args as [])),
  getSharedMemoryAdapter: (...args: unknown[]) => getAdapterMock(...(args as [string])),
}))

const syncMock = jest.fn<Promise<{ pulled: number }>, [string]>()
jest.mock("@/lib/ai/agent/team/shared-memory-orchestrator", () => ({
  syncSharedMemoryFromAdapter: (...args: unknown[]) => syncMock(...(args as [string])),
}))

import { MemoryAdapterStrip } from "./memory-adapter-strip"
import { toast } from "sonner"
import type { AgentTeam } from "@/types/agent/agent-team"

function makeTeam(sharedMemoryAdapterId?: string): AgentTeam {
  return {
    id: "t1",
    name: "Team",
    description: "",
    task: "task",
    status: "idle",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 3,
      executionMode: "coordinated",
      displayMode: "expanded",
      sharedMemoryAdapterId,
    },
    leadId: "lead",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(0),
  } as AgentTeam
}

beforeEach(() => {
  updateTeamConfigMock.mockReset()
  markSavedMock.mockReset()
  syncMock.mockReset()
  listEntriesMock.mockReturnValue([])
  getAdapterMock.mockReturnValue(undefined)
  ;(toast.success as jest.Mock).mockReset()
  ;(toast.error as jest.Mock).mockReset()
})

describe("MemoryAdapterStrip", () => {
  it("shows noAdapter badge when no adapter is configured", () => {
    render(<MemoryAdapterStrip team={makeTeam()} />)
    expect(screen.getByText("noAdapter")).toBeInTheDocument()
  })

  it("shows adapter name when one is configured", () => {
    getAdapterMock.mockReturnValue({ name: "My Adapter" } as ReturnType<typeof getAdapterMock>)
    render(<MemoryAdapterStrip team={makeTeam("plugin:mem")} />)
    expect(screen.getByText("My Adapter")).toBeInTheDocument()
  })

  it("renders the label text", () => {
    render(<MemoryAdapterStrip team={makeTeam()} />)
    expect(screen.getByText("label")).toBeInTheDocument()
  })

  it("renders Configure and Sync now buttons", () => {
    render(<MemoryAdapterStrip team={makeTeam()} />)
    expect(screen.getByText("configure")).toBeInTheDocument()
    expect(screen.getByText("sync")).toBeInTheDocument()
  })

  it("Sync now button is disabled when no adapter is configured", () => {
    render(<MemoryAdapterStrip team={makeTeam()} />)
    const syncBtn = screen.getByText("sync").closest("button")!
    expect(syncBtn).toBeDisabled()
  })

  it("Sync now button is enabled when adapter is configured", () => {
    getAdapterMock.mockReturnValue({ name: "Adapter" } as ReturnType<typeof getAdapterMock>)
    render(<MemoryAdapterStrip team={makeTeam("plugin:mem")} />)
    const syncBtn = screen.getByText("sync").closest("button")!
    expect(syncBtn).not.toBeDisabled()
  })

  it("clicking Configure opens the picker dialog", () => {
    render(<MemoryAdapterStrip team={makeTeam()} />)
    fireEvent.click(screen.getByText("configure"))
    expect(screen.getByText("pickerTitle")).toBeInTheDocument()
  })

  it("picker dialog renders (none) option", () => {
    render(<MemoryAdapterStrip team={makeTeam()} />)
    fireEvent.click(screen.getByText("configure"))
    // The select in the dialog has the "(none)" option.
    expect(screen.getByText("unset")).toBeInTheDocument()
  })

  it("picker dialog renders available adapter entries in the select options", () => {
    listEntriesMock.mockReturnValue([
      { id: "plug:mem", entry: { name: "Redis Adapter" }, pluginId: "plug" } as ReturnType<
        typeof listEntriesMock
      >[0],
    ])
    render(<MemoryAdapterStrip team={makeTeam()} />)
    fireEvent.click(screen.getByText("configure"))
    // Open the select to reveal the options list.
    fireEvent.click(screen.getByRole("combobox"))
    expect(screen.getByText("Redis Adapter")).toBeInTheDocument()
  })

  it("saving with __none__ (no adapter selected) clears the adapterId and calls markSaved", () => {
    // Team has no adapter → draft = "__none__".  Open picker and immediately save.
    render(<MemoryAdapterStrip team={makeTeam()} />)
    fireEvent.click(screen.getByText("configure"))
    const dialogSaveBtn = screen.getAllByText("configure")[1]
    fireEvent.click(dialogSaveBtn)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ sharedMemoryAdapterId: undefined })
    )
    expect(markSavedMock).toHaveBeenCalled()
  })

  it("closing the picker via onOpenChange hides the dialog", () => {
    render(<MemoryAdapterStrip team={makeTeam()} />)
    fireEvent.click(screen.getByText("configure"))
    expect(screen.getByText("pickerTitle")).toBeInTheDocument()
    // Radix Dialog closes on Escape
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByText("pickerTitle")).not.toBeInTheDocument()
  })

  it("sync calls syncSharedMemoryFromAdapter and toasts success", async () => {
    getAdapterMock.mockReturnValue({ name: "Adapter" } as ReturnType<typeof getAdapterMock>)
    syncMock.mockResolvedValue({ pulled: 5 })
    render(<MemoryAdapterStrip team={makeTeam("plugin:mem")} />)
    await act(async () => {
      fireEvent.click(screen.getByText("sync").closest("button")!)
    })
    expect(syncMock).toHaveBeenCalledWith("t1")
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("synced"))
    })
  })

  it("sync toasts error when syncSharedMemoryFromAdapter throws", async () => {
    getAdapterMock.mockReturnValue({ name: "Adapter" } as ReturnType<typeof getAdapterMock>)
    syncMock.mockRejectedValue(new Error("network error"))
    render(<MemoryAdapterStrip team={makeTeam("plugin:mem")} />)
    await act(async () => {
      fireEvent.click(screen.getByText("sync").closest("button")!)
    })
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("syncFailed")
    })
  })

  it("sync button is disabled while a sync is in progress (syncing=true)", async () => {
    getAdapterMock.mockReturnValue({ name: "Adapter" } as ReturnType<typeof getAdapterMock>)
    // Never resolves during this test — keeps syncing=true.
    syncMock.mockReturnValue(new Promise(() => undefined))
    render(<MemoryAdapterStrip team={makeTeam("plugin:mem")} />)
    const syncBtn = screen.getByText("sync").closest("button")!
    fireEvent.click(syncBtn)
    // After click the button should be disabled while syncing.
    await waitFor(() => {
      expect(syncBtn).toBeDisabled()
    })
  })

  it("saves a selected adapter id and closes the picker", () => {
    listEntriesMock.mockReturnValue([
      { id: "plug:mem", entry: { name: "Redis Adapter" }, pluginId: "plug" } as ReturnType<
        typeof listEntriesMock
      >[0],
    ])
    render(<MemoryAdapterStrip team={makeTeam()} />)
    fireEvent.click(screen.getByText("configure"))
    // Open the select to reveal options.
    fireEvent.click(screen.getByRole("combobox"))
    const listbox = screen.queryByRole("listbox")
    if (listbox) {
      const option = listbox.querySelector('[data-value="plug:mem"]') as HTMLElement | null
      if (option) {
        fireEvent.click(option)
      } else {
        // Fallback: click by visible text.
        const redisOpt = screen.getByText("Redis Adapter")
        fireEvent.click(redisOpt)
      }
    } else {
      // If listbox wasn't rendered, click by visible text.
      const redisOpt = screen.getByText("Redis Adapter")
      fireEvent.click(redisOpt)
    }
    // Click Save button inside the dialog.
    const dialogSaveBtn = screen.getAllByText("configure")[1]
    fireEvent.click(dialogSaveBtn)
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ sharedMemoryAdapterId: "plug:mem" })
    )
  })
})
