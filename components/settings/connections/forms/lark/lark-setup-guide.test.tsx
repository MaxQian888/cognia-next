/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { openUrl } from "@/lib/native/opener"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { writeText as writeMobileClipboardText } from "@/lib/capacitor/clipboard"
import { detectPlatform } from "@/lib/platform/detect"
import { LarkSetupGuide } from "./lark-setup-guide"

jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))
jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: jest.fn() }))
jest.mock("@/lib/capacitor/clipboard", () => ({ writeText: jest.fn() }))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: jest.fn(() => "web"),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("next-intl", () => ({
  useTranslations: () => {
    // Read split sources so the tests also work before the coordinated i18n build.
    const messages = jest.requireActual("@/i18n/messages/en/settings/connections.json").lark
      .setupGuide
    return (key: string) => key.split(".").reduce((value, part) => value[part], messages)
  },
}))

const defaultProps = {
  appId: "cli_abc123",
  transport: "long-connection" as const,
  isNew: true,
  credentialsVerified: false,
  botIdentityKnown: false,
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(openUrl).mockResolvedValue(undefined)
  jest.mocked(writeClipboardText).mockResolvedValue(undefined)
  jest.mocked(writeMobileClipboardText).mockResolvedValue({ kind: "ok" })
  jest.mocked(detectPlatform).mockReturnValue("web")
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: jest.fn() },
  })
})

function openPermissions() {
  fireEvent.click(
    screen.getByRole("button", { name: "2. Grant permissions for the features you use" })
  )
}

it("opens prerequisites for a new app and keeps the other stages compact", () => {
  render(<LarkSetupGuide {...defaultProps} />)
  expect(screen.getByText(/Use an enterprise custom app/)).toBeVisible()
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
  expect(
    screen.getByRole("button", { name: "5. Configure replies and verify in Feishu" })
  ).toBeVisible()
})

it("keeps existing connection stages collapsed until requested", () => {
  render(<LarkSetupGuide {...defaultProps} isNew={false} />)
  expect(
    screen.getByRole("button", { name: "1. Create the app and enable its bot" })
  ).toHaveAttribute("aria-expanded", "false")
})

it("requires a live client before saving long-connection event and callback settings", () => {
  render(<LarkSetupGuide {...defaultProps} />)
  fireEvent.click(screen.getByRole("button", { name: "3. Connect events and card callbacks" }))
  expect(screen.getByText(/create or save, and enable the connection/)).toBeVisible()
  expect(screen.getByText(/Feishu requires an online client/)).toHaveTextContent(
    "no public callback URL is needed"
  )
  expect(screen.getByText("im.message.receive_v1")).toBeVisible()
  expect(screen.getByText("card.action.trigger")).toBeVisible()
  expect(screen.queryByText(/Reopen this saved connection/)).not.toBeInTheDocument()
})

it("explains generated webhook URLs and matching secrets in webhook mode", () => {
  render(<LarkSetupGuide {...defaultProps} transport="webhook" />)
  fireEvent.click(screen.getByRole("button", { name: "3. Connect events and card callbacks" }))
  expect(screen.getByText(/Reopen this saved connection/)).toHaveTextContent(
    "both Event configuration and Callback configuration"
  )
  expect(screen.getByText(/Select Webhook, copy Verification Token/)).toBeVisible()
  expect(screen.getByText(/Keep Verification Token and Encrypt Key consistent/)).toBeVisible()
  expect(screen.queryByText(/Feishu requires an online client/)).not.toBeInTheDocument()
})

it("copies selected application scopes without granting access and deduplicates history dependencies", async () => {
  render(<LarkSetupGuide {...defaultProps} />)
  openPermissions()
  fireEvent.click(screen.getByRole("checkbox", { name: "Streaming cards and run controls" }))
  fireEvent.click(screen.getByRole("checkbox", { name: "Private and group history" }))
  fireEvent.click(screen.getByRole("checkbox", { name: "Group follow-ups without @" }))
  fireEvent.click(screen.getByRole("checkbox", { name: "@mentions from other bots" }))
  fireEvent.click(screen.getByRole("button", { name: "Copy selected permissions" }))
  await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(1))
  const scopes = jest.mocked(writeClipboardText).mock.calls[0][0].split("\n")
  expect(scopes).toEqual([
    "im:message.p2p_msg:readonly",
    "im:message.group_at_msg:readonly",
    "im:message:send_as_bot",
    "im:resource",
    "im:message:readonly",
    "im:message.group_msg",
    "im:message.group_at_msg.include_bot:readonly",
  ])
  expect(toast.success).toHaveBeenCalledWith("Permission names copied.")
  expect(screen.getByText(/they do not grant access/)).toBeVisible()
})

it("reports clipboard rejection and leaves a selectable permission list", async () => {
  jest.mocked(writeClipboardText).mockRejectedValueOnce(new Error("permission denied"))
  render(<LarkSetupGuide {...defaultProps} />)
  openPermissions()
  fireEvent.click(screen.getByRole("button", { name: "Copy selected permissions" }))
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Could not copy. Select and copy the permission names above."
    )
  )
  expect(toast.success).not.toHaveBeenCalled()
  expect(screen.getByLabelText("Selected application permission names")).toHaveTextContent(
    "im:message:send_as_bot"
  )
})

it("does not claim copying succeeded in an unsupported browser", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
  render(<LarkSetupGuide {...defaultProps} />)
  openPermissions()
  fireEvent.click(screen.getByRole("button", { name: "Copy selected permissions" }))
  await waitFor(() => expect(toast.error).toHaveBeenCalled())
  expect(writeClipboardText).not.toHaveBeenCalled()
  expect(toast.success).not.toHaveBeenCalled()
})

it("uses the shared native clipboard even when the browser API is absent", async () => {
  jest.mocked(detectPlatform).mockReturnValue("tauri")
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
  render(<LarkSetupGuide {...defaultProps} />)
  openPermissions()
  fireEvent.click(screen.getByRole("button", { name: "Copy selected permissions" }))
  await waitFor(() => expect(toast.success).toHaveBeenCalled())
  expect(writeClipboardText).toHaveBeenCalled()
})

it("does not claim success when mobile native clipboard fails without a browser fallback", async () => {
  jest.mocked(detectPlatform).mockReturnValue("mobile")
  jest.mocked(writeMobileClipboardText).mockResolvedValue({ kind: "error", message: "denied" })
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
  render(<LarkSetupGuide {...defaultProps} />)
  openPermissions()
  fireEvent.click(screen.getByRole("button", { name: "Copy selected permissions" }))
  await waitFor(() => expect(toast.error).toHaveBeenCalled())
  expect(writeClipboardText).not.toHaveBeenCalled()
  expect(toast.success).not.toHaveBeenCalled()
})

it("copies with the mobile native backend without requiring a browser Clipboard API", async () => {
  jest.mocked(detectPlatform).mockReturnValue("mobile")
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
  render(<LarkSetupGuide {...defaultProps} />)
  openPermissions()
  fireEvent.click(screen.getByRole("button", { name: "Copy selected permissions" }))
  await waitFor(() => expect(toast.success).toHaveBeenCalled())
  expect(writeMobileClipboardText).toHaveBeenCalled()
  expect(writeClipboardText).not.toHaveBeenCalled()
})

it.each([
  ["cli_abc123", "https://open.feishu.cn/app/cli_abc123"],
  [" cli_abc123 ", "https://open.feishu.cn/app/cli_abc123"],
  ["cli_abc/../../other", "https://open.feishu.cn/app"],
  ["cli_abc?redirect=https://evil.example", "https://open.feishu.cn/app"],
  ["https://evil.example", "https://open.feishu.cn/app"],
  ["", "https://open.feishu.cn/app"],
])("opens only a trusted console URL for App ID %s", async (appId, expected) => {
  render(<LarkSetupGuide {...defaultProps} appId={appId} />)
  fireEvent.click(screen.getByRole("button", { name: "Open Feishu developer console" }))
  await waitFor(() => expect(openUrl).toHaveBeenCalledWith(expected))
})

it("localizes external link failures", async () => {
  jest.mocked(openUrl).mockRejectedValueOnce(new Error("blocked"))
  render(<LarkSetupGuide {...defaultProps} />)
  fireEvent.click(screen.getByRole("button", { name: "Open Feishu developer console" }))
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Could not open the Feishu page. Open the developer console in your browser."
    )
  )
})

it("never represents credential or cached identity evidence as end-to-end readiness", () => {
  render(<LarkSetupGuide {...defaultProps} credentialsVerified botIdentityKnown />)
  expect(screen.getByText("Credentials verified this session")).toBeVisible()
  expect(screen.getByText("Bot identity recorded")).toBeVisible()
  expect(screen.getByText(/do not confirm current runtime health/)).toBeVisible()
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "5. Configure replies and verify in Feishu" }))
  expect(screen.getByText(/seeing a card alone does not verify callbacks/)).toBeVisible()
  expect(screen.getByText(/bind the intended Agent/)).toBeVisible()
})
