/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TeammateExecutionBindingField } from "./teammate-execution-binding-field"
import en from "@/i18n/messages/en.json"
import type { TeammateExecutionBinding } from "@/types/agent/agent-team"

const renderField = (
  props: Partial<React.ComponentProps<typeof TeammateExecutionBindingField>> = {}
) => {
  const onChange = jest.fn()
  const utils = render(
    <NextIntlClientProvider locale="en" messages={en}>
      <TeammateExecutionBindingField value={undefined} onChange={onChange} {...props} />
    </NextIntlClientProvider>
  )
  return { onChange, ...utils }
}

describe("TeammateExecutionBindingField", () => {
  it("defaults to inherit and previews NATIVE delegation", () => {
    renderField()
    expect(screen.getByTestId("delegation-mode-preview")).toHaveTextContent("Native delegation")
    expect(screen.getByTestId("execution-binding-mode")).toHaveTextContent("Inherit team default")
  })

  it("a pinned deployment previews ORCHESTRATED with the machine-readable reason", () => {
    renderField({ value: { mode: "pinned", deploymentRef: "dep-vendor-a" } })
    const preview = screen.getByTestId("delegation-mode-preview")
    expect(preview).toHaveTextContent("Orchestrated")
    expect(preview).toHaveTextContent("deployment-differs")
  })

  it("a pinned model role alone stays NATIVE (only frozen model roles may differ)", () => {
    renderField({ value: { mode: "pinned", modelRole: "fast" } })
    expect(screen.getByTestId("delegation-mode-preview")).toHaveTextContent("Native delegation")
  })

  it("pinned mode edits deployment and credential REFERENCES via onChange", () => {
    const { onChange } = renderField({ value: { mode: "pinned" } })
    const deployment = screen.getByPlaceholderText("deployment id (e.g. dep-vendor-a)")
    fireEvent.change(deployment, { target: { value: "dep-1" } })
    fireEvent.blur(deployment)
    expect(onChange).toHaveBeenCalledWith({ mode: "pinned", deploymentRef: "dep-1" })

    const credential = screen.getByPlaceholderText("credential profile reference")
    fireEvent.change(credential, { target: { value: "cred-9" } })
    fireEvent.blur(credential)
    expect(onChange).toHaveBeenCalledWith({ mode: "pinned", credentialProfileRef: "cred-9" })
  })

  it("clearing a pinned ref input emits undefined for that ref", () => {
    const { onChange } = renderField({
      value: { mode: "pinned", deploymentRef: "dep-1", credentialProfileRef: "cred-1" },
    })
    const deployment = screen.getByPlaceholderText("deployment id (e.g. dep-vendor-a)")
    fireEvent.change(deployment, { target: { value: "   " } })
    fireEvent.blur(deployment)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "pinned", deploymentRef: undefined })
    )
    const credential = screen.getByPlaceholderText("credential profile reference")
    fireEvent.change(credential, { target: { value: "" } })
    fireEvent.blur(credential)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "pinned", credentialProfileRef: undefined })
    )
  })

  it("pool mode parses candidate ids as a comma list (ids only)", () => {
    const { onChange } = renderField({ value: { mode: "pool", candidateIds: [] } })
    const input = screen.getByPlaceholderText("dep-a, dep-b")
    fireEvent.change(input, { target: { value: " dep-a, dep-b ,, dep-c " } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith({
      mode: "pool",
      candidateIds: ["dep-a", "dep-b", "dep-c"],
    })
  })

  it("switching the mode select emits the right binding shape", async () => {
    const { onChange } = renderField()
    fireEvent.click(screen.getByTestId("execution-binding-mode"))
    fireEvent.click(await screen.findByRole("option", { name: "Pinned" }))
    expect(onChange).toHaveBeenCalledWith({ mode: "pinned" })

    fireEvent.click(screen.getByTestId("execution-binding-mode"))
    fireEvent.click(await screen.findByRole("option", { name: "Candidate pool" }))
    expect(onChange).toHaveBeenCalledWith({ mode: "pool", candidateIds: [] })
  })

  it("switching a pinned member back to inherit emits the inherit shape", async () => {
    const { onChange } = renderField({ value: { mode: "pinned", deploymentRef: "dep-1" } })
    fireEvent.click(screen.getByTestId("execution-binding-mode"))
    fireEvent.click(await screen.findByRole("option", { name: "Inherit team default" }))
    expect(onChange).toHaveBeenCalledWith({ mode: "inherit" })
  })

  it("pinned runtime and model-role selects emit refs (auto/inherit clear them)", async () => {
    const { onChange } = renderField({
      value: { mode: "pinned", runtimePolicy: "claude-agent-sdk", modelRole: "fast" },
    })
    // Runtime → AI SDK.
    fireEvent.click(screen.getByText("Claude Agent SDK"))
    fireEvent.click(await screen.findByRole("option", { name: "AI SDK" }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "pinned", runtimePolicy: "ai-sdk" })
    )
    // Runtime → Auto clears the pin.
    fireEvent.click(screen.getByText("Claude Agent SDK"))
    fireEvent.click(await screen.findByRole("option", { name: "Auto" }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "pinned", runtimePolicy: undefined })
    )
    // Model role → Powerful, then Inherit clears it.
    fireEvent.click(screen.getByText("Fast"))
    fireEvent.click(await screen.findByRole("option", { name: "Powerful" }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "pinned", modelRole: "powerful" })
    )
    fireEvent.click(screen.getByText("Fast"))
    fireEvent.click(await screen.findByRole("option", { name: "Inherit" }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "pinned", modelRole: undefined })
    )
  })

  it("uses the team default as the preview baseline for an inheriting member", () => {
    const teamDefault: TeammateExecutionBinding = {
      mode: "pinned",
      deploymentRef: "dep-team-default",
    }
    renderField({ value: { mode: "inherit" }, teamDefault })
    // Member inherits the team's pinned deployment ⇒ differs from the app
    // baseline ⇒ orchestrated.
    expect(screen.getByTestId("delegation-mode-preview")).toHaveTextContent("deployment-differs")
  })

  it("preserves an offline pinned host and warns that dispatch will wait", () => {
    renderField({
      value: {
        mode: "inherit",
        executionTarget: { mode: "pinned", hostRef: "device:offline" },
      },
    })
    expect(screen.getByTestId("execution-host-target")).toHaveTextContent("device:offline")
    expect(
      screen.getByText("Pinned host is offline; the child will remain queued.")
    ).toBeInTheDocument()
  })
})
