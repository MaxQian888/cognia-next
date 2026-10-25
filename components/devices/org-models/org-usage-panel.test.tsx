import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

import type { OrgUsageReport } from "@/lib/remote-host/org-models"

import { OrgUsagePanel, parseCapTokens, type OrgUsagePanelDeps } from "./org-usage-panel"

const report: OrgUsageReport = {
  month: "2026-10",
  defaultMonthlyTokens: 1000,
  members: [
    {
      userId: "usr_ada",
      spentTokens: 400,
      reservedTokens: 50,
      monthlyTokens: 1000,
      capSource: "default",
    },
    {
      userId: "usr_bob",
      spentTokens: 20,
      reservedTokens: 0,
      monthlyTokens: 20,
      capSource: "override",
    },
  ],
}

function deps(overrides: OrgUsagePanelDeps = {}): Required<OrgUsagePanelDeps> {
  return {
    getUsage: jest.fn(async () => report),
    setDefaultCap: jest.fn(async () => undefined),
    setMemberCap: jest.fn(async () => undefined),
    ...overrides,
  } as Required<OrgUsagePanelDeps>
}

beforeEach(() => jest.clearAllMocks())

describe("parseCapTokens", () => {
  it.each([
    ["1000", 1000],
    [" 1,000_000 ", 1_000_000],
    ["0", 0],
    ["", null],
    ["-5", null],
    ["1.5", null],
    ["10k", null],
    ["1000000000001", null],
  ])("reads %p as %p", (text, expected) => {
    expect(parseCapTokens(text)).toBe(expected)
  })
})

describe("OrgUsagePanel", () => {
  it("p6g lists each person's month against their cap and marks a reached one", async () => {
    render(<OrgUsagePanel hostRef="org" host="Org box" deps={deps()} />)
    const ada = await screen.findByTestId("org-usage-spent-usr_ada")
    expect(ada).toHaveTextContent(/400 used of 1(K|,?000) tokens/)
    expect(ada).toHaveTextContent("50 held by running turns")
    expect(screen.getByTestId("org-usage-member-usr_ada")).toHaveTextContent("Default cap")
    expect(screen.getByTestId("org-usage-member-usr_bob")).toHaveTextContent("Own cap")
    expect(screen.getByTestId("org-usage-capped-usr_bob")).toHaveTextContent("Cap reached")
    expect(screen.queryByTestId("org-usage-capped-usr_ada")).toBeNull()
    expect(screen.getByTestId("org-usage-default-cap-tokens")).toHaveValue("1000")
  })

  it("names each person as the org knows them, keeps the id beside it, and falls back to the id", async () => {
    const named: OrgUsageReport = {
      ...report,
      members: [report.members[0]!, { ...report.members[1]!, displayName: "Bob Builder" }],
    }
    const d = deps({ getUsage: jest.fn(async () => named) })
    render(<OrgUsagePanel hostRef="org" host="Org box" deps={d} />)
    expect(await screen.findByTestId("org-usage-name-usr_bob")).toHaveTextContent("Bob Builder")
    expect(screen.getByTestId("org-usage-member-usr_bob")).toHaveTextContent("usr_bob")
    // No name for Ada: the id is the label.
    expect(screen.queryByTestId("org-usage-name-usr_ada")).toBeNull()
    expect(screen.getByTestId("org-usage-member-usr_ada")).toHaveTextContent("usr_ada")

    const user = userEvent.setup()
    await user.click(screen.getByTestId("org-usage-edit-usr_bob"))
    fireEvent.change(screen.getByTestId("org-usage-member-cap-usr_bob-tokens"), {
      target: { value: "900" },
    })
    await user.click(screen.getByTestId("org-usage-member-save-usr_bob"))
    await waitFor(() => expect(d.setMemberCap).toHaveBeenCalledWith("org", "usr_bob", 900))
    expect(toastSuccess).toHaveBeenCalledWith("Saved the cap for Bob Builder")
  })

  it("p6g saves a new default cap and reads the month again", async () => {
    const d = deps()
    render(<OrgUsagePanel hostRef="org" host="Org box" deps={d} />)
    const input = await screen.findByTestId("org-usage-default-cap-tokens")
    expect(screen.getByTestId("org-usage-default-save")).toBeDisabled()
    fireEvent.change(input, { target: { value: "5,000" } })
    await userEvent.click(screen.getByTestId("org-usage-default-save"))
    await waitFor(() => expect(d.setDefaultCap).toHaveBeenCalledWith("org", 5000))
    expect(toastSuccess).toHaveBeenCalledWith("Saved the default cap on Org box")
    await waitFor(() => expect(d.getUsage).toHaveBeenCalledTimes(2))
  })

  it("p6g refuses to save a cap that is not a whole token count", async () => {
    const d = deps()
    render(<OrgUsagePanel hostRef="org" host="Org box" deps={d} />)
    const input = await screen.findByTestId("org-usage-default-cap-tokens")
    fireEvent.change(input, { target: { value: "lots" } })
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByTestId("org-usage-default-save")).toBeDisabled()
  })

  it("p6g gives one person their own cap, lifts it, or returns them to the default", async () => {
    const d = deps()
    render(<OrgUsagePanel hostRef="org" host="Org box" deps={d} />)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId("org-usage-edit-usr_bob"))
    const tokens = screen.getByTestId("org-usage-member-cap-usr_bob-tokens")
    expect(tokens).toHaveValue("20")
    fireEvent.change(tokens, { target: { value: "300" } })
    await user.click(screen.getByTestId("org-usage-member-save-usr_bob"))
    await waitFor(() => expect(d.setMemberCap).toHaveBeenCalledWith("org", "usr_bob", 300))
    expect(toastSuccess).toHaveBeenCalledWith("Saved the cap for usr_bob")

    await user.click(await screen.findByTestId("org-usage-edit-usr_bob"))
    await user.click(screen.getByTestId("org-usage-member-cap-usr_bob-mode"))
    await user.click(await screen.findByRole("option", { name: "Organization default" }))
    await user.click(screen.getByTestId("org-usage-member-save-usr_bob"))
    await waitFor(() =>
      expect(d.setMemberCap).toHaveBeenLastCalledWith("org", "usr_bob", "default")
    )

    await user.click(await screen.findByTestId("org-usage-edit-usr_ada"))
    await user.click(screen.getByTestId("org-usage-member-cap-usr_ada-mode"))
    await user.click(await screen.findByRole("option", { name: "No limit" }))
    await user.click(screen.getByTestId("org-usage-member-save-usr_ada"))
    await waitFor(() => expect(d.setMemberCap).toHaveBeenLastCalledWith("org", "usr_ada", null))
  })

  it("p6g shows a failed read or write as it came", async () => {
    const d = deps({
      setDefaultCap: jest.fn(async () => Promise.reject(new Error("store unavailable"))),
    })
    render(<OrgUsagePanel hostRef="org" host="Org box" deps={d} />)
    fireEvent.change(await screen.findByTestId("org-usage-default-cap-tokens"), {
      target: { value: "9" },
    })
    await userEvent.click(screen.getByTestId("org-usage-default-save"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("store unavailable"))

    render(
      <OrgUsagePanel
        hostRef="org"
        host="Org box"
        deps={deps({ getUsage: jest.fn(async () => Promise.reject(new Error("timeout"))) })}
      />
    )
    expect(await screen.findByText("timeout")).toBeInTheDocument()
  })

  it("p6g says when nobody has used the Host yet", async () => {
    render(
      <OrgUsagePanel
        hostRef="org"
        host="Org box"
        deps={deps({
          getUsage: jest.fn(async () => ({
            month: "2026-10",
            defaultMonthlyTokens: null,
            members: [],
          })),
        })}
      />
    )
    expect(await screen.findByTestId("org-usage-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("org-usage-incomplete")).not.toBeInTheDocument()
  })

  it("says when the Host could not list every member, and still shows who it knows", async () => {
    render(
      <OrgUsagePanel
        hostRef="org"
        host="Org box"
        deps={deps({ getUsage: jest.fn(async () => ({ ...report, membersIncomplete: true })) })}
      />
    )
    expect(await screen.findByTestId("org-usage-incomplete")).toHaveTextContent(
      "Some members may be missing: Org box could not get the organization's member list"
    )
    expect(screen.getByTestId("org-usage-member-usr_ada")).toBeInTheDocument()
  })
})
