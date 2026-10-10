import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_FILE_SHARING_POLICY, type FileSharingPolicy } from "@/lib/filespace/policy"

import { FileSharingPolicyFields } from "./file-sharing-policy-fields"

function renderFields(value: FileSharingPolicy = DEFAULT_FILE_SHARING_POLICY, disabled = false) {
  const onChange = jest.fn()
  render(
    <FileSharingPolicyFields idPrefix="t" value={value} onChange={onChange} disabled={disabled} />
  )
  return onChange
}

const row = (label: string) => screen.getByText(label).closest("div.flex")!.parentElement!

describe("FileSharingPolicyFields", () => {
  it("shows each switch as the policy has it", () => {
    renderFields()
    expect(screen.getByRole("switch", { name: "Share files as links" })).toBeChecked()
    expect(screen.getByRole("switch", { name: "Live access" })).toBeChecked()
    expect(screen.getByRole("switch", { name: "Network drive access" })).not.toBeChecked()
    expect(screen.getByRole("switch", { name: "Allow changes" })).not.toBeChecked()
    expect(screen.getByRole("switch", { name: "Agents may share" })).not.toBeChecked()
  })

  it("labels every control whose feature has not shipped, and only those", () => {
    renderFields()
    expect(screen.getAllByText("Not available yet")).toHaveLength(5)
    for (const label of [
      "Live access",
      "Network drive access",
      "Allow changes",
      "Agents may share",
      "Longest live access may last",
    ]) {
      expect(within(row(label)).getByText("Not available yet")).toBeInTheDocument()
    }
    expect(within(row("Share files as links")).queryByText("Not available yet")).toBeNull()
    expect(within(row("Longest a file link may last")).queryByText("Not available yet")).toBeNull()
  })

  it("keeps an edit one the plane accepts", async () => {
    const user = userEvent.setup()
    const onChange = renderFields({ ...DEFAULT_FILE_SHARING_POLICY, allowLiveWrite: true })
    await user.click(screen.getByRole("switch", { name: "Live access" }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ allowLiveGrants: false, allowLiveWrite: false })
    )
  })

  it("picks a ceiling from the presets", async () => {
    const user = userEvent.setup()
    const onChange = renderFields()
    expect(
      screen.getByRole("combobox", { name: "Longest a file link may last" })
    ).toHaveTextContent("30 days")
    await user.click(screen.getByRole("combobox", { name: "Longest a file link may last" }))
    await user.click(screen.getByRole("option", { name: "1 hour" }))
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_FILE_SHARING_POLICY,
      maxSnapshotTtlSeconds: 3600,
    })
  })

  it("still shows a ceiling that is not one of the presets", () => {
    renderFields({ ...DEFAULT_FILE_SHARING_POLICY, maxLiveTtlSeconds: 14 * 86_400 })
    expect(
      screen.getByRole("combobox", { name: "Longest live access may last" })
    ).toHaveTextContent("14 days")
  })

  it("disables every control when read-only", () => {
    renderFields(DEFAULT_FILE_SHARING_POLICY, true)
    for (const control of [...screen.getAllByRole("switch"), ...screen.getAllByRole("combobox")]) {
      expect(control).toBeDisabled()
    }
  })
})
