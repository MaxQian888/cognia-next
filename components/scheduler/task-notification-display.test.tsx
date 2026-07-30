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

  // `im` was added to the channel union; without a case here it would fall to
  // the unknown-channel fallback and render as the raw "Im".
  it("renders a labelled IM channel rather than the unknown-channel fallback", () => {
    const notification: TaskNotificationConfig = {
      onStart: false,
      onComplete: true,
      onError: true,
      channels: ["im", "toast"],
      imTarget: { conversationKey: "slack:ops:C1" },
    }
    render(<TaskNotificationDisplay notification={notification} />)
    expect(screen.getByText("IM, Toast")).toBeInTheDocument()
    expect(screen.queryByText("Im, Toast")).not.toBeInTheDocument()
  })

  // The cognia-next port of TaskNotificationDisplay only surfaces the channel
  // label list + notifyOn mode — webhook URL preview and the "Signed" badge
  // were deferred. Keeping the channel list assertion here so we still pin
  // the webhook channel rendering, just without the URL/signing surface.
  it("lists the Webhook channel label without rendering URL preview / signed badge", () => {
    const notification: TaskNotificationConfig = {
      onStart: false,
      onComplete: true,
      onError: true,
      channels: ["webhook"],
      webhookUrl: "https://example.com/webhook/endpoint",
    }
    render(<TaskNotificationDisplay notification={notification} />)
    expect(screen.getByText("Webhook")).toBeInTheDocument()
    expect(screen.queryByText(/https:\/\/example.com\/webhook\/endpoint/)).not.toBeInTheDocument()
    expect(screen.queryByTestId("webhook-signed-badge")).not.toBeInTheDocument()
  })

  it("does not surface a signed badge even when webhook signing is enabled (deferred)", () => {
    mockedHook.mockReturnValue({ enabled: true, loading: false })
    const notification: TaskNotificationConfig = {
      onStart: false,
      onComplete: true,
      onError: true,
      channels: ["webhook"],
      webhookUrl: "https://example.com/webhook",
    }
    render(<TaskNotificationDisplay notification={notification} />)
    expect(screen.queryByTestId("webhook-signed-badge")).not.toBeInTheDocument()
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

  it("ignores webhookUrl entirely (URL preview was deferred in cognia-next)", () => {
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
    expect(screen.queryByText(/…$/)).not.toBeInTheDocument()
    expect(screen.queryByText(longUrl)).not.toBeInTheDocument()
  })
})
