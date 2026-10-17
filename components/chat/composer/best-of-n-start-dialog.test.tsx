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
    expect(onConfirm).toHaveBeenCalledWith({ targetRef: "main", targetIsNew: false })
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
