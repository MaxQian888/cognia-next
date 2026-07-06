/**
 * Smoke tests for the Character ↔ Twin binding section.
 *
 * Mocks Dexie via `useLiveQuery` so we don't need a live IndexedDB. We're
 * not exhaustively asserting markup — just the structural decisions:
 *
 *   • Unbound state shows the "Create new twin" affordance.
 *   • Selecting an existing twin from the dropdown calls onChange with
 *     a default `twinSettings` block.
 *   • Bound state surfaces stat values from the live profile.
 *   • The "Unbind" path clears both `twinId` and `twinSettings`.
 */

import { fireEvent, render, screen, within } from "@testing-library/react"
import { TwinBindingSection } from "./twin-binding-section"
import { DEFAULT_TWIN_SETTINGS } from "@/types/twin"

// useLiveQuery returns its `defaultResult` synchronously when the query
// fires before the IDB connection is ready. We stub it that way for tests
// so we don't need to spin up fake-indexeddb.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown, _deps: unknown[], defaultResult: unknown) => {
    try {
      const v = fn()
      // Promise return — fall back to default. Components need synchronous values.
      if (v && typeof (v as { then?: unknown }).then === "function") return defaultResult
      return v ?? defaultResult
    } catch {
      return defaultResult
    }
  },
}))

jest.mock("@/lib/db/characters", () => ({
  listCharacters: async () => [{ id: "char_x", name: "Other character", twinId: "twin_existing" }],
}))
// The "pick existing" list now unions the twins registry. The synchronous
// useLiveQuery stub above returns the default ([]) for any async query, so the
// picker stays hidden here — we just keep the registry import resolvable.
jest.mock("@/lib/db/twins", () => ({
  observeTwins: async () => [{ id: "twin_existing", name: "Registry Twin" }],
}))
jest.mock("@/lib/db/twin-chunks", () => ({ countTwinChunksByTwin: async () => 42 }))
jest.mock("@/lib/db/twin-profile", () => ({
  getTwinProfile: async () => ({
    id: "twin_x",
    twinId: "twin_x",
    styleSamples: [{}, {}],
    playbooks: [{}],
    entities: [],
    decisions: [],
    voiceSummary: "",
    updatedAt: 1700000000000,
  }),
}))
jest.mock("@/lib/db/twin-sources", () => ({
  listTwinSourcesByTwin: async () => [{}, {}, {}],
}))

// next-intl's `useTranslations` returns the key by default in tests if a
// provider isn't wrapped — wire a tiny passthrough.
jest.mock("next-intl", () => ({
  useTranslations: (_namespace?: string) => (key: string) => key,
}))

// Deep-link uses next/link — render its children straight.
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}))

describe("<TwinBindingSection />", () => {
  it("unbound state shows create-new affordance", () => {
    const onChange = jest.fn()
    render(<TwinBindingSection value={{}} onChange={onChange} />)
    expect(screen.getByText("createNew")).toBeInTheDocument()
    expect(screen.getByText("titleUnbound")).toBeInTheDocument()
  })

  it("creating a new twin calls onChange with default settings", () => {
    const onChange = jest.fn()
    render(<TwinBindingSection value={{}} onChange={onChange} />)
    fireEvent.click(screen.getByText("createNew"))
    fireEvent.click(screen.getByText("confirmBind"))
    expect(onChange).toHaveBeenCalledTimes(1)
    const [arg] = onChange.mock.calls[0]
    expect(arg.twinId).toMatch(/^twin_/)
    expect(arg.twinSettings).toEqual(DEFAULT_TWIN_SETTINGS)
  })

  it("bound state shows stats and runtime knobs", () => {
    const onChange = jest.fn()
    render(
      <TwinBindingSection
        value={{ twinId: "twin_x", twinSettings: DEFAULT_TWIN_SETTINGS }}
        onChange={onChange}
      />
    )
    // The bound id appears as a code element.
    expect(screen.getByText("twin_x")).toBeInTheDocument()
    // Stats labels.
    expect(screen.getByText("statsSources")).toBeInTheDocument()
    expect(screen.getByText("statsChunks")).toBeInTheDocument()
    expect(screen.getByText("statsStyleSamples")).toBeInTheDocument()
    expect(screen.getByText("statsPlaybooks")).toBeInTheDocument()
    // Runtime knob labels.
    expect(screen.getByText("enableRag")).toBeInTheDocument()
    expect(screen.getByText("ragTopK")).toBeInTheDocument()
    expect(screen.getByText("enableHybrid")).toBeInTheDocument()
    expect(screen.getByText("hybridKeywordWeight")).toBeInTheDocument()
    expect(screen.getByText("enableStyleFewShot")).toBeInTheDocument()
    expect(screen.getByText("styleSamplesK")).toBeInTheDocument()
  })

  it("toggling enableHybrid calls onChange with updated settings", () => {
    const onChange = jest.fn()
    render(
      <TwinBindingSection
        value={{ twinId: "twin_x", twinSettings: DEFAULT_TWIN_SETTINGS }}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByLabelText("enableHybrid"))
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0]
    expect(last.twinSettings.enableHybrid).toBe(true)
    expect(last.twinId).toBe("twin_x")
  })

  it("toggling enableRag calls onChange with updated settings", () => {
    const onChange = jest.fn()
    render(
      <TwinBindingSection
        value={{ twinId: "twin_x", twinSettings: DEFAULT_TWIN_SETTINGS }}
        onChange={onChange}
      />
    )
    const enableRagSwitch = screen.getByLabelText("enableRag")
    fireEvent.click(enableRagSwitch)
    expect(onChange).toHaveBeenCalled()
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0]
    expect(last.twinSettings.enableRag).toBe(false)
    expect(last.twinId).toBe("twin_x")
  })

  it("toggling enableCitations updates settings and reveals the style select", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <TwinBindingSection
        value={{ twinId: "twin_x", twinSettings: DEFAULT_TWIN_SETTINGS }}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByLabelText("enableCitations"))
    expect(onChange.mock.calls.at(-1)![0].twinSettings.enableCitations).toBe(true)
    rerender(
      <TwinBindingSection
        value={{
          twinId: "twin_x",
          twinSettings: { ...DEFAULT_TWIN_SETTINGS, enableCitations: true },
        }}
        onChange={onChange}
      />
    )
    expect(screen.getByText("citationStyleLabel")).toBeInTheDocument()
  })

  it("toggles query expansion and corrective filter", () => {
    const onChange = jest.fn()
    render(
      <TwinBindingSection
        value={{ twinId: "twin_x", twinSettings: DEFAULT_TWIN_SETTINGS }}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByLabelText("enableQueryExpansion"))
    expect(onChange.mock.calls.at(-1)![0].twinSettings.enableQueryExpansion).toBe(true)
    fireEvent.click(screen.getByLabelText("enableCorrectiveFilter"))
    expect(onChange.mock.calls.at(-1)![0].twinSettings.enableCorrectiveFilter).toBe(true)
  })

  it("unbind confirms then clears both fields", () => {
    const onChange = jest.fn()
    render(
      <TwinBindingSection
        value={{ twinId: "twin_x", twinSettings: DEFAULT_TWIN_SETTINGS }}
        onChange={onChange}
      />
    )
    // Open the unbind dialog.
    fireEvent.click(screen.getByLabelText("unbind"))
    // Then confirm. The dialog is portal-mounted, so query the document body.
    const confirm = within(document.body).getByText("unbindConfirm")
    fireEvent.click(confirm)
    expect(onChange).toHaveBeenCalledWith({ twinId: undefined, twinSettings: undefined })
  })
})
