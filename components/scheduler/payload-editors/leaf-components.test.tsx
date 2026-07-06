/**
 * @jest-environment jsdom
 *
 * Component tests for the leaf payload-editor primitives:
 *   - PermissionModeSelect (sdk + acp flavours)
 *   - BuiltinToolsToggles
 *   - AdditionalDirectoriesList
 *   - ToolPicker
 *   - McpPicker
 *
 * The composed `ChatPayloadEditor` and `ExternalAgentPayloadEditor` shells
 * pull in DB hooks (listCharacters / listSkills / listTeams / external-agent
 * manager) — those are exercised separately via the structured-pane
 * integration test on TaskForm. Here we keep the units narrow.
 */

import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"
import { PermissionModeSelect } from "./permission-mode-select"
import { BuiltinToolsToggles } from "./builtin-tools-toggles"
import { AdditionalDirectoriesList } from "./additional-directories-list"
import { ToolPicker } from "./tool-picker"
import { McpPicker } from "./mcp-picker"
import { ExternalAgentPayloadEditor } from "./external-agent-payload-editor"
import type { ExternalAgentDraft } from "./types"
import type { BuiltinToolsConfig, McpServer } from "@/lib/claude/types"

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

const messages = {
  scheduler: {
    permissionModeUseDefault: "Use default",
    permissionModes: {
      default: "Default",
      acceptEdits: "Auto-accept edits",
      bypassPermissions: "Bypass",
      plan: "Plan",
      dontAsk: "Don't ask",
    },
    builtinTools: {
      useDefault: "Use app default",
      forceOn: "Force on",
      forceOff: "Force off",
      labels: {
        fileExtras: "File extras",
        git: "Git",
        process: "Process",
        environment: "Environment",
        shellAdvanced: "Shell advanced",
      },
      help: {
        fileExtras: "fe help",
        git: "git help",
        process: "p help",
        environment: "env help",
        shellAdvanced: "sh help",
      },
    },
    tools: {
      customLabel: "Custom",
      addCustomLabel: "Add custom",
      addCustomPlaceholder: "tool name",
      add: "Add",
      remove: "Remove",
    },
    mcp: {
      modes: {
        default: { label: "Default mode", help: "default help" },
        custom: { label: "Custom mode", help: "custom help" },
      },
      serverListLabel: "Server list",
      loading: "Loading",
      empty: "No servers",
      disabledNote: "disabled",
    },
    additionalDirectories: {
      empty: "no dirs",
      placeholder: "path",
      pickFolder: "pick",
      remove: "remove",
      add: "add dir",
    },
  },
  common: {},
}

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  )
}

// ===========================================================================
// PermissionModeSelect
// ===========================================================================

describe("PermissionModeSelect", () => {
  function Harness(props: { flavor?: "sdk" | "acp" }) {
    const [v, setV] = useState<string | undefined>(undefined)
    return (
      <PermissionModeSelect
        flavor={props.flavor ?? "sdk"}
        value={v}
        onChange={setV}
        testId="pm-select"
      />
    )
  }

  it("renders the 'Use default' label by default", () => {
    render(withIntl(<Harness />))
    expect(screen.getByTestId("pm-select")).toHaveTextContent("Use default")
  })

  it("renders the ACP-specific 'dontAsk' option when flavor=acp", () => {
    render(withIntl(<Harness flavor="acp" />))
    fireEvent.click(screen.getByTestId("pm-select"))
    // Radix renders the listbox in a portal — pull from document.body.
    // Global jest mock pulls translations from `i18n/messages/en.json` rather
    // than the local `messages` fixture: the canonical English label is
    // "Don't ask (deny if not pre-approved)".
    expect(screen.getByText(/don't ask/i)).toBeInTheDocument()
  })

  it("narrows options to the backend's supported modes when a protocol is given", () => {
    function ProtocolHarness() {
      const [v, setV] = useState<string | undefined>(undefined)
      return (
        <PermissionModeSelect
          protocol="codex-app-server"
          value={v}
          onChange={setV}
          testId="pm-select"
        />
      )
    }
    render(withIntl(<ProtocolHarness />))
    fireEvent.click(screen.getByTestId("pm-select"))
    // Codex has no `dontAsk`, so it must not appear, while `bypassPermissions` does.
    expect(screen.queryByText(/don't ask/i)).not.toBeInTheDocument()
    expect(screen.getByText(/bypass/i)).toBeInTheDocument()
  })
})

// ===========================================================================
// ExternalAgentPayloadEditor — protocol-aware permission clamping
// ===========================================================================

describe("ExternalAgentPayloadEditor permission adaptation", () => {
  function Harness() {
    const [draft, setDraft] = useState<ExternalAgentDraft>({
      prompt: "do it",
      agentId: "",
      permissionMode: "dontAsk",
    })
    return (
      <>
        <ExternalAgentPayloadEditor
          draft={draft}
          onDraftChange={setDraft}
          agentsForTesting={[{ id: "cdx", name: "Codex", protocol: "codex-app-server" }]}
        />
        <span data-testid="effective-mode">{draft.permissionMode ?? "none"}</span>
      </>
    )
  }

  it("clamps an unsupported mode to the nearest supported one when the agent is selected", () => {
    render(withIntl(<Harness />))
    // Selecting the Codex agent (no `dontAsk`) clamps the draft down to `plan`.
    fireEvent.click(screen.getByTestId("external-agent-payload-editor-agent-select"))
    fireEvent.click(screen.getByText(/Codex/))
    expect(screen.getByTestId("effective-mode")).toHaveTextContent("plan")
  })
})

// ===========================================================================
// BuiltinToolsToggles
// ===========================================================================

describe("BuiltinToolsToggles", () => {
  function Harness() {
    const [v, setV] = useState<Partial<BuiltinToolsConfig> | undefined>(undefined)
    return <BuiltinToolsToggles value={v} onChange={setV} testId="bt-toggles" />
  }

  it("renders all five toggle rows", () => {
    render(withIntl(<Harness />))
    expect(screen.getByTestId("bt-toggles-fileExtras")).toBeInTheDocument()
    expect(screen.getByTestId("bt-toggles-git")).toBeInTheDocument()
    expect(screen.getByTestId("bt-toggles-process")).toBeInTheDocument()
    expect(screen.getByTestId("bt-toggles-environment")).toBeInTheDocument()
    expect(screen.getByTestId("bt-toggles-shellAdvanced")).toBeInTheDocument()
  })

  it("calls onChange with a Partial when a toggle is set, and undefined when reset", () => {
    const onChange = jest.fn()
    render(withIntl(<BuiltinToolsToggles value={{ git: true }} onChange={onChange} testId="bt" />))
    // Open the git select and click "Force off"
    fireEvent.click(screen.getByTestId("bt-git"))
    const offOptions = screen.getAllByText("Force off")
    fireEvent.click(offOptions[0])
    expect(onChange).toHaveBeenCalledWith({ git: false })
  })

  it("clearing the only key returns undefined", () => {
    const onChange = jest.fn()
    render(withIntl(<BuiltinToolsToggles value={{ git: true }} onChange={onChange} testId="bt" />))
    fireEvent.click(screen.getByTestId("bt-git"))
    // The dropdown is rendered into a portal — pick the option with role.
    const opt = screen.getAllByRole("option", { name: "Use app default" })[0]
    fireEvent.click(opt)
    expect(onChange).toHaveBeenCalledWith(undefined)
  })
})

// ===========================================================================
// AdditionalDirectoriesList
// ===========================================================================

describe("AdditionalDirectoriesList", () => {
  function Harness() {
    const [v, setV] = useState<string[] | undefined>(undefined)
    return <AdditionalDirectoriesList value={v} onChange={setV} testId="ad" />
  }

  it("shows empty hint when no rows", () => {
    render(withIntl(<Harness />))
    expect(screen.getByText("No additional directories.")).toBeInTheDocument()
  })

  it("adds a row when 'add dir' is clicked and removes it on remove", () => {
    render(withIntl(<Harness />))
    fireEvent.click(screen.getByTestId("ad-add"))
    expect(screen.getByTestId("ad-row-0")).toBeInTheDocument()

    // Remove it
    fireEvent.click(screen.getByTestId("ad-remove-0"))
    expect(screen.queryByTestId("ad-row-0")).not.toBeInTheDocument()
  })

  it("edits a row in place", () => {
    const onChange = jest.fn()
    render(withIntl(<AdditionalDirectoriesList value={[""]} onChange={onChange} testId="ad" />))
    fireEvent.change(screen.getByTestId("ad-row-0"), { target: { value: "/foo" } })
    expect(onChange).toHaveBeenLastCalledWith(["/foo"])
  })
})

// ===========================================================================
// ToolPicker
// ===========================================================================

describe("ToolPicker", () => {
  function Harness() {
    const [v, setV] = useState<string[] | undefined>(undefined)
    return <ToolPicker value={v} onChange={setV} testId="tp" />
  }

  it("renders all built-in tool checkboxes", () => {
    render(withIntl(<Harness />))
    expect(screen.getByTestId("tp-builtin-Read")).toBeInTheDocument()
    expect(screen.getByTestId("tp-builtin-Bash")).toBeInTheDocument()
  })

  it("toggles a built-in tool on", () => {
    const onChange = jest.fn()
    render(withIntl(<ToolPicker value={undefined} onChange={onChange} testId="tp" />))
    fireEvent.click(screen.getByTestId("tp-builtin-Read"))
    expect(onChange).toHaveBeenLastCalledWith(["Read"])
  })

  it("removes a built-in tool when toggled off", () => {
    const onChange = jest.fn()
    render(withIntl(<ToolPicker value={["Read"]} onChange={onChange} testId="tp" />))
    fireEvent.click(screen.getByTestId("tp-builtin-Read"))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it("adds and removes custom tool names", () => {
    function Adder() {
      const [v, setV] = useState<string[] | undefined>(undefined)
      return <ToolPicker value={v} onChange={setV} testId="tp" />
    }
    render(withIntl(<Adder />))
    fireEvent.change(screen.getByTestId("tp-add-input"), {
      target: { value: "mcp__notion__search" },
    })
    fireEvent.click(screen.getByTestId("tp-add-button"))
    expect(screen.getByTestId("tp-custom-mcp__notion__search")).toBeInTheDocument()
    // Click the X
    const tag = screen.getByTestId("tp-custom-mcp__notion__search")
    const removeBtn = within(tag).getByRole("button")
    fireEvent.click(removeBtn)
    expect(screen.queryByTestId("tp-custom-mcp__notion__search")).not.toBeInTheDocument()
  })

  it("ignores duplicate custom names", () => {
    const onChange = jest.fn()
    render(withIntl(<ToolPicker value={["mcp__notion__search"]} onChange={onChange} testId="tp" />))
    fireEvent.change(screen.getByTestId("tp-add-input"), {
      target: { value: "mcp__notion__search" },
    })
    fireEvent.click(screen.getByTestId("tp-add-button"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("supports Enter to add", () => {
    const onChange = jest.fn()
    render(withIntl(<ToolPicker value={undefined} onChange={onChange} testId="tp" />))
    const input = screen.getByTestId("tp-add-input")
    fireEvent.change(input, { target: { value: "X" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith(["X"])
  })
})

// ===========================================================================
// McpPicker
// ===========================================================================

describe("McpPicker", () => {
  const servers: McpServer[] = [
    {
      id: "a",
      name: "alpha",
      transport: "stdio",
      enabled: true,
      config: {},
    } as unknown as McpServer,
    {
      id: "b",
      name: "beta",
      transport: "http",
      enabled: false,
      config: {},
    } as unknown as McpServer,
  ]

  function Harness(props: { initialMode?: "default" | "custom" }) {
    const [mode, setMode] = useState<"default" | "custom">(props.initialMode ?? "default")
    const [ids, setIds] = useState<string[] | undefined>(undefined)
    return (
      <McpPicker
        mode={mode}
        onModeChange={setMode}
        value={ids}
        onChange={setIds}
        serversForTesting={servers}
        testId="mcp"
      />
    )
  }

  it("renders the two radio modes", () => {
    render(withIntl(<Harness />))
    expect(screen.getByTestId("mcp-mode-default")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-mode-custom")).toBeInTheDocument()
  })

  it("shows the server list when in custom mode", () => {
    render(withIntl(<Harness initialMode="custom" />))
    expect(screen.getByTestId("mcp-server-a")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-server-b")).toBeInTheDocument()
  })

  it("disables the checkbox for a disabled server", () => {
    render(withIntl(<Harness initialMode="custom" />))
    const cb = screen.getByTestId("mcp-server-b")
    expect(cb).toBeDisabled()
  })

  it("renders empty state when serversForTesting is empty", () => {
    render(
      withIntl(
        <McpPicker
          mode="custom"
          onModeChange={() => undefined}
          value={undefined}
          onChange={() => undefined}
          serversForTesting={[]}
          testId="mcp"
        />
      )
    )
    expect(screen.getByText("No MCP servers configured.")).toBeInTheDocument()
  })
})
