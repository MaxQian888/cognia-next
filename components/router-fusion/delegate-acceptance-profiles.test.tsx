/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mockToast = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
  },
}))

type ProjectState = {
  projects: { id: string; name: string }[]
  activeProjectId: string | null
}
const projectState: { current: ProjectState } = {
  current: { projects: [{ id: "project-1", name: "Cognia" }], activeProjectId: "project-1" },
}
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: ProjectState) => unknown) => selector(projectState.current),
}))

import {
  DelegateAcceptanceProfiles,
  type AcceptanceProfileListingView,
} from "./delegate-acceptance-profiles"

function listing(over: Partial<AcceptanceProfileListingView> = {}): AcceptanceProfileListingView {
  return {
    available: true,
    profiles: [
      {
        profileId: "unit",
        commandHash: "abcdef0123456789".repeat(4),
        source: "repository",
        status: "approved",
      },
    ],
    reason: null,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  projectState.current = {
    projects: [{ id: "project-1", name: "Cognia" }],
    activeProjectId: "project-1",
  }
})

describe("DelegateAcceptanceProfiles", () => {
  it("[ACC:OFF-01] reads nothing while the master switch is off", () => {
    const listProfiles = jest.fn()
    render(<DelegateAcceptanceProfiles enabled={false} listProfiles={listProfiles} />)
    expect(screen.getByTestId("router-fusion-acceptance-profiles")).toHaveTextContent(
      "Turn on the master switch"
    )
    expect(listProfiles).not.toHaveBeenCalled()
  })

  it("shows each profile with its source, status and command hash", async () => {
    render(<DelegateAcceptanceProfiles enabled listProfiles={async () => listing()} />)
    const row = await screen.findByTestId("router-fusion-acceptance-profile-unit")
    expect(row).toHaveTextContent("unit")
    expect(row).toHaveTextContent("Repository")
    expect(row).toHaveTextContent("Approved")
    expect(row).toHaveTextContent("Command abcdef012345")
    // An approved profile offers only the withdrawal.
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument()
  })

  it("approves a profile at the hash that was on screen", async () => {
    const user = userEvent.setup()
    const approveProfile = jest.fn().mockResolvedValue({ ok: true })
    render(
      <DelegateAcceptanceProfiles
        enabled
        listProfiles={async () =>
          listing({
            available: false,
            reason: "approval_pending",
            profiles: [
              {
                profileId: "unit",
                commandHash: "f".repeat(64),
                source: "project",
                status: "unapproved",
              },
            ],
          })
        }
        approveProfile={approveProfile}
      />
    )
    await user.click(await screen.findByRole("button", { name: "Approve" }))
    expect(approveProfile).toHaveBeenCalledWith("project-1", "unit", "f".repeat(64))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Approved "unit".'))
  })

  it("explains a refused approval instead of showing it as approved", async () => {
    const user = userEvent.setup()
    render(
      <DelegateAcceptanceProfiles
        enabled
        listProfiles={async () =>
          listing({
            profiles: [
              {
                profileId: "unit",
                commandHash: "f".repeat(64),
                source: "repository",
                status: "changed",
                approvedCommandHash: "0".repeat(64),
              },
            ],
          })
        }
        approveProfile={async () => ({ ok: false, code: "ACCEPTANCE_PROFILE_CHANGED" })}
      />
    )
    const row = await screen.findByTestId("router-fusion-acceptance-profile-unit")
    expect(row).toHaveTextContent("Command changed")
    expect(row).toHaveTextContent("Approved at 000000000000")
    await user.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        '"unit" was not approved: the command changed after it was shown; review it again'
      )
    )
    expect(mockToast.success).not.toHaveBeenCalled()
  })

  it("withdraws an approval", async () => {
    const user = userEvent.setup()
    const revokeProfile = jest.fn().mockResolvedValue({ ok: true, removed: true })
    render(
      <DelegateAcceptanceProfiles
        enabled
        listProfiles={async () => listing()}
        revokeProfile={revokeProfile}
      />
    )
    await user.click(await screen.findByRole("button", { name: "Revoke" }))
    expect(revokeProfile).toHaveBeenCalledWith("project-1", "unit")
    await waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith('Withdrew the approval of "unit".')
    )
  })

  it("says why a project has nothing to approve", async () => {
    render(
      <DelegateAcceptanceProfiles
        enabled
        listProfiles={async () => listing({ available: false, profiles: [], reason: "absent" })}
      />
    )
    expect(await screen.findByTestId("router-fusion-acceptance-unavailable")).toHaveTextContent(
      "This project declares no acceptance profile"
    )
  })

  it("reports a read that failed as a fault, not as an empty project", async () => {
    render(
      <DelegateAcceptanceProfiles
        enabled
        listProfiles={async () => {
          throw new Error("workspace.json is unreadable")
        }}
      />
    )
    expect(await screen.findByTestId("router-fusion-acceptance-unavailable")).toHaveTextContent(
      "workspace.json is unreadable"
    )
  })

  it("says where acceptance profiles live when there is no project", () => {
    projectState.current = { projects: [], activeProjectId: null }
    render(<DelegateAcceptanceProfiles enabled listProfiles={jest.fn()} />)
    expect(screen.getByTestId("router-fusion-acceptance-profiles")).toHaveTextContent(
      "No project yet."
    )
  })
})
