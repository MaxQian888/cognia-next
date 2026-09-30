import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { IntegrationsHub } from "./integrations-hub"

let mockPlatform = "tauri"
let mockHasEntries = true
let mockAccounts: unknown[] = []
let mockEntries: unknown[] | undefined

const mockConfigureRepoWebhook = jest.fn()
const mockRotateAppWebhook = jest.fn()
const mockCreateSubscription = jest.fn()
const mockGetAccount = jest.fn()
const mockUpdateAccount = jest.fn()

jest.mock("@/lib/integrations/ingress-client", () => ({
  ...jest.requireActual("@/lib/integrations/ingress-client"),
  getIntegrationIngressPublicUrl: async (routeId: string) =>
    `http://127.0.0.1:4455/integration/${routeId}`,
  listIntegrationIngressDeadletters: async () => [],
  syncIntegrationIngressRoutes: async () => 0,
}))
jest.mock("@/lib/integrations/github-repo-webhook", () => ({
  ...jest.requireActual("@/lib/integrations/github-repo-webhook"),
  configureGithubRepoWebhook: (...args: unknown[]) => mockConfigureRepoWebhook(...args),
}))
jest.mock("@/lib/integrations/github-webhook", () => ({
  rotateGithubWebhookSecret: (...args: unknown[]) => mockRotateAppWebhook(...args),
}))
jest.mock("@/lib/integrations/providers", () => ({
  checkIntegrationAccountHealth: jest.fn(),
  listIntegrationResources: async () => ({
    items: [{ kind: "repository", id: "acme/app", name: "acme/app" }],
  }),
}))
jest.mock("@/lib/credentials/keyring-store", () => ({
  createKeyringStore: () => ({ save: async () => undefined }),
}))
jest.mock("@/lib/db/integrations", () => ({
  ...jest.requireActual("@/lib/db/integrations"),
  createIntegrationSubscription: (...args: unknown[]) => mockCreateSubscription(...args),
  getIntegrationAccount: (...args: unknown[]) => mockGetAccount(...args),
  updateIntegrationAccount: (...args: unknown[]) => mockUpdateAccount(...args),
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [mockAccounts, [], [], []],
}))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => mockPlatform,
}))
jest.mock("@/lib/integrations/registry", () => ({
  getIntegrationRegistryRevision: () => 1,
  subscribeIntegrationRegistry: () => () => undefined,
  listRegisteredIntegrationEntries: () => mockEntries ?? (mockHasEntries ? MOCK_ENTRIES : []),
}))

const MOCK_ENTRIES = [
  {
    pluginId: "demo-delivery",
    definition: {
      id: "demo",
      label: "Demo Delivery",
      description: "Demo integration",
      authStrategies: [
        {
          id: "token",
          type: "personal-access-token",
          label: "Token",
          providerId: "demo-token",
          configSchema: {
            type: "object",
            required: ["token"],
            properties: {
              token: { type: "string", format: "secret" },
              hostUrl: { type: "string", title: "Enterprise server URL" },
            },
          },
        },
        {
          id: "pat",
          type: "personal-access-token",
          label: "Advanced token",
          providerId: "demo-pat",
        },
      ],
      resourceKinds: ["workspace"],
      eventTypes: [{ id: "issue.created", label: "Issue created" }],
      actions: [
        {
          id: "issue.create",
          label: "Create issue",
          risk: "write",
          inputSchema: { type: "object" },
          idempotency: "supported",
          handler: "createIssue",
        },
      ],
    },
  },
]

beforeEach(() => {
  mockPlatform = "tauri"
  mockHasEntries = true
  mockAccounts = []
  mockEntries = undefined
  jest.clearAllMocks()
})

const GITHUB_ENTRY = {
  pluginId: "github-delivery",
  definition: {
    id: "github",
    label: "GitHub",
    description: "GitHub",
    authStrategies: [],
    resourceKinds: ["repository"],
    resourceProvider: { handler: "listGithubResources", kinds: ["repository"] },
    eventTypes: [{ id: "issues.closed", label: "issues.closed" }],
    actions: [],
    ingress: {
      normalizer: "normalizeGithub",
      verification: { type: "hmac-sha256", signatureHeader: "x-hub-signature-256" },
    },
  },
}

function githubAccount(over: Record<string, unknown> = {}) {
  return {
    id: "acc-gh",
    pluginId: "github-delivery",
    integrationId: "github",
    providerId: "github-pat",
    authSessionId: "s",
    label: "octocat",
    enabled: true,
    health: "healthy",
    ingressEndpoint: {
      id: "ep",
      accountId: "acc-gh",
      routeId: "route-1",
      secretHandle: "h",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    ...over,
  }
}

describe("IntegrationsHub webhook delivery", () => {
  it("says the listener is local-only until a public URL is configured", async () => {
    mockEntries = [GITHUB_ENTRY]
    mockAccounts = [githubAccount()]
    render(<IntegrationsHub />)
    expect(
      await screen.findByText("Local listener: http://127.0.0.1:4455/integration/route-1")
    ).toBeInTheDocument()
    expect(screen.getByText(/only accepts connections from this device/)).toBeInTheDocument()
    expect(screen.queryByText(/^Webhook URL:/)).not.toBeInTheDocument()
  })

  it("shows the public delivery URL once one is configured", async () => {
    mockEntries = [GITHUB_ENTRY]
    const account = githubAccount()
    mockAccounts = [
      {
        ...account,
        ingressEndpoint: { ...account.ingressEndpoint, publicBaseUrl: "https://hooks.example.com" },
      },
    ]
    render(<IntegrationsHub />)
    expect(
      await screen.findByText("Webhook URL: https://hooks.example.com/integration/route-1")
    ).toBeInTheDocument()
  })

  it("configures the repository webhook for a PAT account at the public URL", async () => {
    mockEntries = [GITHUB_ENTRY]
    const account = githubAccount()
    mockAccounts = [account]
    const withBase = {
      ...account,
      ingressEndpoint: { ...account.ingressEndpoint, publicBaseUrl: "https://hooks.example.com" },
    }
    mockGetAccount.mockResolvedValueOnce(account).mockResolvedValueOnce(withBase)
    mockCreateSubscription.mockResolvedValue({})
    mockConfigureRepoWebhook.mockResolvedValue({ status: "created", hookId: 1, events: [] })
    render(<IntegrationsHub />)

    fireEvent.change(screen.getByRole("combobox", { name: "Account" }), {
      target: { value: "acc-gh" },
    })
    fireEvent.click(await screen.findByRole("button", { name: "Discover" }))
    await screen.findByRole("option", { name: "acme/app" })
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "acme/app" } })
    fireEvent.click(screen.getByRole("checkbox", { name: "Issue closed" }))
    fireEvent.change(screen.getByLabelText("Webhook secret (required when ingress is enabled)"), {
      target: { value: "shh" },
    })
    fireEvent.change(screen.getByLabelText("Public webhook URL (tunnel or reverse proxy)"), {
      target: { value: "hooks.example.com" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add subscription" }))
    })

    await waitFor(() =>
      expect(mockConfigureRepoWebhook).toHaveBeenCalledWith({
        account: withBase,
        repoFullName: "acme/app",
        webhookUrl: "https://hooks.example.com/integration/route-1",
        eventTypes: ["issues.closed"],
      })
    )
    expect(mockUpdateAccount).toHaveBeenCalledWith(
      "github-delivery",
      "acc-gh",
      expect.objectContaining({
        ingressEndpoint: expect.objectContaining({ publicBaseUrl: "https://hooks.example.com" }),
      })
    )
    expect(mockRotateAppWebhook).not.toHaveBeenCalled()
    expect(
      await screen.findByText(
        "The webhook for acme/app is configured and will deliver the selected events."
      )
    ).toBeInTheDocument()
  })

  it("refuses a private public-URL before saving anything", async () => {
    mockEntries = [GITHUB_ENTRY]
    mockAccounts = [githubAccount()]
    render(<IntegrationsHub />)
    fireEvent.change(screen.getByRole("combobox", { name: "Account" }), {
      target: { value: "acc-gh" },
    })
    fireEvent.click(screen.getByRole("checkbox", { name: "Issue closed" }))
    fireEvent.change(screen.getByLabelText("Public webhook URL (tunnel or reverse proxy)"), {
      target: { value: "http://192.168.1.2:8080" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add subscription" }))
    })
    expect(await screen.findByText(/must be an https address on a public host/)).toBeInTheDocument()
    expect(mockCreateSubscription).not.toHaveBeenCalled()
  })

  it("does not push anything to GitHub without a public URL", async () => {
    mockEntries = [GITHUB_ENTRY]
    const account = githubAccount({ providerId: "github-app", dedicatedAppConfirmed: true })
    mockAccounts = [account]
    mockGetAccount.mockResolvedValue(account)
    mockCreateSubscription.mockResolvedValue({})
    render(<IntegrationsHub />)
    fireEvent.change(screen.getByRole("combobox", { name: "Account" }), {
      target: { value: "acc-gh" },
    })
    fireEvent.click(screen.getByRole("checkbox", { name: "Issue closed" }))
    fireEvent.change(screen.getByLabelText("Webhook secret (required when ingress is enabled)"), {
      target: { value: "shh" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add subscription" }))
    })
    expect(await screen.findByText(/GitHub was not configured/)).toBeInTheDocument()
    expect(mockRotateAppWebhook).not.toHaveBeenCalled()
    expect(mockConfigureRepoWebhook).not.toHaveBeenCalled()
  })
})

describe("IntegrationsHub", () => {
  it("renders registered Marketplace integrations and host-owned management sections", () => {
    render(<IntegrationsHub />)
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument()
    expect(screen.getAllByText("Demo Delivery")).not.toHaveLength(0)
    expect(screen.getByText("Accounts")).toBeInTheDocument()
    expect(screen.getByText("Subscriptions")).toBeInTheDocument()
    expect(screen.getByText("Approvals and jobs")).toBeInTheDocument()
    expect(screen.getByText("Audit")).toBeInTheDocument()
  })

  it("gives the page one h1 and each management section a real h2", () => {
    // The four sections used to be `<Card>`s whose titles were spans wearing
    // `role="heading"`, and the page title was a hand-rolled <h1> in the
    // scroll body rather than the shared header band. The outline is what a
    // screen reader navigates by, so it is pinned here.
    render(<IntegrationsHub />)
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1)
    const sections = screen
      .getAllByRole("heading", { level: 2 })
      .map((node) => node.textContent?.trim())
    expect(sections).toEqual(["Accounts", "Subscriptions", "Approvals and jobs", "Audit"])
  })

  it("guides authentication configuration instead of asking for raw provider IDs", () => {
    render(<IntegrationsHub />)
    fireEvent.change(screen.getByLabelText("Integration"), {
      target: { value: "demo-delivery:demo" },
    })
    expect(screen.getByRole("button", { name: /Token Recommended/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Advanced token Advanced/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Token Recommended/ }))
    expect(screen.getByLabelText("Personal access token")).toHaveAttribute("type", "password")
    expect(screen.queryByPlaceholderText("Auth provider ID")).not.toBeInTheDocument()
  })

  it("offers the enterprise server field and says that leaving it empty is fine", () => {
    // ADR-0176. The one field here where blank is the common, correct answer.
    // A bare label cannot say so, and a user who types github.com into it has
    // been given a worse account than one who left it alone.
    render(<IntegrationsHub />)
    fireEvent.change(screen.getByLabelText("Integration"), {
      target: { value: "demo-delivery:demo" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Token Recommended/ }))

    const field = screen.getByLabelText("Enterprise server URL")
    expect(field).toHaveAttribute("type", "text")
    expect(field).not.toBeRequired()
    expect(screen.getByText(/Leave empty for github\.com/)).toBeInTheDocument()
  })

  it("points at the marketplace instead of an account form with nothing to pick", () => {
    mockHasEntries = false
    render(<IntegrationsHub />)
    expect(screen.getByRole("link", { name: "Browse plugins" })).toHaveAttribute(
      "href",
      "/plugins?section=discover"
    )
    expect(screen.queryByLabelText("Integration")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Validate and add" })).not.toBeInTheDocument()
    expect(screen.getByText("Install an integration plugin to add an account.")).toBeInTheDocument()
  })

  it("asks for an account before offering a subscription form", () => {
    render(<IntegrationsHub />)
    expect(screen.queryByRole("button", { name: "Add subscription" })).not.toBeInTheDocument()
    expect(
      screen.getByText("Add an account first, then subscribe to its events.")
    ).toBeInTheDocument()
  })

  it("offers the subscription form once an account exists", () => {
    mockAccounts = [
      {
        id: "acc1",
        pluginId: "demo-delivery",
        integrationId: "demo",
        label: "Work",
        enabled: true,
        health: "healthy",
      },
    ]
    render(<IntegrationsHub />)
    expect(screen.getByRole("button", { name: "Add subscription" })).toBeEnabled()
    // No account picked yet: the events legend waits for one instead of
    // heading an empty list.
    expect(screen.queryByText("Events")).not.toBeInTheDocument()
  })

  // A browser or a phone with nothing recorded gets one statement of where
  // integrations live, not four empty sections under an install card whose
  // plugins cannot be installed here either.
  it("says where integrations live instead of an empty console where they cannot run", () => {
    mockPlatform = "web"
    mockHasEntries = false
    render(<IntegrationsHub />)
    expect(screen.getByTestId("integrations-unsupported")).toHaveTextContent(
      "Integration management requires the desktop app."
    )
    expect(screen.queryByRole("link", { name: "Browse plugins" })).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument()
  })

  it("keeps anything already recorded reachable, without the install card", () => {
    mockPlatform = "web"
    mockHasEntries = false
    mockAccounts = [
      {
        id: "acc1",
        pluginId: "demo-delivery",
        integrationId: "demo",
        label: "Work",
        enabled: true,
        health: "healthy",
      },
    ]
    render(<IntegrationsHub />)
    expect(screen.queryByTestId("integrations-unsupported")).not.toBeInTheDocument()
    expect(screen.getByText("Integration management requires the desktop app.")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Browse plugins" })).not.toBeInTheDocument()
  })

  it("makes the whole account form inert where it cannot be submitted", () => {
    mockPlatform = "web"
    // Something is recorded, so the console renders; its forms stay inert.
    mockAccounts = [
      {
        id: "acc1",
        pluginId: "demo-delivery",
        integrationId: "demo",
        label: "Work",
        enabled: true,
        health: "healthy",
      },
    ]
    render(<IntegrationsHub />)
    expect(screen.getByText("Integration management requires the desktop app.")).toBeInTheDocument()
    expect(screen.getByLabelText("Integration")).toBeDisabled()
    expect(screen.getByLabelText("Account label")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Validate and add" })).toBeDisabled()
  })

  it("names the authentication step only once an integration is picked", () => {
    render(<IntegrationsHub />)
    expect(screen.queryByText("Authentication method")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Integration"), {
      target: { value: "demo-delivery:demo" },
    })
    expect(screen.getByText("Authentication method")).toBeInTheDocument()
  })
})
