/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import enPair from "@/i18n/messages/en/mobile/pair.json"
import zhPair from "@/i18n/messages/zh-CN/mobile/pair.json"

import { HostProbeStatus } from "./host-probe-status"
import type { PairHostState } from "./pair-scene"

const mockWriteClipboardText = jest.fn()
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (value: string) => mockWriteClipboardText(value),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && (vars.host || vars.version) ? `${key}(${String(vars.host)}/${String(vars.version)})` : key,
}))

const STATES: readonly PairHostState[] = ["searching", "absent", "blocked", "reachable"] as const

beforeEach(() => {
  mockWriteClipboardText.mockReset()
  mockWriteClipboardText.mockResolvedValue(undefined)
})

it.each(STATES)("states %s in its own words", (state) => {
  render(<HostProbeStatus state={state} />)
  const status = screen.getByTestId("pair-host-probe")
  expect(status).toHaveAttribute("data-state", state)
  expect(status).toHaveTextContent(state)
})

it("names the Host it actually reached", () => {
  render(
    <HostProbeStatus state="reachable" baseUrl="http://127.0.0.1:27891" serverVersion="0.1.0" />
  )
  expect(screen.getByTestId("pair-host-probe")).toHaveTextContent("127.0.0.1:27891/0.1.0")
})

it("hands over the exact origin to allowlist, copyable", async () => {
  // A user retyping an origin by hand gets the scheme or the port wrong and
  // the Host keeps refusing them for a reason this screen already knew.
  render(
    <HostProbeStatus
      state="blocked"
      baseUrl="http://127.0.0.1:27891"
      origin="http://localhost:3000"
    />
  )
  expect(screen.getByTestId("pair-host-probe-origin")).toHaveTextContent("http://localhost:3000")
  await userEvent.click(screen.getByTestId("pair-host-probe-copy-origin"))
  expect(mockWriteClipboardText).toHaveBeenCalledWith("http://localhost:3000")
})

it("does not claim an origin it was never given", () => {
  render(<HostProbeStatus state="blocked" />)
  expect(screen.queryByTestId("pair-host-probe-origin")).not.toBeInTheDocument()
})

it("shows the allowlist block only for a refusal", () => {
  render(<HostProbeStatus state="reachable" origin="http://localhost:3000" />)
  expect(screen.queryByTestId("pair-host-probe-origin")).not.toBeInTheDocument()
})

// `lint:i18n` cannot see `t(state)`, so the catalogue is pinned here.
it.each(STATES)("has copy in both locales for %s", (state) => {
  for (const catalogue of [enPair, zhPair] as Array<Record<string, Record<string, string>>>) {
    expect(catalogue.hostProbe[state]).toBeTruthy()
  }
})
