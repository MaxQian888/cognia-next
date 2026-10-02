/**
 * @jest-environment jsdom
 */

jest.mock("@/lib/platform/detect", () => ({ isTauri: () => true }))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(async (_command: string, args?: { enabled?: boolean }) => ({
    enabled: args?.enabled ?? false,
    devPaths: [],
  })),
}))

import { act, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import {
  resetDevModeForTests,
  setDevModeEnabled,
  setSimulatedPermission,
} from "@/lib/plugin/ide/dev-mode"

import { PluginSimulatedBadge } from "./plugin-simulated-badge"

function renderBadge() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PluginSimulatedBadge pluginId="acme" />
    </NextIntlClientProvider>
  )
}

beforeEach(() => resetDevModeForTests())

it("appears while a simulation is in force for the plugin, and goes when it ends", async () => {
  renderBadge()
  expect(screen.queryByTestId("plugin-simulated-badge-acme")).toBeNull()
  await act(async () => {
    await setDevModeEnabled(true)
    setSimulatedPermission("acme", "process:spawn", "deny")
  })
  expect(screen.getByTestId("plugin-simulated-badge-acme")).toHaveTextContent(
    "Permissions simulated"
  )
  await act(async () => {
    await setDevModeEnabled(false)
  })
  expect(screen.queryByTestId("plugin-simulated-badge-acme")).toBeNull()
})
