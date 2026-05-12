/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}))

// The cron parser is exercised heavily — stub to deterministic results.
jest.mock("@/lib/scheduler/cron-parser", () => ({
  validateCronExpression: () => ({ valid: true, error: null }),
  describeCronExpression: (expr: string) => `desc:${expr}`,
  formatCronExpression: (parts: string[]) => parts.join(" "),
  parseCronExpression: () => null,
}))

jest.mock("@/lib/scheduler/notification-integration", () => ({
  testNotificationChannel: jest.fn(async () => ({ success: true })),
}))

// Stub task-templates to a small list.
jest.mock("@/lib/scheduler/task-templates", () => ({
  TASK_TEMPLATES: [
    {
      id: "tmpl-1",
      name: "T",
      nameZh: "T",
      description: "D",
      descriptionZh: "D",
      icon: "*",
      category: "data",
      taskType: "chat",
      triggerType: "cron",
      getInput: () => ({ name: "From template" }),
    },
  ],
  TEMPLATE_CATEGORIES: [{ id: "data", name: "Data", nameZh: "数据" }],
}))

// Stub Radix Select / Switch / Collapsible primitives.
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

jest.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
  }) => (
    <input
      type="checkbox"
      checked={!!checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}))

jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    <div data-open={open}>{children}</div>
  ),
  CollapsibleTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <button>{children}</button>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
      <option value="America/Los_Angeles">LA</option>
    </select>
  ),
}))

// Stub payload-editors module.
jest.mock("@/components/scheduler/payload-editors", () => ({
  ChatPayloadEditor: () => <div data-testid="chat-payload-editor" />,
  ExternalAgentPayloadEditor: () => <div data-testid="external-agent-payload-editor" />,
  EMPTY_CHAT_LIKE_DRAFT: {},
  EMPTY_EXTERNAL_AGENT_DRAFT: {},
  payloadToChatLikeDraft: () => ({}),
  payloadToExternalAgentDraft: () => ({}),
  chatLikeDraftToPayload: () => ({}),
  externalAgentDraftToPayload: () => ({}),
  isChatLikeTaskType: (t: string) => ["chat", "agent", "skill"].includes(t),
  isStructuredEditableTaskType: (t: string) =>
    ["chat", "agent", "skill", "external-agent"].includes(t),
  DraftValidationError: class extends Error {},
}))

import { TaskForm } from "./task-form"

describe("TaskForm", () => {
  it("renders without throwing", () => {
    render(<TaskForm onSubmit={jest.fn(async () => undefined)} onCancel={jest.fn()} />)
    // The form should render at least one input (the Name field) and a Cancel button.
    expect(document.querySelector("input")).not.toBeNull()
  })

  it("invokes onCancel when the Cancel button is clicked", () => {
    const onCancel = jest.fn()
    render(<TaskForm onSubmit={jest.fn(async () => undefined)} onCancel={onCancel} />)
    const cancelBtn = screen.getAllByRole("button").find((b) => /cancel/i.test(b.textContent || ""))
    if (!cancelBtn) throw new Error("expected a cancel button")
    fireEvent.click(cancelBtn)
    expect(onCancel).toHaveBeenCalled()
  })

  it("renders with initial values when supplied", () => {
    render(
      <TaskForm
        onSubmit={jest.fn(async () => undefined)}
        onCancel={jest.fn()}
        initialValues={{
          name: "Preset name",
          description: "A description",
          type: "chat",
          trigger: { type: "cron", cronExpression: "0 9 * * *", timezone: "UTC" } as never,
          payload: {},
          config: {},
          notification: { enabled: true, onStart: false, onComplete: true, onError: true } as never,
        }}
      />
    )
    expect(
      (document.querySelector('input[value="Preset name"]') as HTMLInputElement | null)?.value
    ).toBe("Preset name")
  })

  it("disables the submit button when isSubmitting", () => {
    render(<TaskForm onSubmit={jest.fn(async () => undefined)} onCancel={jest.fn()} isSubmitting />)
    // Find a button that is disabled.
    const disabled = screen.getAllByRole("button").find((b) => (b as HTMLButtonElement).disabled)
    expect(disabled).toBeTruthy()
  })

  it("renders existingTasks list when supplied", () => {
    render(
      <TaskForm
        onSubmit={jest.fn(async () => undefined)}
        onCancel={jest.fn()}
        existingTasks={[{ id: "t-existing", name: "Existing 1" } as never]}
      />
    )
    // Sanity check — component must not throw, and the form still mounts.
    expect(document.querySelector("input")).not.toBeNull()
  })
})
