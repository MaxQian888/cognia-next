/** @jest-environment jsdom */

import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { isTauri } from "@/lib/tauri"
import {
  forgetSshHostKey,
  listSshHostKeys,
  type TrustedSshHostKey,
} from "@/lib/terminal/ssh-host-key"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import en from "@/i18n/messages/en/settings/terminal.json"
import { SshTrustedHostKeys } from "./ssh-trusted-host-keys"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/terminal/ssh-host-key", () => ({
  listSshHostKeys: jest.fn(),
  forgetSshHostKey: jest.fn(),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => {
    const messages = jest.requireActual("@/i18n/messages/en/settings/terminal.json").ssh.trustedKeys
    return (key: string, values: Record<string, string> = {}) => {
      const template = key.split(".").reduce((value, part) => value[part], messages) as string
      return template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? `{${name}}`)
    }
  },
}))

const key: TrustedSshHostKey = {
  host: "prod.example.com",
  port: 2222,
  keyType: "ssh-ed25519",
  fingerprint: "SHA256:trusted-key",
}
const profile: SshHostProfile = {
  id: "ssh-1",
  name: "Production",
  host: key.host,
  port: key.port,
  username: "deploy",
  authMethod: "agent",
}
const text = en.ssh.trustedKeys

beforeEach(() => {
  jest.mocked(isTauri).mockReturnValue(true)
  jest.mocked(listSshHostKeys).mockReset().mockResolvedValue([key])
  jest.mocked(forgetSshHostKey).mockReset().mockResolvedValue(1)
})

describe("SshTrustedHostKeys", () => {
  it("lists the address, key type, fingerprint and every matching saved profile", async () => {
    render(
      <SshTrustedHostKeys
        profiles={[
          profile,
          {
            ...profile,
            id: "ssh-2",
            name: "Read only",
            host: "PROD.EXAMPLE.COM",
            username: "reader",
          },
          { ...profile, id: "ssh-3", name: "Another port", port: 22 },
          { ...profile, id: "ssh-4", name: "Another machine", host: "other.example.com" },
        ]}
      />
    )
    expect(await screen.findByText("prod.example.com:2222")).toBeInTheDocument()
    expect(screen.getByText(key.keyType)).toBeInTheDocument()
    expect(screen.getByText(key.fingerprint)).toBeInTheDocument()
    expect(screen.getByText("Saved profiles: Production, Read only")).toBeInTheDocument()
    expect(screen.queryByText(/Another port|Another machine/)).not.toBeInTheDocument()
  })

  it("shows keys even when no saved profiles remain and formats IPv6 addresses", async () => {
    jest.mocked(listSshHostKeys).mockResolvedValue([{ ...key, host: "2001:db8::1" }])
    render(<SshTrustedHostKeys profiles={[]} />)
    expect(await screen.findByText("[2001:db8::1]:2222")).toBeInTheDocument()
    expect(screen.getByText(text.noProfiles)).toBeInTheDocument()
  })

  it("explains why paired browsers and phones cannot read or edit desktop trust", () => {
    jest.mocked(isTauri).mockReturnValue(false)
    render(<SshTrustedHostKeys profiles={[profile]} />)
    expect(screen.getByText(text.desktopOnly)).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(listSshHostKeys).not.toHaveBeenCalled()
    expect(forgetSshHostKey).not.toHaveBeenCalled()
  })

  it("shows loading, then the empty state", async () => {
    let resolve!: (keys: TrustedSshHostKey[]) => void
    jest.mocked(listSshHostKeys).mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    render(<SshTrustedHostKeys profiles={[]} />)
    expect(screen.getByRole("status")).toHaveTextContent(text.loading)
    expect(screen.getByRole("button", { name: text.refresh })).toBeDisabled()
    await act(async () => resolve([]))
    expect(screen.getByText(text.empty)).toBeInTheDocument()
  })

  it("renders a translated read refusal and retries", async () => {
    const user = userEvent.setup()
    jest.mocked(listSshHostKeys).mockRejectedValueOnce(new Error("local identity required"))
    render(<SshTrustedHostKeys profiles={[]} />)
    expect(await screen.findByRole("alert")).toHaveTextContent(text.loadFailed)
    await user.click(screen.getByRole("button", { name: text.retry }))
    expect(await screen.findByText(key.fingerprint)).toBeInTheDocument()
    expect(listSshHostKeys).toHaveBeenCalledTimes(2)
  })

  it("cancels without forgetting a key", async () => {
    const user = userEvent.setup()
    render(<SshTrustedHostKeys profiles={[profile]} />)
    await user.click(await screen.findByRole("button", { name: /Forget key SHA256/ }))
    const dialog = screen.getByRole("alertdialog")
    expect(within(dialog).getByText(key.fingerprint)).toBeInTheDocument()
    expect(within(dialog).getByText(text.confirm.body)).toBeInTheDocument()
    expect(forgetSshHostKey).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole("button", { name: text.confirm.cancel }))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(forgetSshHostKey).not.toHaveBeenCalled()
  })

  it("forgets only the confirmed fingerprint and refreshes from the host", async () => {
    const user = userEvent.setup()
    render(<SshTrustedHostKeys profiles={[profile]} />)
    await user.click(await screen.findByRole("button", { name: /Forget key SHA256/ }))
    jest.mocked(listSshHostKeys).mockResolvedValue([])
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: text.confirm.action })
    )
    expect(forgetSshHostKey).toHaveBeenCalledWith(key.host, key.port, key.fingerprint)
    expect(await screen.findByText(text.empty)).toBeInTheDocument()
    expect(listSshHostKeys).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("keeps a refused removal visible and allows cancelling or retrying", async () => {
    const user = userEvent.setup()
    jest.mocked(forgetSshHostKey).mockRejectedValueOnce(new Error("fingerprint changed"))
    render(<SshTrustedHostKeys profiles={[]} />)
    await user.click(await screen.findByRole("button", { name: /Forget key SHA256/ }))
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: text.confirm.action })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(text.forgetFailed)
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
    expect(listSshHostKeys).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: text.confirm.cancel })).toBeEnabled()
  })

  it("locks confirmation while removal is pending", async () => {
    const user = userEvent.setup()
    let resolve!: (removed: number) => void
    jest.mocked(forgetSshHostKey).mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    render(<SshTrustedHostKeys profiles={[]} />)
    await user.click(await screen.findByRole("button", { name: /Forget key SHA256/ }))
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: text.confirm.action })
    )
    expect(screen.getByRole("button", { name: text.forgetting })).toBeDisabled()
    expect(screen.getByRole("button", { name: text.confirm.cancel })).toBeDisabled()
    await act(async () => resolve(1))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
  })
})
