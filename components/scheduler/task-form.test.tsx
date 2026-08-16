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

jest.mock("@/components/ui/switch")

jest.mock("@/components/ui/collapsible")

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

  it("shows lifecycle and jitter controls for recurring triggers only", () => {
    const first = render(
      <TaskForm onSubmit={jest.fn(async () => undefined)} onCancel={jest.fn()} />
    )
    // Default trigger is cron — recurring controls present.
    expect(screen.getByTestId("scheduler-end-date-input")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-max-runs-input")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-jitter-input")).toBeInTheDocument()
    first.unmount()

    // Fresh mount with a one-time trigger — recurring controls absent.
    render(
      <TaskForm
        onSubmit={jest.fn(async () => undefined)}
        onCancel={jest.fn()}
        initialValues={{
          name: "Once task",
          type: "chat",
          trigger: { type: "once", runAt: new Date(Date.now() + 86_400_000) } as never,
        }}
      />
    )
    expect(screen.queryByTestId("scheduler-end-date-input")).not.toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-jitter-input")).not.toBeInTheDocument()
  })

  it("submits overlap policy, lifecycle bounds, and jitter", async () => {
    const onSubmit = jest.fn(async () => undefined)
    render(<TaskForm onSubmit={onSubmit} onCancel={jest.fn()} />)

    const nameInput = document.querySelector("input") as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "Policy task" } })
    fireEvent.change(screen.getByTestId("scheduler-end-date-input"), {
      target: { value: "2030-01-01" },
    })
    fireEvent.change(screen.getByTestId("scheduler-max-runs-input"), {
      target: { value: "5" },
    })
    fireEvent.change(screen.getByTestId("scheduler-jitter-input"), {
      target: { value: "30" },
    })

    fireEvent.click(screen.getByTestId("scheduler-task-submit"))
    await screen.findByTestId("scheduler-task-form")

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Policy task",
        endAt: expect.any(Date),
        trigger: expect.objectContaining({ jitterMs: 30_000 }),
        config: expect.objectContaining({
          overlapPolicy: "skip",
          allowConcurrent: false,
          maxRuns: 5,
        }),
      })
    )
  })

  // The `im` channel is only reachable if the toggle exists AND the typed
  // conversation reaches the submitted config — the whole point of wiring it.
  describe("IM notification channel", () => {
    it("hides the conversation field until the IM channel is selected", () => {
      render(<TaskForm onSubmit={jest.fn(async () => undefined)} onCancel={jest.fn()} />)
      expect(screen.queryByLabelText("notifyImConversation")).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole("button", { name: "im" }))
      expect(screen.getByLabelText("notifyImConversation")).toBeInTheDocument()
    })

    it("submits the typed conversation as the task's imTarget", async () => {
      const onSubmit = jest.fn(async () => undefined)
      render(<TaskForm onSubmit={onSubmit} onCancel={jest.fn()} />)

      fireEvent.change(document.querySelector("input") as HTMLInputElement, {
        target: { value: "Digest task" },
      })
      fireEvent.click(screen.getByRole("button", { name: "im" }))
      fireEvent.change(screen.getByLabelText("notifyImConversation"), {
        target: { value: " slack:ops:C1 " },
      })

      fireEvent.click(screen.getByTestId("scheduler-task-submit"))
      await screen.findByTestId("scheduler-task-form")

      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          notification: expect.objectContaining({
            channels: expect.arrayContaining(["im"]),
            // Trimmed — a stray space would silently target nothing.
            imTarget: { conversationKey: "slack:ops:C1" },
          }),
        })
      )
    })

    // Empty means "use the global ops channel", which is expressed by the field
    // being absent rather than by an empty string.
    it("omits imTarget entirely when the conversation is left blank", async () => {
      // The mock needs a declared parameter: a 0-arg `jest.fn` types
      // `mock.calls` as an empty tuple, so `calls[0][0]` fails to compile.
      const onSubmit = jest.fn(
        async (_input: { notification: Record<string, unknown> }) => undefined
      )
      render(
        <TaskForm
          onSubmit={onSubmit as unknown as React.ComponentProps<typeof TaskForm>["onSubmit"]}
          onCancel={jest.fn()}
        />
      )

      fireEvent.change(document.querySelector("input") as HTMLInputElement, {
        target: { value: "Digest task" },
      })
      fireEvent.click(screen.getByRole("button", { name: "im" }))

      fireEvent.click(screen.getByTestId("scheduler-task-submit"))
      await screen.findByTestId("scheduler-task-form")

      const submitted = onSubmit.mock.calls[0][0]
      expect(submitted.notification.channels).toContain("im")
      expect(submitted.notification).not.toHaveProperty("imTarget")
    })

    it("seeds the conversation field from an existing task", () => {
      render(
        <TaskForm
          onSubmit={jest.fn(async () => undefined)}
          onCancel={jest.fn()}
          initialValues={{
            name: "Existing",
            type: "chat",
            trigger: { type: "interval", intervalMs: 60_000 },
            notification: {
              onStart: false,
              onComplete: true,
              onError: true,
              channels: ["im"],
              imTarget: { conversationKey: "discord:a1:ch_seeded" },
            },
          }}
        />
      )
      expect(screen.getByLabelText("notifyImConversation")).toHaveValue("discord:a1:ch_seeded")
    })
  })

  it("seeds the overlap policy from legacy allowConcurrent and mirrors it on submit", async () => {
    const onSubmit = jest.fn(async () => undefined)
    render(
      <TaskForm
        onSubmit={onSubmit}
        onCancel={jest.fn()}
        initialValues={{
          name: "Legacy concurrent",
          type: "chat",
          trigger: { type: "cron", cronExpression: "0 9 * * *", timezone: "UTC" } as never,
          config: { allowConcurrent: true } as never,
        }}
      />
    )

    fireEvent.click(screen.getByTestId("scheduler-task-submit"))
    await screen.findByTestId("scheduler-task-form")

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ overlapPolicy: "allow", allowConcurrent: true }),
      })
    )
  })

  it("disables task types the target host cannot run and explains why", () => {
    render(
      <TaskForm
        onSubmit={jest.fn(async () => undefined)}
        onCancel={jest.fn()}
        hostForTesting={{ platform: "web", capabilities: ["webview"] }}
      />
    )
    // Web-standalone has no sidecar → chat is disabled and, being the default
    // type, surfaces the inline warning; test needs nothing → enabled.
    const chat = screen.getByTestId("task-type-chat")
    expect(chat).toBeDisabled()
    expect(chat.getAttribute("data-host-supported")).toBe("false")
    expect(chat.getAttribute("title")).toContain("hostSupport.reason.")
    expect(screen.getByTestId("task-type-test")).not.toBeDisabled()
    expect(screen.getByTestId("task-type-host-warning")).toBeInTheDocument()
  })

  it("never offers card-authored types in the picker", () => {
    render(<TaskForm onSubmit={jest.fn(async () => undefined)} onCancel={jest.fn()} />)
    expect(screen.queryByTestId("task-type-twin")).not.toBeInTheDocument()
    expect(screen.queryByTestId("task-type-wiki-lint")).not.toBeInTheDocument()
    expect(screen.queryByTestId("task-type-connection:presence:refresh")).not.toBeInTheDocument()
    expect(screen.getByTestId("task-type-plugin")).toBeInTheDocument()
  })

  it("enables every type on a full desktop host and hides the warning", () => {
    render(
      <TaskForm
        onSubmit={jest.fn(async () => undefined)}
        onCancel={jest.fn()}
        hostForTesting={{
          platform: "tauri",
          capabilities: ["shell", "sidecar", "keyring", "connector-runtime", "mcp-runtime"],
        }}
      />
    )
    expect(screen.getByTestId("task-type-chat")).not.toBeDisabled()
    expect(screen.getByTestId("task-type-script")).not.toBeDisabled()
    expect(screen.queryByTestId("task-type-host-warning")).not.toBeInTheDocument()
  })

  it("rejects an end time in the past", async () => {
    const onSubmit = jest.fn(async () => undefined)
    render(<TaskForm onSubmit={onSubmit} onCancel={jest.fn()} />)

    const nameInput = document.querySelector("input") as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "Past end" } })
    fireEvent.change(screen.getByTestId("scheduler-end-date-input"), {
      target: { value: "2000-01-01" },
    })

    fireEvent.click(screen.getByTestId("scheduler-task-submit"))
    await screen.findByText("lifecycle.endAtInPast")

    expect(onSubmit).not.toHaveBeenCalled()
  })
})
