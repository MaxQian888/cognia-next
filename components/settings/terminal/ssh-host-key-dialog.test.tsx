/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { SshHostKeyDialog } from "./ssh-host-key-dialog"
import type { SshHostKeyChange } from "@/lib/terminal/ssh-host-key"

const change: SshHostKeyChange = {
  host: "prod.example.com",
  port: 2222,
  knownFingerprint: "SHA256:old",
  presentedFingerprint: "SHA256:new",
}

describe("SshHostKeyDialog", () => {
  it("stays closed when there is no mismatch", () => {
    render(<SshHostKeyDialog change={null} onDismiss={jest.fn()} onTrust={jest.fn()} />)
    expect(screen.queryByTestId("ssh-host-key-dialog")).toBeNull()
  })

  it("shows both fingerprints so the user can compare them", () => {
    render(<SshHostKeyDialog change={change} onDismiss={jest.fn()} onTrust={jest.fn()} />)
    expect(screen.getByTestId("ssh-host-key-expected")).toHaveTextContent("SHA256:old")
    expect(screen.getByTestId("ssh-host-key-presented")).toHaveTextContent("SHA256:new")
  })

  it("names the missing half rather than rendering a blank line", () => {
    // An unreadable known_hosts entry must not look like an empty fingerprint,
    // which would read as "nothing was trusted before".
    render(
      <SshHostKeyDialog
        change={{ ...change, knownFingerprint: null }}
        onDismiss={jest.fn()}
        onTrust={jest.fn()}
      />
    )
    expect(screen.getByTestId("ssh-host-key-expected")).toHaveTextContent("unknownFingerprint")
  })

  it("dismisses without re-trusting", () => {
    const onDismiss = jest.fn()
    const onTrust = jest.fn()
    render(<SshHostKeyDialog change={change} onDismiss={onDismiss} onTrust={onTrust} />)

    fireEvent.click(screen.getByTestId("ssh-host-key-cancel"))

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onTrust).not.toHaveBeenCalled()
  })

  it("re-trusts only on the explicit destructive action", async () => {
    const onTrust = jest.fn(async () => undefined)
    render(<SshHostKeyDialog change={change} onDismiss={jest.fn()} onTrust={onTrust} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-host-key-trust"))
    })

    expect(onTrust).toHaveBeenCalledWith(change)
  })

  it("locks both buttons while the key is being forgotten", async () => {
    let release: (() => void) | undefined
    const onTrust = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    render(<SshHostKeyDialog change={change} onDismiss={jest.fn()} onTrust={onTrust} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-host-key-trust"))
    })
    expect(screen.getByTestId("ssh-host-key-trust")).toBeDisabled()
    expect(screen.getByTestId("ssh-host-key-cancel")).toBeDisabled()

    await act(async () => {
      release?.()
      await Promise.resolve()
    })
    expect(screen.getByTestId("ssh-host-key-trust")).not.toBeDisabled()
  })

  it("re-enables after a failed re-trust so the user can retry or back out", async () => {
    const onTrust = jest.fn(async () => {
      throw new Error("known_hosts is read-only")
    })
    render(<SshHostKeyDialog change={change} onDismiss={jest.fn()} onTrust={onTrust} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId("ssh-host-key-trust"))
    })

    // The rejection is the caller's to report; the dialog only has to survive
    // it without stranding the user on two disabled buttons.
    expect(onTrust).toHaveBeenCalled()
    expect(screen.getByTestId("ssh-host-key-trust")).not.toBeDisabled()
    expect(screen.getByTestId("ssh-host-key-cancel")).not.toBeDisabled()
  })
})
