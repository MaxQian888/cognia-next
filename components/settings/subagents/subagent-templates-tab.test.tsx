/**
 * @jest-environment jsdom
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { SubagentTemplatesTab } from "./subagent-templates-tab"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { BUILT_IN_SUBAGENT_TEMPLATES } from "@/types/agent/sub-agent"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("nanoid", () => ({ nanoid: () => "fixed-id" }))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
  },
}))

// Stub Select primitives so jsdom tests don't depend on Radix's pointer logic.
jest.mock("@/components/ui/select", () => {
  const Select = ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value?: string
    onValueChange?: (v: string) => void
  }) => (
    <select data-testid="select" value={value} onChange={(e) => onValueChange?.(e.target.value)}>
      {children}
    </select>
  )
  const SelectTrigger = ({ children }: { children: React.ReactNode }) => <>{children}</>
  const SelectValue = ({ children }: { children?: React.ReactNode }) => <>{children ?? null}</>
  const SelectContent = ({ children }: { children: React.ReactNode }) => <>{children}</>
  const SelectItem = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

beforeEach(() => {
  toastSuccess.mockReset()
  toastError.mockReset()
  // Reset store to seed templates only.
  useSubagentRuntimeStore.setState((s) => {
    const seeded: Record<string, (typeof BUILT_IN_SUBAGENT_TEMPLATES)[number]> = {}
    for (const t of BUILT_IN_SUBAGENT_TEMPLATES) seeded[t.id] = t
    return { ...s, templates: seeded, subAgents: {} }
  })
})

describe("SubagentTemplatesTab", () => {
  it("renders one row per built-in template", () => {
    render(<SubagentTemplatesTab />)
    for (const t of BUILT_IN_SUBAGENT_TEMPLATES) {
      expect(screen.getByTestId(`subagent-template-row-${t.id}`)).toBeInTheDocument()
    }
  })

  it("built-in rows are read-only (edit + delete buttons disabled)", () => {
    render(<SubagentTemplatesTab />)
    const id = BUILT_IN_SUBAGENT_TEMPLATES[0].id
    expect(screen.getByTestId(`edit-${id}`)).toBeDisabled()
    expect(screen.getByTestId(`delete-${id}`)).toBeDisabled()
  })

  it("Duplicate forks a built-in into an editable user copy and opens the editor", () => {
    render(<SubagentTemplatesTab />)
    const id = BUILT_IN_SUBAGENT_TEMPLATES[0].id
    fireEvent.click(screen.getByTestId(`duplicate-${id}`))
    // The forked copy lands in the store with id = "fixed-id" (nanoid mock).
    expect(useSubagentRuntimeStore.getState().templates["fixed-id"]?.isBuiltIn).toBe(false)
    // Editor opens automatically (form fields visible).
    expect(screen.getByTestId("subagent-template-editor")).toBeInTheDocument()
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("New template opens an empty editor and saves on submit with a fresh id", () => {
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("subagent-template-new"))

    const nameInput = screen.getByTestId("editor-name") as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "My agent" } })
    fireEvent.click(screen.getByTestId("editor-submit"))

    expect(useSubagentRuntimeStore.getState().templates["fixed-id"]?.name).toBe("My agent")
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("New template refuses an empty name (toast.error)", () => {
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("subagent-template-new"))
    fireEvent.click(screen.getByTestId("editor-submit"))
    expect(toastError).toHaveBeenCalled()
    // Store unchanged.
    expect(useSubagentRuntimeStore.getState().templates["fixed-id"]).toBeUndefined()
  })

  it("editing a user template patches it in the store", () => {
    // Seed a user template.
    useSubagentRuntimeStore.getState().addTemplate({
      id: "u",
      name: "Mine",
      description: "",
      category: "general",
      taskTemplate: "",
      config: {},
      isBuiltIn: false,
    })
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("edit-u"))
    fireEvent.change(screen.getByTestId("editor-name"), { target: { value: "Mine v2" } })
    fireEvent.click(screen.getByTestId("editor-submit"))
    expect(useSubagentRuntimeStore.getState().templates.u?.name).toBe("Mine v2")
  })

  it("deleting a user template removes it after confirming the alert", () => {
    useSubagentRuntimeStore.getState().addTemplate({
      id: "u",
      name: "Mine",
      description: "",
      category: "general",
      taskTemplate: "",
      config: {},
      isBuiltIn: false,
    })
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("delete-u"))
    // AlertDialog renders confirm action — use accessible role.
    const confirmButtons = screen.getAllByRole("button", { name: /delete/i })
    // Click the alert's Action button (last "delete" button is the confirm).
    fireEvent.click(confirmButtons[confirmButtons.length - 1])
    expect(useSubagentRuntimeStore.getState().templates.u).toBeUndefined()
  })
})
