"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArchiveRestoreIcon,
  BoxesIcon,
  CloudCogIcon,
  DatabaseBackupIcon,
  FilterIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  RocketIcon,
  RotateCcwIcon,
  ServerIcon,
  ShieldCheckIcon,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type {
  Operation,
  RecoveryPoint,
  ServerDetail,
  ServerHealth,
  ServerLogEntry,
} from "@/lib/server-ops/client"
import type { DeploymentTarget } from "@/lib/server-ops/deployment-target"
import { cn } from "@/lib/utils"

export interface ServerOperationsCenterProps {
  servers: ServerDetail[]
  selectedServer: ServerDetail | null
  backups: RecoveryPoint[]
  logs: ServerLogEntry[]
  operations: Operation[]
  offline: boolean
  loading: boolean
  onSelectServer: (id: string) => void
  onRefresh: () => void
  onBackup: (id: string) => void
  onRestore: (id: string, recoveryPointId: string) => void
  onRollback: (id: string) => void
  onRotateKey: (id: string, keyVersion: string) => void
  onValidateTarget: (target: DeploymentTarget) => Promise<void>
}

type Confirmation =
  | { kind: "restore"; recoveryPointId: string }
  | { kind: "rollback" }
  | { kind: "rotate-key"; keyVersion: string }

const HEALTHS: ServerHealth[] = ["healthy", "degraded", "unavailable", "unknown"]

export function ServerOperationsCenter(props: ServerOperationsCenterProps) {
  const t = useTranslations("servers")
  const [deploymentOpen, setDeploymentOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [healthFilter, setHealthFilter] = useState<ServerHealth | "all">("all")
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const filteredServers = useMemo(
    () =>
      healthFilter === "all"
        ? props.servers
        : props.servers.filter((server) => server.health === healthFilter),
    [healthFilter, props.servers]
  )
  const healthy = props.servers.filter((server) => server.health === "healthy").length
  const certified = props.servers.filter((server) => server.productionCertified).length
  const activeOperations = props.operations.filter(
    (operation) =>
      !["succeeded", "failed", "rolled_back", "rollback_failed", "cancelled"].includes(
        operation.state
      )
  ).length

  const confirmOperation = () => {
    const server = props.selectedServer
    if (!server || !confirmation) return
    if (confirmation.kind === "restore") props.onRestore(server.id, confirmation.recoveryPointId)
    if (confirmation.kind === "rollback") props.onRollback(server.id)
    if (confirmation.kind === "rotate-key") props.onRotateKey(server.id, confirmation.keyVersion)
    setConfirmation(null)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b bg-background/95 px-4 py-3 backdrop-blur md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
          </div>
          <div className="flex items-center gap-2">
            {props.offline && <Badge variant="outline">{t("offline")}</Badge>}
            <Button variant="outline" size="sm" onClick={props.onRefresh} disabled={props.loading}>
              <RefreshCwIcon className={cn("size-4", props.loading && "animate-spin")} />
              {t("actions.refresh")}
            </Button>
            <Button size="sm" onClick={() => setDeploymentOpen(true)}>
              <RocketIcon className="size-4" />
              {t("actions.deploy")}
            </Button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Kpi label={t("kpi.total")} value={props.servers.length} icon={ServerIcon} />
          <Kpi label={t("kpi.healthy")} value={healthy} icon={ShieldCheckIcon} />
          <Kpi label={t("kpi.certified")} value={certified} icon={CloudCogIcon} />
          <Kpi label={t("kpi.operations")} value={activeOperations} icon={BoxesIcon} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-hidden">
          <div className="hidden h-full lg:block">
            <ResizablePanelGroup orientation="horizontal">
              <ResizablePanel defaultSize={30} minSize={22} maxSize={45}>
                <ServerList
                  servers={filteredServers}
                  selectedId={props.selectedServer?.id ?? null}
                  onSelect={props.onSelectServer}
                />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={70} minSize={45}>
                <ServerWorkspace {...props} onConfirm={setConfirmation} />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>

          <ScrollArea className="h-full lg:hidden">
            <div className="space-y-3 p-3 md:p-4">
              <div className="sticky top-0 z-10 flex items-center justify-between rounded-lg border bg-background/95 p-2 backdrop-blur md:static">
                <span className="text-sm font-medium">
                  {props.selectedServer
                    ? t("healthSummary", { label: props.selectedServer.label })
                    : t("selectServer")}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="md:hidden"
                  onClick={() => setFilterOpen(true)}
                >
                  <FilterIcon className="size-4" />
                  {t("filters.title")}
                </Button>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {filteredServers.map((server) => (
                  <ServerCard
                    key={server.id}
                    server={server}
                    selected={server.id === props.selectedServer?.id}
                    onSelect={() => props.onSelectServer(server.id)}
                  />
                ))}
              </div>
              <div className="min-h-[34rem] rounded-xl border bg-card">
                <ServerWorkspace {...props} onConfirm={setConfirmation} />
              </div>
            </div>
          </ScrollArea>
        </main>

        {props.operations.length > 0 && (
          <aside
            aria-label={t("operations.ariaLabel")}
            className="hidden w-72 shrink-0 border-l bg-muted/20 xl:flex xl:flex-col"
          >
            <div className="border-b px-4 py-3 text-sm font-semibold">{t("operations.title")}</div>
            <ScrollArea className="flex-1">
              <div className="space-y-2 p-3">
                {props.operations.map((operation) => (
                  <OperationRow key={operation.id} operation={operation} />
                ))}
              </div>
            </ScrollArea>
          </aside>
        )}
      </div>

      {props.operations.length > 0 && (
        <aside
          aria-label={t("operations.ariaLabel")}
          className="flex max-h-28 shrink-0 gap-2 overflow-x-auto border-t bg-background p-2 xl:hidden"
        >
          {props.operations.map((operation) => (
            <OperationRow key={operation.id} operation={operation} compact />
          ))}
        </aside>
      )}

      <DeploymentWizard
        open={deploymentOpen}
        onOpenChange={setDeploymentOpen}
        onValidate={props.onValidateTarget}
      />
      <FilterSheet
        open={filterOpen}
        onOpenChange={setFilterOpen}
        value={healthFilter}
        onChange={setHealthFilter}
      />
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => !open && setConfirmation(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirm.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmOperation}>{t("confirm.confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Kpi({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number
  icon: typeof ServerIcon
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
      <div className="rounded-md bg-primary/10 p-2 text-primary">
        <Icon className="size-4" />
      </div>
      <div>
        <div className="text-lg font-semibold leading-none">{value}</div>
        <div className="mt-1 text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}

function ServerList({
  servers,
  selectedId,
  onSelect,
}: {
  servers: ServerDetail[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const t = useTranslations("servers")
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3 text-sm font-semibold">{t("instances.title")}</div>
      <ScrollArea className="flex-1">
        <div className="space-y-2 p-3">
          {servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              selected={server.id === selectedId}
              onSelect={() => onSelect(server.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function ServerCard({
  server,
  selected,
  onSelect,
}: {
  server: ServerDetail
  selected: boolean
  onSelect: () => void
}) {
  const t = useTranslations("servers")
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/60",
        selected && "border-primary bg-primary/5"
      )}
      aria-current={selected ? "true" : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{server.label}</span>
        <Badge variant={server.health === "healthy" ? "default" : "secondary"}>
          {t(`health.${server.health}`)}
        </Badge>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{t(`topology.${server.topology}`)}</span>
        <span>{server.id}</span>
      </div>
    </button>
  )
}

function ServerWorkspace(
  props: ServerOperationsCenterProps & { onConfirm: (confirmation: Confirmation) => void }
) {
  const t = useTranslations("servers")
  const [keyVersion, setKeyVersion] = useState("")
  const server = props.selectedServer
  if (!server)
    return (
      <div className="grid h-full place-items-center p-8 text-sm text-muted-foreground">
        {t("selectServer")}
      </div>
    )
  return (
    <Tabs defaultValue="overview" className="flex h-full min-h-0 flex-col gap-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <div className="font-semibold">{server.label}</div>
          <div className="text-xs text-muted-foreground">{server.publicUrl}</div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => props.onBackup(server.id)}>
            <DatabaseBackupIcon className="size-4" />
            {t("actions.backup")}
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto border-b px-3">
        <TabsList variant="line" className="min-w-max">
          {(["overview", "instances", "deployments", "backups", "logs", "security"] as const).map(
            (tab) => (
              <TabsTrigger key={tab} value={tab}>
                {t(`tabs.${tab}`)}
              </TabsTrigger>
            )
          )}
        </TabsList>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <TabsContent value="overview" className="space-y-4 p-4">
          <Overview
            server={server}
            latestBackup={props.backups[0] ?? null}
            onRestore={(recoveryPointId) => props.onConfirm({ kind: "restore", recoveryPointId })}
          />
        </TabsContent>
        <TabsContent value="instances" className="p-4">
          <KeyValueGrid
            items={[
              [t("fields.id"), server.id],
              [t("fields.topology"), t(`topology.${server.topology}`)],
              [t("fields.revision"), String(server.targetRevision)],
              [t("fields.lastSeen"), formatDate(server.lastSeenAt)],
            ]}
          />
        </TabsContent>
        <TabsContent value="deployments" className="space-y-3 p-4">
          <KeyValueGrid
            items={[
              [t("fields.release"), server.releaseDigest ?? t("notAvailable")],
              [
                t("fields.certification"),
                server.productionCertified ? t("certified") : t("notCertified"),
              ],
            ]}
          />
          {server.releaseDigest && (
            <Button variant="outline" onClick={() => props.onConfirm({ kind: "rollback" })}>
              <RotateCcwIcon className="size-4" />
              {t("actions.rollback")}
            </Button>
          )}
        </TabsContent>
        <TabsContent value="backups" className="space-y-2 p-4">
          {props.backups.length === 0 ? (
            <Empty text={t("backups.empty")} />
          ) : (
            props.backups.map((backup) => (
              <Card key={backup.id}>
                <CardContent className="flex items-center justify-between gap-3 p-3">
                  <div>
                    <div className="text-sm font-medium">{backup.id}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatDate(backup.createdAt)} · {formatBytes(backup.sizeBytes)}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => props.onConfirm({ kind: "restore", recoveryPointId: backup.id })}
                  >
                    <ArchiveRestoreIcon className="size-4" />
                    {t("actions.restore")}
                  </Button>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
        <TabsContent value="logs" className="p-4">
          {props.logs.length === 0 ? (
            <Empty text={t("logs.empty")} />
          ) : (
            <div className="space-y-1 font-mono text-xs">
              {props.logs.map((entry) => (
                <div
                  key={entry.id}
                  className="grid grid-cols-[auto_auto_1fr] gap-2 rounded border px-2 py-1.5"
                >
                  <span className="text-muted-foreground">{formatDate(entry.timestamp)}</span>
                  <Badge variant="outline">{entry.level}</Badge>
                  <span className="break-all">
                    [{entry.component}] {entry.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="security" className="space-y-4 p-4">
          <KeyValueGrid
            items={[
              [
                t("fields.certification"),
                server.productionCertified ? t("certified") : t("notCertified"),
              ],
              [t("fields.snapshotProviders"), server.capabilities.snapshotProviders.join(", ")],
              [t("fields.secretProviders"), server.capabilities.secretProviders.join(", ")],
            ]}
          />
          <TextField
            label={t("fields.keyVersion")}
            value={keyVersion}
            placeholder={t("wizard.placeholders.keyVersion")}
            onChange={setKeyVersion}
          />
          <Button
            variant="outline"
            disabled={!keyVersion.trim()}
            onClick={() => props.onConfirm({ kind: "rotate-key", keyVersion: keyVersion.trim() })}
          >
            <KeyRoundIcon className="size-4" />
            {t("actions.rotateKey")}
          </Button>
        </TabsContent>
      </ScrollArea>
    </Tabs>
  )
}

function Overview({
  server,
  latestBackup,
  onRestore,
}: {
  server: ServerDetail
  latestBackup: RecoveryPoint | null
  onRestore: (recoveryPointId: string) => void
}) {
  const t = useTranslations("servers")
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("overview.health")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge>{t(`health.${server.health}`)}</Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("overview.production")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={server.productionCertified ? "default" : "secondary"}>
              {server.productionCertified ? t("certified") : t("notCertified")}
            </Badge>
          </CardContent>
        </Card>
      </div>
      {latestBackup && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("overview.latestRecoveryPoint")}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">{latestBackup.id}</div>
              <div className="text-xs text-muted-foreground">
                {formatDate(latestBackup.createdAt)}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => onRestore(latestBackup.id)}>
              <ArchiveRestoreIcon className="size-4" />
              {t("actions.restore")}
            </Button>
          </CardContent>
        </Card>
      )}
      {server.certificationIssues.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("overview.issues")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              {server.certificationIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  )
}

function KeyValueGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border p-3">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-all text-sm font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}
function OperationRow({ operation, compact = false }: { operation: Operation; compact?: boolean }) {
  const t = useTranslations("servers")
  return (
    <div className={cn("rounded-lg border bg-card p-3", compact && "min-w-56")}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t(`operationKinds.${operation.kind}`)}</span>
        <Badge variant="outline">{t(`operationStates.${operation.state}`)}</Badge>
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{operation.targetId}</div>
    </div>
  )
}

function FilterSheet({
  open,
  onOpenChange,
  value,
  onChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: ServerHealth | "all"
  onChange: (value: ServerHealth | "all") => void
}) {
  const t = useTranslations("servers")
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>{t("filters.title")}</SheetTitle>
          <SheetDescription>{t("filters.description")}</SheetDescription>
        </SheetHeader>
        <div className="grid grid-cols-2 gap-2 px-4 pb-6">
          <Button variant={value === "all" ? "default" : "outline"} onClick={() => onChange("all")}>
            {t("filters.all")}
          </Button>
          {HEALTHS.map((health) => (
            <Button
              key={health}
              variant={value === health ? "default" : "outline"}
              onClick={() => onChange(health)}
            >
              {t(`health.${health}`)}
            </Button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}

interface WizardState {
  id: string
  label: string
  topology: "compose" | "kubernetes"
  controllerUrl: string
  publicUrl: string
  oidcIssuer: string
  oidcAudience: string
  tenantClaim: string
  objectStoreEndpoint: string
  objectStoreRegion: string
  objectStoreBucket: string
  objectStoreCredentialRef: string
  snapshotProvider: "kubernetes-csi" | "external-command"
  snapshotRef: string
  secretProvider: "file" | "kubernetes" | "vault" | "aws-secrets-manager"
  secretRootRef: string
  tlsProvider: "ingress" | "existing" | "acme-http01" | "acme-dns01"
  tlsRef: string
  serverImage: string
  runnerImage: string
  workspaceRuntimeImage: string
  namespace: string
  ingressClassName: string
  storageClassName: string
  runtimeClassName: string
  projectName: string
  deploymentRoot: string
}
const INITIAL_WIZARD: WizardState = {
  id: "staging",
  label: "",
  topology: "kubernetes",
  controllerUrl: "",
  publicUrl: "",
  oidcIssuer: "",
  oidcAudience: "",
  tenantClaim: "organization_id",
  objectStoreEndpoint: "",
  objectStoreRegion: "auto",
  objectStoreBucket: "cognia-backups",
  objectStoreCredentialRef: "backups/staging",
  snapshotProvider: "kubernetes-csi",
  snapshotRef: "cognia-snapshots",
  secretProvider: "kubernetes",
  secretRootRef: "cognia/staging",
  tlsProvider: "ingress",
  tlsRef: "cognia-server-tls",
  serverImage: "",
  runnerImage: "",
  workspaceRuntimeImage: "",
  namespace: "cognia-staging",
  ingressClassName: "nginx",
  storageClassName: "standard",
  runtimeClassName: "",
  projectName: "cognia",
  deploymentRoot: "/opt/cognia",
}

function DeploymentWizard({
  open,
  onOpenChange,
  onValidate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onValidate: (target: DeploymentTarget) => Promise<void>
}) {
  const t = useTranslations("servers")
  const [state, setState] = useState(INITIAL_WIZARD)
  const [submitting, setSubmitting] = useState(false)
  const update = (key: keyof WizardState, value: string) =>
    setState((current) => ({ ...current, [key]: value }))
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      await onValidate(buildDeploymentTarget(state))
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }
  const textFields: Array<[keyof WizardState, string, string]> = [
    ["id", "wizard.targetId", "wizard.placeholders.targetId"],
    ["label", "wizard.label", "wizard.placeholders.label"],
    ["controllerUrl", "wizard.controllerUrl", "wizard.placeholders.controllerUrl"],
    ["publicUrl", "wizard.publicUrl", "wizard.placeholders.publicUrl"],
    ["oidcIssuer", "wizard.oidcIssuer", "wizard.placeholders.oidcIssuer"],
    ["oidcAudience", "wizard.oidcAudience", "wizard.placeholders.oidcAudience"],
    ["tenantClaim", "wizard.tenantClaim", "wizard.placeholders.tenantClaim"],
    [
      "objectStoreEndpoint",
      "wizard.objectStoreEndpoint",
      "wizard.placeholders.objectStoreEndpoint",
    ],
    ["objectStoreRegion", "wizard.objectStoreRegion", "wizard.placeholders.objectStoreRegion"],
    ["objectStoreBucket", "wizard.objectStoreBucket", "wizard.placeholders.objectStoreBucket"],
    [
      "objectStoreCredentialRef",
      "wizard.objectStoreCredentialRef",
      "wizard.placeholders.objectStoreCredentialRef",
    ],
    ["snapshotRef", "wizard.snapshotRef", "wizard.placeholders.snapshotRef"],
    ["secretRootRef", "wizard.secretRootRef", "wizard.placeholders.secretRootRef"],
    ["tlsRef", "wizard.tlsRef", "wizard.placeholders.tlsRef"],
    ["serverImage", "wizard.serverImage", "wizard.placeholders.serverImage"],
    ["runnerImage", "wizard.runnerImage", "wizard.placeholders.runnerImage"],
    [
      "workspaceRuntimeImage",
      "wizard.workspaceRuntimeImage",
      "wizard.placeholders.workspaceRuntimeImage",
    ],
  ]
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{t("wizard.title")}</SheetTitle>
          <SheetDescription>{t("wizard.description")}</SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="space-y-5 px-4 pb-8">
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">{t("wizard.targetSection")}</legend>
            <SelectField
              label={t("wizard.topology")}
              value={state.topology}
              onChange={(value) => update("topology", value)}
              options={["compose", "kubernetes"]}
              t={t}
            />
            {textFields.slice(0, 4).map(([key, label, placeholder]) => (
              <TextField
                key={key}
                label={t(label)}
                value={state[key]}
                placeholder={t(placeholder)}
                onChange={(value) => update(key, value)}
              />
            ))}
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">{t("wizard.identitySection")}</legend>
            {textFields.slice(4, 7).map(([key, label, placeholder]) => (
              <TextField
                key={key}
                label={t(label)}
                value={state[key]}
                placeholder={t(placeholder)}
                onChange={(value) => update(key, value)}
              />
            ))}
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">{t("wizard.storageSection")}</legend>
            {textFields.slice(7, 11).map(([key, label, placeholder]) => (
              <TextField
                key={key}
                label={t(label)}
                value={state[key]}
                placeholder={t(placeholder)}
                onChange={(value) => update(key, value)}
              />
            ))}
            <SelectField
              label={t("wizard.snapshotProvider")}
              value={state.snapshotProvider}
              onChange={(value) => update("snapshotProvider", value)}
              options={["kubernetes-csi", "external-command"]}
              t={t}
            />
            <TextField
              label={t("wizard.snapshotRef")}
              value={state.snapshotRef}
              onChange={(value) => update("snapshotRef", value)}
            />
            <SelectField
              label={t("wizard.secretProvider")}
              value={state.secretProvider}
              onChange={(value) => update("secretProvider", value)}
              options={["file", "kubernetes", "vault", "aws-secrets-manager"]}
              t={t}
            />
            <TextField
              label={t("wizard.secretRootRef")}
              value={state.secretRootRef}
              onChange={(value) => update("secretRootRef", value)}
            />
            <SelectField
              label={t("wizard.tlsProvider")}
              value={state.tlsProvider}
              onChange={(value) => update("tlsProvider", value)}
              options={["ingress", "existing", "acme-http01", "acme-dns01"]}
              t={t}
            />
            <TextField
              label={t("wizard.tlsRef")}
              value={state.tlsRef}
              onChange={(value) => update("tlsRef", value)}
            />
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">{t("wizard.platformSection")}</legend>
            {state.topology === "kubernetes" ? (
              <>
                {[
                  ["namespace", "wizard.namespace"],
                  ["ingressClassName", "wizard.ingressClass"],
                  ["storageClassName", "wizard.storageClass"],
                  ["runtimeClassName", "wizard.runtimeClass"],
                ].map(([key, label]) => (
                  <TextField
                    key={key}
                    label={t(label)}
                    value={state[key as keyof WizardState]}
                    onChange={(value) => update(key as keyof WizardState, value)}
                  />
                ))}
              </>
            ) : (
              <>
                {[
                  ["projectName", "wizard.projectName"],
                  ["deploymentRoot", "wizard.deploymentRoot"],
                ].map(([key, label]) => (
                  <TextField
                    key={key}
                    label={t(label)}
                    value={state[key as keyof WizardState]}
                    onChange={(value) => update(key as keyof WizardState, value)}
                  />
                ))}
              </>
            )}
          </fieldset>
          <fieldset className="grid gap-3">
            <legend className="mb-2 text-sm font-semibold">{t("wizard.imagesSection")}</legend>
            {textFields.slice(14).map(([key, label, placeholder]) => (
              <TextField
                key={key}
                label={t(label)}
                value={state[key]}
                placeholder={t(placeholder)}
                onChange={(value) => update(key, value)}
              />
            ))}
          </fieldset>
          <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            {t("wizard.credentialsNotice")}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("wizard.cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("wizard.validating") : t("wizard.validate")}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  const id = `server-field-${label.replace(/\W/g, "-")}`
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}
function SelectField({
  label,
  value,
  onChange,
  options,
  t,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: string[]
  t: ReturnType<typeof useTranslations>
}) {
  const id = `server-select-${label.replace(/\W/g, "-")}`
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        wrapperClassName="w-full"
      >
        {options.map((option) => (
          <NativeSelectOption key={option} value={option}>
            {t(`options.${option}`)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  )
}

function buildDeploymentTarget(state: WizardState): DeploymentTarget {
  const tls =
    state.tlsProvider === "ingress" || state.tlsProvider === "existing"
      ? { provider: state.tlsProvider, secretRef: state.tlsRef }
      : state.tlsProvider === "acme-dns01"
        ? { provider: state.tlsProvider, credentialRef: state.tlsRef }
        : { provider: state.tlsProvider }
  const snapshots =
    state.snapshotProvider === "kubernetes-csi"
      ? { provider: state.snapshotProvider, className: state.snapshotRef }
      : { provider: state.snapshotProvider, adapterRef: state.snapshotRef }
  const target = {
    apiVersion: "deploy.cognia.dev/v1alpha1",
    kind: "DeploymentTarget",
    metadata: { id: state.id, label: state.label },
    spec: {
      topology: state.topology,
      publicUrl: state.publicUrl,
      ...(state.topology === "kubernetes"
        ? {
            kubernetes: {
              namespace: state.namespace,
              ingressClassName: state.ingressClassName,
              storageClassName: state.storageClassName,
              ...(state.runtimeClassName ? { runtimeClassName: state.runtimeClassName } : {}),
            },
          }
        : { compose: { projectName: state.projectName, deploymentRoot: state.deploymentRoot } }),
      controller: { url: state.controllerUrl, credentialRef: `ops-controller/${state.id}` },
      identity: {
        provider: "oidc",
        issuer: state.oidcIssuer,
        audience: state.oidcAudience,
        tenantClaim: state.tenantClaim,
        scopes: { read: "servers:read", operate: "servers:operate", admin: "servers:admin" },
      },
      objectStore: {
        provider: "s3-compatible",
        endpoint: state.objectStoreEndpoint,
        region: state.objectStoreRegion,
        bucket: state.objectStoreBucket,
        pathStyle: false,
        credentialRef: state.objectStoreCredentialRef,
      },
      snapshots,
      tls,
      secrets: { provider: state.secretProvider, rootRef: state.secretRootRef },
      images: {
        server: state.serverImage,
        runner: state.runnerImage,
        workspaceRuntime: state.workspaceRuntimeImage,
      },
    },
  }
  return target as DeploymentTarget
}

function formatDate(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value)
      )
    : "—"
}
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(1)} GiB`
}
