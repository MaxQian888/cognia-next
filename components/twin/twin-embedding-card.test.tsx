/**
 * @jest-environment jsdom
 *
 * Coverage for the per-twin embedding card: override save / clear, the
 * index status line, the rebuild-required + legacy + credential warnings,
 * and the confirm-then-rebuild flow. Dexie and the lifecycle module are
 * mocked at the module boundary; the status itself is computed by the real
 * `computeTwinEmbeddingStatus`.
 */

import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Twin, TwinRuntimeSettings } from "@/types/twin"

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

let mockTwin: Twin | undefined
let mockChunkCount = 0
let mockRuntime: TwinRuntimeSettings
let mockProviderSettings: Record<string, unknown> = {}

const setOverrideMock = jest.fn(async (..._args: unknown[]) => undefined)
const rebuildMock = jest.fn()

jest.mock("dexie-react-hooks", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactActual = require("react") as typeof React
  return {
    useLiveQuery: <T,>(query: () => Promise<T> | T, deps: unknown[] = [], initial?: T): T => {
      const [value, setValue] = ReactActual.useState<T | undefined>(initial)
      ReactActual.useEffect(() => {
        let alive = true
        void Promise.resolve(query()).then((next) => {
          if (alive) setValue(next)
        })
        return () => {
          alive = false
        }
      }, deps)
      return value as T
    },
  }
})

jest.mock("@/lib/db/twins", () => ({
  getTwin: jest.fn(async () => mockTwin),
  setTwinEmbeddingOverride: (...args: unknown[]) => setOverrideMock(...args),
}))
jest.mock("@/lib/db/twin-chunks", () => ({
  countTwinChunksByTwin: jest.fn(async () => mockChunkCount),
}))
jest.mock("@/lib/db/twin-runtime-settings", () => ({
  observeTwinRuntimeSettings: jest.fn(async () => mockRuntime),
}))
jest.mock("@/lib/twin/lifecycle", () => ({
  rebuildTwinIndex: (...args: unknown[]) => rebuildMock(...args),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (state: { settings: { providerSettings: unknown } }) => T) =>
    selector({ settings: { providerSettings: mockProviderSettings } }),
}))

// Native <select> stand-in for Radix Select (same approach as twin-cron-card).
jest.mock("@/components/ui/select", () => {
  type Harvest = {
    ariaLabel?: string
    testId?: string
    options: Array<{ value: string; label: string }>
  }
  const collect = (node: React.ReactNode, sink: Harvest): void => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return
      const props = child.props as {
        children?: React.ReactNode
        value?: string
        "aria-label"?: string
        "data-testid"?: string
      }
      const kind = (child.type as { displayName?: string }).displayName
      if (kind === "SelectTriggerStub") {
        sink.ariaLabel = props["aria-label"]
        sink.testId = props["data-testid"]
      }
      if (kind === "SelectItemStub") {
        sink.options.push({
          value: props.value ?? "",
          label: React.Children.toArray(props.children).join(""),
        })
        return
      }
      collect(props.children, sink)
    })
  }
  const Trigger = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  Trigger.displayName = "SelectTriggerStub"
  const Item = ({ children }: { value: string; children: React.ReactNode }) => <>{children}</>
  Item.displayName = "SelectItemStub"
  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => {
    const harvest: Harvest = { options: [] }
    collect(children, harvest)
    return (
      <select
        aria-label={harvest.ariaLabel}
        data-testid={harvest.testId}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {harvest.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: Trigger,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectItem: Item,
  }
})

import { toast } from "sonner"
import { DEFAULT_TWIN_RUNTIME_SETTINGS } from "@/types/twin"
import { TwinEmbeddingCard } from "./twin-embedding-card"

const mockedToast = toast as unknown as { success: jest.Mock; error: jest.Mock }

const COHERE_INDEX = {
  provider: "cohere" as const,
  model: "embed-english-v3.0",
  dimensions: 1024,
  fingerprint: "cohere::embed-english-v3.0::1024",
  builtAt: Date.UTC(2026, 0, 2),
}

function baseTwin(overrides: Partial<Twin> = {}): Twin {
  return { id: "twin_alice", name: "Alice", createdAt: 1, updatedAt: 1, ...overrides }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockTwin = baseTwin()
  mockChunkCount = 0
  mockProviderSettings = {}
  mockRuntime = {
    ...DEFAULT_TWIN_RUNTIME_SETTINGS,
    embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-global" },
  }
})

describe("TwinEmbeddingCard", () => {
  it("shows the inherited global embedding and an empty index", async () => {
    render(<TwinEmbeddingCard twinId="twin_alice" />)
    expect(await screen.findByText("Embedding for this twin")).toBeInTheDocument()
    const select = screen.getByTestId("twin-embedding-provider") as HTMLSelectElement
    expect(select.value).toBe("__inherit__")
    expect(
      screen.getByRole("option", { name: "Inherit global (openai · text-embedding-3-small)" })
    ).toBeInTheDocument()
    expect(screen.getByText("Embeds with openai · text-embedding-3-small")).toBeInTheDocument()
    expect(screen.getByText("Global")).toBeInTheDocument()
    expect(screen.getByText(/No index recorded yet/)).toBeInTheDocument()
    expect(screen.getByTestId("twin-embedding-model")).toBeDisabled()
    expect(screen.getByTestId("twin-embedding-save")).toBeDisabled()
  })

  it("saves a provider + model override for this twin", async () => {
    mockProviderSettings = { cohere: { apiKey: "co-key" } }
    render(<TwinEmbeddingCard twinId="twin_alice" />)
    await screen.findByText("Embedding for this twin")

    await userEvent.selectOptions(screen.getByTestId("twin-embedding-provider"), "cohere")
    const model = screen.getByTestId("twin-embedding-model") as HTMLInputElement
    expect(model).toBeEnabled()
    expect(model.placeholder).toBe("Default: embed-english-v3.0")
    fireEvent.change(model, { target: { value: "embed-multilingual-v3.0" } })
    expect(screen.getByText("Save the embedding choice before rebuilding.")).toBeInTheDocument()
    expect(screen.getByTestId("twin-embedding-rebuild")).toBeDisabled()

    await userEvent.click(screen.getByTestId("twin-embedding-save"))
    await waitFor(() =>
      expect(setOverrideMock).toHaveBeenCalledWith("twin_alice", {
        provider: "cohere",
        model: "embed-multilingual-v3.0",
      })
    )
    expect(mockedToast.success).toHaveBeenCalledWith("Embedding choice saved")
  })

  it("clears the override when switched back to inherit", async () => {
    mockTwin = baseTwin({ embedding: { provider: "openai", model: "text-embedding-3-large" } })
    render(<TwinEmbeddingCard twinId="twin_alice" />)
    await waitFor(() =>
      expect((screen.getByTestId("twin-embedding-provider") as HTMLSelectElement).value).toBe(
        "openai"
      )
    )
    expect(screen.getByText("This twin")).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByTestId("twin-embedding-provider"), "__inherit__")
    await userEvent.click(screen.getByTestId("twin-embedding-save"))
    await waitFor(() => expect(setOverrideMock).toHaveBeenCalledWith("twin_alice", undefined))
  })

  it("warns that a rebuild is required when the recorded index names another model", async () => {
    mockTwin = baseTwin({ embedding: { provider: "openai" }, embeddingIndex: COHERE_INDEX })
    mockChunkCount = 5
    render(<TwinEmbeddingCard twinId="twin_alice" />)
    const warning = await screen.findByTestId("twin-embedding-rebuild-required")
    expect(warning).toHaveTextContent(
      "Rebuild required: the index was built with cohere · embed-english-v3.0, but this twin now embeds with openai · text-embedding-3-small."
    )
    expect(
      screen.getByText(/Index built with cohere · embed-english-v3.0 \(1024 dimensions\)/)
    ).toBeInTheDocument()
  })

  it("flags a legacy index when the twin has its own model", async () => {
    mockTwin = baseTwin({ embedding: { provider: "openai", model: "text-embedding-3-large" } })
    mockChunkCount = 3
    render(<TwinEmbeddingCard twinId="twin_alice" />)
    expect(await screen.findByTestId("twin-embedding-legacy-warning")).toBeInTheDocument()
    expect(screen.getByText(/built before model tracking/)).toBeInTheDocument()
  })

  it("reports missing credentials and blocks the rebuild", async () => {
    mockTwin = baseTwin({ embedding: { provider: "mistral" } })
    render(<TwinEmbeddingCard twinId="twin_alice" />)
    const credentials = await screen.findByTestId("twin-embedding-credentials")
    expect(credentials).toHaveTextContent('No API key or base URL is configured for "mistral"')
    expect(screen.getByTestId("twin-embedding-rebuild")).toBeDisabled()
  })

  it("rebuilds after confirmation and reports the queued sources", async () => {
    rebuildMock.mockResolvedValue({
      ok: true,
      rebuilt: true,
      value: {
        jobId: "job-1",
        sourceIds: ["s1", "s2"],
        droppedCollections: [],
        cancelledJobIds: [],
        chunksRemoved: 3,
        embedding: { provider: "openai", model: "text-embedding-3-small", source: "global" },
      },
    })
    render(<TwinEmbeddingCard twinId="twin_alice" />)
    await screen.findByText("Embedding for this twin")

    await userEvent.click(screen.getByTestId("twin-embedding-rebuild"))
    expect(await screen.findByText("Rebuild this twin's index?")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("twin-embedding-rebuild-confirm"))

    await waitFor(() => expect(rebuildMock).toHaveBeenCalledWith("twin_alice"))
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith("Rebuild queued for 2 sources.")
    )
  })

  it("surfaces a failed rebuild with its stage", async () => {
    rebuildMock.mockResolvedValue({
      ok: false,
      rebuilt: false,
      stage: "runtime-adapter",
      error: "disabled",
    })
    render(<TwinEmbeddingCard twinId="twin_alice" />)
    await screen.findByText("Embedding for this twin")

    await userEvent.click(screen.getByTestId("twin-embedding-rebuild"))
    await userEvent.click(await screen.findByTestId("twin-embedding-rebuild-confirm"))

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(
        "Rebuild failed at the runtime (worker / vector store) step: disabled"
      )
    )
  })
})

it("keeps the inherited embedding label within its grid column", async () => {
  render(<TwinEmbeddingCard twinId="twin_alice" />)
  const provider = await screen.findByTestId("twin-embedding-provider")
  expect(provider.parentElement).toHaveClass("min-w-0")
  expect(screen.getByTestId("twin-embedding-model").parentElement).toHaveClass("min-w-0")
})
