/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"

import en from "@/i18n/messages/en/account.json"
import { CLOUD_OFFLINE_KEY_PREFIX } from "@/components/account/cloud-sign-in-gate"
import type { DeploymentDiscovery, ReadyDeployment } from "@/lib/identity/deployment-discovery"
import type { CloudSessionState } from "@/lib/identity/cloud-session"

import { CloudDeploymentCard, type CloudDeploymentCardDeps } from "./cloud-deployment-card"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      `${ns}.${key}${values ? `(${Object.values(values).join(",")})` : ""}`
    t.has = () => true
    return t
  },
}))
jest.mock("next/navigation", () => ({ usePathname: () => "/" }))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("@/lib/accounts/active-account-id", () => ({ getActiveAccountId: () => "acct_active" }))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))
jest.mock("@/lib/logto/app-session", () => ({
  signOutFromLogto: jest.fn(),
  signOutLeftTokensLive: () => false,
}))
jest.mock("@/lib/identity/complete-sign-in", () => ({ completeSignOut: jest.fn() }))
jest.mock("@/lib/identity/cloud-session", () => ({ readCloudSessionState: jest.fn() }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: unknown) => unknown) =>
    selector({ loaded: true, locked: false, unlockedAccountId: null, activeAccountId: null }),
}))

const FP = "ab".repeat(32)

const ready: ReadyDeployment = {
  status: "ready",
  baseUrl: "https://cloud.example",
  config: {} as ReadyDeployment["config"],
  social: [
    { provider: "github", directSignIn: "social:github" },
    { provider: "feishu-web", directSignIn: "social:feishu-web" },
    { provider: "okta-custom", directSignIn: "social:okta-custom" },
  ],
  collaborationServiceUrl: "https://cloud.example/collab",
  registrationPolicy: "bootstrap-then-invite",
  webOrigin: "https://cloud.example",
}

function memory() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

function deps(overrides: Partial<CloudDeploymentCardDeps> = {}): CloudDeploymentCardDeps {
  return {
    localAccountId: "acct_a",
    discover: jest.fn(async () => ready as DeploymentDiscovery),
    readState: jest.fn(async () => ({ status: "signed-out" }) as CloudSessionState),
    signOut: jest.fn(async () => ({ endSessionUrl: null, tokensLive: false })),
    reload: jest.fn(),
    storage: { local: memory() },
    ...overrides,
  }
}

beforeEach(() => {
  sessionStorage.clear()
  jest.clearAllMocks()
})

describe("CloudDeploymentCard", () => {
  it("starts on the form when the profile has no deployment, and refuses a bad address", () => {
    const d = deps()
    render(<CloudDeploymentCard deps={d} />)
    expect(screen.getByTestId("cloud-deployment-form")).toBeInTheDocument()
    fireEvent.change(screen.getByTestId("cloud-deployment-url"), {
      target: { value: "not a url" },
    })
    fireEvent.click(screen.getByTestId("cloud-deployment-check"))
    expect(screen.getByTestId("cloud-deployment-error")).toHaveTextContent(
      "account.cloud.deployment.error.invalid"
    )
    expect(d.discover).not.toHaveBeenCalled()
  })

  it("checks the normalized address, shows what it offers, and only then stores it", async () => {
    const d = deps()
    sessionStorage.setItem(`${CLOUD_OFFLINE_KEY_PREFIX}.acct_a`, "1")
    render(<CloudDeploymentCard deps={d} />)
    fireEvent.change(screen.getByTestId("cloud-deployment-url"), {
      target: { value: " cloud.example:27890/ " },
    })
    fireEvent.change(screen.getByTestId("cloud-deployment-fingerprint"), {
      target: { value: "AB:" + "ab:".repeat(30) + "AB" },
    })
    fireEvent.click(screen.getByTestId("cloud-deployment-check"))
    const result = await screen.findByTestId("cloud-deployment-result")
    expect(d.discover).toHaveBeenCalledWith({
      baseUrl: "https://cloud.example:27890",
      fingerprint: FP,
    })
    expect(result).toHaveAttribute("data-status", "ready")
    // Known targets get their label, the Feishu connector's real target
    // included. An unknown target stays visible under its own name.
    expect(screen.getByTestId("cloud-deployment-result-providers")).toHaveTextContent(
      "account.cloud.provider.github, account.cloud.provider.feishu-web, okta-custom"
    )
    expect(screen.getByText("https://cloud.example/collab")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("cloud-deployment-use"))
    expect(await screen.findByTestId("cloud-deployment-current")).toBeInTheDocument()
    expect(screen.getByTestId("cloud-deployment-current-url")).toHaveTextContent(
      "https://cloud.example:27890"
    )
    const stored = (d.storage!.local as ReturnType<typeof memory>).map.get(
      "cognia.cloud.deployment.acct_a"
    )
    expect(JSON.parse(stored!)).toEqual({ baseUrl: "https://cloud.example:27890", fingerprint: FP })
    // The tab's "continue offline" no longer stands: the gate must ask again.
    expect(sessionStorage.getItem(`${CLOUD_OFFLINE_KEY_PREFIX}.acct_a`)).toBeNull()
  })

  it("says single-user and unreachable without offering to use them", async () => {
    let answer: DeploymentDiscovery = { status: "none", reason: "single-user" }
    const d = deps({ discover: jest.fn(async () => answer) })
    render(<CloudDeploymentCard deps={d} />)
    fireEvent.change(screen.getByTestId("cloud-deployment-url"), {
      target: { value: "https://one.example" },
    })
    fireEvent.click(screen.getByTestId("cloud-deployment-check"))
    expect(await screen.findByTestId("cloud-deployment-result")).toHaveAttribute(
      "data-status",
      "none"
    )
    expect(screen.queryByTestId("cloud-deployment-use")).not.toBeInTheDocument()

    answer = {
      status: "unavailable",
      reason: "unreachable",
      baseUrl: "https://one.example",
      message: "ECONNREFUSED",
    }
    fireEvent.click(screen.getByTestId("cloud-deployment-check"))
    await waitFor(() =>
      expect(screen.getByTestId("cloud-deployment-result")).toHaveAttribute(
        "data-status",
        "unavailable"
      )
    )
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument()
    expect(screen.queryByTestId("cloud-deployment-use")).not.toBeInTheDocument()
  })

  it("shows the stored deployment with the session, and signs out through the shared path", async () => {
    const local = memory()
    local.setItem(
      "cognia.cloud.deployment.default",
      JSON.stringify({ baseUrl: "https://cloud.example", fingerprint: FP })
    )
    const d = deps({
      storage: { local },
      readState: jest.fn(
        async () =>
          ({
            status: "active",
            session: {} as never,
            identity: { userId: "usr_ada", logtoSubject: "s", displayName: "Ada" },
          }) as CloudSessionState
      ),
    })
    render(<CloudDeploymentCard deps={d} />)
    expect(await screen.findByTestId("cloud-deployment-session")).toHaveTextContent("Ada")
    expect(screen.getByText(FP)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("cloud-deployment-sign-out"))
    await waitFor(() => expect(d.signOut).toHaveBeenCalledWith("acct_a"))
    expect(toast.success).toHaveBeenCalled()
    expect(d.readState).toHaveBeenCalledTimes(2)
  })

  it("lets a signed-out profile sign in by withdrawing the offline choice and reloading", async () => {
    const local = memory()
    local.setItem(
      "cognia.cloud.deployment.acct_a",
      JSON.stringify({ baseUrl: "https://c.example" })
    )
    sessionStorage.setItem(`${CLOUD_OFFLINE_KEY_PREFIX}.acct_a`, "1")
    const d = deps({ storage: { local } })
    render(<CloudDeploymentCard deps={d} />)
    expect(await screen.findByTestId("cloud-deployment-session")).toHaveTextContent("signed-out")
    fireEvent.click(screen.getByTestId("cloud-deployment-sign-in"))
    expect(sessionStorage.getItem(`${CLOUD_OFFLINE_KEY_PREFIX}.acct_a`)).toBeNull()
    expect(d.reload).toHaveBeenCalled()
  })

  it("forgets the deployment and returns to the form, and change pre-fills it", async () => {
    const local = memory()
    local.setItem(
      "cognia.cloud.deployment.acct_a",
      JSON.stringify({ baseUrl: "https://c.example" })
    )
    const d = deps({ storage: { local } })
    render(<CloudDeploymentCard deps={d} />)
    fireEvent.click(await screen.findByTestId("cloud-deployment-change"))
    expect(screen.getByTestId("cloud-deployment-url")).toHaveValue("https://c.example")
    fireEvent.click(screen.getByTestId("cloud-deployment-cancel"))
    fireEvent.click(screen.getByTestId("cloud-deployment-forget"))
    expect(screen.getByTestId("cloud-deployment-form")).toBeInTheDocument()
    expect(local.map.has("cognia.cloud.deployment.acct_a")).toBe(false)
  })

  it("defaults to the active profile and renders plain without the block chrome", () => {
    render(<CloudDeploymentCard frame="plain" deps={{ storage: { local: memory() } }} />)
    const card = screen.getByTestId("cloud-deployment-card")
    expect(card).toHaveAttribute("data-frame", "plain")
    expect(screen.queryByTestId("cloud-deployment-block")).not.toBeInTheDocument()
  })

  /** The dynamic keys `lint:i18n` cannot see. */
  it("has a catalogue entry for every session and result state it can name", () => {
    const deployment = en.cloud.deployment as {
      session: Record<string, string>
      result: { status: Record<string, string> }
    }
    for (const status of [
      "loading",
      "active",
      "signed-out",
      "reauth-required",
      "offline",
      "error",
    ]) {
      expect(deployment.session[status]).toEqual(expect.any(String))
    }
    for (const status of ["ready", "none", "unavailable"]) {
      expect(deployment.result.status[status]).toEqual(expect.any(String))
    }
    expect((en.cloud.provider as Record<string, string>)["feishu-web"]).toEqual(expect.any(String))
  })

  it("names a deployment with no social sign-in, no collaboration service and no policy", async () => {
    const d = deps({
      discover: jest.fn(
        async () =>
          ({
            ...ready,
            social: [],
            collaborationServiceUrl: null,
            registrationPolicy: null,
          }) as DeploymentDiscovery
      ),
    })
    render(<CloudDeploymentCard deps={d} />)
    fireEvent.change(screen.getByTestId("cloud-deployment-url"), {
      target: { value: "https://bare.example" },
    })
    fireEvent.click(screen.getByTestId("cloud-deployment-check"))
    const result = await screen.findByTestId("cloud-deployment-result")
    expect(result).toHaveTextContent("account.cloud.deployment.result.providersNone")
    expect(result).toHaveTextContent("account.cloud.deployment.result.collaborationMissing")
    expect(result).not.toHaveTextContent("account.cloud.deployment.result.policy")
    expect(screen.getByTestId("cloud-deployment-use")).toBeInTheDocument()
  })

  it("reports a check that threw as a form error", async () => {
    const d = deps({
      discover: jest.fn(async () => {
        throw new Error("boom")
      }),
    })
    render(<CloudDeploymentCard deps={d} />)
    fireEvent.change(screen.getByTestId("cloud-deployment-url"), {
      target: { value: "https://bare.example" },
    })
    fireEvent.click(screen.getByTestId("cloud-deployment-check"))
    expect(await screen.findByTestId("cloud-deployment-error")).toHaveTextContent("boom")
  })

  it("warns when revocation did not land, opens the end-session URL, and reports a failed sign-out", async () => {
    const { openUrl } = jest.requireMock("@/lib/native/opener") as { openUrl: jest.Mock }
    const local = memory()
    local.setItem(
      "cognia.cloud.deployment.acct_a",
      JSON.stringify({ baseUrl: "https://c.example" })
    )
    const signOut = jest
      .fn()
      .mockResolvedValueOnce({ endSessionUrl: "https://logto.example/end", tokensLive: true })
      .mockRejectedValueOnce(new Error("network down"))
    const d = deps({
      storage: { local },
      signOut,
      readState: jest.fn(
        async () =>
          ({
            status: "active",
            session: {} as never,
            identity: { userId: "usr_ada", logtoSubject: "s", email: "ada@example.com" },
          }) as CloudSessionState
      ),
    })
    render(<CloudDeploymentCard deps={d} />)
    expect(await screen.findByTestId("cloud-deployment-session")).toHaveTextContent(
      "ada@example.com"
    )
    fireEvent.click(screen.getByTestId("cloud-deployment-sign-out"))
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(openUrl).toHaveBeenCalledWith("https://logto.example/end")
    fireEvent.click(screen.getByTestId("cloud-deployment-sign-out"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect((toast.error as jest.Mock).mock.calls[0][0]).toContain("network down")
  })
})
