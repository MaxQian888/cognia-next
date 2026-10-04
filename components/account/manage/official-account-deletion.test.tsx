/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join(",")})` : key
    t.has = () => true
    return t
  },
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"

import { AccountDeletionError } from "@/lib/identity/official-account-deletion"
import { officialDeployment } from "@/lib/identity/official-deployment"
import type { LogtoSession } from "@/lib/logto/client"

import {
  OfficialAccountDeletion,
  type OfficialAccountDeletionDeps,
} from "./official-account-deletion"

const deployment = officialDeployment({})!
const session: LogtoSession = {
  issuer: deployment.issuer,
  clientId: "cognia-app",
  resource: deployment.audience,
  accessToken: "at",
  scopes: [],
  issuerKind: "oidc",
}
const drivers = jest.fn(() => ({
  drivers: { openUrl: jest.fn(), waitForCode: jest.fn() },
  redirectUri: "cn.cognia.app:/auth/callback",
  clientKind: "native" as const,
}))

function renderWith(deps: OfficialAccountDeletionDeps) {
  return render(
    <OfficialAccountDeletion
      deployment={deployment}
      session={session}
      deps={{ drivers, ...deps }}
    />
  )
}

beforeEach(() => jest.clearAllMocks())

describe("OfficialAccountDeletion", () => {
  it("confirms, offers a backup first, signs in again, then shows the purge date", async () => {
    const confirm = jest.fn(async () => ({
      status: "pending" as const,
      purgeAfter: "2026-10-12T00:00:00.000Z",
    }))
    renderWith({ read: jest.fn(async () => ({ status: "none" as const })), confirm })

    fireEvent.click(await screen.findByTestId("official-account-deletion-start"))
    expect(screen.getByTestId("official-account-deletion-backup")).toHaveAttribute(
      "href",
      "/me/backup"
    )
    fireEvent.click(screen.getByTestId("official-account-deletion-confirm-button"))

    expect(await screen.findByTestId("official-account-deletion-pending")).toBeInTheDocument()
    expect(drivers).toHaveBeenCalledWith(expect.objectContaining({ issuerKind: "oidc" }))
    expect(confirm).toHaveBeenCalledWith(
      deployment,
      expect.anything(),
      { redirectUri: "cn.cognia.app:/auth/callback", clientKind: "native" },
      session
    )
    expect(toast.success).toHaveBeenCalledWith("requested")
  })

  it("goes back without asking anything", async () => {
    const confirm = jest.fn()
    renderWith({ read: jest.fn(async () => ({ status: "cancelled" as const })), confirm })
    fireEvent.click(await screen.findByTestId("official-account-deletion-start"))
    fireEvent.click(screen.getByTestId("official-account-deletion-back"))
    expect(screen.getByTestId("official-account-deletion-start")).toBeInTheDocument()
    expect(confirm).not.toHaveBeenCalled()
  })

  it("explains a confirmation by somebody else and stays on the confirmation", async () => {
    renderWith({
      read: jest.fn(async () => ({ status: "none" as const })),
      confirm: jest.fn(async () => {
        throw new AccountDeletionError("different-person", "x")
      }),
    })
    fireEvent.click(await screen.findByTestId("official-account-deletion-start"))
    fireEvent.click(screen.getByTestId("official-account-deletion-confirm-button"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("error.differentPerson"))
    expect(screen.getByTestId("official-account-deletion-confirm")).toBeInTheDocument()
  })

  it("lets the person stop waiting for the browser, without an error", async () => {
    let signal: AbortSignal | undefined
    const waitingDrivers = jest.fn((options: { signal?: AbortSignal }) => {
      signal = options.signal
      return drivers()
    })
    const confirm = jest.fn(
      () =>
        new Promise<never>((_, reject) => {
          signal!.addEventListener("abort", () => {
            const error = new Error("aborted")
            error.name = "AbortError"
            reject(error)
          })
        })
    )
    renderWith({
      read: jest.fn(async () => ({ status: "none" as const })),
      confirm,
      drivers: waitingDrivers as never,
    })
    fireEvent.click(await screen.findByTestId("official-account-deletion-start"))
    fireEvent.click(screen.getByTestId("official-account-deletion-confirm-button"))
    fireEvent.click(await screen.findByTestId("official-account-deletion-stop"))
    expect(
      await screen.findByTestId("official-account-deletion-confirm-button")
    ).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("cancels a pending deletion", async () => {
    const cancel = jest.fn(async () => ({ status: "cancelled" as const }))
    renderWith({
      read: jest.fn(async () => ({ status: "pending" as const, purgeAfter: "2026-10-12" })),
      cancel,
    })
    fireEvent.click(await screen.findByTestId("official-account-deletion-cancel"))
    expect(await screen.findByTestId("official-account-deletion-start")).toBeInTheDocument()
    expect(cancel).toHaveBeenCalledWith(session)
    expect(toast.success).toHaveBeenCalledWith("cancelled")
  })

  it("names a failed read and retries it", async () => {
    const read = jest
      .fn()
      .mockRejectedValueOnce(new AccountDeletionError("unauthorized", "expired"))
      .mockResolvedValueOnce({ status: "none" })
    renderWith({ read })
    expect(await screen.findByRole("alert")).toHaveTextContent("error.unauthorized")
    fireEvent.click(screen.getByTestId("official-account-deletion-retry"))
    expect(await screen.findByTestId("official-account-deletion-start")).toBeInTheDocument()
  })
})
