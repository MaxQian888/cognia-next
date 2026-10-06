import { act, render, screen } from "@testing-library/react"

import { PushPanel } from "./push-panel"
import type { PushConfigStatus } from "../blocks/push-credentials-block"

let report: ((status: PushConfigStatus) => void) | undefined
jest.mock("../blocks/push-credentials-block", () => ({
  PushCredentialsBlock: ({ onStatus }: { onStatus: typeof report }) => {
    report = onStatus
    return <div data-testid="push-credentials-block" />
  },
}))
jest.mock("../blocks/push-test-block", () => ({
  PushTestBlock: ({ configured }: { configured: boolean }) => (
    <div data-testid="push-test-block" data-configured={configured} />
  ),
}))

it("arms the test button once either provider reports configured", () => {
  render(<PushPanel />)
  expect(screen.getByTestId("push-test-block")).toHaveAttribute("data-configured", "false")
  act(() => report?.({ fcmConfigured: false, apnsConfigured: true }))
  expect(screen.getByTestId("push-test-block")).toHaveAttribute("data-configured", "true")
})

it("arms the test button when only Huawei push is configured and disarms it when cleared", () => {
  render(<PushPanel />)
  act(() => report?.({ fcmConfigured: false, apnsConfigured: false, hmsConfigured: true }))
  expect(screen.getByTestId("push-test-block")).toHaveAttribute("data-configured", "true")
  act(() => report?.({ fcmConfigured: false, apnsConfigured: false, hmsConfigured: false }))
  expect(screen.getByTestId("push-test-block")).toHaveAttribute("data-configured", "false")
})
