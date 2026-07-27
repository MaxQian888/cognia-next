/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import {
  GithubOpenPrConfig,
  GithubRunIssueLoopConfig,
  GithubWebhookTriggerConfig,
} from "./github-forms"

jest.mock("@/components/agent/external-agent/selector", () => ({
  ExternalAgentSelector: ({
    selectedAgentId,
    onAgentChange,
  }: {
    selectedAgentId: string | null
    onAgentChange: (agentId: string | null) => void
  }) => (
    <div data-testid="external-agent-selector" data-selected-agent={selectedAgentId ?? "built-in"}>
      <button type="button" onClick={() => onAgentChange("codex-main")}>
        select-codex
      </button>
      <button type="button" onClick={() => onAgentChange(null)}>
        select-built-in
      </button>
      <button type="button" disabled>
        disabled-agent
      </button>
    </div>
  ),
}))

jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({
    id,
    value,
    onChange,
    placeholder,
  }: {
    id?: string
    value: string
    onChange: (next: string) => void
    placeholder?: string
  }) => (
    <input
      id={id}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

function fieldInput(container: HTMLElement, name: string): HTMLInputElement {
  const wrapper = container.querySelector(`[data-field="${name}"]`)
  const input = wrapper?.querySelector("input")
  if (!(input instanceof HTMLInputElement)) throw new Error(`missing ${name} input`)
  return input
}

describe("GithubWebhookTriggerConfig", () => {
  it("exposes repo, webhook transport, secret, and events controls", () => {
    const onChange = jest.fn()
    const { container } = render(
      <GithubWebhookTriggerConfig
        params={{
          repoFullName: "acme/widgets",
          path: "github-events",
          hmacSecret: "secret",
          events: ["issues.labeled"],
        }}
        onChange={onChange}
      />
    )

    expect(container.querySelector('[data-field="repoFullName"]')).toBeInTheDocument()
    expect(fieldInput(container, "repoFullName")).toBeInTheDocument()
    expect(container.querySelector('[data-field="path"]')).toBeInTheDocument()
    expect(fieldInput(container, "path")).toBeInTheDocument()
    expect(container.querySelector('[data-field="hmacSecret"]')).toBeInTheDocument()
    expect(fieldInput(container, "hmacSecret")).toBeInTheDocument()
    expect(screen.getByText("issues.labeled")).toBeInTheDocument()
  })

  it("patches transport params and toggles events", () => {
    const onChange = jest.fn()
    const { container } = render(
      <GithubWebhookTriggerConfig params={{ events: [] }} onChange={onChange} />
    )

    const path = fieldInput(container, "path")
    fireEvent.change(path, { target: { value: "github-events" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ path: "github-events" }))

    const secret = fieldInput(container, "hmacSecret")
    fireEvent.change(secret, { target: { value: "ghs_secret" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hmacSecret: "ghs_secret" }))

    fireEvent.click(screen.getByLabelText("issues.labeled"))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ events: ["issues.labeled"] }))
  })
})

describe("GitHub forms", () => {
  it("uses unique repo field ids when multiple GitHub forms render together", () => {
    const onChange = jest.fn()
    const { container } = render(
      <div>
        <GithubWebhookTriggerConfig params={{}} onChange={onChange} />
        <GithubOpenPrConfig params={{}} onChange={onChange} />
      </div>
    )

    const repoInputs = container.querySelectorAll('[data-field="repoFullName"] input')
    expect(repoInputs).toHaveLength(2)
    const ids = Array.from(repoInputs).map((input) => input.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("GithubRunIssueLoopConfig", () => {
  it("loads legacy params as built-in Claude and persists External Agent selection", () => {
    const onChange = jest.fn()
    render(<GithubRunIssueLoopConfig params={{ issueNumber: 1 }} onChange={onChange} />)

    expect(screen.getByTestId("external-agent-selector")).toHaveAttribute(
      "data-selected-agent",
      "built-in"
    )
    fireEvent.click(screen.getByRole("button", { name: "select-codex" }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 1, externalAgentId: "codex-main" })
    )
  })

  it("reloads and clears a persisted External Agent without saving disabled agents", () => {
    const onChange = jest.fn()
    render(
      <GithubRunIssueLoopConfig
        params={{ issueNumber: 1, externalAgentId: "codex-main" }}
        onChange={onChange}
      />
    )

    expect(screen.getByTestId("external-agent-selector")).toHaveAttribute(
      "data-selected-agent",
      "codex-main"
    )
    expect(screen.getByRole("button", { name: "disabled-agent" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "disabled-agent" }))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "select-built-in" }))
    expect(onChange).toHaveBeenCalledWith({ issueNumber: 1 })
  })
})
