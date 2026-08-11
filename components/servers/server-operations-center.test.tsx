/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type {
  Operation,
  RecoveryPoint,
  ServerDetail,
  ServerLogEntry,
} from "@/lib/server-ops/client"
import { ServerOperationsCenter } from "./server-operations-center"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
  CodeBlockActions: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CodeBlockCopyButton: () => <button type="button">copy</button>,
  CodeBlockFilename: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  CodeBlockHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CodeBlockTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const server: ServerDetail = {
  id: "production",
  label: "Production",
  topology: "kubernetes",
  publicUrl: "https://server.example.com",
  health: "healthy",
  releaseDigest: `sha256:${"a".repeat(64)}`,
  lastSeenAt: "2026-08-01T10:00:00Z",
  targetRevision: 7,
  productionCertified: true,
  certificationIssues: [],
  capabilities: {
    topologies: ["compose", "kubernetes"],
    snapshotProviders: ["kubernetes-csi", "external-command", "none"],
    secretProviders: ["file", "kubernetes", "vault"],
    tlsProviders: ["ingress", "existing", "acme-http01", "acme-dns01"],
    objectStoreProtocols: ["s3-compatible"],
    requiresProviderCredentials: false,
  },
}

const recoveryPoint: RecoveryPoint = {
  id: "rp-1",
  serverId: server.id,
  createdAt: "2026-08-01T09:45:00Z",
  kind: "snapshot",
  manifestSha256: "abc",
  sizeBytes: 1024,
  verified: true,
}

const log: ServerLogEntry = {
  id: 1,
  serverId: server.id,
  timestamp: "2026-08-01T10:00:00Z",
  level: "info",
  component: "server",
  message: "ready",
}

const operation: Operation = {
  id: "op-1",
  targetId: server.id,
  kind: "backup",
  state: "executing",
  request: {},
  result: null,
  error: null,
  createdBy: "user",
  createdAt: "2026-08-01T10:00:00Z",
  updatedAt: "2026-08-01T10:01:00Z",
}

function renderCenter(
  overrides: Partial<React.ComponentProps<typeof ServerOperationsCenter>> = {}
) {
  const props: React.ComponentProps<typeof ServerOperationsCenter> = {
    servers: [server],
    selectedServer: server,
    backups: [recoveryPoint],
    logs: [log],
    operations: [operation],
    capabilities: server.capabilities,
    controllerUrl: "https://ops.example.com",
    targetId: "default",
    eventStreamConnected: true,
    offline: false,
    loading: false,
    onSelectServer: jest.fn(),
    onRefresh: jest.fn(),
    onDisconnect: jest.fn(),
    onBackup: jest.fn(),
    onRestore: jest.fn(),
    onRollback: jest.fn(),
    onRotateKey: jest.fn(),
    onValidateTarget: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  render(<ServerOperationsCenter {...props} />)
  return props
}

function selectTab(name: string) {
  const tab = screen.getAllByRole("tab", { name })[0]
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
  fireEvent.click(tab)
}

it("renders the complete operations workspace and persistent operation drawer", () => {
  renderCenter()

  expect(screen.getByRole("heading", { name: "title" })).toBeInTheDocument()
  expect(screen.getAllByText("Production").length).toBeGreaterThan(0)
  for (const tab of [
    "tabs.overview",
    "tabs.instances",
    "tabs.deployments",
    "tabs.backups",
    "tabs.logs",
    "tabs.security",
  ]) {
    expect(screen.getAllByRole("tab", { name: tab }).length).toBeGreaterThan(0)
  }
  expect(screen.getAllByLabelText("operations.ariaLabel")[0]).toHaveTextContent("executing")
})

it("runs safe operations directly and gates restore behind confirmation", () => {
  const props = renderCenter()
  fireEvent.click(screen.getAllByRole("button", { name: "actions.backup" })[0])
  expect(props.onBackup).toHaveBeenCalledWith("production")

  fireEvent.click(screen.getAllByRole("button", { name: "actions.restore" })[0])
  expect(screen.getByRole("alertdialog")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "confirm.confirm" }))
  expect(props.onRestore).toHaveBeenCalledWith("production", "rp-1")
})

it("requests rollback by target only after confirmation", () => {
  const props = renderCenter()
  selectTab("tabs.deployments")
  fireEvent.click(screen.getAllByRole("button", { name: "actions.rollback" })[0])
  fireEvent.click(screen.getByRole("button", { name: "confirm.confirm" }))
  expect(props.onRollback).toHaveBeenCalledWith("production")
})

it("opens a cloud-neutral deployment wizard with no raw credential fields", () => {
  renderCenter()
  fireEvent.click(screen.getByRole("button", { name: "actions.deploy" }))

  expect(screen.getByRole("dialog")).toBeInTheDocument()
  expect(screen.getByLabelText("wizard.controllerUrl")).toBeInTheDocument()
  expect(screen.getByLabelText("wizard.oidcIssuer")).toBeInTheDocument()
  expect(screen.getByLabelText("wizard.objectStoreEndpoint")).toBeInTheDocument()
  expect(screen.getByLabelText("wizard.objectStoreCredentialRef")).toBeInTheDocument()
  expect(screen.queryByLabelText(/access key|secret key|kubeconfig|ssh/i)).toBeNull()
})

it("selects, refreshes, and filters server cards", () => {
  const degraded = { ...server, id: "degraded", label: "Degraded", health: "degraded" as const }
  const props = renderCenter({ servers: [server, degraded] })

  fireEvent.click(screen.getByRole("button", { name: "actions.refresh" }))
  expect(props.onRefresh).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getAllByRole("button", { name: /Degraded/ })[0])
  expect(props.onSelectServer).toHaveBeenCalledWith("degraded")

  fireEvent.click(screen.getByRole("button", { name: "filters.title" }))
  fireEvent.click(screen.getByRole("button", { name: "health.degraded" }))
  expect(screen.queryAllByRole("button", { name: /Production/ })).toHaveLength(0)

  fireEvent.click(screen.getByRole("button", { name: "filters.all" }))
  fireEvent.click(screen.getByRole("button", { name: "Close" }))
  expect(screen.getAllByRole("button", { name: /Production/ }).length).toBeGreaterThan(0)
})

it("renders offline, loading, empty, and uncertified states", () => {
  const uncertified = {
    ...server,
    health: "unknown" as const,
    releaseDigest: null,
    lastSeenAt: null,
    productionCertified: false,
    certificationIssues: ["snapshot_missing"],
  }
  renderCenter({
    selectedServer: uncertified,
    servers: [uncertified],
    backups: [],
    logs: [],
    operations: [],
    offline: true,
    loading: true,
  })

  expect(screen.getByText("offline")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "actions.refresh" })).toBeDisabled()
  expect(screen.queryByLabelText("operations.ariaLabel")).toBeNull()
  expect(screen.getAllByText("snapshot_missing").length).toBeGreaterThan(0)

  selectTab("tabs.instances")
  expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  selectTab("tabs.deployments")
  expect(screen.queryByRole("button", { name: "actions.rollback" })).toBeNull()
  selectTab("tabs.backups")
  expect(screen.getAllByText("backups.empty").length).toBeGreaterThan(0)
  selectTab("tabs.logs")
  expect(screen.getAllByText("logs.empty").length).toBeGreaterThan(0)
})

it("renders reconnecting streams, unrestricted provider fallbacks, and large backups", () => {
  renderCenter({
    capabilities: null,
    eventStreamConnected: false,
    backups: [{ ...recoveryPoint, sizeBytes: 5 * 1024 ** 3 }],
  })

  expect(screen.getByText("connection.eventsReconnecting")).toBeInTheDocument()
  selectTab("tabs.backups")
  expect(screen.getByText(/5\.0 GiB/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "actions.deploy" }))
  expect(screen.getByRole("combobox", { name: "wizard.topology" })).toBeInTheDocument()
})

it("gates key rotation and all recovery point entry points", () => {
  const props = renderCenter()

  fireEvent.click(screen.getAllByRole("button", { name: "actions.restore" })[0])
  fireEvent.click(screen.getByRole("button", { name: "confirm.cancel" }))
  expect(props.onRestore).not.toHaveBeenCalled()

  selectTab("tabs.backups")
  fireEvent.click(screen.getAllByRole("button", { name: "actions.restore" })[0])
  fireEvent.click(screen.getByRole("button", { name: "confirm.confirm" }))
  expect(props.onRestore).toHaveBeenCalledWith("production", "rp-1")

  selectTab("tabs.security")
  const rotateButton = screen.getAllByRole("button", { name: "actions.rotateKey" })[0]
  expect(rotateButton).toBeDisabled()
  fireEvent.change(screen.getAllByLabelText("fields.keyVersion")[0], {
    target: { value: "key-2026-08" },
  })
  fireEvent.click(rotateButton)
  fireEvent.click(screen.getByRole("button", { name: "confirm.confirm" }))
  expect(props.onRotateKey).toHaveBeenCalledWith("production", "key-2026-08")
})

it("renders a selection prompt when no server is selected", () => {
  renderCenter({ selectedServer: null })
  expect(screen.getAllByText("selectServer").length).toBeGreaterThan(0)
})

it("builds a complete Kubernetes target from the deployment wizard", async () => {
  const onValidateTarget = jest.fn().mockResolvedValue(undefined)
  renderCenter({ onValidateTarget })
  fireEvent.click(screen.getByRole("button", { name: "actions.deploy" }))

  const fields: Record<string, string> = {
    "wizard.targetId": "production-eu",
    "wizard.label": "Production EU",
    "wizard.controllerUrl": "https://ops.example.com",
    "wizard.publicUrl": "https://server.example.com",
    "wizard.oidcIssuer": "https://auth.example.com/oidc",
    "wizard.oidcAudience": "https://server.example.com/api",
    "wizard.tenantClaim": "organization_id",
    "wizard.objectStoreEndpoint": "https://s3.example.com",
    "wizard.objectStoreRegion": "auto",
    "wizard.objectStoreBucket": "cognia-backups",
    "wizard.objectStoreCredentialRef": "backups/production-eu",
    "wizard.snapshotRef": "fast-snapshots",
    "wizard.secretRootRef": "cognia/production-eu",
    "wizard.tlsRef": "cognia-server-tls",
    "wizard.serverImage": `server@sha256:${"a".repeat(64)}`,
    "wizard.runnerImage": `runner@sha256:${"b".repeat(64)}`,
    "wizard.workspaceRuntimeImage": `runtime@sha256:${"c".repeat(64)}`,
    "wizard.namespace": "cognia-production-eu",
    "wizard.ingressClass": "nginx-public",
    "wizard.storageClass": "fast-rwo",
    "wizard.runtimeClass": "gvisor",
  }
  for (const [label, value] of Object.entries(fields)) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }
  fireEvent.submit(screen.getByRole("button", { name: "wizard.validate" }).closest("form")!)

  await waitFor(() => expect(onValidateTarget).toHaveBeenCalledTimes(1))
  expect(onValidateTarget).toHaveBeenCalledWith(
    expect.objectContaining({
      apiVersion: "deploy.cognia.dev/v1alpha1",
      kind: "DeploymentTarget",
      metadata: { id: "production-eu", label: "Production EU" },
      spec: expect.objectContaining({
        topology: "kubernetes",
        kubernetes: {
          namespace: "cognia-production-eu",
          ingressClassName: "nginx-public",
          storageClassName: "fast-rwo",
          runtimeClassName: "gvisor",
        },
        snapshots: { provider: "kubernetes-csi", className: "fast-snapshots" },
        tls: { provider: "ingress", secretRef: "cognia-server-tls" },
      }),
    })
  )
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
})

it("builds a Compose target with external snapshot and ACME DNS contracts", async () => {
  const user = userEvent.setup()
  const onValidateTarget = jest.fn().mockResolvedValue(undefined)
  renderCenter({ onValidateTarget })
  fireEvent.click(screen.getByRole("button", { name: "actions.deploy" }))

  await user.click(screen.getByRole("combobox", { name: "wizard.topology" }))
  await user.click(screen.getByRole("option", { name: "options.compose" }))
  await user.click(screen.getByRole("combobox", { name: "wizard.snapshotProvider" }))
  await user.click(screen.getByRole("option", { name: "options.external-command" }))
  await user.click(screen.getByRole("combobox", { name: "wizard.tlsProvider" }))
  await user.click(screen.getByRole("option", { name: "options.acme-dns01" }))
  fireEvent.change(screen.getByLabelText("wizard.snapshotRef"), {
    target: { value: "zfs-cognia" },
  })
  fireEvent.change(screen.getByLabelText("wizard.tlsRef"), {
    target: { value: "dns/provider" },
  })
  fireEvent.change(screen.getByLabelText("wizard.projectName"), {
    target: { value: "cognia-prod" },
  })
  fireEvent.change(screen.getByLabelText("wizard.deploymentRoot"), {
    target: { value: "/srv/cognia" },
  })
  for (const [label, value] of Object.entries({
    "wizard.label": "Production Compose",
    "wizard.controllerUrl": "https://ops.example.com",
    "wizard.publicUrl": "https://compose.example.com",
    "wizard.oidcIssuer": "https://auth.example.com/oidc",
    "wizard.oidcAudience": "https://compose.example.com/api",
    "wizard.objectStoreEndpoint": "https://s3.example.com",
    "wizard.serverImage": `server@sha256:${"a".repeat(64)}`,
    "wizard.runnerImage": `runner@sha256:${"b".repeat(64)}`,
    "wizard.workspaceRuntimeImage": `runtime@sha256:${"c".repeat(64)}`,
  })) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }
  fireEvent.submit(screen.getByRole("button", { name: "wizard.validate" }).closest("form")!)

  await waitFor(() => expect(onValidateTarget).toHaveBeenCalledTimes(1))
  expect(onValidateTarget.mock.calls[0][0].spec).toEqual(
    expect.objectContaining({
      topology: "compose",
      compose: { projectName: "cognia-prod", deploymentRoot: "/srv/cognia" },
      snapshots: { provider: "external-command", adapterRef: "zfs-cognia" },
      tls: { provider: "acme-dns01", credentialRef: "dns/provider" },
    })
  )
}, 15000)

it("exposes every deployment contract field and applies advanced values", async () => {
  const user = userEvent.setup()
  const onValidateTarget = jest.fn().mockResolvedValue(undefined)
  renderCenter({ onValidateTarget })
  fireEvent.click(screen.getByRole("button", { name: "actions.deploy" }))

  for (const label of [
    "wizard.controllerCredentialRef",
    "wizard.scopeRead",
    "wizard.scopeOperate",
    "wizard.scopeAdmin",
    "wizard.objectStorePathStyle",
  ]) {
    expect(screen.getByLabelText(label)).toBeInTheDocument()
  }

  fireEvent.change(screen.getByLabelText("wizard.controllerCredentialRef"), {
    target: { value: "controllers/production" },
  })
  fireEvent.change(screen.getByLabelText("wizard.scopeRead"), {
    target: { value: "fleet:read" },
  })
  await user.click(screen.getByRole("switch", { name: "wizard.objectStorePathStyle" }))
  await user.click(screen.getByRole("combobox", { name: "wizard.snapshotProvider" }))
  await user.click(screen.getByRole("option", { name: "options.none" }))

  expect(screen.queryByLabelText("wizard.snapshotRef")).not.toBeInTheDocument()
})

it("offers a strict JSON/YAML custom target editor without credential values", async () => {
  renderCenter()
  fireEvent.click(screen.getByRole("button", { name: "actions.deploy" }))
  fireEvent.mouseDown(screen.getByRole("tab", { name: "wizard.custom" }), {
    button: 0,
    ctrlKey: false,
  })
  fireEvent.click(screen.getByRole("tab", { name: "wizard.custom" }))

  expect(screen.getByLabelText("editorLabel")).toBeInTheDocument()
  expect(screen.getByText("import")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "download" })).toBeInTheDocument()
  expect((screen.getByLabelText("editorLabel") as HTMLTextAreaElement).value).not.toMatch(
    /accessToken|secretKey|kubeconfig/i
  )
})

it("round-trips a complete custom target into the guided deployment contract", async () => {
  const user = userEvent.setup()
  const onValidateTarget = jest.fn().mockResolvedValue(undefined)
  renderCenter({ onValidateTarget })
  fireEvent.click(screen.getByRole("button", { name: "actions.deploy" }))
  fireEvent.mouseDown(screen.getByRole("tab", { name: "wizard.custom" }), {
    button: 0,
    ctrlKey: false,
  })
  fireEvent.click(screen.getByRole("tab", { name: "wizard.custom" }))

  const target = {
    apiVersion: "deploy.cognia.dev/v1alpha1",
    kind: "DeploymentTarget",
    metadata: { id: "custom-compose", label: "Custom Compose" },
    spec: {
      topology: "compose",
      compose: { projectName: "custom", deploymentRoot: "/srv/custom" },
      controller: { url: "https://ops.example.com", credentialRef: "controllers/custom" },
      publicUrl: "https://custom.example.com",
      identity: {
        provider: "oidc",
        issuer: "https://auth.example.com/oidc",
        audience: "https://custom.example.com/api",
        tenantClaim: "organization_id",
        scopes: { read: "servers:read", operate: "servers:operate", admin: "servers:admin" },
      },
      objectStore: {
        provider: "s3-compatible",
        endpoint: "https://s3.example.com",
        region: "auto",
        bucket: "custom-backups",
        pathStyle: true,
        credentialRef: "backups/custom",
      },
      snapshots: { provider: "none" },
      tls: { provider: "acme-http01" },
      secrets: { provider: "vault", rootRef: "cognia/custom" },
      images: {
        server: `server@sha256:${"a".repeat(64)}`,
        runner: `runner@sha256:${"b".repeat(64)}`,
        workspaceRuntime: `runtime@sha256:${"c".repeat(64)}`,
      },
    },
  }
  fireEvent.change(screen.getByLabelText("editorLabel"), {
    target: { value: JSON.stringify(target) },
  })
  await user.click(screen.getByRole("button", { name: "apply" }))

  const kubernetesTarget = {
    ...target,
    metadata: { id: "custom-kubernetes", label: "Custom Kubernetes" },
    spec: {
      ...target.spec,
      topology: "kubernetes",
      compose: undefined,
      kubernetes: {
        namespace: "custom",
        ingressClassName: "nginx",
        storageClassName: "fast-rwo",
      },
      snapshots: { provider: "kubernetes-csi", className: "fast-snapshots" },
      tls: { provider: "ingress", secretRef: "custom-tls" },
    },
  }
  await waitFor(() =>
    expect((screen.getByLabelText("editorLabel") as HTMLTextAreaElement).value).toContain(
      "custom-compose"
    )
  )
  fireEvent.change(screen.getByLabelText("editorLabel"), {
    target: { value: JSON.stringify(kubernetesTarget) },
  })
  await user.click(screen.getByRole("button", { name: "apply" }))
  fireEvent.submit(screen.getByRole("button", { name: "wizard.validate" }).closest("form")!)

  await waitFor(() => expect(onValidateTarget).toHaveBeenCalledWith(kubernetesTarget))
})

it("keeps the deployment wizard open and reports non-Error validation failures", async () => {
  const onValidateTarget = jest.fn().mockRejectedValue("invalid target")
  renderCenter({ onValidateTarget })
  fireEvent.click(screen.getByRole("button", { name: "actions.deploy" }))
  fireEvent.submit(screen.getByRole("button", { name: "wizard.validate" }).closest("form")!)

  expect(await screen.findByText("wizard.invalid")).toBeInTheDocument()
  expect(screen.getByRole("dialog")).toBeInTheDocument()
})

it("disconnects the controller from the workspace header", () => {
  const props = renderCenter()
  fireEvent.click(screen.getByRole("button", { name: "connection.disconnect" }))
  expect(props.onDisconnect).toHaveBeenCalledTimes(1)
})
