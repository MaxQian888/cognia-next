/** @jest-environment jsdom */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ScheduledTasksSection } from "./scheduled-tasks-section"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

jest.mock("@/lib/scheduler/notification-integration", () => ({
  testNotificationChannel: jest.fn().mockResolvedValue({ success: true }),
}))

// The ops-channel field is the only consumer of AppSettings in this section.
const appSettingsRef: {
  value: { schedulerNotifications?: { fallbackConversationKey?: string } } | null
} = { value: null }
const saveAppSettings = jest.fn(async (_patch: unknown) => {})
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown; save: unknown }) => T): T =>
    selector({ settings: appSettingsRef.value, save: saveAppSettings }),
}))

jest.mock("@/lib/scheduler/webhook-outbound-config", () => ({
  useWebhookSigningState: jest.fn(() => ({ enabled: false, loading: false })),
}))

jest.mock("@/hooks/scheduler/use-system-scheduler", () => ({
  useSystemScheduler: jest.fn(),
}))

// The real TimezoneSelect uses Radix primitives that don't drive cleanly under
// jsdom (portals, pointer events). Stub with a native <select> exposing the
// onValueChange callback so tests can fire change events directly.
jest.mock("@/components/scheduler/timezone-select", () => ({
  TimezoneSelect: ({
    value,
    onValueChange,
    testId,
  }: {
    value?: string
    onValueChange: (v: string) => void
    testId?: string
  }) => {
    return (
      <select
        data-testid={testId ?? "timezone-select"}
        value={value ?? ""}
        onChange={(e) => onValueChange(e.target.value)}
      >
        <option value="UTC">UTC</option>
        <option value="Asia/Shanghai">Asia/Shanghai</option>
        <option value="">empty</option>
      </select>
    )
  },
}))

const { isTauri: mockedIsTauri } = jest.requireMock("@/lib/tauri") as {
  isTauri: jest.Mock
}
const { useWebhookSigningState: mockedSigningHook } = jest.requireMock(
  "@/lib/scheduler/webhook-outbound-config"
) as { useWebhookSigningState: jest.Mock }
const { useSystemScheduler: mockedSystemHook } = jest.requireMock(
  "@/hooks/scheduler/use-system-scheduler"
) as { useSystemScheduler: jest.Mock }
const { testNotificationChannel: mockedTestChannel } = jest.requireMock(
  "@/lib/scheduler/notification-integration"
) as { testNotificationChannel: jest.Mock }

beforeEach(() => {
  jest.clearAllMocks()
  appSettingsRef.value = null
  mockedIsTauri.mockReturnValue(false)
  mockedSigningHook.mockReturnValue({ enabled: false, loading: false })
  mockedSystemHook.mockReturnValue({
    capabilities: null,
    isAvailable: false,
    isElevated: false,
    tasks: [],
    pendingConfirmation: null,
    pendingConfirmations: [],
    loading: false,
    error: null,
    refresh: jest.fn(),
    requestElevation: jest.fn().mockResolvedValue(true),
  })
  mockedTestChannel.mockResolvedValue({ success: true })
  // Reset the scheduler store between tests so policy edits don't leak.
  useSchedulerStore.setState({
    permissionPolicy: {
      agentAutoCreate: false,
      confirmationRequired: ["script", "agent"],
      scriptTasksEnabled: true,
      maxTasksPerSource: 50,
      maxConcurrentExecutions: 5,
    },
    tasks: [],
    schedulerStatus: "idle",
    isInitialized: false,
  })
})

describe("ScheduledTasksSection — runtime status card", () => {
  it("renders the 'Not initialised' badge before initialization", () => {
    render(<ScheduledTasksSection />)
    expect(screen.getByTestId("scheduler-runtime-status")).toHaveTextContent(/not initialised/i)
  })

  it("renders 'Running' once initialised and status is running", () => {
    useSchedulerStore.setState({ isInitialized: true, schedulerStatus: "running" })
    render(<ScheduledTasksSection />)
    expect(screen.getByTestId("scheduler-runtime-status")).toHaveTextContent(/running/i)
  })

  it("renders 'Stopped' once initialised and status is stopped", () => {
    useSchedulerStore.setState({ isInitialized: true, schedulerStatus: "stopped" })
    render(<ScheduledTasksSection />)
    expect(screen.getByTestId("scheduler-runtime-status")).toHaveTextContent(/stopped/i)
  })

  it("renders 'Idle' once initialised and status is idle", () => {
    useSchedulerStore.setState({ isInitialized: true, schedulerStatus: "idle" })
    render(<ScheduledTasksSection />)
    expect(screen.getByTestId("scheduler-runtime-status")).toHaveTextContent(/idle/i)
  })

  it("renders an active/total count derived from the tasks array", () => {
    useSchedulerStore.setState({
      isInitialized: true,
      tasks: [
        {
          id: "t1",
          name: "alpha",
          type: "chat",
          trigger: { type: "cron", cronExpression: "0 9 * * *" },
          config: {
            timeout: 1000,
            maxRetries: 0,
            retryDelay: 0,
            runMissedOnStartup: false,
            allowConcurrent: false,
          },
          notification: { onStart: false, onComplete: true, onError: true },
          status: "active",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "t2",
          name: "beta",
          type: "chat",
          trigger: { type: "cron", cronExpression: "0 9 * * *" },
          config: {
            timeout: 1000,
            maxRetries: 0,
            retryDelay: 0,
            runMissedOnStartup: false,
            allowConcurrent: false,
          },
          notification: { onStart: false, onComplete: true, onError: true },
          status: "paused",
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    })
    render(<ScheduledTasksSection />)
    expect(screen.getByTestId("scheduler-runtime-counts")).toHaveTextContent(/1 active.*2 total/i)
  })
})

describe("ScheduledTasksSection — confirmation-required grid (G1 fix)", () => {
  it("renders all 8 runtime-supported task-type checkboxes", () => {
    render(<ScheduledTasksSection />)
    for (const id of [
      "confirm-chat",
      "confirm-agent",
      "confirm-skill",
      "confirm-external-agent",
      "confirm-script",
      "confirm-backup",
      "confirm-custom",
      "confirm-plugin",
    ]) {
      expect(document.getElementById(id)).not.toBeNull()
    }
    // workflow / sync / twin must NOT appear (no runtime today).
    expect(document.getElementById("confirm-workflow")).toBeNull()
    expect(document.getElementById("confirm-sync")).toBeNull()
    expect(document.getElementById("confirm-twin")).toBeNull()
  })
})

describe("ScheduledTasksSection — defaults card", () => {
  it("writes timezone changes through to the scheduler store", () => {
    render(<ScheduledTasksSection />)
    const select = screen.getByTestId("default-timezone") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "Asia/Shanghai" } })
    expect(useSchedulerStore.getState().permissionPolicy.taskDefaults?.timezone).toBe(
      "Asia/Shanghai"
    )
  })

  it("clears the timezone default when an empty value is picked", () => {
    useSchedulerStore.setState({
      permissionPolicy: {
        ...useSchedulerStore.getState().permissionPolicy,
        taskDefaults: { timezone: "Asia/Shanghai" },
      },
    })
    render(<ScheduledTasksSection />)
    const select = screen.getByTestId("default-timezone") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "" } })
    expect(useSchedulerStore.getState().permissionPolicy.taskDefaults?.timezone).toBeUndefined()
  })

  it("toggles a notification channel into taskDefaults.notification.channels", () => {
    render(<ScheduledTasksSection />)
    const desktopCheckbox = document.getElementById("channel-desktop") as HTMLInputElement
    fireEvent.click(desktopCheckbox)
    const td = useSchedulerStore.getState().permissionPolicy.taskDefaults
    expect(td?.notification?.channels).toContain("desktop")
  })

  it("disables the webhook URL input when webhook is not in the channel list", () => {
    render(<ScheduledTasksSection />)
    const input = document.getElementById("default-webhook-url") as HTMLInputElement
    expect(input.disabled).toBe(true)
  })

  it("calls testNotificationChannel when the per-channel test button is clicked", async () => {
    // Activate the toast channel so its test button is enabled.
    useSchedulerStore.setState({
      permissionPolicy: {
        ...useSchedulerStore.getState().permissionPolicy,
        taskDefaults: { notification: { channels: ["toast"] } },
      },
    })
    render(<ScheduledTasksSection />)
    const button = screen.getByTestId("test-channel-toast")
    fireEvent.click(button)
    await waitFor(() =>
      // 3rd arg is the global ops channel — passed so the test reflects the
      // value in the box rather than racing the settings write.
      expect(mockedTestChannel).toHaveBeenCalledWith("toast", undefined, undefined)
    )
  })

  it("toasts on test failure (channel returns success=false)", async () => {
    mockedTestChannel.mockResolvedValueOnce({ success: false, error: "boom" })
    const { toast: mockedToast } = jest.requireMock("sonner") as {
      toast: { error: jest.Mock; success: jest.Mock }
    }
    useSchedulerStore.setState({
      permissionPolicy: {
        ...useSchedulerStore.getState().permissionPolicy,
        taskDefaults: { notification: { channels: ["toast"] } },
      },
    })
    render(<ScheduledTasksSection />)
    fireEvent.click(screen.getByTestId("test-channel-toast"))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
  })

  it("toasts on test exception (channel rejects)", async () => {
    mockedTestChannel.mockRejectedValueOnce(new Error("network down"))
    const { toast: mockedToast } = jest.requireMock("sonner") as {
      toast: { error: jest.Mock; success: jest.Mock }
    }
    useSchedulerStore.setState({
      permissionPolicy: {
        ...useSchedulerStore.getState().permissionPolicy,
        taskDefaults: { notification: { channels: ["toast"] } },
      },
    })
    render(<ScheduledTasksSection />)
    fireEvent.click(screen.getByTestId("test-channel-toast"))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
  })

  it("uncheck a channel removes it from the defaults list", () => {
    useSchedulerStore.setState({
      permissionPolicy: {
        ...useSchedulerStore.getState().permissionPolicy,
        taskDefaults: { notification: { channels: ["desktop", "toast"] } },
      },
    })
    render(<ScheduledTasksSection />)
    const desktopCheckbox = document.getElementById("channel-desktop") as HTMLInputElement
    fireEvent.click(desktopCheckbox)
    const td = useSchedulerStore.getState().permissionPolicy.taskDefaults
    expect(td?.notification?.channels).not.toContain("desktop")
    expect(td?.notification?.channels).toContain("toast")
  })

  it("updates execution config when retry-related inputs change", () => {
    render(<ScheduledTasksSection />)
    const timeoutInput = document.getElementById("default-timeout") as HTMLInputElement
    fireEvent.change(timeoutInput, { target: { value: "60" } })
    const retriesInput = document.getElementById("default-max-retries") as HTMLInputElement
    fireEvent.change(retriesInput, { target: { value: "9" } })
    const retryDelayInput = document.getElementById("default-retry-delay") as HTMLInputElement
    fireEvent.change(retryDelayInput, { target: { value: "3000" } })
    const maxMissedInput = document.getElementById("default-max-missed") as HTMLInputElement
    fireEvent.change(maxMissedInput, { target: { value: "4" } })
    const td = useSchedulerStore.getState().permissionPolicy.taskDefaults
    expect(td?.execution?.timeout).toBe(60_000)
    expect(td?.execution?.maxRetries).toBe(9)
    expect(td?.execution?.retryDelay).toBe(3000)
    expect(td?.execution?.maxMissedRuns).toBe(4)
  })

  it("updates the default webhook URL via the input", () => {
    useSchedulerStore.setState({
      permissionPolicy: {
        ...useSchedulerStore.getState().permissionPolicy,
        taskDefaults: { notification: { channels: ["webhook"] } },
      },
    })
    render(<ScheduledTasksSection />)
    const input = document.getElementById("default-webhook-url") as HTMLInputElement
    fireEvent.change(input, { target: { value: "https://example.com/hook" } })
    expect(
      useSchedulerStore.getState().permissionPolicy.taskDefaults?.notification?.webhookUrl
    ).toBe("https://example.com/hook")
    // Clearing the URL drops the field rather than keeping an empty string.
    fireEvent.change(input, { target: { value: "" } })
    expect(
      useSchedulerStore.getState().permissionPolicy.taskDefaults?.notification?.webhookUrl
    ).toBeUndefined()
  })

  it("toggles run-missed and allow-concurrent execution switches", () => {
    render(<ScheduledTasksSection />)
    const runMissed = document.getElementById("default-run-missed") as HTMLButtonElement
    fireEvent.click(runMissed)
    expect(
      useSchedulerStore.getState().permissionPolicy.taskDefaults?.execution?.runMissedOnStartup
    ).toBe(true)
    const allowConcurrent = document.getElementById("default-allow-concurrent") as HTMLButtonElement
    fireEvent.click(allowConcurrent)
    expect(
      useSchedulerStore.getState().permissionPolicy.taskDefaults?.execution?.allowConcurrent
    ).toBe(true)
  })
})

describe("ScheduledTasksSection — system scheduler card request-elevation flow", () => {
  it("calls requestElevation and toasts success", async () => {
    mockedIsTauri.mockReturnValue(true)
    const requestElevation = jest.fn().mockResolvedValue(true)
    mockedSystemHook.mockReturnValue({
      capabilities: { backend: "Task Scheduler", os: "windows" },
      isAvailable: true,
      isElevated: false,
      tasks: [],
      pendingConfirmation: null,
      pendingConfirmations: [],
      loading: false,
      error: null,
      refresh: jest.fn(),
      requestElevation,
    })
    const { toast: mockedToast } = jest.requireMock("sonner") as {
      toast: { error: jest.Mock; success: jest.Mock }
    }
    render(<ScheduledTasksSection />)
    fireEvent.click(screen.getByTestId("system-request-elevation"))
    await waitFor(() => expect(requestElevation).toHaveBeenCalled())
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
  })

  it("toasts an error when elevation is denied", async () => {
    mockedIsTauri.mockReturnValue(true)
    const requestElevation = jest.fn().mockResolvedValue(false)
    mockedSystemHook.mockReturnValue({
      capabilities: { backend: "launchd", os: "macos" },
      isAvailable: true,
      isElevated: false,
      tasks: [],
      pendingConfirmation: null,
      pendingConfirmations: [],
      loading: false,
      error: null,
      refresh: jest.fn(),
      requestElevation,
    })
    const { toast: mockedToast } = jest.requireMock("sonner") as {
      toast: { error: jest.Mock; success: jest.Mock }
    }
    render(<ScheduledTasksSection />)
    fireEvent.click(screen.getByTestId("system-request-elevation"))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
  })

  it("toasts an error when requestElevation throws", async () => {
    mockedIsTauri.mockReturnValue(true)
    const requestElevation = jest.fn().mockRejectedValue(new Error("polkit gone"))
    mockedSystemHook.mockReturnValue({
      capabilities: { backend: "systemd", os: "linux" },
      isAvailable: true,
      isElevated: false,
      tasks: [],
      pendingConfirmation: null,
      pendingConfirmations: [],
      loading: false,
      error: null,
      refresh: jest.fn(),
      requestElevation,
    })
    const { toast: mockedToast } = jest.requireMock("sonner") as {
      toast: { error: jest.Mock; success: jest.Mock }
    }
    render(<ScheduledTasksSection />)
    fireEvent.click(screen.getByTestId("system-request-elevation"))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
  })

  it("renders a 'View' link when there are pending confirmations", () => {
    mockedIsTauri.mockReturnValue(true)
    mockedSystemHook.mockReturnValue({
      capabilities: { backend: "systemd", os: "linux" },
      isAvailable: true,
      isElevated: true,
      tasks: [],
      pendingConfirmation: null,
      pendingConfirmations: [
        {
          id: "conf-1",
          taskName: "x",
          riskLevel: "Low",
          riskWarnings: [],
          createdAt: new Date().toISOString(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      loading: false,
      error: null,
      refresh: jest.fn(),
      requestElevation: jest.fn(),
    })
    render(<ScheduledTasksSection />)
    expect(screen.getByRole("link", { name: /view/i })).toBeInTheDocument()
  })
})

describe("ScheduledTasksSection — webhook signing loading branch", () => {
  it("renders the loading alert when the hook reports loading=true", () => {
    mockedIsTauri.mockReturnValue(true)
    mockedSigningHook.mockReturnValue({ enabled: false, loading: true })
    render(<ScheduledTasksSection />)
    expect(screen.getByText(/checking signing status/i)).toBeInTheDocument()
  })
})

describe("ScheduledTasksSection — system scheduler card", () => {
  it("renders the desktop-only fallback alert on web", () => {
    mockedIsTauri.mockReturnValue(false)
    render(<ScheduledTasksSection />)
    expect(
      screen.getByText(/native scheduler integration is available in the desktop build only/i)
    ).toBeInTheDocument()
  })

  it("renders availability + elevation badges on desktop", () => {
    mockedIsTauri.mockReturnValue(true)
    mockedSystemHook.mockReturnValue({
      capabilities: { backend: "Task Scheduler", os: "windows" },
      isAvailable: true,
      isElevated: true,
      tasks: [{ id: "sys-1" }],
      pendingConfirmation: null,
      pendingConfirmations: [],
      loading: false,
      error: null,
      refresh: jest.fn(),
      requestElevation: jest.fn().mockResolvedValue(true),
    })
    render(<ScheduledTasksSection />)
    expect(screen.getByTestId("system-backend-availability")).toHaveTextContent(/available/i)
    expect(screen.getByTestId("system-elevation-state")).toHaveTextContent(/elevated/i)
    expect(screen.getByTestId("system-native-count")).toHaveTextContent(/native task/i)
  })

  it("shows the Request elevation button only when not elevated and available", () => {
    mockedIsTauri.mockReturnValue(true)
    mockedSystemHook.mockReturnValue({
      capabilities: { backend: "Task Scheduler", os: "windows" },
      isAvailable: true,
      isElevated: false,
      tasks: [],
      pendingConfirmation: null,
      pendingConfirmations: [],
      loading: false,
      error: null,
      refresh: jest.fn(),
      requestElevation: jest.fn().mockResolvedValue(true),
    })
    render(<ScheduledTasksSection />)
    expect(screen.getByTestId("system-request-elevation")).toBeInTheDocument()
  })
})

describe("ScheduledTasksSection — webhook signing card", () => {
  it("renders the web-only notice on web", () => {
    mockedIsTauri.mockReturnValue(false)
    render(<ScheduledTasksSection />)
    expect(screen.getByText(/web sessions cannot sign outbound webhooks/i)).toBeInTheDocument()
  })

  it("renders the 'enabled' state when the hook reports a configured secret", () => {
    mockedIsTauri.mockReturnValue(true)
    mockedSigningHook.mockReturnValue({ enabled: true, loading: false })
    render(<ScheduledTasksSection />)
    expect(screen.getByTestId("signing-state-enabled")).toBeInTheDocument()
  })

  it("renders the 'disabled' state when the hook reports no secret", () => {
    mockedIsTauri.mockReturnValue(true)
    mockedSigningHook.mockReturnValue({ enabled: false, loading: false })
    render(<ScheduledTasksSection />)
    expect(screen.getByTestId("signing-state-disabled")).toBeInTheDocument()
  })

  it("renders a manage-secret link to the canonical webhooks section", () => {
    mockedIsTauri.mockReturnValue(true)
    mockedSigningHook.mockReturnValue({ enabled: true, loading: false })
    render(<ScheduledTasksSection />)
    const link = screen.getByRole("link", { name: /manage signing secret/i })
    expect(link).toHaveAttribute("href", "/settings?section=webhooks")
  })
})

describe("ScheduledTasksSection — existing permission cards", () => {
  it("toggles agentAutoCreate", () => {
    render(<ScheduledTasksSection />)
    const toggle = document.getElementById("agent-auto-create") as HTMLButtonElement
    fireEvent.click(toggle)
    expect(useSchedulerStore.getState().permissionPolicy.agentAutoCreate).toBe(true)
  })

  it("updates maxTasksPerSource via the input", () => {
    render(<ScheduledTasksSection />)
    const input = document.getElementById("max-tasks-per-source") as HTMLInputElement
    fireEvent.change(input, { target: { value: "100" } })
    expect(useSchedulerStore.getState().permissionPolicy.maxTasksPerSource).toBe(100)
  })

  it("updates maxConcurrentExecutions via the input", () => {
    render(<ScheduledTasksSection />)
    const input = document.getElementById("max-concurrent") as HTMLInputElement
    fireEvent.change(input, { target: { value: "12" } })
    expect(useSchedulerStore.getState().permissionPolicy.maxConcurrentExecutions).toBe(12)
  })

  it("toggles scriptTasksEnabled via the script-tasks switch", () => {
    render(<ScheduledTasksSection />)
    const toggle = document.getElementById("script-tasks-enabled") as HTMLButtonElement
    fireEvent.click(toggle)
    expect(useSchedulerStore.getState().permissionPolicy.scriptTasksEnabled).toBe(false)
  })

  it("toggles a confirmation-required entry on and off", () => {
    render(<ScheduledTasksSection />)
    const externalCheckbox = document.getElementById("confirm-external-agent") as HTMLInputElement
    fireEvent.click(externalCheckbox)
    expect(useSchedulerStore.getState().permissionPolicy.confirmationRequired).toContain(
      "external-agent"
    )
    fireEvent.click(externalCheckbox)
    expect(useSchedulerStore.getState().permissionPolicy.confirmationRequired).not.toContain(
      "external-agent"
    )
  })
})

describe("ScheduledTasksSection — chat channel + global ops channel", () => {
  // `im` delivery, its two-layer target resolution, and the channel test all
  // existed; the settings defaults card was the one surface that could neither
  // pick the channel nor set the ops chat it falls back to, so the fallback
  // resolved to undefined on every delivery.

  it("offers the chat channel among the default channels", () => {
    render(<ScheduledTasksSection />)
    expect(screen.getByTestId("test-channel-im")).toBeInTheDocument()
  })

  it("writes the ops channel to AppSettings.schedulerNotifications", () => {
    render(<ScheduledTasksSection />)
    fireEvent.change(screen.getByTestId("default-ops-channel"), {
      target: { value: " telegram:-100123 " },
    })
    expect(saveAppSettings).toHaveBeenCalledWith({
      schedulerNotifications: { fallbackConversationKey: "telegram:-100123" },
    })
  })

  it("clears the ops channel back to undefined rather than storing an empty string", () => {
    appSettingsRef.value = { schedulerNotifications: { fallbackConversationKey: "x" } }
    render(<ScheduledTasksSection />)
    fireEvent.change(screen.getByTestId("default-ops-channel"), { target: { value: "  " } })
    expect(saveAppSettings).toHaveBeenCalledWith({
      schedulerNotifications: { fallbackConversationKey: undefined },
    })
  })

  it("reflects a stored ops channel", () => {
    appSettingsRef.value = { schedulerNotifications: { fallbackConversationKey: "slack:C1" } }
    render(<ScheduledTasksSection />)
    expect(screen.getByTestId("default-ops-channel")).toHaveValue("slack:C1")
  })

  it("keeps the chat test button disabled until an ops channel exists", () => {
    render(<ScheduledTasksSection />)
    fireEvent.click(document.getElementById("channel-im") as HTMLInputElement)
    expect(screen.getByTestId("test-channel-im")).toBeDisabled()
  })

  it("passes the ops channel to the channel test", async () => {
    appSettingsRef.value = { schedulerNotifications: { fallbackConversationKey: "slack:C1" } }
    render(<ScheduledTasksSection />)
    fireEvent.click(document.getElementById("channel-im") as HTMLInputElement)
    fireEvent.click(screen.getByTestId("test-channel-im"))
    await waitFor(() => expect(mockedTestChannel).toHaveBeenCalledWith("im", undefined, "slack:C1"))
  })
})
