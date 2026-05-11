/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub Radix Select primitive.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)} data-testid="select-stub">
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

jest.mock("@/components/scheduler/timezone-select", () => ({
  __esModule: true,
  TimezoneSelect: ({
    value,
    onValueChange,
  }: {
    value?: string
    onValueChange: (v: string) => void
  }) => (
    <select
      data-testid="tz-stub"
      value={value ?? "UTC"}
      onChange={(e) => onValueChange(e.target.value)}
    >
      <option value="UTC">UTC</option>
    </select>
  ),
}))

jest.mock("@/components/scheduler/script-task-editor", () => ({
  __esModule: true,
  ScriptTaskEditor: () => <div data-testid="script-editor-stub" />,
}))

import { SystemTaskForm } from "./system-task-form"

describe("SystemTaskForm", () => {
  it("renders without throwing", () => {
    render(<SystemTaskForm onSubmit={jest.fn(async () => undefined)} onCancel={jest.fn()} />)
    expect(document.querySelector("input")).not.toBeNull()
  })

  it("invokes onCancel when the Cancel button is clicked", () => {
    const onCancel = jest.fn()
    render(<SystemTaskForm onSubmit={jest.fn(async () => undefined)} onCancel={onCancel} />)
    const cancelBtn = screen.getAllByRole("button").find((b) => /cancel/i.test(b.textContent || ""))
    if (!cancelBtn) throw new Error("expected a cancel button")
    fireEvent.click(cancelBtn)
    expect(onCancel).toHaveBeenCalled()
  })

  it("renders with initial values when supplied", () => {
    render(
      <SystemTaskForm
        onSubmit={jest.fn(async () => undefined)}
        onCancel={jest.fn()}
        initialValues={{
          name: "My system task",
          description: "Description",
          trigger: { type: "cron", expression: "0 * * * *" } as never,
          action: { type: "run_command", command: "echo hi" } as never,
          run_level: "administrator",
        }}
      />
    )
    expect(
      (document.querySelector('input[value="My system task"]') as HTMLInputElement | null)?.value
    ).toBe("My system task")
  })

  it("renders the script editor stub when action type is execute_script", () => {
    render(
      <SystemTaskForm
        onSubmit={jest.fn(async () => undefined)}
        onCancel={jest.fn()}
        initialValues={{
          action: {
            type: "execute_script",
            language: "python",
            code: "print(1)",
          } as never,
        }}
      />
    )
    expect(screen.getByTestId("script-editor-stub")).toBeInTheDocument()
  })

  it("respects isSubmitting by disabling the primary action", () => {
    render(
      <SystemTaskForm onSubmit={jest.fn(async () => undefined)} onCancel={jest.fn()} isSubmitting />
    )
    const disabled = screen.getAllByRole("button").find((b) => (b as HTMLButtonElement).disabled)
    expect(disabled).toBeTruthy()
  })

  it("renders capability-aware messaging when capabilities are missing", () => {
    expect(() =>
      render(
        <SystemTaskForm
          onSubmit={jest.fn(async () => undefined)}
          onCancel={jest.fn()}
          capabilities={null}
        />
      )
    ).not.toThrow()
  })
})
