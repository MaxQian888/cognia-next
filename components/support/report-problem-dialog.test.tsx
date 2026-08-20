/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    t.has = (key: string) => !key.includes("custom")
    return t
  },
}))
const trackEvent = jest.fn(async (..._args: unknown[]) => true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}))
const toastMock = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastMock.success(m),
    error: (m: string) => toastMock.error(m),
  },
}))
const buildSupportReport = jest.fn()
jest.mock("@/lib/support-report/build", () => ({
  buildSupportReport: (...args: unknown[]) => buildSupportReport(...args),
}))
const deliverSupportReport = jest.fn(async (..._args: unknown[]) => undefined)
const channels: Array<{
  id: string
  labelKey: string
  primary?: boolean
  isAvailable: () => boolean
  deliver: () => Promise<void>
}> = []
jest.mock("@/lib/support-report/channels", () => ({
  deliverSupportReport: (...args: unknown[]) => deliverSupportReport(...args),
  listAvailableSupportReportChannels: () => channels,
  // The registry is a module singleton the dialog subscribes to, so a channel
  // registered from an effect appears without a remount. Inert here: this
  // suite drives the list directly.
  subscribeSupportReportChannels: () => () => {},
  supportReportChannelsVersion: () => 0,
}))
jest.mock("@/hooks/support/use-diagnostic-report-channel", () => ({
  useDiagnosticReportChannel: () => undefined,
}))
const sections: Array<{
  id: string
  labelKey: string
  descriptionKey: string
  heading: string
  pinned: boolean
  defaultIncluded: boolean
  sensitive: boolean
  isAvailable: () => boolean
  collect: () => string | null
}> = []
jest.mock("@/lib/support-report/sections", () => ({
  listAvailableSupportReportSections: () => sections,
  defaultSupportReportSectionIds: () =>
    sections.filter((s) => s.pinned || s.defaultIncluded).map((s) => s.id),
}))

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ReportProblemDialog } from "./report-problem-dialog"

const report = {
  title: "Cognia support report",
  markdown: "## Cognia support report\n\n### App\n\nCognia 1.0.0\n",
  filename: "cognia-support-report-2026-08-16.md",
  generatedAt: "2026-08-16T00:00:00.000Z",
  sectionIds: ["app"],
}

function section(
  id: string,
  overrides: Partial<(typeof sections)[number]> = {}
): (typeof sections)[number] {
  return {
    id,
    labelKey: `${id}.label`,
    descriptionKey: `${id}.description`,
    heading: id,
    pinned: false,
    defaultIncluded: true,
    sensitive: true,
    isAvailable: () => true,
    collect: () => id,
    ...overrides,
  }
}

beforeEach(() => {
  trackEvent.mockClear()
  toastMock.success.mockReset()
  toastMock.error.mockReset()
  buildSupportReport.mockReset().mockResolvedValue(report)
  deliverSupportReport.mockClear()
  channels.splice(
    0,
    channels.length,
    { id: "copy", labelKey: "copy", isAvailable: () => true, deliver: async () => undefined },
    {
      id: "issue",
      labelKey: "issue",
      primary: true,
      isAvailable: () => true,
      deliver: async () => undefined,
    },
    { id: "custom", labelKey: "custom", isAvailable: () => true, deliver: async () => undefined }
  )
  sections.splice(
    0,
    sections.length,
    section("description", { pinned: true, sensitive: false }),
    section("app", { pinned: true, sensitive: false }),
    section("runtime"),
    section("recentErrors", { defaultIncluded: false })
  )
})

const context = { surface: "chat" as const, sessionId: "s1" }

it("opens from its trigger, tracks the open, and offers only toggleable sections", async () => {
  const user = userEvent.setup()
  render(<ReportProblemDialog context={context} trigger={<button>open</button>} />)
  expect(screen.queryByTestId("report-problem-form")).toBeNull()

  await user.click(screen.getByRole("button", { name: "open" }))
  expect(await screen.findByTestId("report-problem-form")).toBeInTheDocument()
  expect(trackEvent).toHaveBeenCalledWith("support.feedback.draft.opened", {
    surface: "chat",
    sessionId: "s1",
  })

  expect(screen.getByText('alwaysIncluded:{"items":"section.app.label"}')).toBeInTheDocument()
  const runtime = screen.getByRole("checkbox", { name: /runtime\.label/ })
  const recent = screen.getByRole("checkbox", { name: /recentErrors\.label/ })
  expect(runtime).toBeChecked()
  expect(recent).not.toBeChecked()
  expect(screen.queryByRole("checkbox", { name: /app\.label/ })).toBeNull()
  expect(screen.getAllByText("redacted")).toHaveLength(2)
})

it("previews the redacted report and rebuilds it as the selection changes", async () => {
  jest.useFakeTimers()
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
  render(<ReportProblemDialog context={context} open onOpenChange={() => {}} />)

  await user.click(screen.getByRole("button", { name: "preview" }))
  expect(screen.getByText("building")).toBeInTheDocument()
  await act(async () => {
    jest.advanceTimersByTime(400)
  })
  expect(await screen.findByTestId("report-problem-preview")).toHaveTextContent("Cognia 1.0.0")
  expect(buildSupportReport).toHaveBeenLastCalledWith({
    context: { ...context, description: "" },
    sectionIds: ["description", "app", "runtime"],
  })

  await user.click(screen.getByRole("checkbox", { name: /recentErrors\.label/ }))
  await act(async () => {
    jest.advanceTimersByTime(400)
  })
  await waitFor(() =>
    expect(buildSupportReport).toHaveBeenLastCalledWith({
      context: { ...context, description: "" },
      sectionIds: ["description", "app", "runtime", "recentErrors"],
    })
  )

  buildSupportReport.mockRejectedValueOnce(new Error("pii"))
  await user.click(screen.getByRole("checkbox", { name: /runtime\.label/ }))
  await act(async () => {
    jest.advanceTimersByTime(400)
  })
  expect(await screen.findByRole("alert")).toHaveTextContent("previewFailed")

  await user.click(screen.getByRole("button", { name: "hidePreview" }))
  expect(screen.queryByTestId("report-problem-preview")).toBeNull()
  jest.useRealTimers()
})

it("delivers through the chosen channel with the typed description, then tracks and toasts", async () => {
  const user = userEvent.setup()
  render(
    <ReportProblemDialog
      context={context}
      initialDescription="seed"
      open
      onOpenChange={() => {}}
      channelDeps={{ issueTrackerUrl: "https://github.com/acme/app" }}
    />
  )
  const box = screen.getByRole("textbox", { name: "descriptionLabel" })
  expect(box).toHaveValue("seed")
  await user.clear(box)
  await user.type(box, "Chat stopped")

  const issue = screen.getByTestId("report-problem-channel-issue")
  const copy = screen.getByTestId("report-problem-channel-copy")
  expect(issue).toHaveAttribute("data-variant", "default")
  expect(copy).toHaveAttribute("data-variant", "outline")
  // Unknown label keys fall back to the channel id rather than a raw key.
  expect(screen.getByTestId("report-problem-channel-custom")).toHaveTextContent("custom")

  await user.click(issue)
  await waitFor(() => expect(deliverSupportReport).toHaveBeenCalledTimes(1))
  expect(buildSupportReport).toHaveBeenCalledWith({
    context: { ...context, description: "Chat stopped" },
    sectionIds: ["description", "app", "runtime"],
  })
  expect(deliverSupportReport).toHaveBeenCalledWith("issue", report, {
    issueTrackerUrl: "https://github.com/acme/app",
  })
  expect(trackEvent).toHaveBeenCalledWith("support.feedback.draft.exported", {
    surface: "chat",
    channel: "issue",
    sessionId: "s1",
  })
  expect(toastMock.success).toHaveBeenCalledWith("delivered.issue")

  await user.click(screen.getByTestId("report-problem-channel-custom"))
  await waitFor(() => expect(deliverSupportReport).toHaveBeenCalledTimes(2))
  expect(toastMock.success).toHaveBeenLastCalledWith('delivered.generic:{"channel":"custom"}')
})

it("toasts a failure and re-enables the buttons when delivery throws", async () => {
  const user = userEvent.setup()
  deliverSupportReport.mockRejectedValueOnce(new Error("blocked"))
  render(<ReportProblemDialog context={{ surface: "mobile" }} open onOpenChange={() => {}} />)
  await user.click(screen.getByTestId("report-problem-channel-copy"))
  await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("failed"))
  expect(screen.getByTestId("report-problem-channel-copy")).toBeEnabled()
  expect(trackEvent).toHaveBeenCalledWith("support.feedback.draft.opened", { surface: "mobile" })
  expect(trackEvent).not.toHaveBeenCalledWith("support.feedback.draft.exported", expect.anything())
})

it("stays silent when toasts are disabled and reports close through onOpenChange", async () => {
  const user = userEvent.setup()
  const onOpenChange = jest.fn()
  render(
    <ReportProblemDialog
      context={{ surface: "error-page" }}
      open
      onOpenChange={onOpenChange}
      toastsEnabled={false}
    />
  )
  await user.click(screen.getByTestId("report-problem-channel-copy"))
  await waitFor(() => expect(deliverSupportReport).toHaveBeenCalledTimes(1))
  expect(toastMock.success).not.toHaveBeenCalled()

  await user.click(screen.getByRole("button", { name: "Close" }))
  expect(onOpenChange).toHaveBeenCalledWith(false)
})
