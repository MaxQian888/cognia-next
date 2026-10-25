/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { repositoryTarget } from "@/lib/policy/action-review/outbound-targets"

import { IntegrationAccountOutboundRecipients } from "./account-outbound-recipients"

const mockSetRecipients = jest.fn()
const mockToastSuccess = jest.fn()
const mockToastError = jest.fn()
let mockApiBaseUrl: string | undefined
const mockIntegrationApiBaseUrl = jest.fn(async () => mockApiBaseUrl)

jest.mock("@/lib/db/integrations", () => ({
  setIntegrationAccountOutboundRecipients: (...args: unknown[]) => mockSetRecipients(...args),
}))
jest.mock("@/lib/integrations/action-runner", () => ({
  integrationApiBaseUrl: () => mockIntegrationApiBaseUrl(),
}))
jest.mock("@/hooks/outbound/use-known-repositories", () => ({
  useKnownRepositories: (accountId?: string) =>
    accountId === "acct_1"
      ? [
          {
            target: {
              kind: "repository",
              channel: "github",
              recipient: "github:github.com/acme/web",
            },
            name: "acme/web",
            lastSeenAt: 1,
          },
        ]
      : [],
}))
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}))

const account = {
  id: "acct_1",
  pluginId: "github-delivery",
  providerId: "github-pat",
  authSessionId: "s",
}

beforeEach(() => {
  mockApiBaseUrl = undefined
  mockSetRecipients.mockReset()
  mockSetRecipients.mockResolvedValue(undefined)
  mockToastSuccess.mockClear()
  mockToastError.mockClear()
})

describe("IntegrationAccountOutboundRecipients", () => {
  it("says what the list covers and offers the account's known repositories", async () => {
    render(<IntegrationAccountOutboundRecipients account={account} />)
    expect(screen.getByText("Repositories writable unattended")).toBeInTheDocument()
    expect(screen.getByText(/Any GitHub write through this account/)).toBeInTheDocument()
    // The list holds repositories only, so no kind picker is shown.
    expect(screen.queryByRole("group", { name: "Recipient kind" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Add acme/web" }))
    await waitFor(() => expect(mockSetRecipients).toHaveBeenCalledTimes(1))
    expect(mockSetRecipients).toHaveBeenCalledWith("github-delivery", "acct_1", [
      expect.objectContaining({ recipient: repositoryTarget("acme/web"), addedBy: "local-user" }),
    ])
    expect(mockToastSuccess).toHaveBeenCalledWith("Recipient list saved")
  })

  it("puts a typed owner/repo on the account's GitHub Enterprise host", async () => {
    mockApiBaseUrl = "https://ghe.corp.io/api/v3"
    render(<IntegrationAccountOutboundRecipients account={account} />)
    // The host resolves once the account's API root is read.
    await waitFor(() => expect(mockIntegrationApiBaseUrl).toHaveBeenCalled())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    fireEvent.change(screen.getByLabelText("owner/repo or a repository URL"), {
      target: { value: "acme/tools" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(mockSetRecipients).toHaveBeenCalledTimes(1))
    expect(mockSetRecipients.mock.lastCall?.[2]?.[0]?.recipient).toEqual(
      repositoryTarget("ghe.corp.io/acme/tools")
    )
  })

  it("shows the stored list, and says when a save is refused", async () => {
    mockSetRecipients.mockRejectedValue(new Error("not a GitHub repository"))
    render(
      <IntegrationAccountOutboundRecipients
        account={{
          ...account,
          outboundRecipients: [
            {
              recipient: repositoryTarget("acme/api")! as never,
              addedAt: 1,
              addedBy: "local-user",
            },
          ],
        }}
      />
    )
    expect(screen.getByText("acme/api")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Remove acme/api" }))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Could not save the recipient list: not a GitHub repository"
      )
    )
  })
})
