import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({ relativeTime: () => "3 minutes ago" }),
  useNow: () => new Date(1_700_000_000_000),
}))
jest.mock("@/components/browser/browser-preview-pane", () => ({
  BrowserPreviewPane: ({ initialUrl }: { initialUrl: string }) => (
    <div data-testid="browser-preview">{initialUrl}</div>
  ),
}))
jest.mock("../site-manifest-editor", () => ({
  SiteManifestEditor: () => <div data-testid="manifest-editor" />,
}))
// The sub-status now reads a live query scoped to the one running operation,
// instead of filtering a flat array of every operation's events.
const operationEvents = jest.fn(() => [] as Array<Record<string, unknown>>)
jest.mock("@/hooks/sites/use-site-operation-events", () => ({
  useSiteOperationEvents: (operationId: string | null) => operationEvents(operationId),
}))

import type { SiteHostingManifestController } from "@/hooks/sites/use-site-hosting-manifest"
import type { SiteStepKey, SiteStepState } from "@/hooks/sites/use-site-live-data"
import type { SiteOperationRow, SiteProjectRow, SiteVersionRow } from "@/types/sites"
import { SitePublishTab } from "./site-publish-tab"

function site(): SiteProjectRow {
  return {
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "a", workerName: "docs" },
    authoringPolicy: { ownerAccountId: "owner", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
  }
}

const IDLE: Record<SiteStepKey, SiteStepState> = {
  connect: "idle",
  manifest: "idle",
  environment: "idle",
  build: "idle",
  preview: "idle",
  publish: "idle",
}

function manifest(ready: boolean): SiteHostingManifestController {
  return {
    state: ready
      ? { status: "ok", path: "/p", text: "{}", manifest: {} as never }
      : { status: "missing", path: "/p" },
    ready,
    text: "",
    refresh: jest.fn(async () => undefined),
    scaffold: jest.fn(async () => undefined),
    save: jest.fn(async () => undefined),
  }
}

const allowed = { allowed: true, reason: "ok" as const, title: undefined }
const blocked = { allowed: false, reason: "requires-desktop" as const, title: "Desktop only" }

function renderTab(props: Partial<React.ComponentProps<typeof SitePublishTab>> = {}) {
  const handlers = {
    onSaveToken: jest.fn(),
    onSaveManifest: jest.fn(),
    onProvision: jest.fn(),
    onBuild: jest.fn(),
    onStartPreview: jest.fn(),
    onStopPreview: jest.fn(),
    onRedetectWrangler: jest.fn(),
    onGoToVersions: jest.fn(),
    onGoToEnvironment: jest.fn(),
  }
  render(
    <SitePublishTab
      site={site()}
      stepStates={IDLE}
      operations={[]}
      readyVersions={[]}
      manifest={manifest(true)}
      wrangler={{ path: "/usr/bin/wrangler", version: "3.90.0", ready: true }}
      previewUrl={null}
      isBusy={() => false}
      providerGate={allowed}
      buildGate={allowed}
      previewGate={allowed}
      deployGate={allowed}
      filesystemGate={allowed}
      {...handlers}
      {...props}
    />
  )
  return handlers
}

it("renders six steps with the manifest between connecting and the environment", () => {
  renderTab()
  const titles = screen
    .getAllByText(/^steps\.[a-z]+\.(title|description)/)
    .map((node) => node.textContent)
  expect(titles).toEqual([
    "steps.connect.title",
    "steps.connect.description",
    "steps.manifest.title",
    "steps.manifest.description",
    "steps.environment.title",
    "steps.environment.description",
    "steps.build.title",
    "steps.build.description",
    "steps.preview.title",
    "steps.preview.description",
    "steps.publish.title",
    "steps.publish.description",
  ])
})

it("saves and clears the provider token", async () => {
  const user = userEvent.setup()
  const handlers = renderTab()
  const input = screen.getByLabelText("provider.token")
  expect(screen.getByTestId("site-save-token")).toBeDisabled()

  await user.type(input, "cf-token")
  await user.click(screen.getByTestId("site-save-token"))
  expect(handlers.onSaveToken).toHaveBeenCalledWith("cf-token")
  expect(input).toHaveValue("")
})

it("blocks build and preview until the manifest exists, and says why", () => {
  renderTab({ manifest: manifest(false) })
  expect(screen.getByTestId("site-build")).toBeDisabled()
  expect(screen.getByTestId("site-provision")).toBeDisabled()
  expect(screen.getByTestId("site-start-preview")).toBeDisabled()
  expect(screen.getAllByRole("alert")[0]).toHaveTextContent("errors.manifestMissing")
})

it("builds with the runtime, package manager, and approved install hosts", async () => {
  const user = userEvent.setup()
  const handlers = renderTab()
  await user.clear(screen.getByLabelText("build.networkHosts"))
  await user.type(screen.getByLabelText("build.networkHosts"), "registry.npmjs.org, example.com")
  await user.click(screen.getByTestId("site-build"))

  expect(handlers.onBuild).toHaveBeenCalledWith({
    runtime: "node@24",
    packageManager: "pnpm@10",
    installNetworkHosts: ["registry.npmjs.org", "example.com"],
    buildNetworkHosts: [],
  })
})

it("keeps the build phase off the network unless hosts are named", async () => {
  const user = userEvent.setup()
  const handlers = renderTab()
  await user.type(screen.getByLabelText("build.buildNetworkHosts"), "api.example.com")
  await user.click(screen.getByTestId("site-build"))

  expect(handlers.onBuild).toHaveBeenCalledWith(
    expect.objectContaining({ buildNetworkHosts: ["api.example.com"] })
  )
})

it("swaps start for stop and embeds the preview once one is running", async () => {
  const user = userEvent.setup()
  const handlers = renderTab({ previewUrl: "http://localhost:5173" })
  expect(screen.queryByTestId("site-start-preview")).not.toBeInTheDocument()
  expect(screen.getByTestId("browser-preview")).toHaveTextContent("http://localhost:5173")
  await user.click(screen.getByTestId("site-stop-preview"))
  expect(handlers.onStopPreview).toHaveBeenCalled()
})

it("guides the user when wrangler is missing", async () => {
  const user = userEvent.setup()
  const handlers = renderTab({ wrangler: { path: null, version: null, ready: false } })
  expect(screen.getByText("wrangler.notFound")).toBeInTheDocument()
  await user.click(screen.getByTestId("site-redetect-wrangler"))
  expect(handlers.onRedetectWrangler).toHaveBeenCalled()
})

it("waits quietly while wrangler detection is still running", () => {
  renderTab({ wrangler: null })
  expect(screen.getByText("wrangler.detecting")).toBeInTheDocument()
})

it("routes to the versions tab once something is buildable", async () => {
  const user = userEvent.setup()
  const handlers = renderTab({
    readyVersions: [{ id: "v1" } as SiteVersionRow],
  })
  await user.click(screen.getByTestId("site-goto-versions"))
  expect(handlers.onGoToVersions).toHaveBeenCalled()
})

it("says there is nothing to publish yet", () => {
  renderTab()
  expect(screen.getByText("publish.noVersions")).toBeInTheDocument()
})

it("streams the running operation's newest event into the owning step", () => {
  const operation: SiteOperationRow = {
    id: "op1",
    siteId: "site_1",
    type: "build",
    executionTargetKey: "local",
    idempotencyKey: "op1",
    inputDigest: "d",
    status: "running",
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  operationEvents.mockReturnValue([
    { id: "e1", operationId: "op1", sequence: 1, type: "queued", createdAt: 1 },
    {
      id: "e2",
      operationId: "op1",
      sequence: 2,
      type: "claimed",
      message: "installing dependencies",
      createdAt: 2,
    },
  ])
  renderTab({ stepStates: { ...IDLE, build: "running" }, operations: [operation] })
  // Scoped to the operation actually in flight.
  expect(operationEvents).toHaveBeenCalledWith("op1")
  expect(screen.getByRole("status")).toHaveTextContent("installing dependencies")
})

it("carries the gate reason on every host-privileged control", () => {
  renderTab({ buildGate: blocked, previewGate: blocked })
  expect(screen.getByTestId("site-build")).toHaveAttribute("title", "Desktop only")
  expect(screen.getByTestId("site-start-preview")).toHaveAttribute("title", "Desktop only")
})

describe("provider token standing", () => {
  it("says a verified token is connected instead of leaving the step blank", () => {
    // The connect step used to derive its state from "does a provider resource
    // exist", so a Site whose token was saved and verified read as not started
    // until the first provision.
    renderTab({
      site: {
        ...site(),
        providerTokenState: {
          executionTargetKey: "local",
          status: "verified",
          verifiedAt: 1_699_999_000_000,
        },
      },
    })
    expect(screen.getByTestId("site-token-standing")).toHaveTextContent(
      "steps.connectState.verified"
    )
  })

  it("distinguishes a token saved on another machine from no token at all", () => {
    // The credential is real, it is just not here — a different instruction
    // from "you never saved one".
    renderTab({
      site: {
        ...site(),
        providerTokenState: { executionTargetKey: "other-host", status: "verified" },
      },
    })
    expect(screen.getByTestId("site-token-standing")).toHaveTextContent(
      "steps.connectState.other-host"
    )
  })

  it("says the provider rejected the stored token", () => {
    renderTab({
      site: {
        ...site(),
        providerTokenState: { executionTargetKey: "local", status: "rejected" },
      },
    })
    expect(screen.getByTestId("site-token-standing")).toHaveTextContent(
      "steps.connectState.rejected"
    )
  })

  it("says there is none yet", () => {
    renderTab()
    expect(screen.getByTestId("site-token-standing")).toHaveTextContent(
      "steps.connectState.missing"
    )
  })
})
