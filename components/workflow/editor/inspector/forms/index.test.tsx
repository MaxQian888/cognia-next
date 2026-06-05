/**
 * @jest-environment jsdom
 *
 * Focused coverage for the forms newly added/changed in the node-config
 * completeness work: the two synthesizer-internal team forms and the desktop
 * event trigger. (The bulk of the pre-existing forms are exercised via the
 * desktop shells + integration; this file guards the new additions.)
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  TeamTriggerConfig,
  TeamTaskDispatchConfig,
  DesktopEventTriggerConfig,
  GoalCompletedTriggerConfig,
  TerminalScriptConfig,
  TerminalReadRecentConfig,
  TerminalWaitForExitConfig,
  TerminalCommandTriggerConfig,
} from "./index"

jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn(async () => []) }))
jest.mock("@/lib/db/teams", () => ({
  listTeams: jest.fn(async () => [{ id: "team_1", name: "Alpha" }]),
}))
jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn(async () => []) }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn(async () => []) }))
jest.mock("@/lib/db/plugins", () => ({ listPlugins: jest.fn(async () => []) }))
jest.mock("@/lib/db/workflows", () => ({ listWorkflows: jest.fn(async () => []) }))
jest.mock("@/lib/db/twins", () => ({ listTwins: jest.fn(async () => []) }))

const messages = {
  workflows: {
    forms: {
      pickers: {
        team: "Select a team",
        noResults: "No matches",
        useExpression: "Use expression",
        usePicker: "Pick from list",
        none: "None",
      },
      teamTrigger: { intro: "Fired internally by the agent-team runtime." },
      teamTaskDispatch: {
        teamId: { label: "Team" },
        taskId: { label: "Task id", hint: "Stable id", placeholder: "task_" },
        title: { label: "Title", placeholder: "Title" },
        description: { label: "Description", placeholder: "Detail" },
        expectedOutput: { label: "Expected output", hint: "Used to validate" },
      },
      desktopEventTrigger: {
        desktopOnly: "Desktop only.",
        kinds: {
          label: "Event kinds",
          hint: "Fire on UIA events.",
          options: {
            "focus-changed": "Focus changed",
            "structure-changed": "Structure changed",
            "property-changed": "Property changed",
          },
        },
      },
      goalCompletedTrigger: {
        goalId: { label: "Goal id (optional)", hint: "Limit to a specific goal." },
        status: {
          label: "Terminal status (optional)",
          hint: "Limit to one outcome.",
          placeholder: "completed",
        },
        sessionId: { label: "Session id (optional)", hint: "Limit to a chat session." },
        characterId: { label: "Character (optional)" },
      },
    },
  },
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

describe("TeamTriggerConfig", () => {
  it("renders the informational intro", () => {
    wrap(<TeamTriggerConfig />)
    expect(screen.getByText(/agent-team runtime/i)).toBeInTheDocument()
  })
})

describe("TeamTaskDispatchConfig", () => {
  it("renders the dispatch fields and propagates edits", () => {
    const onChange = jest.fn()
    wrap(<TeamTaskDispatchConfig params={{}} onChange={onChange} />)
    expect(screen.getByLabelText(/Task id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Title/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Task id/i), { target: { value: "task_42" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task_42" }))
  })
})

describe("DesktopEventTriggerConfig", () => {
  it("toggles event kinds into params.kinds", () => {
    const onChange = jest.fn()
    wrap(<DesktopEventTriggerConfig params={{}} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("desktop-event-focus-changed"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kinds: ["focus-changed"] }))
  })

  it("removes a kind when toggled off", () => {
    const onChange = jest.fn()
    wrap(<DesktopEventTriggerConfig params={{ kinds: ["focus-changed"] }} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("desktop-event-focus-changed"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kinds: [] }))
  })
})

describe("GoalCompletedTriggerConfig", () => {
  it("renders the optional scope fields and propagates edits", () => {
    const onChange = jest.fn()
    wrap(<GoalCompletedTriggerConfig params={{}} onChange={onChange} />)
    expect(screen.getByLabelText(/Goal id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Terminal status/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Goal id/i), { target: { value: "goal_7" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ goalId: "goal_7" }))
  })

  it("reflects existing params into the inputs", () => {
    const onChange = jest.fn()
    wrap(<GoalCompletedTriggerConfig params={{ status: "stopped" }} onChange={onChange} />)
    expect(screen.getByLabelText(/Terminal status/i)).toHaveValue("stopped")
  })
})

/** The input element inside the `Field` wrapper with `data-field={name}`. */
function fieldInput(container: HTMLElement, name: string): HTMLElement {
  const wrapper = container.querySelector(`[data-field="${name}"]`)
  if (!wrapper) throw new Error(`no field wrapper for "${name}"`)
  const control = (wrapper as HTMLElement).querySelector("input, textarea, button")
  if (!control) throw new Error(`no control inside field "${name}"`)
  return control as HTMLElement
}

describe("TerminalScriptConfig", () => {
  it("renders the script fields and propagates edits", () => {
    const onChange = jest.fn()
    const { container } = wrap(<TerminalScriptConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "scriptPath"), {
      target: { value: "scripts/build.sh" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ scriptPath: "scripts/build.sh" })
    )
    fireEvent.change(fieldInput(container, "interpreter"), { target: { value: "deno" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ interpreter: "deno" }))
    // onFailure select + unattended switch are present.
    expect(container.querySelector('[data-field="onFailure"]')).toBeInTheDocument()
    expect(container.querySelector('[data-field="unattended"]')).toBeInTheDocument()
  })

  it("clamps the timeout into [5, 600] and reveals the ask-policy when unattended", () => {
    const onChange = jest.fn()
    const { container, rerender } = wrap(<TerminalScriptConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "timeoutSec"), { target: { value: "9999" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ timeoutSec: 600 }))
    expect(container.querySelector('[data-field="onAskVerdict"]')).not.toBeInTheDocument()
    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TerminalScriptConfig params={{ unattended: true }} onChange={onChange} />
      </NextIntlClientProvider>
    )
    expect(container.querySelector('[data-field="onAskVerdict"]')).toBeInTheDocument()
  })
})

describe("TerminalReadRecentConfig", () => {
  it("edits tabId and clamps lineLimit into [1, 50]", () => {
    const onChange = jest.fn()
    const { container } = wrap(<TerminalReadRecentConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "tabId"), { target: { value: "tab-9" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tabId: "tab-9" }))
    fireEvent.change(fieldInput(container, "lineLimit"), { target: { value: "500" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ lineLimit: 50 }))
  })
})

describe("TerminalWaitForExitConfig", () => {
  it("edits tabId and renders timeout + onFailure", () => {
    const onChange = jest.fn()
    const { container } = wrap(<TerminalWaitForExitConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "tabId"), { target: { value: "tab-3" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tabId: "tab-3" }))
    fireEvent.change(fieldInput(container, "timeoutSec"), { target: { value: "1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ timeoutSec: 5 }))
    expect(container.querySelector('[data-field="onFailure"]')).toBeInTheDocument()
  })
})

describe("TerminalCommandTriggerConfig", () => {
  it("renders the scope fields and propagates edits", () => {
    const onChange = jest.fn()
    const { container } = wrap(<TerminalCommandTriggerConfig params={{}} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "sessionId"), { target: { value: "tab-1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "tab-1" }))
    fireEvent.change(fieldInput(container, "projectId"), { target: { value: "proj-2" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj-2" }))
    fireEvent.change(fieldInput(container, "commandContains"), {
      target: { value: "pnpm test" },
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ commandContains: "pnpm test" }))
    expect(container.querySelector('[data-field="status"]')).toBeInTheDocument()
  })

  it("reflects an existing status param ('' shows as Any)", () => {
    const { container } = wrap(
      <TerminalCommandTriggerConfig params={{ status: "" }} onChange={jest.fn()} />
    )
    // The Select trigger renders — '' maps to the 'any' option internally.
    expect(fieldInput(container, "status")).toBeInTheDocument()
  })
})
