/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: jest.fn() }))

import type { LocalBrowserState } from "@/hooks/browser/use-local-browser"
import type { BrowserBackendDecision } from "@/lib/browser/backend-availability"
import type { UserChromeCandidate } from "@/lib/browser/local-client"
import { writeClipboardText } from "@/lib/tauri/clipboard"

import {
  BrowserBackendSwitcher,
  CHROME_REMOTE_DEBUGGING_URL,
  pickUserChromeCandidate,
  selectedBackend,
} from "./browser-backend-switcher"

const decision = (overrides: Partial<BrowserBackendDecision> = {}): BrowserBackendDecision => ({
  backend: "embedded",
  remoteReachable: false,
  localReachable: false,
  userChromeReachable: false,
  reason: "remote-disabled",
  ...overrides,
})

const STATUS = {
  installed: false,
  installing: false,
  chromiumVersion: null,
  running: false,
  runtimeStaged: true,
  error: null,
}

const local = (overrides: Partial<LocalBrowserState> = {}): LocalBrowserState => ({
  supported: true,
  status: STATUS,
  progress: null,
  userChrome: [],
  busy: false,
  error: null,
  refresh: jest.fn(),
  install: jest.fn().mockResolvedValue(true),
  uninstall: jest.fn(),
  discoverUserChrome: jest.fn(),
  ...overrides,
})

const chrome = (overrides: Partial<UserChromeCandidate> = {}): UserChromeCandidate => ({
  browser: "chrome",
  label: "Google Chrome",
  userDataDir: "/x",
  available: true,
  reason: null,
  ...overrides,
})

function renderSwitcher(props: Partial<React.ComponentProps<typeof BrowserBackendSwitcher>> = {}) {
  const onPreferenceChange = jest.fn()
  const onUserChromeBrowserChange = jest.fn()
  render(
    <BrowserBackendSwitcher
      decision={decision()}
      preference={null}
      onPreferenceChange={onPreferenceChange}
      local={local()}
      userChromeBrowser={null}
      onUserChromeBrowserChange={onUserChromeBrowserChange}
      {...props}
    />
  )
  return { onPreferenceChange, onUserChromeBrowserChange }
}

describe("selectedBackend", () => {
  it("shows an explicit choice over the fallback", () => {
    expect(selectedBackend(decision(), "local-chromium")).toBe("local-chromium")
    expect(selectedBackend(decision({ backend: "remote" }), null)).toBe("remote")
    expect(selectedBackend(decision({ backend: "web-fallback" }), "web-fallback")).toBe("embedded")
  })
})

describe("pickUserChromeCandidate", () => {
  it("prefers the requested browser, then an available one, then an installed one", () => {
    const edge = chrome({
      browser: "edge",
      label: "Edge",
      available: false,
      reason: "remote_debugging_disabled",
    })
    const brave = chrome({ browser: "brave", label: "Brave" })
    expect(pickUserChromeCandidate([edge, brave], "edge")).toBe(edge)
    expect(pickUserChromeCandidate([edge, brave], null)).toBe(brave)
    expect(pickUserChromeCandidate([edge], null)).toBe(edge)
    expect(
      pickUserChromeCandidate([chrome({ available: false, reason: "not_installed" })], null)
    ).toBeNull()
  })
})

describe("BrowserBackendSwitcher", () => {
  it("lists the desktop engines and hides the cloud one when unreachable", () => {
    renderSwitcher()
    const select = screen.getByRole("combobox", { name: "Browser engine" })
    const labels = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)
    expect(labels).toEqual([
      "Built-in preview",
      "Local Chromium (not installed)",
      "Your Chrome (unavailable)",
    ])
  })

  it("offers only the built-in preview and cloud off the desktop", () => {
    renderSwitcher({
      local: local({ supported: false }),
      decision: decision({ remoteReachable: true }),
    })
    const select = screen.getByRole("combobox", { name: "Browser engine" }) as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["embedded", "remote"])
  })

  it("reports the chosen engine", () => {
    const { onPreferenceChange } = renderSwitcher({
      decision: decision({ localReachable: true }),
      local: local({ status: { ...STATUS, installed: true } }),
    })
    fireEvent.change(screen.getByRole("combobox", { name: "Browser engine" }), {
      target: { value: "local-chromium" },
    })
    expect(onPreferenceChange).toHaveBeenCalledWith("local-chromium")
  })

  it("offers to install Chromium when it is chosen but missing", () => {
    const state = local()
    renderSwitcher({ preference: "local-chromium", local: state })
    fireEvent.click(screen.getByRole("button", { name: "Install Chromium" }))
    expect(state.install).toHaveBeenCalled()
  })

  it("shows install progress and failures", () => {
    renderSwitcher({
      preference: "local-chromium",
      local: local({
        busy: true,
        progress: { phase: "downloading", receivedBytes: 1024, totalBytes: 2048 },
      }),
    })
    expect(screen.getByText("Downloading Chromium… 1.0 KB of 2.0 KB")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Install Chromium" })).toBeNull()
  })

  it("shows unpacking, unknown totals and errors", () => {
    const { unmount } = render(
      <BrowserBackendSwitcher
        decision={decision()}
        preference="local-chromium"
        onPreferenceChange={jest.fn()}
        local={local({ progress: { phase: "extracting" } })}
        userChromeBrowser={null}
        onUserChromeBrowserChange={jest.fn()}
      />
    )
    expect(screen.getByText("Unpacking Chromium…")).toBeInTheDocument()
    unmount()
    renderSwitcher({
      preference: "local-chromium",
      local: local({ busy: true, progress: { phase: "downloading", receivedBytes: 10 } }),
    })
    expect(screen.getByText("Downloading Chromium… 10 B")).toBeInTheDocument()
  })

  it("reports a failed install", () => {
    renderSwitcher({
      preference: "local-chromium",
      local: local({ progress: { phase: "failed", message: "offline" } }),
    })
    expect(screen.getByRole("alert")).toHaveTextContent("Chromium could not be installed: offline")
  })

  it("says so when the build has no runtime", () => {
    renderSwitcher({
      preference: "local-chromium",
      local: local({ status: { ...STATUS, runtimeStaged: false } }),
    })
    expect(
      screen.getByText("This build does not include the local browser runtime.")
    ).toBeInTheDocument()
  })

  it("guides the user to enable remote debugging and re-checks", async () => {
    const state = local({
      userChrome: [chrome({ available: false, reason: "remote_debugging_disabled" })],
    })
    renderSwitcher({ preference: "user-chrome", local: state })
    expect(screen.getByRole("status")).toHaveTextContent(CHROME_REMOTE_DEBUGGING_URL)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the address" }))
    })
    expect(writeClipboardText).toHaveBeenCalledWith(CHROME_REMOTE_DEBUGGING_URL)
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Check again" }))
    expect(state.discoverUserChrome).toHaveBeenCalled()
  })

  it("lets the user pick among installed browsers and explains the consent prompt", () => {
    const { onUserChromeBrowserChange } = renderSwitcher({
      preference: "user-chrome",
      decision: decision({ userChromeReachable: true }),
      local: local({
        userChrome: [chrome(), chrome({ browser: "edge", label: "Microsoft Edge" })],
      }),
    })
    fireEvent.change(screen.getByRole("combobox", { name: "Browser to attach" }), {
      target: { value: "edge" },
    })
    expect(onUserChromeBrowserChange).toHaveBeenCalledWith("edge")
    expect(screen.getByText(/asks you to allow each connection/)).toBeInTheDocument()
  })

  it("explains when no supported browser exists or the chosen one is missing", () => {
    const { unmount } = render(
      <BrowserBackendSwitcher
        decision={decision()}
        preference="user-chrome"
        onPreferenceChange={jest.fn()}
        local={local()}
        userChromeBrowser={null}
        onUserChromeBrowserChange={jest.fn()}
      />
    )
    expect(screen.getByText(/No supported browser/)).toBeInTheDocument()
    unmount()
    renderSwitcher({
      preference: "user-chrome",
      userChromeBrowser: "brave",
      local: local({
        userChrome: [
          chrome(),
          chrome({ browser: "brave", label: "Brave", available: false, reason: "not_installed" }),
        ],
      }),
    })
    expect(screen.getByText("Brave is not installed.")).toBeInTheDocument()
  })
})
