"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  BoxesIcon,
  CloudCogIcon,
  DatabaseBackupIcon,
  FilterIcon,
  KeyRoundIcon,
  LogOutIcon,
  RefreshCwIcon,
  RocketIcon,
  RotateCcwIcon,
  ServerIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Message, MessageContent } from "@/components/ai-elements/message"
import { StructuredConfigEditor } from "@/components/common/structured-config-editor"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Empty as EmptyState, EmptyDescription } from "@/components/ui/empty"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import type {
  Operation,
  ProviderCapabilities,
  RecoveryPoint,
  ServerDetail,
  ServerHealth,
  ServerLogEntry,
} from "@/lib/server-ops/client"
import { parseDeploymentTarget, type DeploymentTarget } from "@/lib/server-ops/deployment-target"
import { cn } from "@/lib/utils"

export interface ServerOperationsCenterProps {
  servers: ServerDetail[]
  selectedServer: ServerDetail | null
  backups: RecoveryPoint[]
  logs: ServerLogEntry[]
  operations: Operation[]
  capabilities: ProviderCapabilities | null
  controllerUrl: string
  targetId: string
  eventStreamConnected: boolean
  offline: boolean
  loading: boolean
  onSelectServer: (id: string) => void
  onRefresh: () => void
  onDisconnect: () => void
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
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
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
  const selectServer = (id: string) => {
    props.onSelectServer(id)
    setMobileDetailOpen(true)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b bg-background/95 px-4 py-3 backdrop-blur md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{props.controllerUrl}</span>
              <Separator orientation="vertical" className="h-3" />
              <span>{props.targetId}</span>
              <Badge variant="outline">
                {props.eventStreamConnected
                  ? t("connection.eventsConnected")
                  : t("connection.eventsReconnecting")}
              </Badge>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {props.offline && <Badge variant="outline">{t("offline")}</Badge>}
            <Button variant="outline" size="sm" onClick={() => setFilterOpen(true)}>
              <FilterIcon className="size-4" />
              {t("filters.title")}
            </Button>
            <Button variant="outline" size="sm" onClick={props.onRefresh} disabled={props.loading}>
              <RefreshCwIcon className={cn("size-4", props.loading && "animate-spin")} />
              {t("actions.refresh")}
            </Button>
            <Button size="sm" onClick={() => setDeploymentOpen(true)}>
              <RocketIcon className="size-4" />
              {t("actions.deploy")}
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onDisconnect}>
              <LogOutIcon className="size-4" />
              {t("connection.disconnect")}
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
                  onSelect={selectServer}
                />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={70} minSize={45}>
                <ServerWorkspace {...props} onConfirm={setConfirmation} />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>

          <ScrollArea className="h-full lg:hidden">
            <div className="p-3 md:p-4">
              {mobileDetailOpen ? (
                <div className="min-h-[34rem]">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mb-2"
                    onClick={() => setMobileDetailOpen(false)}
                  >
                    <ArrowLeftIcon className="size-4" />
                    {t("actions.backToServers")}
                  </Button>
                  <ServerWorkspace {...props} onConfirm={setConfirmation} />
                </div>
              ) : (
                <>
                  <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/95 p-2 backdrop-blur md:static">
                    <span className="text-sm font-medium">
                      {props.selectedServer
                        ? t("healthSummary", { label: props.selectedServer.label })
                        : t("selectServer")}
                    </span>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {filteredServers.map((server) => (
                      <ServerCard
                        key={server.id}
                        server={server}
                        selected={server.id === props.selectedServer?.id}
                        onSelect={() => selectServer(server.id)}
                      />
                    ))}
                  </div>
                </>
              )}
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
        capabilities={props.capabilities}
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
    <div className="flex items-center gap-3 border-l px-3 py-2 first:border-l-0">
      <div className="text-primary">
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
        <ItemGroup className="p-2">
          {servers.map((server) => (
            <div key={server.id}>
              <ServerCard
                server={server}
                selected={server.id === selectedId}
                onSelect={() => onSelect(server.id)}
              />
              <ItemSeparator />
            </div>
          ))}
        </ItemGroup>
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
    <Item asChild size="sm" className={cn("rounded-none", selected && "bg-primary/5")}>
      <Button
        type="button"
        variant="ghost"
        onClick={onSelect}
        className="h-auto w-full justify-start whitespace-normal px-3 py-3 text-left"
        aria-current={selected ? "true" : undefined}
      >
        <ItemContent>
          <ItemTitle>{server.label}</ItemTitle>
          <ItemDescription>
            {t(`topology.${server.topology}`)} · {server.id}
          </ItemDescription>
        </ItemContent>
        <Badge variant={server.health === "healthy" ? "default" : "secondary"}>
          {t(`health.${server.health}`)}
        </Badge>
      </Button>
    </Item>
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
            <ItemGroup className="border-y">
              {props.backups.map((backup, index) => (
                <div key={backup.id}>
                  <Item className="rounded-none px-0">
                    <ItemContent>
                      <ItemTitle>{backup.id}</ItemTitle>
                      <ItemDescription>
                        {formatDate(backup.createdAt)} · {formatBytes(backup.sizeBytes)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          props.onConfirm({ kind: "restore", recoveryPointId: backup.id })
                        }
                      >
                        <ArchiveRestoreIcon className="size-4" />
                        {t("actions.restore")}
                      </Button>
                    </ItemActions>
                  </Item>
                  {index < props.backups.length - 1 && <ItemSeparator />}
                </div>
              ))}
            </ItemGroup>
          )}
        </TabsContent>
        <TabsContent value="logs" className="p-4">
          {props.logs.length === 0 ? (
            <Empty text={t("logs.empty")} />
          ) : (
            <div className="space-y-3 font-mono text-xs">
              {props.logs.map((entry) => (
                <Message key={entry.id} from="assistant" className="max-w-full border-b pb-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatDate(entry.timestamp)}</span>
                    <Badge variant="outline">{entry.level}</Badge>
                    <span>{entry.component}</span>
                  </div>
                  <MessageContent className="w-full font-mono break-all">
                    {entry.message}
                  </MessageContent>
                </Message>
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
      <div className="grid divide-y border-y sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <section className="space-y-2 p-4">
          <h3 className="text-sm font-medium">{t("overview.health")}</h3>
          <Badge>{t(`health.${server.health}`)}</Badge>
        </section>
        <section className="space-y-2 p-4">
          <h3 className="text-sm font-medium">{t("overview.production")}</h3>
          <Badge variant={server.productionCertified ? "default" : "secondary"}>
            {server.productionCertified ? t("certified") : t("notCertified")}
          </Badge>
        </section>
      </div>
      {latestBackup && (
        <section className="border-y py-3">
          <h3 className="mb-2 text-sm font-medium">{t("overview.latestRecoveryPoint")}</h3>
          <Item className="rounded-none px-0">
            <ItemContent>
              <ItemTitle>{latestBackup.id}</ItemTitle>
              <ItemDescription>{formatDate(latestBackup.createdAt)}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button variant="outline" size="sm" onClick={() => onRestore(latestBackup.id)}>
                <ArchiveRestoreIcon className="size-4" />
                {t("actions.restore")}
              </Button>
            </ItemActions>
          </Item>
        </section>
      )}
      {server.certificationIssues.length > 0 && (
        <section className="border-y py-3">
          <h3 className="mb-2 text-sm font-medium">{t("overview.issues")}</h3>
          <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
            {server.certificationIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function KeyValueGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="grid border-y sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="border-b p-3 sm:border-r">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-all text-sm font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
function Empty({ text }: { text: string }) {
  return (
    <EmptyState className="rounded-none border-y">
      <EmptyDescription>{text}</EmptyDescription>
    </EmptyState>
  )
}
function OperationRow({ operation, compact = false }: { operation: Operation; compact?: boolean }) {
  const t = useTranslations("servers")
  return (
    <div className={cn("border-l p-3", compact && "min-w-56")}>
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
  controllerCredentialRef: string
  publicUrl: string
  oidcIssuer: string
  oidcAudience: string
  tenantClaim: string
  scopeRead: string
  scopeOperate: string
  scopeAdmin: string
  objectStoreEndpoint: string
  objectStoreRegion: string
  objectStoreBucket: string
  objectStorePathStyle: boolean
  objectStoreCredentialRef: string
  snapshotProvider: "kubernetes-csi" | "external-command" | "none"
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
  controllerCredentialRef: "ops-controller/staging",
  publicUrl: "",
  oidcIssuer: "",
  oidcAudience: "",
  tenantClaim: "organization_id",
  scopeRead: "servers:read",
  scopeOperate: "servers:operate",
  scopeAdmin: "servers:admin",
  objectStoreEndpoint: "",
  objectStoreRegion: "auto",
  objectStoreBucket: "cognia-backups",
  objectStorePathStyle: false,
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
  capabilities,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onValidate: (target: DeploymentTarget) => Promise<void>
  capabilities: ProviderCapabilities | null
}) {
  const t = useTranslations("servers")
  const [state, setState] = useState(INITIAL_WIZARD)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const update = <K extends keyof WizardState>(key: K, value: WizardState[K]) =>
    setState((current) => ({ ...current, [key]: value }))
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await onValidate(parseDeploymentTarget(buildDeploymentTarget(state)))
      onOpenChange(false)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("wizard.invalid"))
    } finally {
      setSubmitting(false)
    }
  }
  const textFields: Array<[keyof WizardState, string, string]> = [
    ["id", "wizard.targetId", "wizard.placeholders.targetId"],
    ["label", "wizard.label", "wizard.placeholders.label"],
    ["controllerUrl", "wizard.controllerUrl", "wizard.placeholders.controllerUrl"],
    [
      "controllerCredentialRef",
      "wizard.controllerCredentialRef",
      "wizard.placeholders.controllerCredentialRef",
    ],
    ["publicUrl", "wizard.publicUrl", "wizard.placeholders.publicUrl"],
    ["oidcIssuer", "wizard.oidcIssuer", "wizard.placeholders.oidcIssuer"],
    ["oidcAudience", "wizard.oidcAudience", "wizard.placeholders.oidcAudience"],
    ["tenantClaim", "wizard.tenantClaim", "wizard.placeholders.tenantClaim"],
    ["scopeRead", "wizard.scopeRead", "wizard.placeholders.scopeRead"],
    ["scopeOperate", "wizard.scopeOperate", "wizard.placeholders.scopeOperate"],
    ["scopeAdmin", "wizard.scopeAdmin", "wizard.placeholders.scopeAdmin"],
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
  const topologyOptions = supportedOptions(
    capabilities?.topologies,
    ["compose", "kubernetes"],
    state.topology
  )
  const snapshotOptions = supportedOptions(
    capabilities?.snapshotProviders,
    ["kubernetes-csi", "external-command", "none"],
    state.snapshotProvider
  )
  const secretOptions = supportedOptions(
    capabilities?.secretProviders,
    ["file", "kubernetes", "vault", "aws-secrets-manager"],
    state.secretProvider
  )
  const tlsOptions = supportedOptions(
    capabilities?.tlsProviders,
    ["ingress", "existing", "acme-http01", "acme-dns01"],
    state.tlsProvider
  )
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{t("wizard.title")}</SheetTitle>
          <SheetDescription>{t("wizard.description")}</SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="space-y-5 px-4 pb-8">
          <Tabs defaultValue="guided">
            <TabsList variant="line" className="w-full justify-start">
              <TabsTrigger value="guided">{t("wizard.guided")}</TabsTrigger>
              <TabsTrigger value="custom">{t("wizard.custom")}</TabsTrigger>
            </TabsList>
            <TabsContent value="guided" className="space-y-6 pt-4">
              <fieldset className="grid gap-3 border-t pt-4 sm:grid-cols-2">
                <legend className="mb-2 text-sm font-semibold">{t("wizard.targetSection")}</legend>
                <SelectField
                  label={t("wizard.topology")}
                  value={state.topology}
                  onChange={(value) => update("topology", value)}
                  options={topologyOptions}
                  t={t}
                />
                {textFields.slice(0, 5).map(([key, label, placeholder]) => (
                  <TextField
                    key={key}
                    label={t(label)}
                    value={state[key]}
                    placeholder={t(placeholder)}
                    onChange={(value) => update(key, value)}
                  />
                ))}
              </fieldset>
              <fieldset className="grid gap-3 border-t pt-4 sm:grid-cols-2">
                <legend className="mb-2 text-sm font-semibold">
                  {t("wizard.identitySection")}
                </legend>
                {textFields.slice(5, 11).map(([key, label, placeholder]) => (
                  <TextField
                    key={key}
                    label={t(label)}
                    value={state[key]}
                    placeholder={t(placeholder)}
                    onChange={(value) => update(key, value)}
                  />
                ))}
              </fieldset>
              <fieldset className="grid gap-3 border-t pt-4 sm:grid-cols-2">
                <legend className="mb-2 text-sm font-semibold">{t("wizard.storageSection")}</legend>
                {textFields.slice(11, 15).map(([key, label, placeholder]) => (
                  <TextField
                    key={key}
                    label={t(label)}
                    value={state[key]}
                    placeholder={t(placeholder)}
                    onChange={(value) => update(key, value)}
                  />
                ))}
                <Field orientation="horizontal" className="sm:col-span-2">
                  <FieldContent>
                    <FieldLabel htmlFor="server-object-store-path-style">
                      {t("wizard.objectStorePathStyle")}
                    </FieldLabel>
                    <FieldDescription>{t("wizard.objectStorePathStyleHelp")}</FieldDescription>
                  </FieldContent>
                  <Switch
                    id="server-object-store-path-style"
                    checked={state.objectStorePathStyle}
                    onCheckedChange={(checked) => update("objectStorePathStyle", checked)}
                  />
                </Field>
                <SelectField
                  label={t("wizard.snapshotProvider")}
                  value={state.snapshotProvider}
                  onChange={(value) => update("snapshotProvider", value)}
                  options={snapshotOptions}
                  t={t}
                />
                {state.snapshotProvider !== "none" && (
                  <TextField
                    label={t("wizard.snapshotRef")}
                    value={state.snapshotRef}
                    onChange={(value) => update("snapshotRef", value)}
                  />
                )}
                <SelectField
                  label={t("wizard.secretProvider")}
                  value={state.secretProvider}
                  onChange={(value) => update("secretProvider", value)}
                  options={secretOptions}
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
                  options={tlsOptions}
                  t={t}
                />
                {state.tlsProvider !== "acme-http01" && (
                  <TextField
                    label={t("wizard.tlsRef")}
                    value={state.tlsRef}
                    onChange={(value) => update("tlsRef", value)}
                  />
                )}
              </fieldset>
              <fieldset className="grid gap-3 border-t pt-4 sm:grid-cols-2">
                <legend className="mb-2 text-sm font-semibold">
                  {t("wizard.platformSection")}
                </legend>
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
              <fieldset className="grid gap-3 border-t pt-4">
                <legend className="mb-2 text-sm font-semibold">{t("wizard.imagesSection")}</legend>
                {textFields.slice(18).map(([key, label, placeholder]) => (
                  <TextField
                    key={key}
                    label={t(label)}
                    value={state[key]}
                    placeholder={t(placeholder)}
                    onChange={(value) => update(key, value)}
                  />
                ))}
              </fieldset>
            </TabsContent>
            <TabsContent value="custom" className="pt-4">
              <StructuredConfigEditor
                value={buildDeploymentTarget(state)}
                validate={parseDeploymentTarget}
                onApply={(target) => setState(wizardStateFromTarget(target))}
                filename={`${state.id || "deployment-target"}.deployment-target`}
                disabled={submitting}
              />
            </TabsContent>
          </Tabs>
          <p className="border-l-2 border-primary bg-muted/50 p-3 text-xs text-muted-foreground">
            {t("wizard.credentialsNotice")}
          </p>
          {capabilities?.requiresProviderCredentials && (
            <p className="border-l-2 border-amber-500 p-3 text-xs text-muted-foreground">
              {t("wizard.providerCredentialsRequired")}
            </p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{t("wizard.invalid")}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
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
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {t(`options.${option}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
    state.snapshotProvider === "none"
      ? { provider: state.snapshotProvider }
      : state.snapshotProvider === "kubernetes-csi"
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
      controller: { url: state.controllerUrl, credentialRef: state.controllerCredentialRef },
      identity: {
        provider: "oidc",
        issuer: state.oidcIssuer,
        audience: state.oidcAudience,
        tenantClaim: state.tenantClaim,
        scopes: { read: state.scopeRead, operate: state.scopeOperate, admin: state.scopeAdmin },
      },
      objectStore: {
        provider: "s3-compatible",
        endpoint: state.objectStoreEndpoint,
        region: state.objectStoreRegion,
        bucket: state.objectStoreBucket,
        pathStyle: state.objectStorePathStyle,
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

function wizardStateFromTarget(target: DeploymentTarget): WizardState {
  const snapshots = target.spec.snapshots
  const tls = target.spec.tls
  return {
    id: target.metadata.id,
    label: target.metadata.label,
    topology: target.spec.topology,
    controllerUrl: target.spec.controller.url,
    controllerCredentialRef: target.spec.controller.credentialRef,
    publicUrl: target.spec.publicUrl,
    oidcIssuer: target.spec.identity.issuer,
    oidcAudience: target.spec.identity.audience,
    tenantClaim: target.spec.identity.tenantClaim,
    scopeRead: target.spec.identity.scopes.read,
    scopeOperate: target.spec.identity.scopes.operate,
    scopeAdmin: target.spec.identity.scopes.admin,
    objectStoreEndpoint: target.spec.objectStore.endpoint,
    objectStoreRegion: target.spec.objectStore.region,
    objectStoreBucket: target.spec.objectStore.bucket,
    objectStorePathStyle: target.spec.objectStore.pathStyle,
    objectStoreCredentialRef: target.spec.objectStore.credentialRef,
    snapshotProvider: snapshots.provider,
    snapshotRef:
      snapshots.provider === "kubernetes-csi"
        ? snapshots.className
        : snapshots.provider === "external-command"
          ? snapshots.adapterRef
          : "",
    secretProvider: target.spec.secrets.provider,
    secretRootRef: target.spec.secrets.rootRef,
    tlsProvider: tls.provider,
    tlsRef:
      tls.provider === "ingress" || tls.provider === "existing"
        ? tls.secretRef
        : tls.provider === "acme-dns01"
          ? tls.credentialRef
          : "",
    serverImage: target.spec.images.server,
    runnerImage: target.spec.images.runner,
    workspaceRuntimeImage: target.spec.images.workspaceRuntime,
    namespace: target.spec.kubernetes?.namespace ?? INITIAL_WIZARD.namespace,
    ingressClassName: target.spec.kubernetes?.ingressClassName ?? INITIAL_WIZARD.ingressClassName,
    storageClassName: target.spec.kubernetes?.storageClassName ?? INITIAL_WIZARD.storageClassName,
    runtimeClassName: target.spec.kubernetes?.runtimeClassName ?? "",
    projectName: target.spec.compose?.projectName ?? INITIAL_WIZARD.projectName,
    deploymentRoot: target.spec.compose?.deploymentRoot ?? INITIAL_WIZARD.deploymentRoot,
  }
}

function supportedOptions<T extends string>(
  supported: string[] | undefined,
  fallback: readonly T[],
  current: T
): T[] {
  const available = supported?.length
    ? fallback.filter((option) => supported.includes(option))
    : [...fallback]
  return available.includes(current) ? available : [current, ...available]
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
