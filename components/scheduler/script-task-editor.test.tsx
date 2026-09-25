/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

// Records every key the editor asks for, so the catalog check below sees
// exactly what renders. The echo translator alone hid twelve missing keys:
// the component's `t(key) || "English"` fallbacks never fired either,
// because next-intl answers a miss with the key path, which is truthy.
const requestedKeys = new Set<string>()
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    requestedKeys.add(`${namespace}.${key}`)
    return key
  },
}))

const validateScript: jest.Mock = jest.fn(() => ({ valid: true, errors: [], warnings: [] }))
const getScriptTemplate: jest.Mock = jest.fn(() => "// template\n")
jest.mock("@/lib/scheduler/script-executor", () => ({
  validateScript: (lang: unknown, code: unknown) => validateScript(lang, code),
  getScriptTemplate: (lang: unknown) => getScriptTemplate(lang),
}))

// Stub Select + Switch + Collapsible to render inline.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <select
      data-testid="lang-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}))

jest.mock("@/components/ui/switch")

jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean
    onOpenChange?: (v: boolean) => void
    children: React.ReactNode
  }) => (
    <div data-testid="collapsible" data-open={open}>
      <button data-testid="collapsible-toggle" onClick={() => onOpenChange?.(!open)}>
        toggle
      </button>
      {open ? children : null}
    </div>
  ),
  CollapsibleTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { ScriptTaskEditor } from "./script-task-editor"
import type { ExecuteScriptAction } from "@/types/scheduler"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

const baseValue: ExecuteScriptAction = {
  type: "execute_script",
  language: "javascript",
  code: 'console.log("hi")',
  timeout: 30,
  capture_output: true,
} as unknown as ExecuteScriptAction

beforeEach(() => {
  validateScript.mockClear()
  getScriptTemplate.mockClear()
})

describe("ScriptTaskEditor", () => {
  it("renders the language select with the current value", () => {
    render(<ScriptTaskEditor value={baseValue} onChange={jest.fn()} />)
    expect((screen.getByTestId("lang-select") as HTMLSelectElement).value).toBe("javascript")
  })

  it("invokes onChange when the script code changes and validates it", () => {
    const onChange = jest.fn()
    render(<ScriptTaskEditor value={baseValue} onChange={onChange} />)
    const codeArea = document.querySelector("textarea") as HTMLTextAreaElement
    fireEvent.change(codeArea, { target: { value: "new code" } })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ code: "new code", language: "javascript" })
    )
    expect(validateScript).toHaveBeenCalled()
  })

  it("loads a template when language changes and code is empty", () => {
    const onChange = jest.fn()
    render(<ScriptTaskEditor value={{ ...baseValue, code: "" }} onChange={onChange} />)
    const select = screen.getByTestId("lang-select") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "python" } })
    expect(getScriptTemplate).toHaveBeenCalledWith("python")
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ language: "python", code: "// template\n" })
    )
  })

  it("keeps existing code when language changes and code is non-empty", () => {
    const onChange = jest.fn()
    getScriptTemplate.mockClear()
    render(<ScriptTaskEditor value={baseValue} onChange={onChange} />)
    fireEvent.change(screen.getByTestId("lang-select"), { target: { value: "powershell" } })
    // The component preserves existing code instead of asking for a template.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ language: "powershell", code: baseValue.code })
    )
  })

  it("disables interaction when disabled is true", () => {
    render(<ScriptTaskEditor value={baseValue} onChange={jest.fn()} disabled />)
    expect((screen.getByTestId("lang-select") as HTMLSelectElement).disabled).toBe(true)
  })

  it("renders the Test button when onTest is supplied", () => {
    const onTest = jest.fn()
    render(<ScriptTaskEditor value={baseValue} onChange={jest.fn()} onTest={onTest} />)
    fireEvent.click(screen.getByRole("button", { name: /scriptEditor\.test/ }))
    expect(onTest).toHaveBeenCalled()
  })

  it("ties each text field to its label", () => {
    render(<ScriptTaskEditor value={baseValue} onChange={jest.fn()} />)
    fireEvent.click(screen.getByTestId("collapsible-toggle"))
    for (const label of [
      "scriptEditor.code",
      "scriptEditor.timeoutSeconds",
      "scriptEditor.memoryLimitMb",
      "scriptEditor.workingDirectory",
      "scriptEditor.args",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument()
    }
  })

  it("asks only for keys both catalogs have", () => {
    requestedKeys.clear()
    render(<ScriptTaskEditor value={baseValue} onChange={jest.fn()} onTest={jest.fn()} />)
    fireEvent.click(screen.getByTestId("collapsible-toggle"))
    const lookup = (messages: unknown, key: string) =>
      key
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages)
    expect(requestedKeys.size).toBeGreaterThan(10)
    for (const key of requestedKeys) {
      expect([key, typeof lookup(enMessages, key)]).toEqual([key, "string"])
      expect([key, typeof lookup(zhMessages, key)]).toEqual([key, "string"])
    }
  })
})
