/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { PolicyForm } from "./policy-form"
import { DEFAULT_GH_POLICY, type GhPolicy } from "@/lib/github/types"

describe("PolicyForm", () => {
  it("renders the default policy when value is null", () => {
    render(<PolicyForm value={null} onSave={jest.fn()} />)
    const max = screen.getByLabelText(/Max daily merges/i) as HTMLInputElement
    expect(max.value).toBe(String(DEFAULT_GH_POLICY.maxDailyMerges))
  })

  it("disables save until the user changes something", () => {
    render(<PolicyForm value={DEFAULT_GH_POLICY} onSave={jest.fn()} />)
    const save = screen.getByTestId("policy-save") as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it("captures edits and calls onSave with the modified policy", async () => {
    const onSave = jest.fn((_p: GhPolicy) => Promise.resolve())
    render(<PolicyForm value={DEFAULT_GH_POLICY} onSave={onSave} />)
    const max = screen.getByLabelText(/Max daily merges/i) as HTMLInputElement
    fireEvent.change(max, { target: { value: "12" } })
    const save = screen.getByTestId("policy-save")
    fireEvent.click(save)
    await new Promise((r) => setTimeout(r, 0))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0].maxDailyMerges).toBe(12)
  })

  it("renders explicit-logins textarea when authors.kind === explicit", () => {
    const policy: GhPolicy = {
      ...DEFAULT_GH_POLICY,
      allowedAuthors: { kind: "explicit", logins: ["octocat"] },
    }
    render(<PolicyForm value={policy} onSave={jest.fn()} />)
    expect(screen.getByLabelText(/explicit-logins/i)).toBeInTheDocument()
  })

  it("toggles the quiet-hours sub-form", async () => {
    render(<PolicyForm value={DEFAULT_GH_POLICY} onSave={jest.fn()} />)
    expect(screen.queryByLabelText(/From \(HH:MM\)/i)).not.toBeInTheDocument()
    const sw = screen.getByLabelText(/quiet-hours-enabled/i)
    fireEvent.click(sw)
    expect(await screen.findByLabelText(/From \(HH:MM\)/i)).toBeInTheDocument()
  })

  it("shows the reset button only when showResetToGlobal is true", () => {
    const { rerender } = render(<PolicyForm value={DEFAULT_GH_POLICY} onSave={jest.fn()} />)
    expect(screen.queryByTestId("policy-reset")).not.toBeInTheDocument()
    rerender(
      <PolicyForm
        value={DEFAULT_GH_POLICY}
        onSave={jest.fn()}
        onReset={jest.fn()}
        showResetToGlobal
      />
    )
    expect(screen.getByTestId("policy-reset")).toBeInTheDocument()
  })
})
