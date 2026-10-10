import { act, fireEvent, render, screen } from "@testing-library/react"

import en from "@/i18n/messages/en/settings/remoteSandboxes.json"
import type { RemoteSandboxesWriteResult } from "@/hooks/sandbox/use-remote-sandboxes"
import type { RegistryRule } from "@/types/sandbox/remote-sandboxes"
import { RemoteSandboxRegistryAllowlist } from "./remote-sandbox-registry-allowlist"

const t = en.registries

function renderAllowlist(
  rules: RegistryRule[] = [],
  result: RemoteSandboxesWriteResult = { ok: true }
) {
  const save = jest.fn(async (_rules: RegistryRule[]) => result)
  render(<RemoteSandboxRegistryAllowlist rules={rules} busy={false} save={save} />)
  return save
}

describe("RemoteSandboxRegistryAllowlist", () => {
  it("says no registry is allowed when the list is empty, and cannot save an unchanged list", () => {
    renderAllowlist()
    expect(screen.getByText(t.empty)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: t.save })).toBeDisabled()
  })

  it("adds a row and saves it", async () => {
    const save = renderAllowlist()
    fireEvent.click(screen.getByRole("button", { name: t.add }))
    fireEvent.change(screen.getByLabelText(t.registry), { target: { value: "ghcr.io" } })
    fireEvent.change(screen.getByLabelText(t.prefix), { target: { value: "acme" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.save }))
    })
    expect(save).toHaveBeenCalledWith([{ registry: "ghcr.io", repositoryPrefix: "acme" }])
    expect(screen.getByRole("status")).toHaveTextContent(t.saved)
  })

  it("names an invalid row and blocks the save", () => {
    const save = renderAllowlist()
    fireEvent.click(screen.getByRole("button", { name: t.add }))
    fireEvent.change(screen.getByLabelText(t.registry), { target: { value: "nohost" } })
    expect(screen.getByRole("alert")).toHaveTextContent(t.problem.registry_invalid)
    expect(screen.getByRole("button", { name: t.save })).toBeDisabled()
    expect(save).not.toHaveBeenCalled()
  })

  it("marks plain-HTTP registries and removes rows", async () => {
    const save = renderAllowlist([{ registry: "localhost:5000", repositoryPrefix: "" }])
    fireEvent.click(screen.getByRole("checkbox"))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.save }))
    })
    expect(save).toHaveBeenLastCalledWith([
      { registry: "localhost:5000", repositoryPrefix: "", insecure: true },
    ])
    fireEvent.click(
      screen.getByRole("button", {
        name: t.removeRow.replace("{registry}", "localhost:5000"),
      })
    )
    expect(screen.getByText(t.empty)).toBeInTheDocument()
  })

  it("shows the Host's refusal", async () => {
    renderAllowlist([], {
      ok: false,
      problem: { code: "remote_sandboxes_registry_invalid", message: "bad rule" },
    })
    fireEvent.click(screen.getByRole("button", { name: t.add }))
    fireEvent.change(screen.getByLabelText(t.registry), { target: { value: "ghcr.io" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.save }))
    })
    expect(screen.getByRole("alert")).toHaveTextContent(
      en.errors.remote_sandboxes_registry_invalid.replace("{message}", "bad rule")
    )
  })
})
