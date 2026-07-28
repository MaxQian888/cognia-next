/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { PluginPanel } from "./plugin-panel"

const def = (over: Partial<PluginSubagentDef> = {}): PluginSubagentDef => ({
  id: "reviewer",
  name: "Reviewer",
  description: "Reviews code",
  prompt: "You review code.",
  ...over,
})

describe("PluginPanel", () => {
  it("degrades to an empty state when the plugin is gone", () => {
    render(<PluginPanel runtimeId="acme:reviewer" entry={undefined} />)
    expect(screen.queryByTestId("plugin-disabled")).not.toBeInTheDocument()
  })

  it("shows the namespaced runtime id — the value the dispatcher addresses", () => {
    render(<PluginPanel runtimeId="acme:reviewer" entry={def()} pluginId="acme" />)
    expect(screen.getByText("acme:reviewer")).toBeInTheDocument()
  })

  it("renders the prompt read-only", () => {
    render(<PluginPanel runtimeId="acme:reviewer" entry={def()} pluginId="acme" />)
    expect(screen.getByText("You review code.")).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("marks a disabled entry — the resolvers exclude it from dispatch", () => {
    render(
      <PluginPanel runtimeId="acme:reviewer" entry={def({ disabled: true })} pluginId="acme" />
    )
    expect(screen.getByTestId("plugin-disabled")).toBeInTheDocument()
  })

  it("marks a hidden entry, which stays dispatchable", () => {
    render(<PluginPanel runtimeId="acme:reviewer" entry={def({ hidden: true })} pluginId="acme" />)
    expect(screen.getByTestId("plugin-hidden")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-disabled")).not.toBeInTheDocument()
  })

  it("lists the manifest's tool grants when present", () => {
    render(
      <PluginPanel
        runtimeId="acme:reviewer"
        entry={def({ tools: ["Read", "Grep"], disallowedTools: ["Bash"] })}
        pluginId="acme"
      />
    )
    expect(screen.getByText("Read, Grep")).toBeInTheDocument()
    expect(screen.getByText("Bash")).toBeInTheDocument()
  })

  it("omits optional rows it has no value for", () => {
    render(<PluginPanel runtimeId="acme:reviewer" entry={def()} pluginId="acme" />)
    expect(screen.queryByText("toolsLabel")).not.toBeInTheDocument()
    expect(screen.queryByText("mcpLabel")).not.toBeInTheDocument()
  })
})
