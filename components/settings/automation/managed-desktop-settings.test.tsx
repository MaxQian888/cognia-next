// The global mock fixes English; respect each fixture provider to verify both locales.
jest.mock("next-intl", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const Context = React.createContext<Record<string, unknown>>({})
  return {
    NextIntlClientProvider: ({
      messages,
      children,
    }: {
      messages: Record<string, unknown>
      children: React.ReactNode
    }) => React.createElement(Context.Provider, { value: messages }, children),
    useTranslations: (namespace: string) => {
      const messages = React.useContext(Context)
      return (key: string, values?: Record<string, unknown>) => {
        const result = `${namespace}.${key}`
          .split(".")
          .reduce<unknown>(
            (value, part) =>
              value && typeof value === "object"
                ? (value as Record<string, unknown>)[part]
                : undefined,
            messages
          )
        if (typeof result !== "string") throw new Error(`Missing translation: ${namespace}.${key}`)
        return result.replace(/\{(\w+)\}/g, (_, name: string) =>
          String(values?.[name] ?? `{${name}}`)
        )
      }
    },
  }
})
jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: jest.fn(),
  getCompanionConfigGeneration: jest.fn(() => 0),
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: jest.fn(),
  subscribeRuntimeTargetContext: jest.fn(() => jest.fn()),
}))
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
jest.mock("./managed-desktop-cleanup", () => ({
  ManagedDesktopCleanup: () => <div data-testid="managed-desktop-cleanup" />,
}))
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/settings/managedDesktops.json"
import zhMessages from "@/i18n/messages/zh-CN/settings/managedDesktops.json"
jest.mock("@/stores/account/account-store", () => {
  const store = Object.assign(jest.fn(), {
    getState: jest.fn(),
    subscribe: jest.fn(() => jest.fn()),
  })
  store.getState.mockImplementation(() => store((state: unknown) => state))
  return { useAccountStore: store }
})
jest.mock("@/lib/automation/managed-desktop-handoff-client", () => ({
  managedDesktopHandoffClient: { deliveries: jest.fn(), prepare: jest.fn() },
  managedDesktopHandoffErrorKey: jest.fn(() => "prepareFailed"),
}))
jest.mock("@/stores/remote-host/remote-host-store", () => {
  const store = Object.assign(jest.fn(), {
    getState: jest.fn(),
    subscribe: jest.fn(() => jest.fn()),
  })
  store.getState.mockImplementation(() => store((state: unknown) => state))
  return { useRemoteHostStore: store }
})
import { useAccountStore } from "@/stores/account/account-store"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { managedDesktopHandoffClient } from "@/lib/automation/managed-desktop-handoff-client"
jest.mock("@/lib/automation/managed-desktop-client", () => ({
  ...jest.requireActual("@/lib/automation/managed-desktop-client"),
  managedDesktopClient: {
    list: jest.fn(),
    listConfigs: jest.fn(),
    quote: jest.fn(),
    authorize: jest.fn(),
    prepareTemplate: jest.fn(),
  },
}))
jest.mock("./sandbox-desktop-viewer", () => ({ SandboxDesktopViewer: jest.fn(() => null) }))
import { SandboxDesktopViewer } from "./sandbox-desktop-viewer"
jest.mock("@/lib/sandbox/connection-lifecycle", () => ({
  runSandboxConnectionOperation: jest.fn(),
}))
import { managedDesktopClient } from "@/lib/automation/managed-desktop-client"
import { runSandboxConnectionOperation } from "@/lib/sandbox/connection-lifecycle"
import { ManagedDesktopSettings } from "./managed-desktop-settings"
const api = managedDesktopClient as jest.Mocked<typeof managedDesktopClient>
const config = {
  id: "byo",
  ownerPrincipalId: "owner",
  hostId: "host",
  enabled: true,
  canCreate: false,
  canPrepareTemplate: true,
  qualification: "unqualified" as const,
  isolationTier: "vm" as const,
  egressTier: "off" as const,
  egressEnforcement: "unverified" as const,
  maxConcurrent: 2,
  maxLifetimeSeconds: 3600,
  idleTimeoutSeconds: 600,
  cpuCount: 2,
  memoryMb: 4096,
}
const currentProof = {
  qualificationEvidenceVersion: 2,
  workloadIsolationRevision: 1,
  egressEnforcement: "provider-and-guest-kernel" as const,
}
function settings() {
  return (
    <NextIntlClientProvider locale="en" messages={{ settings: { managedDesktops: messages } }}>
      <ManagedDesktopSettings target={{ kind: "remote", hostId: "chosen-host" }} />
    </NextIntlClientProvider>
  )
}
function renderSettings() {
  return render(settings())
}
beforeEach(() => {
  jest.clearAllMocks()
  ;(useAccountStore as unknown as jest.Mock).mockImplementation((selector) =>
    selector({ locked: false, unlockedAccountId: "owner" })
  )
  ;(useRemoteHostStore as unknown as jest.Mock).mockImplementation((selector) =>
    selector({ hosts: [{ id: "chosen-host", config: { deviceId: "paired", accountId: "owner" } }] })
  )
  api.listConfigs.mockResolvedValue([config])
  api.list.mockResolvedValue([])
  api.quote.mockResolvedValue({
    id: "quote",
    providerConfigId: "byo",
    lifetimeSeconds: 3600,
    expiresAt: Date.now() + 60000,
    currency: "USD",
    hourlyRateMicros: 165600,
    maximumComputeCostMicros: 165600,
    priceObservedAt: Date.now(),
    cpuCount: 2,
    memoryMb: 4096,
    configRevision: 1,
  })
  api.authorize.mockResolvedValue({ id: "auth", expiresAt: Date.now() + 60000 })
})

test("labels dormancy on the real settings surface and makes no billed call on mount", async () => {
  renderSettings()
  expect(await screen.findByText(messages.unqualified)).toBeInTheDocument()
  expect(screen.getByText(messages.dormant)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: messages.create })).toBeDisabled()
  expect(api.listConfigs).toHaveBeenCalledWith({ kind: "remote", hostId: "chosen-host" })
  expect(api.quote).not.toHaveBeenCalled()
  expect(api.authorize).not.toHaveBeenCalled()
  expect(runSandboxConnectionOperation).not.toHaveBeenCalled()
  expect(screen.getByRole("region", { name: messages.handoff.title })).toBeVisible()
  expect(screen.getByRole("button", { name: messages.handoff.start })).toBeDisabled()
  expect(managedDesktopHandoffClient.deliveries).not.toHaveBeenCalled()
  expect(managedDesktopHandoffClient.prepare).not.toHaveBeenCalled()
})

test("the settings entry loads owner-filtered handoff sources only after user action", async () => {
  ;(managedDesktopHandoffClient.deliveries as jest.Mock).mockResolvedValue([])
  renderSettings()
  fireEvent.click(await screen.findByRole("button", { name: messages.handoff.load }))
  expect(await screen.findByText(messages.handoff.empty)).toBeVisible()
  expect(managedDesktopHandoffClient.deliveries).toHaveBeenCalledWith({
    kind: "remote",
    hostId: "chosen-host",
  })
  expect(api.authorize).not.toHaveBeenCalled()
  expect(runSandboxConnectionOperation).not.toHaveBeenCalled()
})

test("shows the selected shape cost before setup and refuses unqualified creation", async () => {
  renderSettings()
  await screen.findByText(messages.unqualified)
  fireEvent.click(screen.getByRole("button", { name: messages.quote }))
  expect(
    await screen.findByText("Estimated selected-spec price: USD 0.1656/hour")
  ).toBeInTheDocument()
  expect(
    screen.getByText("Maximum desktop compute within this deadline: USD 0.1656")
  ).toBeInTheDocument()
  expect(screen.getByText(messages.costs)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: messages.create })).toBeDisabled()
  expect(screen.getByRole("button", { name: messages.prepare })).toBeEnabled()
})

test("rejects lifetime increases without silently clipping", async () => {
  renderSettings()
  await screen.findByText(messages.unqualified)
  fireEvent.change(screen.getByLabelText(messages.lifetime), { target: { value: "61" } })
  expect(screen.getByRole("button", { name: messages.quote })).toBeDisabled()
  expect(api.quote).not.toHaveBeenCalled()
})

test("requires Host consent before creating and consumes its authorization once", async () => {
  api.listConfigs.mockResolvedValue([
    { ...config, ...currentProof, qualification: "qualified", canCreate: true },
  ])
  renderSettings()
  await screen.findByText(messages.qualified)
  fireEvent.click(screen.getByRole("button", { name: messages.quote }))
  await screen.findByText("Estimated selected-spec price: USD 0.1656/hour")
  fireEvent.click(screen.getByRole("button", { name: messages.create }))
  await waitFor(() => expect(runSandboxConnectionOperation).toHaveBeenCalled())
  expect(api.authorize).toHaveBeenCalledWith(
    { kind: "remote", hostId: "chosen-host" },
    "byo",
    "quote",
    "create"
  )
  expect(runSandboxConnectionOperation).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "e2b" }),
    "create",
    {
      managedCreation: expect.objectContaining({
        authorizationId: "auth",
        quoteId: "quote",
        providerConfigId: "byo",
      }),
    }
  )
  expect(screen.getByRole("button", { name: messages.create })).toBeDisabled()
})

test("expired quotes cannot request consent or spend", async () => {
  api.quote.mockResolvedValue({
    ...(await api.quote({ kind: "local" }, "byo", 3600)),
    expiresAt: 1,
  })
  renderSettings()
  await screen.findByText(messages.unqualified)
  fireEvent.click(screen.getByRole("button", { name: messages.quote }))
  await screen.findByText("Estimated selected-spec price: USD 0.1656/hour")
  fireEvent.click(screen.getByRole("button", { name: messages.prepare }))
  expect(await screen.findByRole("alert")).toHaveTextContent(messages.errors.quoteExpired)
  expect(api.authorize).not.toHaveBeenCalled()
  expect(api.prepareTemplate).not.toHaveBeenCalled()
})

test("cleanup remains available when provider is unqualified or disabled", async () => {
  api.listConfigs.mockResolvedValue([{ ...config, enabled: false }])
  api.list.mockResolvedValue([
    {
      id: "desktop",
      providerConfigId: "byo",
      generation: 1,
      state: "destroyRetrying",
      deadlineAt: Date.now(),
      idleTimeoutSeconds: 600,
      createdAt: 1,
      updatedAt: 1,
      cleanupAttempts: 2,
      qualification: "smoke",
    },
  ])
  renderSettings()
  await screen.findByText("Destroy retry pending", { exact: false })
  expect(screen.getByText(messages.smokeResource)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: messages.delete }))
  await waitFor(() =>
    expect(runSandboxConnectionOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "desktop" }),
      "delete"
    )
  )
})

test("labels unsupported egress qualification and does not claim provider enforcement", async () => {
  api.listConfigs.mockResolvedValue([
    { ...config, egressTier: "allowlist", reason: "managed_desktop_egress_smoke_unsupported" },
  ])
  renderSettings()
  expect(await screen.findByText(messages.errors.egressSmokeUnsupported)).toBeInTheDocument()
  expect(
    screen.getByText("Isolation: VM · Network: Allowlist · Enforcement: Unverified")
  ).toBeInTheDocument()
  expect(screen.getByRole("button", { name: messages.create })).toBeDisabled()
  expect(api.authorize).not.toHaveBeenCalled()
})

test("lifecycle qualification alone cannot open the managed desktop", async () => {
  api.listConfigs.mockResolvedValue([
    { ...config, ...currentProof, qualification: "qualified", canCreate: true },
  ])
  api.list.mockResolvedValue([
    {
      id: "desktop",
      providerConfigId: "byo",
      generation: 2,
      state: "running",
      deadlineAt: Date.now() + 60000,
      idleTimeoutSeconds: 600,
      createdAt: 1,
      updatedAt: 1,
      cleanupAttempts: 0,
      qualification: "qualified",
    },
  ])
  renderSettings()
  expect(await screen.findByText(messages.guiDormant)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: messages.openDesktop })).toBeDisabled()
  expect(SandboxDesktopViewer).not.toHaveBeenCalled()
})

test("GUI qualification mounts the existing viewer only after an explicit open gesture", async () => {
  api.listConfigs.mockResolvedValue([
    { ...config, ...currentProof, qualification: "qualified", canCreate: true, guiQualified: true },
  ])
  api.list.mockResolvedValue([
    {
      id: "desktop",
      providerConfigId: "byo",
      generation: 2,
      state: "running",
      deadlineAt: Date.now() + 60000,
      idleTimeoutSeconds: 600,
      createdAt: 1,
      updatedAt: 1,
      cleanupAttempts: 0,
      qualification: "qualified",
    },
  ])
  renderSettings()
  const open = await screen.findByRole("button", { name: messages.openDesktop })
  expect(open).toBeEnabled()
  expect(SandboxDesktopViewer).not.toHaveBeenCalled()
  fireEvent.click(open)
  await waitFor(() => expect(SandboxDesktopViewer).toHaveBeenCalled())
  expect(runSandboxConnectionOperation).toHaveBeenCalledWith(
    expect.objectContaining({
      config: expect.objectContaining({
        target: { kind: "remote", hostId: "chosen-host" },
        desktopId: "desktop",
        generation: 2,
      }),
    }),
    "connect"
  )
  expect(SandboxDesktopViewer).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: "desktop",
      enabled: true,
      openDesktop: expect.any(Function),
    }),
    undefined
  )
  fireEvent.click(screen.getByRole("button", { name: messages.closeDesktop }))
  expect(screen.getByRole("button", { name: messages.openDesktop })).toBeInTheDocument()
})

test("cleanup receipts stay mounted even when no provider is configured", async () => {
  api.listConfigs.mockResolvedValue([])
  renderSettings()
  await waitFor(() => expect(api.listConfigs).toHaveBeenCalled())
  expect(screen.getByTestId("managed-desktop-cleanup")).toBeInTheDocument()
})

test("locked settings mount no owner data or cleanup panel", () => {
  ;(useAccountStore as unknown as jest.Mock).mockImplementation((selector) =>
    selector({ locked: true, unlockedAccountId: "owner" })
  )
  renderSettings()
  expect(api.listConfigs).not.toHaveBeenCalled()
  expect(api.list).not.toHaveBeenCalled()
  expect(screen.queryByTestId("managed-desktop-cleanup")).not.toBeInTheDocument()
})

test.each(["account", "pairing", "lock"])(
  "settings clear quotes and owner resources immediately on %s change",
  async (change) => {
    const view = renderSettings()
    await screen.findByText(messages.unqualified)
    fireEvent.click(screen.getByRole("button", { name: messages.quote }))
    await screen.findByText("Estimated selected-spec price: USD 0.1656/hour")
    api.listConfigs.mockReturnValue(new Promise(() => {}))
    if (change === "pairing")
      (useRemoteHostStore as unknown as jest.Mock).mockImplementation((selector) =>
        selector({ hosts: [{ id: "chosen-host", config: { deviceId: "repaired" } }] })
      )
    else
      (useAccountStore as unknown as jest.Mock).mockImplementation((selector) =>
        selector({ locked: change === "lock", unlockedAccountId: "other" })
      )
    view.rerender(settings())
    expect(
      screen.queryByText("Estimated selected-spec price: USD 0.1656/hour")
    ).not.toBeInTheDocument()
    expect(screen.queryByText("byo")).not.toBeInTheDocument()
  }
)

test("active paired Host settings remain available without a remote Host row", async () => {
  ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue({
    accountId: "owner",
    targetId: "paired-host",
    routingGeneration: 1,
  })
  ;(loadCompanionConfig as jest.Mock).mockReturnValue({
    targetId: "paired-host",
    accountId: "owner",
    deviceId: "paired",
  })
  render(
    <NextIntlClientProvider locale="en" messages={{ settings: { managedDesktops: messages } }}>
      <ManagedDesktopSettings target={{ kind: "remote", hostId: "companion:paired-host" }} />
    </NextIntlClientProvider>
  )
  expect(await screen.findByText(messages.unqualified)).toBeInTheDocument()
  expect(api.listConfigs).toHaveBeenCalledWith({ kind: "remote", hostId: "companion:paired-host" })
})

test.each([undefined, "owner"])(
  "settings refuse retained registered Host with accountId %s for a fresh other owner",
  (accountId) => {
    ;(useAccountStore as unknown as jest.Mock).mockImplementation((selector) =>
      selector({ locked: false, unlockedAccountId: "other" })
    )
    ;(useRemoteHostStore as unknown as jest.Mock).mockImplementation((selector) =>
      selector({ hosts: [{ id: "chosen-host", config: { deviceId: "paired", accountId } }] })
    )
    renderSettings()
    expect(api.listConfigs).not.toHaveBeenCalled()
    expect(api.list).not.toHaveBeenCalled()
    expect(screen.queryByTestId("managed-desktop-cleanup")).not.toBeInTheDocument()
  }
)

test.each([undefined, 0, 1, 3])(
  "qualified flags with old or absent evidence %s remain visibly dormant",
  async (version) => {
    api.listConfigs.mockResolvedValue([
      {
        ...config,
        ...currentProof,
        qualification: "qualified",
        canCreate: true,
        guiQualified: true,
        qualificationEvidenceVersion: version,
      },
    ])
    api.list.mockResolvedValue([
      {
        id: "desktop",
        providerConfigId: "byo",
        generation: 1,
        state: "running",
        deadlineAt: Date.now() + 60000,
        idleTimeoutSeconds: 600,
        createdAt: 1,
        updatedAt: 1,
        cleanupAttempts: 0,
        qualification: "qualified",
      },
    ])
    renderSettings()
    expect(await screen.findByText(messages.unqualified)).toBeVisible()
    expect(screen.queryByText(messages.qualified)).not.toBeInTheDocument()
    expect(screen.getByText("Isolation: VM · Network: Off · Enforcement: Unverified")).toBeVisible()
    expect(screen.getByText(messages.guiDormant)).toBeVisible()
    expect(screen.getByRole("button", { name: messages.openDesktop })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: messages.quote }))
    await screen.findByText("Estimated selected-spec price: USD 0.1656/hour")
    expect(screen.getByRole("button", { name: messages.create })).toBeDisabled()
    expect(screen.getByRole("button", { name: messages.delete })).toBeEnabled()
    expect(api.authorize).not.toHaveBeenCalled()
  }
)

test.each([
  ["en", messages],
  ["zh-CN", zhMessages],
] as const)(
  "%s labels qualified enforcement as provider policy plus guest kernel",
  async (locale, translated) => {
    api.listConfigs.mockResolvedValue([
      { ...config, ...currentProof, qualification: "qualified", canCreate: true },
    ])
    render(
      <NextIntlClientProvider
        locale={locale}
        messages={{ settings: { managedDesktops: translated } }}
      >
        <ManagedDesktopSettings target={{ kind: "remote", hostId: "chosen-host" }} />
      </NextIntlClientProvider>
    )
    expect(await screen.findByText(translated.qualified)).toBeVisible()
    expect(
      screen.getByText(
        translated.attestation
          .replace("{isolation}", translated.isolation.vm)
          .replace("{egress}", translated.egress.off)
          .replace("{enforcement}", translated.enforcement["provider-and-guest-kernel"])
      )
    ).toBeVisible()
  }
)
