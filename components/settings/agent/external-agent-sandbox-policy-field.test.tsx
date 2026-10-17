import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ExternalAgentProcessSandboxPolicy } from "@cognia/agent-contracts/external-agent"

import messages from "@/i18n/messages/en.json"
import externalAgentManage from "@/i18n/messages/en/externalAgentManage.json"
import { ExternalAgentSandboxPolicyField } from "./external-agent-sandbox-policy-field"

// The aggregate is regenerated in the commit worktree; exercise split-source
// copy here without changing generated locale artifacts in the shared tree.
Object.assign(messages.externalAgentManage.editor, externalAgentManage.editor)

function Editor({ initial }: { initial?: ExternalAgentProcessSandboxPolicy }) {
  const [policy, setPolicy] = useState(initial)
  return <ExternalAgentSandboxPolicyField value={policy} onChange={setPolicy} platform="macos" />
}

describe("ExternalAgentSandboxPolicyField", () => {
  it("renders backward-compatible defaults and updates both controls", () => {
    render(<Editor />)
    expect(screen.getByRole("combobox", { name: "Sandbox network" })).toHaveValue("full")
    const readable = screen.getByRole("combobox", { name: "Readable files" })
    expect(readable).toHaveValue("home")
    fireEvent.change(readable, { target: { value: "workspace" } })
    expect(readable).toHaveValue("workspace")
    fireEvent.change(screen.getByRole("combobox", { name: "Sandbox network" }), {
      target: { value: "off" },
    })
    expect(screen.queryByRole("textbox", { name: "Allowed hosts" })).not.toBeInTheDocument()
  })

  it("validates host patterns and explains an empty allowlist", () => {
    render(<Editor initial={{ network: "allowlist" }} />)
    expect(screen.getByText("An empty allowlist disables network access.")).toBeInTheDocument()
    const hosts = screen.getByRole("textbox", { name: "Allowed hosts" })
    fireEvent.change(hosts, { target: { value: "api.example.com\n*.example.org\n8.8.8.8" } })
    expect(hosts).toHaveAttribute("aria-invalid", "false")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    fireEvent.change(hosts, { target: { value: "https://example.com:443/path" } })
    expect(hosts).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("alert")).toHaveTextContent("Enter valid exact hosts")
    fireEvent.change(hosts, { target: { value: "api.example.com" } })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("labels every policy field inert on Windows while retaining saved values", () => {
    render(
      <ExternalAgentSandboxPolicyField
        value={{
          network: "allowlist",
          allowedHosts: ["api.example.com"],
          readableScope: "workspace",
        }}
        onChange={jest.fn()}
        platform="windows"
      />
    )
    expect(
      screen.getByText(/Inactive on Windows: the required external-agent OS sandbox is unavailable/)
    ).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Sandbox network" })).toBeDisabled()
    expect(screen.getByRole("combobox", { name: "Readable files" })).toBeDisabled()
    expect(screen.getByRole("textbox", { name: "Allowed hosts" })).toBeDisabled()
    expect(screen.getByRole("textbox", { name: "Allowed hosts" })).toHaveValue("api.example.com")
  })
})
