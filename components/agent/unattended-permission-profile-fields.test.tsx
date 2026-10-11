/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  UnattendedPermissionProfileFields,
  samePermissionProfile,
  setPermissionClassLevel,
} from "./unattended-permission-profile-fields"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("setPermissionClassLevel", () => {
  it("writes a narrowed class and drops one set back to the ceiling", () => {
    expect(setPermissionClassLevel(undefined, "outbound", "deny")).toEqual({ outbound: "deny" })
    expect(setPermissionClassLevel({ outbound: "deny" }, "outbound", "ask")).toEqual({})
    expect(setPermissionClassLevel({ secrets: "deny" }, "workspace", "ask")).toEqual({
      secrets: "deny",
      workspace: "ask",
    })
    expect(setPermissionClassLevel({ workspace: "ask" }, "workspace", "sandbox")).toEqual({})
  })
})

describe("samePermissionProfile", () => {
  it("treats an absent class as the ceiling", () => {
    expect(samePermissionProfile(undefined, { outbound: "ask" })).toBe(true)
    expect(samePermissionProfile({}, { workspace: "ask" })).toBe(false)
    expect(samePermissionProfile({ hostConfig: "deny" }, { hostConfig: "deny" })).toBe(true)
  })
})

describe("<UnattendedPermissionProfileFields />", () => {
  it("shows the ceiling for every class the profile has no opinion on", () => {
    render(
      <UnattendedPermissionProfileFields
        value={{ secrets: "deny" }}
        onChange={jest.fn()}
        idPrefix="p"
      />
    )
    expect(screen.getByTestId("unattended-permission-profile-workspace")).toHaveTextContent(
      "level.sandbox"
    )
    expect(screen.getByTestId("unattended-permission-profile-outbound")).toHaveTextContent(
      "level.ask"
    )
    expect(screen.getByTestId("unattended-permission-profile-secrets")).toHaveTextContent(
      "level.deny"
    )
    expect(screen.getByText("class.hostConfig.label")).toBeInTheDocument()
  })

  it("offers a guarded class only ask and deny, never the sandbox level", async () => {
    const onChange = jest.fn()
    render(<UnattendedPermissionProfileFields value={{}} onChange={onChange} idPrefix="p" />)
    await userEvent.click(screen.getByTestId("unattended-permission-profile-outbound"))
    const options = screen.getAllByRole("option").map((o) => o.textContent)
    expect(options).toEqual(["level.ask", "level.deny"])
    await userEvent.click(screen.getByRole("option", { name: "level.deny" }))
    expect(onChange).toHaveBeenCalledWith({ outbound: "deny" })
  })

  it("lets the workspace class be lowered from the sandbox level", async () => {
    const onChange = jest.fn()
    render(
      <UnattendedPermissionProfileFields
        value={{ secrets: "deny" }}
        onChange={onChange}
        idPrefix="p"
      />
    )
    await userEvent.click(screen.getByTestId("unattended-permission-profile-workspace"))
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "level.sandbox",
      "level.ask",
      "level.deny",
    ])
    await userEvent.click(screen.getByRole("option", { name: "level.ask" }))
    expect(onChange).toHaveBeenCalledWith({ secrets: "deny", workspace: "ask" })
  })

  it("disables every row together", () => {
    render(
      <UnattendedPermissionProfileFields value={{}} onChange={jest.fn()} idPrefix="p" disabled />
    )
    for (const cls of ["workspace", "outbound", "secrets", "hostConfig"]) {
      expect(screen.getByTestId(`unattended-permission-profile-${cls}`)).toBeDisabled()
    }
  })
})
