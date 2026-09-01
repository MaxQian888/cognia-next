/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { SshConfigImportDialog } from "./ssh-config-import-dialog"
import type { SshConfigSource, SshImportResult } from "@/lib/terminal/ssh-config-import"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"

function found(text: string): () => Promise<SshConfigSource> {
  return async () => ({ kind: "found", path: "/Users/dev/.ssh/config", text })
}

async function openWith(
  read: () => Promise<SshConfigSource>,
  hosts: SshHostProfile[] = [],
  onImport: (result: SshImportResult) => void = () => {}
) {
  const user = userEvent.setup()
  render(<SshConfigImportDialog hosts={hosts} onImport={onImport} read={read as never} />)
  await user.click(screen.getByTestId("ssh-config-import-open"))
  return user
}

describe("SshConfigImportDialog", () => {
  it("lists each importable host with its target", async () => {
    await openWith(found("Host prod\n  HostName server.example\n  User deploy\n  Port 2222\n"))
    const entry = await screen.findByTestId("ssh-config-import-entry-alias:prod")
    expect(entry.textContent).toContain("prod")
    expect(entry.textContent).toContain("deploy@server.example:2222")
  })

  it("says the file is missing rather than showing an empty list", async () => {
    // A machine that has never used ssh has no config; that is ordinary and
    // must not read as "nothing to import from a file that exists".
    await openWith(async () => ({ kind: "absent", path: "/Users/dev/.ssh/config" }))
    const absent = await screen.findByTestId("ssh-config-import-absent")
    expect(absent).toBeInTheDocument()
    // We looked at a real path and it was not there: the ordinary fresh-machine
    // case, which needs no apology and no instruction.
    expect(absent.textContent).toContain("absent")
    expect(absent.textContent).not.toContain("unreadableHere")
    expect(screen.getByTestId("ssh-config-import-confirm")).toBeDisabled()
  })

  it("surfaces a read failure instead of pretending the file was empty", async () => {
    await openWith(async () => {
      throw new Error("permission denied")
    })
    expect((await screen.findByTestId("ssh-config-import-error")).textContent).toBe(
      "permission denied"
    )
  })

  it("marks a host that already exists and defaults it to replace", async () => {
    const hosts: SshHostProfile[] = [
      { id: "ssh-1", name: "prod", host: "old", port: 22, username: "u", authMethod: "agent" },
    ]
    await openWith(found("Host prod\n  HostName server.example\n"), hosts)
    const entry = await screen.findByTestId("ssh-config-import-entry-alias:prod")
    expect(entry.getAttribute("data-resolution")).toBe("overwrite")
    expect(entry.textContent).toContain("badges.exists")
  })

  it("does not offer replace for a host that matches nothing", async () => {
    // "Replace saved" with nothing to replace is a choice that cannot be
    // honoured, so it is absent rather than present and inert.
    const user = await openWith(found("Host fresh\n  HostName server.example\n"))
    await screen.findByTestId("ssh-config-import-entry-alias:fresh")
    await user.click(screen.getByLabelText('resolution.label:{"name":"fresh"}'))
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent)
    expect(options).toEqual(["resolution.create", "resolution.skip"])
  })

  it("marks a bastion invented from a ProxyJump line", async () => {
    await openWith(found("Host prod\n  HostName server.example\n  ProxyJump ci@jump.example\n"))
    const entry = await screen.findByTestId("ssh-config-import-entry-jump:ci@jump.example")
    expect(entry.textContent).toContain("badges.synthesized")
    const target = screen.getByTestId("ssh-config-import-entry-alias:prod")
    expect(target.textContent).toContain("via")
  })

  it("labels a narrowed bind on the entry it applies to", async () => {
    await openWith(found("Host prod\n  LocalForward 0.0.0.0:9090 cache:6379\n"))
    expect(
      await screen.findByTestId("ssh-config-import-adjustment-bindNarrowedToLoopback")
    ).toBeInTheDocument()
  })

  it("names everything it could not import, with line numbers", async () => {
    await openWith(
      found(`Host *
  User deploy
Include ~/.ssh/config.d/*
Match host bastion
  User root
`)
    )
    const notices = await screen.findByTestId("ssh-config-import-notices")
    expect(notices.textContent).toContain("notices.wildcardHost")
    expect(notices.textContent).toContain("notices.include")
    expect(notices.textContent).toContain("notices.matchBlock")
    expect(notices.textContent).toContain('notices.line:{"line":1}')
  })

  it("counts only the entries that are not skipped", async () => {
    const user = await openWith(found("Host a\nHost b\n"))
    await screen.findByTestId("ssh-config-import-entry-alias:a")
    expect(screen.getByTestId("ssh-config-import-confirm").textContent).toBe('confirm:{"count":2}')

    await user.click(screen.getByLabelText('resolution.label:{"name":"a"}'))
    await user.click(await screen.findByRole("option", { name: "resolution.skip" }))
    await waitFor(() =>
      expect(screen.getByTestId("ssh-config-import-confirm").textContent).toBe(
        'confirm:{"count":1}'
      )
    )
  })

  it("cannot be confirmed when every entry is skipped", async () => {
    const user = await openWith(found("Host a\n"))
    await screen.findByTestId("ssh-config-import-entry-alias:a")
    await user.click(screen.getByLabelText('resolution.label:{"name":"a"}'))
    await user.click(await screen.findByRole("option", { name: "resolution.skip" }))
    await waitFor(() => expect(screen.getByTestId("ssh-config-import-confirm")).toBeDisabled())
  })

  it("hands the caller the merged profiles only after confirmation", async () => {
    const onImport = jest.fn()
    const user = await openWith(
      found("Host prod\n  HostName server.example\n  User deploy\n"),
      [],
      onImport
    )
    await screen.findByTestId("ssh-config-import-entry-alias:prod")
    // Nothing is written while the preview is open.
    expect(onImport).not.toHaveBeenCalled()

    await user.click(screen.getByTestId("ssh-config-import-confirm"))
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1))
    const result = onImport.mock.calls[0][0] as SshImportResult
    expect(result.created).toBe(1)
    expect(result.profiles[0]).toMatchObject({ name: "prod", host: "server.example" })
  })

  it("honours a per-entry skip when it applies the import", async () => {
    const onImport = jest.fn()
    const user = await openWith(found("Host a\nHost b\n"), [], onImport)
    await screen.findByTestId("ssh-config-import-entry-alias:a")
    await user.click(screen.getByLabelText('resolution.label:{"name":"a"}'))
    await user.click(await screen.findByRole("option", { name: "resolution.skip" }))
    await user.click(screen.getByTestId("ssh-config-import-confirm"))

    await waitFor(() => expect(onImport).toHaveBeenCalled())
    const result = onImport.mock.calls[0][0] as SshImportResult
    expect(result.profiles.map((profile) => profile.name)).toEqual(["b"])
  })

  it("keeps the dialog open and shows why when applying fails", async () => {
    const user = await openWith(found("Host prod\n"), [], () => {
      throw new Error("settings are read-only")
    })
    await screen.findByTestId("ssh-config-import-entry-alias:prod")
    await user.click(screen.getByTestId("ssh-config-import-confirm"))
    expect((await screen.findByTestId("ssh-config-import-error")).textContent).toBe(
      "settings are read-only"
    )
    expect(screen.getByTestId("ssh-config-import-dialog")).toBeInTheDocument()
  })

  it("closes without importing when cancelled", async () => {
    const onImport = jest.fn()
    const user = await openWith(found("Host prod\n"), [], onImport)
    await screen.findByTestId("ssh-config-import-entry-alias:prod")
    await user.click(screen.getByTestId("ssh-config-import-cancel"))
    await waitFor(() => expect(screen.queryByTestId("ssh-config-import-dialog")).toBeNull())
    expect(onImport).not.toHaveBeenCalled()
  })
})

/**
 * `readSshConfigFile` returns `{ kind: "absent", path: null }` when it could
 * not resolve a home directory at all, which is every shell without a local
 * filesystem. Rendering that as "no config found at ~/.ssh/config" invited the
 * reader to go create a file this build would still never read.
 */
it("separates a shell that cannot look from a machine that has no config", async () => {
  await openWith(async () => ({ kind: "absent", path: null }))
  const absent = await screen.findByTestId("ssh-config-import-absent")
  expect(absent.textContent).toContain("unreadableHere")
})
