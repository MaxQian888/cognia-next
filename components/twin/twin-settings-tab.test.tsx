/**
 * @jest-environment jsdom
 *
 * Tests for the native vector backend UI in TwinSettingsTab.
 * Covers the four spec-required cases:
 *   1. Native option visibility gated by isTauri()
 *   2. Selecting "native" saves via saveTwinRuntimeSettings
 *   3. "Test connection" calls verifyVectorBackendReadiness and shows result
 *   4. "Reset vector store" two-step confirm (cancel vs confirm, success vs error)
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock("@/lib/utils", () => ({
  ...jest.requireActual("@/lib/utils"),
  isTauri: jest.fn(),
}))

// usePlatform is the M4.1 replacement for the inline isTauri() UI gate in
// twin-settings-tab.tsx. We mirror the isTauri mock value so existing test
// cases keep working.
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: jest.fn(),
}))

jest.mock("@/lib/tauri/opener", () => ({
  revealInExplorer: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@cognia/vector/readiness", () => ({
  verifyVectorBackendReadiness: jest.fn(),
}))

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@tauri-apps/api/path", () => ({
  appDataDir: jest.fn().mockResolvedValue("C:\\Users\\test\\AppData\\Roaming"),
  join: jest.fn(async (...parts: string[]) => parts.join("\\")),
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

// Bridge the Radix Select into a native <select> for accessibility testing.
// The mock bubbles aria-label + data-testid up from SelectTrigger so existing
// `screen.getByLabelText("Backend")` queries keep working.
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react") as typeof import("react")
  type Harvest = {
    ariaLabel?: string
    testId?: string
    options: Array<{ value: string; label: React.ReactNode }>
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
      const kind = (child.type as React.ComponentType & { displayName?: string }).displayName
      if (kind === "SelectTriggerStub") {
        if (props["aria-label"]) sink.ariaLabel = props["aria-label"]
        if (props["data-testid"]) sink.testId = props["data-testid"]
      }
      if (kind === "SelectItemStub") {
        sink.options.push({
          value: props.value ?? "",
          label: props.children ?? "",
        })
        return
      }
      collect(props.children, sink)
    })
  }
  const Trigger = ({ children }: { children: React.ReactNode }) => <>{children}</>
  ;(Trigger as React.FC & { displayName?: string }).displayName = "SelectTriggerStub"
  const Item = ({ children }: { value: string; children: React.ReactNode }) => <>{children}</>
  ;(Item as React.FC & { displayName?: string }).displayName = "SelectItemStub"
  const Select = ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    disabled?: boolean
    children: React.ReactNode
  }) => {
    const harvest: Harvest = { options: [] }
    collect(children, harvest)
    return (
      <select
        aria-label={harvest.ariaLabel}
        data-testid={harvest.testId}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {harvest.options.map((o, i) => (
          <option key={`${o.value}-${i}`} value={o.value}>
            {typeof o.label === "string" ? o.label : String(o.value)}
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

// The component uses dexie-react-hooks. In jsdom we need fake-indexeddb +
// the real Dexie schema but we mock the twin-runtime-settings module so we
// don't need a fully seeded DB for these tests.
jest.mock("@/lib/db/twin-runtime-settings", () => ({
  observeTwinRuntimeSettings: jest.fn(),
  saveTwinRuntimeSettings: jest.fn().mockResolvedValue(undefined),
  getTwinRuntimeSettings: jest.fn(),
}))

// Dexie live-query hooks used in the outer TwinSettingsTab; stub them out so
// we can render the RuntimeConfigCard in isolation without wiring real Dexie.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn((fn: () => unknown, _deps: unknown[], defaultVal: unknown) => {
    // Return defaultVal synchronously — all tests only care about RuntimeConfigCard.
    void fn
    return defaultVal
  }),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

import { isTauri } from "@/lib/utils"
import { usePlatform } from "@/hooks/use-platform"
import { verifyVectorBackendReadiness } from "@cognia/vector/readiness"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { saveTwinRuntimeSettings, observeTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { DEFAULT_TWIN_RUNTIME_SETTINGS } from "@/types/twin"
import { TwinSettingsTab } from "./twin-settings-tab"

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockedIsTauri = isTauri as jest.Mock
const mockedUsePlatform = usePlatform as jest.Mock
const mockedVerify = verifyVectorBackendReadiness as jest.Mock
const mockedInvoke = invoke as jest.Mock
const mockedToast = toast as unknown as { success: jest.Mock; error: jest.Mock }
const mockedSave = saveTwinRuntimeSettings as jest.Mock
const mockedObserve = observeTwinRuntimeSettings as jest.Mock

/** Render <TwinSettingsTab> with live-query stubs producing DEFAULT settings. */
function renderTab() {
  // observeTwinRuntimeSettings is called by RuntimeConfigCard's useLiveQuery;
  // we stub it to return the defaults via the mock above.
  mockedObserve.mockResolvedValue(DEFAULT_TWIN_RUNTIME_SETTINGS)
  return render(<TwinSettingsTab twinId="twin_test" />)
}

// ── Baseline: select options are visible ──────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()
  // Default: not running under Tauri
  mockedIsTauri.mockReturnValue(false)
})

// ── Test suite ────────────────────────────────────────────────────────────────

describe("TwinSettingsTab — native vector backend", () => {
  // 1a. "Native" option renders when isTauri() is true
  it("shows the Native option in the backend select when running in Tauri", () => {
    mockedIsTauri.mockReturnValue(true)
    mockedUsePlatform.mockReturnValue("tauri")
    renderTab()

    // The select element is labelled "Backend"
    const select = screen.getByLabelText("Backend") as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.value)
    expect(options).toContain("native")

    // The display label should include "Native"
    const nativeOption = Array.from(select.options).find((o) => o.value === "native")
    expect(nativeOption?.text).toMatch(/native/i)
  })

  // 1b. "Native" option is hidden when isTauri() is false
  it("hides the Native option in the backend select when running in the browser", () => {
    mockedIsTauri.mockReturnValue(false)
    mockedUsePlatform.mockReturnValue("web")
    renderTab()

    const select = screen.getByLabelText("Backend") as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.value)
    expect(options).not.toContain("native")
  })

  // 2. Selecting native saves via saveTwinRuntimeSettings
  it("saves vectorBackend='native' when the Native option is selected", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedUsePlatform.mockReturnValue("tauri")
    const user = userEvent.setup()
    renderTab()

    const select = screen.getByLabelText("Backend") as HTMLSelectElement
    await user.selectOptions(select, "native")

    // Now the NativeBackendFields should be visible — save button
    const saveButton = screen.getByRole("button", { name: /save runtime settings/i })
    await user.click(saveButton)

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledWith(
        expect.objectContaining({
          storage: expect.objectContaining({ vectorBackend: "native" }),
        })
      )
    })
  })

  // T2.6: the reranker toggle persists reranker.enabled on save
  it("enables reranking and persists reranker.enabled on save (T2.6)", async () => {
    mockedUsePlatform.mockReturnValue("web")
    const user = userEvent.setup()
    renderTab()

    const toggle = screen.getByLabelText(/rerank retrieved results/i)
    await user.click(toggle)
    await user.click(screen.getByRole("button", { name: /save runtime settings/i }))

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledWith(
        expect.objectContaining({ reranker: expect.objectContaining({ enabled: true }) })
      )
    })
  })

  // D1 privacy: extraNameHints textarea parses comma/newline input and saves.
  it("persists extraNameHints parsed from the always-redact names textarea", async () => {
    mockedUsePlatform.mockReturnValue("web")
    const user = userEvent.setup()
    renderTab()

    const textarea = screen.getByTestId("twin-settings-extra-name-hints")
    await user.type(textarea, "Alice, 张伟")
    await user.click(screen.getByRole("button", { name: /save runtime settings/i }))

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledWith(
        expect.objectContaining({ extraNameHints: ["Alice", "张伟"] })
      )
    })
  })

  // Phase 4a: the reranker model selector persists the LLM-backed choice
  it("lets the user pick the LLM reranker model and persists it", async () => {
    mockedUsePlatform.mockReturnValue("web")
    const user = userEvent.setup()
    renderTab()

    // The model selector only appears once reranking is enabled.
    await user.click(screen.getByLabelText(/rerank retrieved results/i))
    const modelSelect = (await screen.findByLabelText("Reranker model")) as HTMLSelectElement
    await user.selectOptions(modelSelect, "llm")
    await user.click(screen.getByRole("button", { name: /save runtime settings/i }))

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledWith(
        expect.objectContaining({
          reranker: expect.objectContaining({ enabled: true, model: "llm" }),
        })
      )
    })
  })

  // 3. "Test connection" calls verifyVectorBackendReadiness and shows the result
  it("calls verifyVectorBackendReadiness on test click and shows Operational badge", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedUsePlatform.mockReturnValue("tauri")
    mockedVerify.mockResolvedValue({ state: "operational", diagnostic: undefined })

    const user = userEvent.setup()
    renderTab()

    // Switch to native backend
    const select = screen.getByLabelText("Backend") as HTMLSelectElement
    await user.selectOptions(select, "native")

    const testBtn = screen.getByRole("button", { name: /test connection/i })
    await user.click(testBtn)

    await waitFor(() => {
      expect(mockedVerify).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "native",
          native: {},
        })
      )
      expect(screen.getByText(/operational/i)).toBeInTheDocument()
    })
  })

  // 4a. Reset: cancel does NOT call invoke
  it("does not call invoke when the reset dialog is cancelled", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedUsePlatform.mockReturnValue("tauri")
    const user = userEvent.setup()
    renderTab()

    // Switch to native backend
    const select = screen.getByLabelText("Backend") as HTMLSelectElement
    await user.selectOptions(select, "native")

    // Open the reset dialog
    const resetBtn = screen.getByRole("button", { name: /reset vector store/i })
    await user.click(resetBtn)

    // Dialog should appear
    await screen.findByRole("alertdialog")
    expect(screen.getByText(/This cannot be undone/i)).toBeInTheDocument()

    // Click Cancel
    const cancelBtn = screen.getByRole("button", { name: /cancel/i })
    await user.click(cancelBtn)

    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  // 4b. Reset: confirm calls invoke and triggers success toast
  it("calls vector_reset_store and shows success toast on confirm", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedUsePlatform.mockReturnValue("tauri")
    mockedInvoke.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderTab()

    // Switch to native backend
    const select = screen.getByLabelText("Backend") as HTMLSelectElement
    await user.selectOptions(select, "native")

    // Open the reset dialog and confirm
    const resetBtn = screen.getByRole("button", { name: /reset vector store/i })
    await user.click(resetBtn)
    await screen.findByRole("alertdialog")

    const confirmBtn = screen.getByRole("button", { name: /confirm reset/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("vector_reset_store")
      expect(mockedToast.success).toHaveBeenCalledWith(expect.stringContaining("Reload"))
    })
  })

  // 4c. Reset: invoke error triggers error toast
  it("shows error toast when vector_reset_store rejects", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedUsePlatform.mockReturnValue("tauri")
    mockedInvoke.mockRejectedValue(new Error("disk full"))
    const user = userEvent.setup()
    renderTab()

    // Switch to native backend
    const select = screen.getByLabelText("Backend") as HTMLSelectElement
    await user.selectOptions(select, "native")

    const resetBtn = screen.getByRole("button", { name: /reset vector store/i })
    await user.click(resetBtn)
    await screen.findByRole("alertdialog")

    const confirmBtn = screen.getByRole("button", { name: /confirm reset/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith(expect.stringContaining("disk full"))
    })
  })
})

// ── Embedding / distill provider support ───────────────────────────────────────

describe("TwinSettingsTab — embedding & distill providers", () => {
  const embeddingFieldset = () => screen.getByText("Embedding").closest("fieldset") as HTMLElement
  const distillFieldset = () => screen.getByText("Distill LLM").closest("fieldset") as HTMLElement

  it("exposes the full canonical embedding provider list (local + voyage)", () => {
    mockedUsePlatform.mockReturnValue("web")
    renderTab()

    const select = within(embeddingFieldset()).getByLabelText("Provider") as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.value)
    expect(options).toEqual(
      expect.arrayContaining(["openai", "voyage", "ollama", "lmstudio", "transformersjs"])
    )
  })

  it("surfaces a Base URL field and hides the API key for a local provider", async () => {
    mockedUsePlatform.mockReturnValue("web")
    const user = userEvent.setup()
    renderTab()

    // Default provider is openai (cloud): API key shown, no Base URL.
    expect(within(embeddingFieldset()).queryByText("Base URL")).toBeNull()
    expect(within(embeddingFieldset()).queryByText("API key")).not.toBeNull()

    const select = within(embeddingFieldset()).getByLabelText("Provider") as HTMLSelectElement
    await user.selectOptions(select, "ollama")

    // Ollama is keyless + local: Base URL appears, API key disappears.
    expect(within(embeddingFieldset()).queryByText("Base URL")).not.toBeNull()
    expect(within(embeddingFieldset()).queryByText("API key")).toBeNull()
  })

  it("persists the chosen distill LLM provider on save", async () => {
    mockedUsePlatform.mockReturnValue("web")
    const user = userEvent.setup()
    renderTab()

    const distillProvider = within(distillFieldset()).getByLabelText(
      "Provider"
    ) as HTMLSelectElement
    const options = Array.from(distillProvider.options).map((o) => o.value)
    expect(options).toEqual(["anthropic", "openai", "google", "mistral", "cohere"])

    await user.selectOptions(distillProvider, "openai")
    await user.click(screen.getByRole("button", { name: /save runtime settings/i }))

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledWith(
        expect.objectContaining({ llm: expect.objectContaining({ provider: "openai" }) })
      )
    })
  })
})
