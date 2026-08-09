/**
 * @jest-environment jsdom
 */

import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { HooksSection } from "./hooks-section"
import { knownHookRuntimeCapabilities } from "@/lib/claude/hooks/runtime-capabilities"

// The command field renders the shared CodeMirror `LightCodeEditor`, which
// measures the DOM and crashes under jsdom. Swap it for a plain textarea with
// the same value/onChange(string)/data-testid contract.
jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({
    value,
    onChange,
    "data-testid": testId,
    "aria-label": ariaLabel,
  }: {
    value: string
    onChange: (next: string) => void
    "data-testid"?: string
    "aria-label"?: string
  }) => (
    <textarea
      data-testid={testId}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

// Radix Tabs uses pointer events that jsdom doesn't fully simulate; replace
// the primitives with plain buttons so click() flips the active tab. Mirrors
// the pattern in `components/settings/provider/provider-settings.test.tsx`.
jest.mock("@/components/ui/tabs", () => {
  const TabsContext = React.createContext<{
    value?: string
    onValueChange?: (v: string) => void
  }>({})
  const Tabs = ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (v: string) => void
    children: React.ReactNode
  }) => <TabsContext.Provider value={{ value, onValueChange }}>{children}</TabsContext.Provider>
  const TabsList = ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  const TabsTrigger = ({
    value,
    children,
    disabled,
    ...rest
  }: {
    value: string
    children: React.ReactNode
    disabled?: boolean
  } & Record<string, unknown>) => {
    const ctx = React.useContext(TabsContext)
    return (
      <button
        type="button"
        role="tab"
        disabled={disabled}
        aria-selected={ctx.value === value}
        onClick={() => ctx.onValueChange?.(value)}
        {...rest}
      >
        {children}
      </button>
    )
  }
  const TabsContent = ({ value, children }: { value: string; children: React.ReactNode }) => {
    const ctx = React.useContext(TabsContext)
    return ctx.value === value ? <div>{children}</div> : null
  }
  return { Tabs, TabsList, TabsTrigger, TabsContent }
})

// ---- Mocks ---------------------------------------------------------------

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const replaceMock = jest.fn()
let searchString = ""
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(searchString),
}))

const mockReadUser = jest.fn()
const mockReadProject = jest.fn()
const mockReadLocal = jest.fn()
const mockWriteUser = jest.fn()
const mockWriteProject = jest.fn()
const mockWriteLocal = jest.fn()

jest.mock("@/lib/claude/settings", () => ({
  readClaudeUserSettings: () => mockReadUser(),
  readClaudeProjectSettings: (cwd: string) => mockReadProject(cwd),
  readClaudeLocalSettings: (cwd: string) => mockReadLocal(cwd),
  writeClaudeUserSettings: (p: unknown) => mockWriteUser(p),
  writeClaudeProjectSettings: (cwd: string, p: unknown) => mockWriteProject(cwd, p),
  writeClaudeLocalSettings: (cwd: string, p: unknown) => mockWriteLocal(cwd, p),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
  },
}))

beforeEach(() => {
  searchString = ""
  replaceMock.mockReset()
  mockReadUser.mockReset()
  mockReadProject.mockReset()
  mockReadLocal.mockReset()
  mockWriteUser.mockReset()
  mockWriteProject.mockReset()
  mockWriteLocal.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
})

describe("HooksSection — scroll ownership", () => {
  it("keeps the settings region fixed and gives vertical scrolling only to the event list", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    render(<HooksSection />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    expect(screen.getByTestId("hooks-settings-region")).toHaveClass("overflow-hidden")
    expect(screen.getByTestId("hooks-settings-region")).not.toHaveClass("overflow-y-auto")
    expect(screen.getByLabelText("eventListLabel")).toHaveClass("overflow-y-auto")
  })
})

describe("HooksSection — load + scope switching", () => {
  it("loads user-scope hooks on initial mount", async () => {
    mockReadUser.mockResolvedValue({
      model: "haiku",
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "log.sh" }] }] },
      extra: { customKey: "preserved" },
    })
    render(<HooksSection cwd="/repo" />)

    // PreToolUse default tab is active and shows the loaded group once the
    // async read settles.
    await waitFor(() => expect(screen.getAllByTestId("hook-group-editor")).toHaveLength(1))
    // Save button starts disabled (clean state).
    expect(screen.getByTestId("hooks-save")).toBeDisabled()
  })

  it("reads from project scope when project tab is selected", async () => {
    mockReadUser.mockResolvedValue({})
    mockReadProject.mockResolvedValue({ hooks: {} })
    render(<HooksSection cwd="/repo" />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("scope-project"))
    await waitFor(() => expect(mockReadProject).toHaveBeenCalledWith("/repo"))
  })

  it("disables project + local scopes when no cwd is provided", async () => {
    mockReadUser.mockResolvedValue({})
    render(<HooksSection />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())
    expect(screen.getByTestId("scope-project")).toBeDisabled()
    expect(screen.getByTestId("scope-local")).toBeDisabled()
  })

  it("toasts an error when the read fails", async () => {
    mockReadUser.mockRejectedValue(new Error("nope"))
    render(<HooksSection />)
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })
})

describe("HooksSection — editing + save", () => {
  it("threads runtime-proven handler capabilities into newly added groups", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    const runtimeCapabilities = {
      ...knownHookRuntimeCapabilities("claude"),
      handlerTypes: ["http"] as const,
      probed: true,
    }
    render(<HooksSection runtimeCapabilities={runtimeCapabilities} />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("hooks-add-group"))
    fireEvent.click(screen.getByTestId("group-add-handler"))
    expect(screen.getByTestId("hook-handler-form")).toHaveAttribute("data-handler-type", "http")
  })

  it("adding a group bumps the active event count badge and dirties the form", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    render(<HooksSection />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("hooks-add-group"))
    expect(screen.getByTestId("hooks-save")).not.toBeDisabled()
    expect(screen.getAllByTestId("hook-group-editor")).toHaveLength(1)
  })

  it("save uses the user writer and round-trips the rest of the doc untouched", async () => {
    mockReadUser.mockResolvedValue({
      model: "sonnet",
      permissions: { ask: ["Bash"] },
      hooks: {},
      extra: { customKey: "preserved" },
    })
    mockWriteUser.mockResolvedValue({ path: "/u/.claude/settings.json", backupPath: null })
    render(<HooksSection />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("hooks-add-group"))
    await waitFor(() => expect(screen.getByTestId("hooks-save")).not.toBeDisabled())
    fireEvent.click(screen.getByTestId("hooks-save"))

    await waitFor(() => expect(mockWriteUser).toHaveBeenCalled())
    const payload = mockWriteUser.mock.calls[0][0]
    expect(payload.model).toBe("sonnet")
    expect(payload.permissions).toEqual({ ask: ["Bash"] })
    expect(payload.extra).toEqual({ customKey: "preserved" })
    expect(payload.hooks.PreToolUse).toBeDefined()
    expect(toastSuccess).toHaveBeenCalledWith("saved")
  })

  it("save uses the project writer with the cwd when scope is project", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    mockReadProject.mockResolvedValue({ hooks: {} })
    mockWriteProject.mockResolvedValue({ path: "/repo/.claude/settings.json", backupPath: null })
    render(<HooksSection cwd="/repo" />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("scope-project"))
    await waitFor(() => expect(mockReadProject).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("hooks-add-group"))
    await waitFor(() => expect(screen.getByTestId("hooks-save")).not.toBeDisabled())
    fireEvent.click(screen.getByTestId("hooks-save"))
    await waitFor(() => expect(mockWriteProject).toHaveBeenCalled())
    expect(mockWriteProject.mock.calls[0][0]).toBe("/repo")
  })

  it("save uses the local writer with the cwd when scope is local", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    mockReadLocal.mockResolvedValue({ hooks: {} })
    mockWriteLocal.mockResolvedValue({
      path: "/repo/.claude/settings.local.json",
      backupPath: null,
    })
    render(<HooksSection cwd="/repo" />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("scope-local"))
    await waitFor(() => expect(mockReadLocal).toHaveBeenCalledWith("/repo"))

    fireEvent.click(screen.getByTestId("hooks-add-group"))
    await waitFor(() => expect(screen.getByTestId("hooks-save")).not.toBeDisabled())
    fireEvent.click(screen.getByTestId("hooks-save"))
    await waitFor(() => expect(mockWriteLocal).toHaveBeenCalled())
    expect(mockWriteLocal.mock.calls[0][0]).toBe("/repo")
  })

  it("save remains disabled when a group has invalid matcher regex", async () => {
    mockReadUser.mockResolvedValue({
      hooks: { PreToolUse: [{ matcher: "[bad", hooks: [] }] },
    })
    render(<HooksSection />)
    await waitFor(() => expect(screen.getAllByTestId("hook-group-editor")).toHaveLength(1))

    // Dirty the form so save would otherwise enable.
    fireEvent.click(screen.getByTestId("hooks-add-group"))
    expect(screen.getByTestId("hooks-save")).toBeDisabled()
  })

  it("revert restores the last-saved hooks block", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    render(<HooksSection />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("hooks-add-group"))
    expect(screen.getAllByTestId("hook-group-editor")).toHaveLength(1)
    fireEvent.click(screen.getByTestId("hooks-revert"))
    expect(screen.queryAllByTestId("hook-group-editor")).toHaveLength(0)
  })

  it("toasts on write failure and leaves dirty state intact for a retry", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    mockWriteUser.mockRejectedValue(new Error("io"))
    render(<HooksSection />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("hooks-add-group"))
    fireEvent.click(screen.getByTestId("hooks-save"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // Dirty marker still set: button should not be disabled (modulo invalid-state).
    await waitFor(() => expect(screen.getByTestId("hooks-save")).not.toBeDisabled())
  })

  it("removing the only group for an event drops the event from the payload", async () => {
    mockReadUser.mockResolvedValue({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }],
      },
    })
    mockWriteUser.mockResolvedValue({ path: "/u" })
    render(<HooksSection />)
    await waitFor(() => expect(screen.getAllByTestId("hook-group-editor")).toHaveLength(1))

    fireEvent.click(screen.getByTestId("group-remove"))
    await waitFor(() => expect(screen.queryByTestId("hook-group-editor")).not.toBeInTheDocument())
    fireEvent.click(screen.getByTestId("hooks-save"))
    await waitFor(() => expect(mockWriteUser).toHaveBeenCalled())
    const payload = mockWriteUser.mock.calls[0][0]
    expect(payload.hooks).toBeUndefined()
  })
})

describe("HooksSection — runtime event annotations", () => {
  it("does not mark SDK-native events as dormant", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    render(<HooksSection />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    expect(screen.queryByTestId("event-no-trigger-WorktreeCreate")).not.toBeInTheDocument()
    expect(screen.queryByTestId("event-no-trigger-PostToolUse")).not.toBeInTheDocument()
  })

  it("does not show a dormant note for SDK-native lifecycle events", async () => {
    searchString = "hookTab=WorktreeCreate"
    mockReadUser.mockResolvedValue({ hooks: {} })
    render(<HooksSection />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())
    expect(screen.queryByTestId("hooks-no-trigger-note")).not.toBeInTheDocument()
  })
})

describe("HooksSection — category grouping + event description", () => {
  it("renders a section per lifecycle category", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    render(<HooksSection />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    for (const cat of ["tools", "session", "permissions", "tasks", "lifecycle"]) {
      expect(screen.getByTestId(`event-category-${cat}`)).toBeInTheDocument()
    }
    // Every event still gets its own tab inside the right section.
    expect(screen.getByTestId("event-tab-PreToolUse")).toBeInTheDocument()
    expect(screen.getByTestId("event-tab-WorktreeCreate")).toBeInTheDocument()
  })

  it("shows the active event's localized label + description", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    render(<HooksSection />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    // The local next-intl mock echoes the key, proving the catalog-derived
    // i18n path (not a raw event id) drives both the heading and the subtitle.
    expect(screen.getByTestId("hooks-active-event").textContent).toBe("events.PreToolUse.label")
    expect(screen.getByTestId("hooks-active-event-desc").textContent).toBe("events.PreToolUse.desc")
  })
})

describe("HooksSection — URL-driven event tab", () => {
  it("respects ?hookTab=PostToolUse on initial render", async () => {
    searchString = "hookTab=PostToolUse"
    mockReadUser.mockResolvedValue({ hooks: { PostToolUse: [{ matcher: "x", hooks: [] }] } })
    render(<HooksSection />)
    // Wait for the editor for PostToolUse to render — proves both that the
    // read settled AND the URL-driven activeEvent picked up.
    await waitFor(() => expect(screen.getAllByTestId("hook-group-editor")).toHaveLength(1))
    expect(screen.getByTestId("event-tab-PostToolUse").dataset.active).toBe("true")
  })

  it("clicking another event tab updates the URL via router.replace", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    render(<HooksSection />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("event-tab-Stop"))
    await waitFor(() => expect(replaceMock).toHaveBeenCalled())
    const arg0 = replaceMock.mock.calls[replaceMock.mock.calls.length - 1][0] as string
    expect(arg0).toContain("hookTab=Stop")
  })
})

describe("HooksSection — unsaved-changes guard + feedback", () => {
  it("switches scope immediately when the draft is clean", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    mockReadProject.mockResolvedValue({ hooks: {} })
    render(<HooksSection cwd="/repo" />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("scope-project"))
    await waitFor(() => expect(mockReadProject).toHaveBeenCalledWith("/repo"))
    expect(screen.queryByTestId("hooks-scope-confirm")).not.toBeInTheDocument()
  })

  it("confirms before discarding unsaved edits on a scope switch", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    mockReadProject.mockResolvedValue({ hooks: {} })
    render(<HooksSection cwd="/repo" />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("hooks-add-group")) // dirty
    fireEvent.click(screen.getByTestId("scope-project"))

    // The confirm dialog appears and the new scope is NOT read yet.
    expect(await screen.findByTestId("hooks-scope-confirm")).toBeInTheDocument()
    expect(mockReadProject).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("hooks-scope-discard"))
    await waitFor(() => expect(mockReadProject).toHaveBeenCalledWith("/repo"))
  })

  it("cancelling the scope switch keeps the draft intact", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    render(<HooksSection cwd="/repo" />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId("hooks-add-group"))
    expect(screen.getAllByTestId("hook-group-editor")).toHaveLength(1)

    fireEvent.click(screen.getByTestId("scope-project"))
    fireEvent.click(await screen.findByTestId("hooks-scope-cancel"))

    expect(mockReadProject).not.toHaveBeenCalled()
    // Draft survived — the added group is still there.
    expect(screen.getAllByTestId("hook-group-editor")).toHaveLength(1)
  })

  it("shows the unsaved indicator only while the draft is dirty", async () => {
    mockReadUser.mockResolvedValue({ hooks: {} })
    render(<HooksSection />)
    await waitFor(() => expect(mockReadUser).toHaveBeenCalled())

    expect(screen.queryByTestId("hooks-unsaved")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("hooks-add-group"))
    expect(screen.getByTestId("hooks-unsaved")).toBeInTheDocument()
  })

  it("summarises the configured group count in a badge", async () => {
    mockReadUser.mockResolvedValue({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [] }],
        Stop: [{ matcher: "", hooks: [] }],
      },
    })
    render(<HooksSection />)
    await waitFor(() => expect(screen.getByTestId("hooks-summary")).toBeInTheDocument())
    expect(screen.getByTestId("hooks-summary").textContent).toContain("2")
  })

  it("blocks save when a handler command is empty", async () => {
    mockReadUser.mockResolvedValue({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "" }] }],
      },
    })
    render(<HooksSection />)
    await waitFor(() => expect(screen.getAllByTestId("hook-group-editor")).toHaveLength(1))

    // Dirty the form so save would otherwise enable.
    fireEvent.click(screen.getByTestId("hooks-add-group"))
    expect(screen.getByTestId("hooks-save")).toBeDisabled()
  })
})
