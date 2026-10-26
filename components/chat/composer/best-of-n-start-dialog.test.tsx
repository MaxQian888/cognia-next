import userEvent from "@testing-library/user-event"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { BestOfNStartDialog } from "./best-of-n-start-dialog"
import type { PreparedBestOfN } from "@/lib/best-of-n/entry"
import { RunEstimateHint } from "@/components/usage/run-estimate-hint"
import { externalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/usage/run-estimate-hint", () => ({ RunEstimateHint: jest.fn(() => null) }))
const hintMock = RunEstimateHint as unknown as jest.Mock
const prepared = {
  session: { model: "claude-sonnet-4-5", providerOverride: "anthropic" },
  n: 3,
  dirty: true,
  baseSha: "abc",
  targetRef: "best-of-n/run",
  branches: ["main"],
  agents: ["session", "session", "session"],
  agentOptions: [
    { value: "session", kind: "session", label: "session" },
    { value: "codex-1", kind: "external", label: "Codex" },
  ],
} as PreparedBestOfN
it("shows dirty exclusion and a new branch by default; existing requires explicit selection", async () => {
  const onConfirm = jest.fn(async () => undefined)
  render(<BestOfNStartDialog prepared={prepared} onConfirm={onConfirm} onCancel={jest.fn()} />)
  expect(screen.getByText("dirty")).toBeInTheDocument()
  expect(screen.getByRole("textbox", { name: "target" })).toHaveValue("best-of-n/run")
  await userEvent.click(screen.getByRole("combobox", { name: "targetMode" }))
  await userEvent.click(screen.getByRole("option", { name: "existingBranch" }))
  expect(screen.getByRole("button", { name: "start" })).toBeDisabled()
  await userEvent.click(screen.getByRole("combobox", { name: "target" }))
  await userEvent.click(screen.getByRole("option", { name: "main" }))
  fireEvent.click(screen.getByRole("button", { name: "start" }))
  await waitFor(() =>
    expect(onConfirm).toHaveBeenCalledWith({ targetRef: "main", targetIsNew: false }, [
      "session",
      "session",
      "session",
    ])
  )
})
it("assigns an agent to each attempt and says external cost is unknown", async () => {
  const onConfirm = jest.fn(async () => undefined)
  render(<BestOfNStartDialog prepared={prepared} onConfirm={onConfirm} onCancel={jest.fn()} />)
  expect(screen.queryByText("externalCost")).not.toBeInTheDocument()
  const pickers = screen.getAllByRole("combobox", { name: "candidateAgent" })
  expect(pickers).toHaveLength(3)
  await userEvent.click(pickers[1])
  expect(screen.getByRole("option", { name: "externalAgent" })).toBeInTheDocument()
  await userEvent.click(screen.getByRole("option", { name: "externalAgent" }))
  expect(screen.getByText("externalCost")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "start" }))
  await waitFor(() =>
    expect(onConfirm).toHaveBeenCalledWith({ targetRef: "best-of-n/run", targetIsNew: true }, [
      "session",
      "codex-1",
      "session",
    ])
  )
})
it("keeps a failed start reviewable and retryable", async () => {
  render(
    <BestOfNStartDialog
      prepared={prepared}
      onConfirm={jest.fn(async () => {
        throw new Error("failed")
      })}
      onCancel={jest.fn()}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "start" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("failed")
  expect(screen.getByRole("button", { name: "start" })).toBeEnabled()
})
it("estimates the whole group from the agents currently assigned (ADR-0232)", async () => {
  render(<BestOfNStartDialog prepared={prepared} onConfirm={jest.fn()} onCancel={jest.fn()} />)
  expect(hintMock.mock.lastCall?.[0].queries).toEqual([
    { surface: "best-of-n", model: "claude-sonnet-4-5", providerId: "anthropic", multiplier: 3 },
  ])
  await userEvent.click(screen.getAllByRole("combobox", { name: "candidateAgent" })[1])
  await userEvent.click(screen.getByRole("option", { name: "externalAgent" }))
  expect(hintMock.mock.lastCall?.[0].queries).toEqual([
    { surface: "best-of-n", model: "claude-sonnet-4-5", providerId: "anthropic", multiplier: 2 },
    { surface: "best-of-n", providerId: externalAgentProviderId("codex-1"), multiplier: 1 },
  ])
})

it("keeps native pickers on Capacitor, including a wide tablet", () => {
  Object.assign(window, { Capacitor: { isNativePlatform: () => true } })
  try {
    render(<BestOfNStartDialog prepared={prepared} onConfirm={jest.fn()} onCancel={jest.fn()} />)
    const picker = screen.getByRole("combobox", { name: "targetMode" })
    expect(picker.tagName).toBe("SELECT")
    fireEvent.change(picker, { target: { value: "existing" } })
    expect(screen.getByRole("button", { name: "start" })).toBeDisabled()
  } finally {
    delete (window as { Capacitor?: unknown }).Capacitor
  }
})

it("preserves empty, numeric and named form values with one real change event on desktop", async () => {
  const user = userEvent.setup()
  const onChange = jest.fn()
  const onFormChange = jest.fn()
  render(
    <form aria-label="Candidate settings" onChange={onFormChange}>
      <label htmlFor="attempt-count">Attempts</label>
      <NativeSelect id="attempt-count" name="attempts" defaultValue="" onChange={onChange}>
        <NativeSelectOption value="">Off</NativeSelectOption>
        <NativeSelectOption value={3}>Best of 3</NativeSelectOption>
        <NativeSelectOption value="disabled" disabled>
          Unavailable
        </NativeSelectOption>
      </NativeSelect>
      <button type="reset">Reset</button>
    </form>
  )
  const form = screen.getByRole("form", { name: "Candidate settings" }) as HTMLFormElement
  expect(new FormData(form).get("attempts")).toBe("")
  await user.click(screen.getByText("Attempts"))
  expect(screen.getByRole("option", { name: "Unavailable" })).toHaveAttribute(
    "aria-disabled",
    "true"
  )
  await user.keyboard("{ArrowDown}{Enter}")
  expect(screen.getByRole("combobox", { name: "Attempts" })).toHaveTextContent("Best of 3")
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onFormChange).toHaveBeenCalledTimes(1)
  expect(new FormData(form).get("attempts")).toBe("3")
  expect(onChange.mock.calls[0][0].target).toBeInstanceOf(HTMLSelectElement)
  expect(onChange.mock.calls[0][0].target.name).toBe("attempts")
  await user.click(screen.getByRole("combobox", { name: "Attempts" }))
  await user.click(screen.getByRole("option", { name: "Off" }))
  expect(new FormData(form).get("attempts")).toBe("")
  await user.click(screen.getByRole("combobox", { name: "Attempts" }))
  await user.click(screen.getByRole("option", { name: "Best of 3" }))
  await user.click(screen.getByRole("button", { name: "Reset" }))
  expect(screen.getByRole("combobox", { name: "Attempts" })).toHaveTextContent("Off")
  expect(new FormData(form).get("attempts")).toBe("")
})
