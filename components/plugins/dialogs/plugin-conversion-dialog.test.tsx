/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PluginConversionDialog } from "./plugin-conversion-dialog"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
const inspect = jest.fn()
const apply = jest.fn()
jest.mock("@/lib/plugin/convert/agent-service", () => ({
  getPluginConversionService: () => ({ inspect, apply }),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ activeProjectId: "p", projects: [{ id: "p", roots: [{ path: "/workspace" }] }] }),
}))
jest.mock("@/lib/workspace/roots", () => ({
  primaryRootOf: (project: { roots: unknown[] }) => project.roots[0],
}))
jest.mock("../_shared/plugin-conversion-report", () => ({
  PluginConversionReport: ({ report }: { report: { blocking: Array<{ message: string }> } }) => (
    <div aria-label="conversion-report">
      {report.blocking.map((issue) => (
        <p key={issue.message}>{issue.message}</p>
      ))}
    </div>
  ),
}))

const plan = (overrides = {}) => ({
  applicable: true,
  planId: "plan-1",
  sourceFormat: "cognia",
  target: "claude-code",
  proposedOutputDir: "converted",
  files: ["plugin.json", "skills/review/SKILL.md"],
  report: { fidelity: "structured", converted: [], blocking: [], warnings: [] },
  ...overrides,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function review() {
  fireEvent.change(screen.getByLabelText("sourceDir"), { target: { value: "source" } })
  fireEvent.click(screen.getByRole("button", { name: "inspect" }))
  await screen.findByLabelText("conversion-report")
}

beforeEach(() => {
  jest.clearAllMocks()
  inspect.mockResolvedValue(plan())
  apply.mockResolvedValue({ outputDir: "converted" })
})

it("inspects, reviews files and writes a copy without installing", async () => {
  render(<PluginConversionDialog open onOpenChange={jest.fn()} />)
  expect(screen.getByLabelText("workspaceRoot")).toHaveValue("/workspace")
  fireEvent.change(screen.getByLabelText("target"), { target: { value: "claude-code" } })
  await review()
  expect(inspect).toHaveBeenCalledWith({
    workspaceRoot: "/workspace",
    sourceDir: "source",
    target: "claude-code",
    surface: "cli",
  })
  expect(screen.getByText("skills/review/SKILL.md")).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("outputDir"), { target: { value: "output/review" } })
  fireEvent.click(screen.getByRole("button", { name: "write" }))
  await waitFor(() =>
    expect(apply).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      planId: "plan-1",
      outputDir: "output/review",
      acknowledgeWarnings: false,
    })
  )
  expect(await screen.findByRole("status")).toHaveTextContent("converted")
  expect(screen.getByRole("button", { name: "write" })).toBeDisabled()
})

it("shows blockers and never enables writing", async () => {
  inspect.mockResolvedValue(
    plan({
      applicable: false,
      planId: undefined,
      report: {
        fidelity: "unsupported",
        converted: [],
        blocking: [{ message: "Cloud is unavailable" }],
        warnings: [],
      },
    })
  )
  render(<PluginConversionDialog open onOpenChange={jest.fn()} />)
  fireEvent.change(screen.getByLabelText("surface"), { target: { value: "cloud" } })
  expect(screen.getByText("cloudHint")).toBeInTheDocument()
  await review()
  expect(screen.getByText("Cloud is unavailable")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "write" })).toBeDisabled()
})

it.each(["warnings", "contextual"])("requires acknowledgement for %s", async (kind) => {
  inspect.mockResolvedValue(
    plan({
      report: {
        fidelity: kind === "contextual" ? "contextual" : "structured",
        converted: [],
        blocking: [],
        warnings: kind === "warnings" ? [{ message: "Review" }] : [],
      },
    })
  )
  render(<PluginConversionDialog open onOpenChange={jest.fn()} />)
  await review()
  expect(screen.getByRole("button", { name: "write" })).toBeDisabled()
  fireEvent.click(screen.getByRole("checkbox", { name: "acknowledge" }))
  fireEvent.click(screen.getByRole("button", { name: "write" }))
  await waitFor(() =>
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ acknowledgeWarnings: true }))
  )
})

it.each([
  ["sourceDir", "other"],
  ["target", "codex"],
  ["surface", "desktop"],
  ["workspaceRoot", "/other"],
])("invalidates a reviewed plan when %s changes", async (label, value) => {
  render(<PluginConversionDialog open onOpenChange={jest.fn()} />)
  await review()
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
  expect(screen.queryByLabelText("conversion-report")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "write" })).toBeDisabled()
})

it("ignores stale inspections after the target changes", async () => {
  const pending = deferred<ReturnType<typeof plan>>()
  inspect.mockReturnValueOnce(pending.promise)
  render(<PluginConversionDialog open onOpenChange={jest.fn()} />)
  fireEvent.change(screen.getByLabelText("sourceDir"), { target: { value: "source" } })
  fireEvent.click(screen.getByRole("button", { name: "inspect" }))
  fireEvent.change(screen.getByLabelText("target"), { target: { value: "codex" } })
  await act(async () => {
    pending.resolve(plan())
  })
  expect(screen.queryByLabelText("conversion-report")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "write" })).toBeDisabled()
})

it("does not restore a pending plan after close and reopen", async () => {
  const pending = deferred<ReturnType<typeof plan>>()
  inspect.mockReturnValueOnce(pending.promise)
  const { rerender } = render(<PluginConversionDialog open onOpenChange={jest.fn()} />)
  fireEvent.change(screen.getByLabelText("sourceDir"), { target: { value: "source" } })
  fireEvent.click(screen.getByRole("button", { name: "inspect" }))
  rerender(<PluginConversionDialog open={false} onOpenChange={jest.fn()} />)
  await act(async () => {
    pending.resolve(plan())
  })
  rerender(<PluginConversionDialog open onOpenChange={jest.fn()} />)
  expect(screen.getByLabelText("sourceDir")).toHaveValue("")
  expect(screen.queryByLabelText("conversion-report")).not.toBeInTheDocument()
})

it("prevents duplicate writes, input changes and closing while applying", async () => {
  const pending = deferred<{ outputDir: string }>()
  apply.mockReturnValue(pending.promise)
  const onOpenChange = jest.fn()
  render(<PluginConversionDialog open onOpenChange={onOpenChange} />)
  await review()
  fireEvent.click(screen.getByRole("button", { name: "write" }))
  fireEvent.click(screen.getByRole("button", { name: "writing" }))
  fireEvent.click(screen.getByRole("button", { name: "close" }))
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
  expect(apply).toHaveBeenCalledTimes(1)
  expect(onOpenChange).not.toHaveBeenCalled()
  expect(screen.getByLabelText("sourceDir")).toBeDisabled()
  await act(async () => {
    pending.resolve({ outputDir: "converted" })
  })
  fireEvent.click(screen.getByRole("button", { name: "close" }))
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

it("renders inspect and write failures and allows retry", async () => {
  inspect.mockRejectedValueOnce(new Error("read failed"))
  apply.mockRejectedValueOnce(new Error("output exists"))
  render(<PluginConversionDialog open onOpenChange={jest.fn()} />)
  fireEvent.change(screen.getByLabelText("sourceDir"), { target: { value: "source" } })
  fireEvent.click(screen.getByRole("button", { name: "inspect" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("read failed")
  await review()
  fireEvent.click(screen.getByRole("button", { name: "write" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("output exists")
  fireEvent.change(screen.getByLabelText("outputDir"), { target: { value: "retry" } })
  fireEvent.click(screen.getByRole("button", { name: "write" }))
  expect(await screen.findByRole("status")).toHaveTextContent("converted")
})
