/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { TaskNotificationDisplay } from "./task-notification-display"
import type { TaskNotificationConfig } from "@/types/scheduler"

jest.mock("@/lib/scheduler/webhook-outbound-config", () => ({
  useWebhookSigningState: jest.fn(),
}))

const { useWebhookSigningState: mockedHook } = jest.requireMock(
  "@/lib/scheduler/webhook-outbound-config"
) as { useWebhookSigningState: jest.Mock }

beforeEach(() => {
  jest.clearAllMocks()
  mockedHook.mockReturnValue({ enabled: false, loading: false })
})

describe("TaskNotificationDisplay", () => {
  it("renders 'None' / 'Never' when no notification config is provided", () => {
    render(<TaskNotificationDisplay notification={undefined} />)
    expect(screen.getByText("None")).toBeInTheDocument()
    expect(screen.getByText("Never")).toBeInTheDocument()
  })

  it("renders the channel labels for desktop + toast", () => {
    const notification: TaskNotificationConfig = {
      onStart: false,
      onComplete: true,
      onError: true,
      channels: ["desktop", "toast"],
    }
    render(<TaskNotificationDisplay notification={notification} />)
    expect(screen.getByText("Desktop, Toast")).toBeInTheDocument()
    // Webhook URL row should NOT be present.
    expect(screen.queryByTestId("webhook-signed-badge")).not.toBeInTheDocument()
  })

  it("renders the truncated webhook URL without a 'Signed' badge when signing is disabled", () => {
    const notification: TaskNotificationConfig = {
      onStart: false,
      onComplete: true,
      onError: true,
      channels: ["webhook"],
      webhookUrl: "https://example.com/webhook/endpoint",
    }
    render(<TaskNotificationDisplay notification={notification} />)
    expect(screen.getByText(/https:\/\/example.com\/webhook\/endpoint/)).toBeInTheDocument()
    expect(screen.queryByTestId("webhook-signed-badge")).not.toBeInTheDocument()
  })

  it("renders a 'Signed' badge when signing is enabled and webhook channel is active", () => {
    mockedHook.mockReturnValue({ enabled: true, loading: false })
    const notification: TaskNotificationConfig = {
      onStart: false,
      onComplete: true,
      onError: true,
      channels: ["webhook"],
      webhookUrl: "https://example.com/webhook",
    }
    render(<TaskNotificationDisplay notification={notification} />)
    expect(screen.getByTestId("webhook-signed-badge")).toBeInTheDocument()
    expect(screen.getByText(/signed/i)).toBeInTheDocument()
  })

  it("does not render the signing badge if webhook channel is not selected", () => {
    mockedHook.mockReturnValue({ enabled: true, loading: false })
    const notification: TaskNotificationConfig = {
      onStart: false,
      onComplete: true,
      onError: true,
      channels: ["toast"],
    }
    render(<TaskNotificationDisplay notification={notification} />)
    expect(screen.queryByTestId("webhook-signed-badge")).not.toBeInTheDocument()
  })

  it("renders the unknown-channel fallback (capitalised channel string)", () => {
    const notification: TaskNotificationConfig = {
      onStart: false,
      onComplete: true,
      onError: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channels: ["pager"] as any,
    }
    render(<TaskNotificationDisplay notification={notification} />)
    expect(screen.getByText("Pager")).toBeInTheDocument()
  })

  it("renders 'Never' when the config disables both complete and error notifications", () => {
    const notification: TaskNotificationConfig = {
      onStart: false,
      onComplete: false,
      onError: false,
      channels: ["toast"],
    }
    render(<TaskNotificationDisplay notification={notification} />)
    expect(screen.getByText("Never")).toBeInTheDocument()
  })

  it("renders 'Success Only' when only onComplete is true", () => {
    const notification: TaskNotificationConfig = {
      onStart: false,
      onComplete: true,
      onError: false,
      channels: ["toast"],
    }
    render(<TaskNotificationDisplay notification={notification} />)
    expect(screen.getByText("Success Only")).toBeInTheDocument()
  })

  it("renders 'Failure Only' when only onError is true", () => {
    const notification: TaskNotificationConfig = {
      onStart: false,
      onComplete: false,
      onError: true,
      channels: ["toast"],
    }
    render(<TaskNotificationDisplay notification={notification} />)
    expect(screen.getByText("Failure Only")).toBeInTheDocument()
  })

  it("truncates webhook URLs longer than 48 characters", () => {
    mockedHook.mockReturnValue({ enabled: false, loading: false })
    const longUrl = "https://example.com/" + "a".repeat(60) + "/end"
    const notification: TaskNotificationConfig = {
      onStart: false,
      onComplete: true,
      onError: true,
      channels: ["webhook"],
      webhookUrl: longUrl,
    }
    render(<TaskNotificationDisplay notification={notification} />)
    // Look for the ellipsis character that signals truncation.
    expect(screen.getByText(/…$/)).toBeInTheDocument()
  })
})
