/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))

/**
 * `var`, not `const`: `jest.mock` factories hoist above this body, and the hook
 * module reads `toast` at import time. A `const` is still in its temporal dead
 * zone at that point and the whole suite fails to load.
 */
// eslint-disable-next-line no-var -- hoisting is the point; see above.
var toastSuccess = jest.fn()
// eslint-disable-next-line no-var -- same hoisting rule.
var toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

// eslint-disable-next-line no-var -- jest.mock factories hoist above this body.
var tauri: boolean
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => tauri,
}))

// eslint-disable-next-line no-var -- same hoisting rule.
var forgetHostKey = jest.fn(async (..._args: unknown[]) => 1)
jest.mock("@/lib/terminal/ssh-host-key", () => ({
  ...jest.requireActual("@/lib/terminal/ssh-host-key"),
  forgetSshHostKey: (...args: unknown[]) => forgetHostKey(...args),
}))

import { useSshHostKeyChange } from "./use-ssh-host-key-change"

const CHANGED = `ssh_host_key_changed:${JSON.stringify({
  host: "10.0.4.21",
  port: 22,
  knownFingerprint: "SHA256:old",
  presentedFingerprint: "SHA256:new",
})}`

function Harness({
  message,
  onForgotten,
}: {
  message: unknown
  onForgotten?: (change: { host: string }) => void
}) {
  const guard = useSshHostKeyChange(onForgotten ? { onForgotten } : {})
  return (
    <div>
      <button data-testid="offer" onClick={() => guard.capture(message)}>
        offer
      </button>
      <span data-testid="taken">{String(guard.change !== null)}</span>
      {guard.dialog}
    </div>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  tauri = true
})

it("takes a host-key change and shows both fingerprints", async () => {
  render(<Harness message={CHANGED} />)
  await userEvent.click(screen.getByTestId("offer"))
  expect(screen.getByTestId("ssh-host-key-expected")).toHaveTextContent("SHA256:old")
  expect(screen.getByTestId("ssh-host-key-presented")).toHaveTextContent("SHA256:new")
})

/**
 * The guard knows about exactly one failure. Swallowing the rest would leave
 * every other connection error with no reporting at all, since the caller
 * skips its own path on a `true`.
 */
it("declines every other failure, so the caller keeps its own error path", async () => {
  render(<Harness message="connection refused" />)
  await userEvent.click(screen.getByTestId("offer"))
  expect(screen.getByTestId("taken")).toHaveTextContent("false")
  expect(screen.queryByTestId("ssh-host-key-dialog")).not.toBeInTheDocument()
})

/** A truncated payload must degrade to the ordinary path, not a blank warning. */
it("declines a malformed payload rather than rendering empty fingerprints", async () => {
  render(<Harness message="ssh_host_key_changed:{not json" />)
  await userEvent.click(screen.getByTestId("offer"))
  expect(screen.getByTestId("taken")).toHaveTextContent("false")
})

it("forgets the old key only on the explicit re-trust", async () => {
  render(<Harness message={CHANGED} />)
  await userEvent.click(screen.getByTestId("offer"))
  expect(forgetHostKey).not.toHaveBeenCalled()
  await userEvent.click(screen.getByTestId("ssh-host-key-trust"))
  expect(forgetHostKey).toHaveBeenCalledWith("10.0.4.21", 22)
  expect(toastSuccess).toHaveBeenCalled()
})

it("hands the caller the change back so a retry can follow", async () => {
  const onForgotten = jest.fn()
  render(<Harness message={CHANGED} onForgotten={onForgotten} />)
  await userEvent.click(screen.getByTestId("offer"))
  await userEvent.click(screen.getByTestId("ssh-host-key-trust"))
  expect(onForgotten).toHaveBeenCalledWith(expect.objectContaining({ host: "10.0.4.21" }))
})

it("keeps the dialog up when known_hosts cannot be written", async () => {
  forgetHostKey.mockRejectedValueOnce(new Error("read-only"))
  render(<Harness message={CHANGED} />)
  await userEvent.click(screen.getByTestId("offer"))
  await userEvent.click(screen.getByTestId("ssh-host-key-trust"))
  expect(toastError).toHaveBeenCalled()
  expect(screen.getByTestId("ssh-host-key-dialog")).toBeInTheDocument()
})

/**
 * `ssh_forget_host_key` is `target: "client"` with `transports: ["internal"]`,
 * so a companion cannot call it. The warning is still worth everything it
 * carries: both fingerprints are what the user needs in order to go and check.
 */
it("still shows the mismatch on a companion, without offering the re-trust", async () => {
  tauri = false
  render(<Harness message={CHANGED} />)
  await userEvent.click(screen.getByTestId("offer"))
  expect(screen.getByTestId("ssh-host-key-presented")).toHaveTextContent("SHA256:new")
  expect(screen.queryByTestId("ssh-host-key-trust")).not.toBeInTheDocument()
  expect(screen.getByTestId("ssh-host-key-desktop-only")).toBeInTheDocument()
})

it("closes without touching known_hosts when the warning is dismissed", async () => {
  render(<Harness message={CHANGED} />)
  await userEvent.click(screen.getByTestId("offer"))
  await userEvent.click(screen.getByTestId("ssh-host-key-cancel"))
  expect(forgetHostKey).not.toHaveBeenCalled()
  expect(screen.getByTestId("taken")).toHaveTextContent("false")
})
