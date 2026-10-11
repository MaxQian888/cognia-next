import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

import type { DeviceRow } from "@/lib/devices/types"
import type { HostVersionState } from "@/lib/remote-host/host-version"
import { HostUpdateUnsupportedError, type HostUpdateStatus } from "@/lib/remote-host/host-update"

import { APP_UPDATES_HREF, HostVersionNotice } from "./host-version-notice"

function row(hostVersion?: HostVersionState, overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    kind: "remote-host",
    connectionState: "versionMismatch",
    ...(hostVersion ? { hostVersion } : {}),
    ...overrides,
  } as DeviceRow
}

const state = (overrides: Partial<HostVersionState>): HostVersionState => ({
  advice: "update-host",
  hostContractVersion: 2,
  appContractVersion: 3,
  brainRefusal: null,
  observedAt: 1,
  ...overrides,
})

describe("HostVersionNotice", () => {
  it("renders nothing for a matching host, an unknown one, a revoked one, or another kind", () => {
    const { container, rerender } = render(<HostVersionNotice row={row()} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<HostVersionNotice row={row(state({ advice: "none" }))} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<HostVersionNotice row={row(state({}), { connectionState: "revoked" })} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<HostVersionNotice row={row(state({}), { kind: "paired-device" })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("asks to update a host that is behind, without an app-update link", () => {
    render(<HostVersionNotice row={row(state({}))} />)
    const notice = screen.getByTestId("host-version-notice")
    expect(notice).toHaveAttribute("data-advice", "update-host")
    expect(notice).toHaveTextContent(/v2/)
    expect(notice).toHaveTextContent(/v3/)
    expect(screen.queryByTestId("host-version-update-app")).toBeNull()
    // A host the store cannot name has no channel to ask over.
    expect(screen.queryByTestId("host-version-update-host")).toBeNull()
  })

  it("asks the host to update itself in one click", async () => {
    const install = jest.fn(async () => ({}) as HostUpdateStatus)
    render(<HostVersionNotice row={row(state({}), { hostId: "mini" })} install={install} />)
    await userEvent.click(screen.getByTestId("host-version-update-host"))
    expect(install).toHaveBeenCalledWith("mini")
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it("says when the host is too old to update itself, or refused", async () => {
    const tooOld = jest.fn(async () => {
      throw new HostUpdateUnsupportedError()
    })
    const { unmount } = render(
      <HostVersionNotice row={row(state({}), { hostId: "mini" })} install={tooOld} />
    )
    await userEvent.click(screen.getByTestId("host-version-update-host"))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(String(toastError.mock.calls[0][0])).toMatch(/by hand/)
    unmount()
    const refused = jest.fn(async () => {
      throw new Error("this host is up to date")
    })
    render(<HostVersionNotice row={row(state({}), { hostId: "mini" })} install={refused} />)
    await userEvent.click(screen.getByTestId("host-version-update-host"))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2))
    expect(String(toastError.mock.calls[1][0])).toMatch(/up to date/)
  })

  it("names a host from before contract versions", () => {
    render(<HostVersionNotice row={row(state({ hostContractVersion: null }))} />)
    expect(screen.getByTestId("host-version-notice")).not.toHaveTextContent(/v2/)
  })

  it("sends the user to the Update Center when this app is the one behind", () => {
    render(<HostVersionNotice row={row(state({ advice: "update-app", hostContractVersion: 4 }))} />)
    expect(screen.getByTestId("host-version-notice")).toHaveAttribute("data-advice", "update-app")
    expect(screen.getByTestId("host-version-update-app")).toHaveAttribute("href", APP_UPDATES_HREF)
  })

  it("explains a half-updated host by its server and brain builds", () => {
    render(
      <HostVersionNotice
        row={row(
          state({
            hostContractVersion: 3,
            brainRefusal: {
              reason: "contract_mismatch",
              brain: { version: "0.2.0", contractVersion: 4 },
              server: { version: "0.1.0", contractVersion: 3 },
            },
          })
        )}
      />
    )
    const notice = screen.getByTestId("host-version-notice")
    expect(notice).toHaveAttribute("data-half-updated", "true")
    expect(notice).toHaveTextContent("0.1.0")
    expect(notice).toHaveTextContent("0.2.0")
  })
})
