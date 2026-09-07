/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

let alwaysOn = true
let remoteActive = false
let paired = true

jest.mock("@/lib/platform/capabilities", () => ({
  hasCapability: () => alwaysOn,
  hasHostRuntime: () => paired,
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => remoteActive,
  subscribeActiveRemoteTransport: () => () => {},
}))

import { BotRuntimeNotice } from "./bot-runtime-notice"

beforeEach(() => {
  alwaysOn = true
  remoteActive = false
  paired = true
})

describe("BotRuntimeNotice", () => {
  it("says nothing on a shell that runs the Bots itself", () => {
    // A notice that appears in the healthy case is one the reader learns to
    // skip, and the healthy case needs no explaining.
    render(<BotRuntimeNotice />)
    expect(screen.queryByTestId("bot-runtime-notice")).not.toBeInTheDocument()
  })

  it("warns loudest when nothing anywhere will run these Bots", () => {
    // The failure the whole notice exists for: armed triggers and a healthy
    // status on a browser tab that has no runner and no Host to ask.
    alwaysOn = false
    paired = false
    render(<BotRuntimeNotice />)
    const notice = screen.getByTestId("bot-runtime-notice")
    expect(notice).toHaveAttribute("data-reach", "none")
    expect(notice).toHaveTextContent("Nothing is running these Bots")
  })

  it("names the paired Host as the one draining, rather than warning", () => {
    alwaysOn = false
    render(<BotRuntimeNotice />)
    const notice = screen.getByTestId("bot-runtime-notice")
    expect(notice).toHaveAttribute("data-reach", "paired")
    expect(notice).toHaveTextContent("A paired Host runs these Bots")
  })

  it("says the remote Host is draining even though this desktop has always-on", () => {
    // `always-on` is a static baseline. A desktop driving a remote Cognia
    // still reports it, and calling this shell local would claim its own
    // runner is draining a queue whose rows are mirrors.
    remoteActive = true
    render(<BotRuntimeNotice />)
    expect(screen.getByTestId("bot-runtime-notice")).toHaveAttribute("data-reach", "remote")
  })
})
