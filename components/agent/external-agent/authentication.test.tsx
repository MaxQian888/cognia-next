/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/externalAgent.json"
import { acpTerminalOutput } from "@/lib/native/external-agent"
import { openUrl } from "@/lib/native/opener"
import {
  ExternalAgentAuthentication,
  type ExternalAgentAuthenticationProps,
} from "./authentication"
import type { AcpTerminalAuthState } from "@/types/agent/external-agent"

jest.mock("@/lib/native/external-agent", () => ({ acpTerminalOutput: jest.fn() }))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn(async () => {}) }))

function setup(overrides: Partial<ExternalAgentAuthenticationProps> = {}) {
  const props: ExternalAgentAuthenticationProps = {
    agentId: "kimi",
    connected: true,
    methods: [{ id: "login", name: "Kimi", type: "terminal", args: ["login"] }],
    supportsLogout: true,
    authenticate: jest.fn(async () => {}),
    getTerminalAuthState: jest.fn(() => undefined),
    cancelTerminalAuthentication: jest.fn(async () => {}),
    logout: jest.fn(async () => {}),
    ...overrides,
  }
  const wrap = (values: ExternalAgentAuthenticationProps) => (
    <NextIntlClientProvider locale="en" messages={{ externalAgent: messages }} timeZone="UTC">
      <ExternalAgentAuthentication {...values} />
    </NextIntlClientProvider>
  )
  const view = render(wrap(props))
  return {
    ...view,
    props,
    switchAgent: (next: ExternalAgentAuthenticationProps) => view.rerender(wrap(next)),
  }
}

describe("ExternalAgentAuthentication", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(acpTerminalOutput).mockResolvedValue({
      output: "Open https://example.test and enter TEST",
      truncated: false,
      exitStatus: { exitCode: null, signal: null },
    })
  })
  afterEach(() => jest.useRealTimers())

  it("does not infer authentication from connection or advertised methods", () => {
    setup()
    expect(screen.getByRole("status")).toHaveTextContent("does not confirm authentication")
    expect(screen.queryByText("Login completed")).not.toBeInTheDocument()
  })

  it("gates account changes while execution is busy or disconnected", () => {
    const { props, switchAgent } = setup({ busy: true })
    expect(screen.getByRole("button", { name: "Sign in with Kimi" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Sign out" })).toBeDisabled()
    switchAgent({ ...props, busy: false, connected: false })
    expect(screen.getByRole("button", { name: "Sign in with Kimi" })).toBeDisabled()
  })

  it("shows device login output, cancels, and reports adapter completion", async () => {
    jest.useFakeTimers()
    let state: AcpTerminalAuthState | undefined
    let finish!: () => void
    const { props } = setup({
      getTerminalAuthState: () => state,
      authenticate: jest.fn(() => {
        state = { methodId: "login", terminalId: "term", status: "running" }
        return new Promise<void>((resolve) => {
          finish = resolve
        })
      }),
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Kimi" }))
    await act(async () => {
      jest.advanceTimersByTime(300)
      await Promise.resolve()
    })
    expect(screen.getByLabelText("Login terminal output")).toHaveTextContent("TEST")
    fireEvent.click(screen.getByRole("button", { name: "Open https://example.test" }))
    expect(openUrl).toHaveBeenCalledWith("https://example.test")
    fireEvent.click(screen.getByRole("button", { name: "Cancel login" }))
    expect(props.cancelTerminalAuthentication).toHaveBeenCalledTimes(1)
    state = { methodId: "login", status: "completed" }
    await act(async () => finish())
    expect(screen.getByRole("status")).toHaveTextContent("Login completed")
  })

  it("cancels the previous agent's login and ignores its late failure after switching", async () => {
    let fail!: (error: Error) => void
    const { props, switchAgent } = setup({
      authenticate: jest.fn(
        () =>
          new Promise<void>((_, reject) => {
            fail = reject
          })
      ),
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Kimi" }))
    switchAgent({ ...props, agentId: "other", methods: [], supportsLogout: false })
    expect(props.cancelTerminalAuthentication).toHaveBeenCalledTimes(1)
    await act(async () => fail(new Error("old agent login failed")))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("requires a logout confirmation and surfaces failures without claiming sign-out", async () => {
    const { props } = setup({
      logout: jest.fn(async () => {
        throw new Error("Logout refused")
      }),
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    expect(props.logout).not.toHaveBeenCalled()
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Other applications")
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Sign out" })
    )
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Logout refused"))
    expect(screen.getByRole("status")).not.toHaveTextContent("Signed out")
  })

  it("cancels an in-flight login when the panel is closed", () => {
    const onBusyChange = jest.fn()
    const { props, unmount } = setup({
      authenticate: jest.fn(() => new Promise<void>(() => {})),
      onBusyChange,
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Kimi" }))
    unmount()
    expect(props.cancelTerminalAuthentication).toHaveBeenCalledTimes(1)
    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it("reports successful logout after confirmation", async () => {
    const { props } = setup()
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Sign out" })
    )
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Signed out"))
    expect(props.logout).toHaveBeenCalledTimes(1)
  })

  it("shows a readable error when the login terminal cannot be read", async () => {
    jest.useFakeTimers()
    jest.mocked(acpTerminalOutput).mockRejectedValue(new Error("terminal unavailable"))
    setup({
      getTerminalAuthState: () => ({ methodId: "login", terminalId: "term", status: "running" }),
    })
    await act(async () => {
      jest.advanceTimersByTime(0)
      await Promise.resolve()
    })
    expect(screen.getByRole("alert")).toHaveTextContent("Could not read login output")
  })
})
