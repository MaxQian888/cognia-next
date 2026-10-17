import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { BestOfNStartDialog } from "./best-of-n-start-dialog"
import type { PreparedBestOfN } from "@/lib/best-of-n/entry"
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const prepared = {
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
  fireEvent.change(screen.getByRole("combobox", { name: "targetMode" }), {
    target: { value: "existing" },
  })
  expect(screen.getByRole("button", { name: "start" })).toBeDisabled()
  fireEvent.change(screen.getByRole("combobox", { name: "target" }), { target: { value: "main" } })
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
  expect(screen.getAllByRole("option", { name: "externalAgent" })).toHaveLength(3)
  fireEvent.change(pickers[1], { target: { value: "codex-1" } })
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
