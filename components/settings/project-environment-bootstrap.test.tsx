import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ProjectEnvironmentBootstrapAgent } from "@/types/project-environment"
import { ProjectEnvironmentBootstrap } from "./project-environment-bootstrap"

function Harness({ initial }: { initial?: ProjectEnvironmentBootstrapAgent }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <ProjectEnvironmentBootstrap value={value} onChange={setValue} ids="bootstrap" />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  )
}

it("is optional and shows fields with bounded defaults when enabled", () => {
  render(<Harness />)
  expect(screen.queryByLabelText("Initialization task")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  expect(screen.getByLabelText("API key variable")).toHaveValue("COGNIA_BOOTSTRAP_API_KEY")
  expect(screen.getByLabelText("Bootstrap executable")).toHaveValue("cognia-bootstrap")
  expect(screen.getByLabelText("Maximum steps")).toHaveValue(32)
  expect(screen.getByLabelText("Total timeout (seconds)")).toHaveAttribute("max", "3600")
})

it("applies provider and task presets only on explicit action and keeps results editable", () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  fireEvent.change(screen.getByLabelText("Provider preset"), { target: { value: "ollama" } })
  expect(screen.getByLabelText("Model API endpoint")).toHaveValue("")
  fireEvent.click(screen.getByRole("button", { name: "Apply provider" }))
  expect(screen.getByLabelText("Model API endpoint")).toHaveValue("http://localhost:11434/v1")
  expect(screen.getByText(/^Replace local-model/)).toHaveAttribute("role", "status")
  fireEvent.change(screen.getByLabelText("Bootstrap model"), {
    target: { value: "installed-model" },
  })
  expect(screen.queryByText(/^Replace local-model/)).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("Task preset"), { target: { value: "chat" } })
  expect(screen.getByLabelText("Enable shell tool")).toBeChecked()
  fireEvent.click(screen.getByRole("button", { name: "Apply task" }))
  expect(screen.getByLabelText("Enable shell tool")).not.toBeChecked()
  expect(screen.getByLabelText("Enable editor tool")).not.toBeChecked()
  expect(screen.getByLabelText("Maximum steps")).toHaveValue(8)
  expect(screen.getByLabelText("Maximum response tokens")).toHaveValue(4096)
  expect(screen.getByLabelText("Bootstrap model")).toHaveValue("installed-model")
})

it("hands the recipe setup script and Agent settings to the parent in one callback", () => {
  const apply = jest.fn()
  const change = jest.fn()
  render(
    <ProjectEnvironmentBootstrap
      value={{
        enabled: true,
        runtime: "powershell",
        task: "old",
        baseUrl: "",
        model: "",
        checks: [],
      }}
      onChange={change}
      onApplyRecipe={apply}
      ids="recipe"
    />
  )
  fireEvent.change(screen.getByLabelText("Initialization recipe"), {
    target: { value: "python-uv" },
  })
  expect(apply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Apply recipe" }))
  expect(apply).toHaveBeenCalledWith({
    setupScript: { default: "uv sync --frozen", byOs: {} },
    bootstrapAgent: expect.objectContaining({
      runtime: "powershell",
      checks: [{ name: "virtualenv", command: expect.stringContaining("$IsWindows") }],
      reuse: { inputs: ["pyproject.toml", "uv.lock"], outputs: [".venv"] },
      commandTimeoutSecs: 300,
      totalTimeoutSecs: 900,
    }),
  })
  expect(change).not.toHaveBeenCalled()
})

it("cannot apply a recipe without a parent setup-script handler", () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  expect(screen.getByRole("button", { name: "Apply recipe" })).toBeDisabled()
})

it("clears stale advanced editor content when applying a provider", () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  const editor = screen.getByLabelText("Advanced configuration JSON")
  fireEvent.change(editor, { target: { value: '{"modelOptions":{"headersEnv":' } })
  expect(editor).toHaveAttribute("aria-invalid", "true")
  fireEvent.click(screen.getByRole("button", { name: "Apply provider" }))
  expect(editor).toHaveAttribute("aria-invalid", "false")
  expect(JSON.parse((editor as HTMLTextAreaElement).value).modelOptions).toEqual({ auth: "bearer" })
})

it("edits configuration and readiness checks, retaining a draft while disabled", () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  fireEvent.change(screen.getByLabelText("Initialization task"), {
    target: { value: "Repair dependencies" },
  })
  fireEvent.change(screen.getByLabelText("Model API endpoint"), {
    target: { value: "https://api.example.com/v1" },
  })
  fireEvent.change(screen.getByLabelText("Bootstrap model"), { target: { value: "model" } })
  fireEvent.click(screen.getByRole("button", { name: "Add readiness check" }))
  fireEvent.change(screen.getByLabelText("Readiness check name"), { target: { value: "ready" } })
  fireEvent.change(screen.getByLabelText("Readiness check command"), {
    target: { value: "test -d node_modules" },
  })
  fireEvent.change(screen.getByLabelText("Maximum steps"), { target: { value: "8" } })
  expect(JSON.parse(screen.getByTestId("value").textContent!)).toMatchObject({
    enabled: true,
    task: "Repair dependencies",
    model: "model",
    maxSteps: 8,
    checks: [{ name: "ready", command: "test -d node_modules" }],
  })
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  expect(screen.queryByLabelText("Initialization task")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  expect(screen.getByLabelText("Initialization task")).toHaveValue("Repair dependencies")
  fireEvent.click(screen.getByRole("button", { name: "Remove readiness check" }))
  expect(screen.queryByLabelText("Readiness check name")).not.toBeInTheDocument()
})

it("selects independent runtimes and preserves explicitly customized script paths", () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  fireEvent.change(screen.getByLabelText("Agent runtime"), { target: { value: "powershell" } })
  expect(screen.getByLabelText("Bootstrap executable")).toHaveValue("cognia-bootstrap.ps1")
  expect(screen.getByLabelText("Shell executable")).toHaveValue("pwsh")
  expect(JSON.parse(screen.getByTestId("value").textContent!)).toMatchObject({
    runtime: "powershell",
  })
  fireEvent.change(screen.getByLabelText("Agent runtime"), { target: { value: "bash" } })
  expect(screen.getByLabelText("Bootstrap executable")).toHaveValue("cognia-bootstrap.sh")
  fireEvent.change(screen.getByLabelText("Bootstrap executable"), {
    target: { value: "/custom/agent" },
  })
  fireEvent.change(screen.getByLabelText("Agent runtime"), { target: { value: "native" } })
  expect(screen.getByLabelText("Bootstrap executable")).toHaveValue("/custom/agent")
})

it("customizes authentication, generation parameters and the system prompt", () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "header" } })
  fireEvent.change(screen.getByLabelText("API key header name"), { target: { value: "X-API-Key" } })
  fireEvent.change(screen.getByLabelText("Maximum response tokens"), { target: { value: "4096" } })
  fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "0.3" } })
  fireEvent.change(screen.getByLabelText("Custom system prompt (optional)"), {
    target: { value: "Repair this environment" },
  })
  fireEvent.click(screen.getByRole("switch", { name: "Stream model responses" }))
  expect(JSON.parse(screen.getByTestId("value").textContent!)).toMatchObject({
    systemPrompt: "Repair this environment",
    modelOptions: {
      auth: "header",
      apiKeyHeader: "X-API-Key",
      maxTokens: 4096,
      temperature: 0.3,
      stream: true,
    },
  })
})

it("round-trips advanced tools/context and retains invalid edits with a visible error", () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  const editor = screen.getByLabelText("Advanced configuration JSON")
  fireEvent.change(editor, {
    target: {
      value: JSON.stringify({
        tools: { profile: "dsh", shellExecutable: "/bin/bash", editor: false },
        context: { contextWindowTokens: 32000 },
        modelOptions: { auth: "none", headersEnv: { "X-Token": "MODEL_TOKEN" } },
        maxContextBytes: 1048576,
      }),
    },
  })
  expect(JSON.parse(screen.getByTestId("value").textContent!)).toMatchObject({
    tools: { profile: "dsh", editor: false },
    context: { contextWindowTokens: 32000 },
    modelOptions: { auth: "none", headersEnv: { "X-Token": "MODEL_TOKEN" } },
    maxContextBytes: 1048576,
  })
  fireEvent.change(editor, { target: { value: '{"tools":{' } })
  expect(editor).toHaveAttribute("aria-invalid", "true")
  expect(screen.getByRole("alert")).toBeInTheDocument()
  expect(JSON.parse(screen.getByTestId("value").textContent!)).toMatchObject({
    advancedOptionsDraft: '{"tools":{',
  })
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  expect(screen.getByLabelText("Advanced configuration JSON")).toHaveValue('{"tools":{')
  fireEvent.change(screen.getByLabelText("Advanced configuration JSON"), {
    target: { value: "{}" },
  })
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(JSON.parse(screen.getByTestId("value").textContent!)).not.toHaveProperty(
    "advancedOptionsDraft"
  )
  expect(JSON.parse(screen.getByTestId("value").textContent!)).not.toHaveProperty("tools")
})

it("edits tools, compaction, budgets and reuse through structured controls", () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  fireEvent.change(screen.getByLabelText("Tool schema profile"), { target: { value: "dsh" } })
  fireEvent.change(screen.getByLabelText("Shell executable"), {
    target: { value: "/usr/bin/bash" },
  })
  fireEvent.click(screen.getByLabelText("Enable editor tool"))
  fireEvent.change(screen.getByLabelText("Context window (tokens)"), { target: { value: "64000" } })
  fireEvent.click(screen.getByLabelText("Automatically compact context"))
  fireEvent.change(screen.getByLabelText("Context message limit (bytes)"), {
    target: { value: "1048576" },
  })
  fireEvent.change(screen.getByLabelText("Bootstrap reuse inputs (one per line)"), {
    target: { value: "pnpm-lock.yaml\npackage.json" },
  })
  fireEvent.change(screen.getByLabelText("Bootstrap required outputs (one per line)"), {
    target: { value: "node_modules" },
  })
  expect(JSON.parse(screen.getByTestId("value").textContent!)).toMatchObject({
    tools: { profile: "dsh", shellExecutable: "/usr/bin/bash", editor: false },
    context: { contextWindowTokens: 64000, autoCompact: false },
    maxContextBytes: 1048576,
    reuse: { inputs: ["pnpm-lock.yaml", "package.json"], outputs: ["node_modules"] },
  })
  expect(
    JSON.parse((screen.getByLabelText("Advanced configuration JSON") as HTMLTextAreaElement).value)
  ).toMatchObject({ tools: { editor: false }, reuse: { outputs: ["node_modules"] } })
})

it("preserves valid JSON text and the caret while editing, then reflects structured edits after blur", () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" }))
  const editor = screen.getByLabelText("Advanced configuration JSON") as HTMLTextAreaElement
  const text = '{ "tools": { "editor": false } }'
  fireEvent.focus(editor)
  fireEvent.change(editor, { target: { value: text, selectionStart: 14, selectionEnd: 14 } })
  expect(editor).toHaveValue(text)
  expect(editor.selectionStart).toBe(14)
  expect(editor).toHaveAttribute("aria-invalid", "false")
  expect(JSON.parse(screen.getByTestId("value").textContent!)).toMatchObject({
    tools: { editor: false },
  })
  fireEvent.blur(editor)
  fireEvent.change(screen.getByLabelText("Tool schema profile"), { target: { value: "dsh" } })
  expect(JSON.parse(editor.value)).toEqual({ tools: { editor: false, profile: "dsh" } })
})
