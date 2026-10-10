import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(), saveSettings: jest.fn() }))
jest.mock("@/hooks/workspace/use-membership-admin", () => ({ useMembershipAdmin: jest.fn() }))
jest.mock("@/lib/collab/file-sharing-policy", () => ({
  getOrgFileSharingPolicy: jest.fn(),
  saveOrgFileSharingPolicy: jest.fn(),
}))

import { toast } from "sonner"
import { useMembershipAdmin } from "@/hooks/workspace/use-membership-admin"
import { CollabConflictError, CollabError, type CollabFileSharingPolicy } from "@/lib/collab/client"
import { getOrgFileSharingPolicy, saveOrgFileSharingPolicy } from "@/lib/collab/file-sharing-policy"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { DEFAULT_FILE_SHARING_POLICY } from "@/lib/filespace/policy"

import { FileSharingPolicyCard } from "./file-sharing-policy-card"

const useAdmin = useMembershipAdmin as jest.Mock
const getOrg = getOrgFileSharingPolicy as jest.Mock
const saveOrg = saveOrgFileSharingPolicy as jest.Mock

const CONTEXT = { orgId: "org_1", localAccountId: "acct", userId: "usr_1", client: {} }
const ORG_POLICY: CollabFileSharingPolicy = { ...DEFAULT_FILE_SHARING_POLICY, revision: 3 }

function noOrg() {
  useAdmin.mockReturnValue({ context: null, canManageOrg: false })
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(getSettings as jest.Mock).mockResolvedValue({ fileSharing: { allowPublicSnapshots: true } })
  ;(saveSettings as jest.Mock).mockResolvedValue({})
  getOrg.mockResolvedValue(ORG_POLICY)
  noOrg()
})

describe("FileSharingPolicyCard: your policy", () => {
  it("loads the stored policy with defaults filled in, and saves an edit", async () => {
    const user = userEvent.setup()
    render(<FileSharingPolicyCard />)
    const links = await screen.findByRole("switch", { name: "Share files as links" })
    expect(links).toBeChecked()
    const save = screen.getByRole("button", { name: "Save" })
    expect(save).toBeDisabled()

    await user.click(links)
    expect(save).toBeEnabled()
    await user.click(save)
    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({
        fileSharing: { ...DEFAULT_FILE_SHARING_POLICY, allowPublicSnapshots: false },
      })
    )
    expect(toast.success).toHaveBeenCalledWith("File sharing policy saved")
    expect(save).toBeDisabled()
  })

  it("says when the save failed and keeps the edit", async () => {
    const user = userEvent.setup()
    ;(saveSettings as jest.Mock).mockRejectedValueOnce(new Error("quota"))
    render(<FileSharingPolicyCard />)
    await user.click(await screen.findByRole("switch", { name: "Share files as links" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not save the file sharing policy.")
    )
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })

  it("shows no organization section outside an organization", async () => {
    render(<FileSharingPolicyCard />)
    await screen.findByRole("switch", { name: "Share files as links" })
    expect(screen.queryByText("Organization policy")).toBeNull()
    expect(getOrg).not.toHaveBeenCalled()
  })
})

describe("FileSharingPolicyCard: organization policy", () => {
  const orgSwitch = () => screen.getAllByRole("switch", { name: "Share files as links" })[1]!

  it("shows it read-only to members", async () => {
    useAdmin.mockReturnValue({ context: CONTEXT, canManageOrg: false })
    render(<FileSharingPolicyCard />)
    expect(await screen.findByText("Only owners and admins can change this.")).toBeInTheDocument()
    expect(getOrg).toHaveBeenCalledWith(CONTEXT, { refresh: true })
    expect(orgSwitch()).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Save for organization" })).toBeNull()
    expect(screen.getByText("The organization uses the default policy.")).toBeInTheDocument()
  })

  it("lets an owner save over the revision they read", async () => {
    const user = userEvent.setup()
    useAdmin.mockReturnValue({ context: CONTEXT, canManageOrg: true })
    saveOrg.mockResolvedValue({
      ...ORG_POLICY,
      allowPublicSnapshots: false,
      revision: 4,
      updatedAt: Date.UTC(2026, 9, 10),
    })
    render(<FileSharingPolicyCard />)
    await screen.findByText("Organization policy")
    await waitFor(() => expect(orgSwitch()).toBeEnabled())
    await user.click(orgSwitch())
    await user.click(screen.getByRole("button", { name: "Save for organization" }))
    await waitFor(() =>
      expect(saveOrg).toHaveBeenCalledWith(
        CONTEXT,
        { ...DEFAULT_FILE_SHARING_POLICY, allowPublicSnapshots: false },
        3
      )
    )
    expect(toast.success).toHaveBeenCalledWith("Organization policy saved")
    expect(await screen.findByText(/^Last changed /)).toBeInTheDocument()
    expect(orgSwitch()).not.toBeChecked()
  })

  it("replaces the edit with the winner of a conflicting save", async () => {
    const user = userEvent.setup()
    useAdmin.mockReturnValue({ context: CONTEXT, canManageOrg: true })
    saveOrg.mockRejectedValue(
      new CollabConflictError("conflict", {
        ...ORG_POLICY,
        allowAgentSharing: true,
        revision: 5,
        updatedAt: 1,
      })
    )
    render(<FileSharingPolicyCard />)
    await screen.findByText("Organization policy")
    await waitFor(() => expect(orgSwitch()).toBeEnabled())
    await user.click(orgSwitch())
    await user.click(screen.getByRole("button", { name: "Save for organization" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Someone else changed the organization's policy. Their version is shown; review it and save again."
      )
    )
    expect(orgSwitch()).toBeChecked()
    expect(screen.getAllByRole("switch", { name: "Agents may share" })[1]).toBeChecked()
  })

  it("explains a refused save", async () => {
    const user = userEvent.setup()
    useAdmin.mockReturnValue({ context: CONTEXT, canManageOrg: true })
    saveOrg.mockRejectedValue(new CollabError(403, "forbidden"))
    render(<FileSharingPolicyCard />)
    await screen.findByText("Organization policy")
    await waitFor(() => expect(orgSwitch()).toBeEnabled())
    await user.click(orgSwitch())
    await user.click(screen.getByRole("button", { name: "Save for organization" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Only owners and admins can change the organization's policy."
      )
    )
  })

  it("says when the organization's policy cannot be read, and retries", async () => {
    const user = userEvent.setup()
    useAdmin.mockReturnValue({ context: CONTEXT, canManageOrg: true })
    getOrg.mockRejectedValueOnce(new Error("offline"))
    render(<FileSharingPolicyCard />)
    expect(
      await screen.findByText(
        "The organization's policy could not be read, so files can't be shared until it can."
      )
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(orgSwitch()).toBeEnabled())
    expect(getOrg).toHaveBeenCalledTimes(2)
  })
})
