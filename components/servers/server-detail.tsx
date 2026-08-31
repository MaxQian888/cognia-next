"use client"

/**
 * One deployment target: what it is, what it is running, and every operation
 * the controller will accept for it.
 *
 * The action surface here is the point of the rebuild. `preflight`,
 * `collect-status`, `collect-logs` and `upgrade` all existed end to end — agent
 * protocol, executor, translations — with no way to trigger them, so a target
 * could only ever be deployed, backed up, restored, rolled back, or re-keyed.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import {
  ArchiveRestoreIcon,
  DatabaseBackupIcon,
  FileTextIcon,
  KeyRoundIcon,
  PlugZapIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  ServerIcon,
  ShieldAlertIcon,
  SquareArrowUpIcon,
  StethoscopeIcon,
} from "lucide-react"

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { RecoveryPoint, ServerDetail, ServerLogEntry } from "@/lib/server-ops/client"
import { cn } from "@/lib/utils"
import { formatBytes, HealthLabel, useAbsoluteTime, useRelativeTime } from "./server-visuals"

type Confirmation =
  | { kind: "restore"; recoveryPointId: string }
  | { kind: "rollback" }
  | { kind: "rotate-key"; keyVersion: string }

export interface ServerDetailActions {
  onBackup: () => void
  onPreflight: () => void
  onCollectStatus: (includeRuntimeUsage: boolean) => void
  onCollectLogs: () => void
  onRestore: (recoveryPointId: string) => void
  onRollback: () => void
  onRotateKey: (keyVersion: string) => void
  onUpgrade: (release: {
    serverImage: string
    runnerImage: string
    workspaceRuntimeImage: string
  }) => void
  onConnectAgent: () => void
}

const TABS = ["overview", "deployments", "backups", "logs", "security"] as const

function FactGrid({ items }: { items: ReadonlyArray<readonly [string, React.ReactNode]> }) {
  return (
    <dl className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="bg-card p-3">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 text-sm font-medium break-all">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ActionTile({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  disabled,
  children,
}: {
  icon: typeof StethoscopeIcon
  title: string
  description: string
  actionLabel: string
  onAction: () => void
  disabled?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled}
        onClick={onAction}
      >
        {actionLabel}
      </Button>
    </div>
  )
}

function UpgradeDialog({
  open,
  onOpenChange,
  onUpgrade,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpgrade: ServerDetailActions["onUpgrade"]
}) {
  const t = useTranslations("servers")
  const [serverImage, setServerImage] = useState("")
  const [runnerImage, setRunnerImage] = useState("")
  const [workspaceRuntimeImage, setWorkspaceRuntimeImage] = useState("")
  const complete = Boolean(serverImage.trim() && runnerImage.trim() && workspaceRuntimeImage.trim())

  const fields = [
    ["upgrade.serverImage", serverImage, setServerImage, "wizard.placeholders.serverImage"],
    ["upgrade.runnerImage", runnerImage, setRunnerImage, "wizard.placeholders.runnerImage"],
    [
      "upgrade.workspaceRuntimeImage",
      workspaceRuntimeImage,
      setWorkspaceRuntimeImage,
      "wizard.placeholders.workspaceRuntimeImage",
    ],
  ] as const

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("upgrade.title")}</DialogTitle>
          <DialogDescription>{t("upgrade.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {fields.map(([labelKey, value, setValue, placeholderKey]) => (
            <Field key={labelKey}>
              <FieldLabel htmlFor={`upgrade-${labelKey}`}>
                {t(labelKey as "upgrade.serverImage")}
              </FieldLabel>
              <Input
                id={`upgrade-${labelKey}`}
                value={value}
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                placeholder={t(placeholderKey as "wizard.placeholders.serverImage")}
                onChange={(event) => setValue(event.target.value)}
              />
            </Field>
          ))}
          <FieldDescription>{t("upgrade.digestNotice")}</FieldDescription>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("wizard.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!complete}
            onClick={() => {
              onUpgrade({
                serverImage: serverImage.trim(),
                runnerImage: runnerImage.trim(),
                workspaceRuntimeImage: workspaceRuntimeImage.trim(),
              })
              onOpenChange(false)
            }}
          >
            {t("upgrade.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ServerDetailView({
  server,
  backups,
  logs,
  loadingDetail,
  actions,
}: {
  server: ServerDetail
  backups: readonly RecoveryPoint[]
  logs: readonly ServerLogEntry[]
  loadingDetail: boolean
  actions: ServerDetailActions
}) {
  const t = useTranslations("servers")
  const absolute = useAbsoluteTime()
  const relative = useRelativeTime()
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [keyVersion, setKeyVersion] = useState("")
  const [includeRuntimeUsage, setIncludeRuntimeUsage] = useState(false)
  const [upgradeOpen, setUpgradeOpen] = useState(false)

  const confirm = () => {
    if (!confirmation) return
    if (confirmation.kind === "restore") actions.onRestore(confirmation.recoveryPointId)
    if (confirmation.kind === "rollback") actions.onRollback()
    if (confirmation.kind === "rotate-key") actions.onRotateKey(confirmation.keyVersion)
    setConfirmation(null)
  }

  const latestBackup = backups[0] ?? null

  return (
    <Tabs defaultValue="overview" className="flex h-full min-h-0 flex-col gap-0">
      <div className="overflow-x-auto border-b px-3">
        <TabsList variant="line" className="min-w-max">
          {TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`tabs.${tab}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-[1100px]">
          <TabsContent value="overview" className="space-y-4 p-4 md:p-6">
            {server.certificationIssues.length > 0 && (
              <Alert variant="destructive">
                <ShieldAlertIcon className="size-4" aria-hidden="true" />
                <AlertTitle>{t("overview.issues")}</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {server.certificationIssues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <FactGrid
              items={[
                [t("overview.health"), <HealthLabel key="health" health={server.health} />],
                [
                  t("fields.certification"),
                  <Badge
                    key="certified"
                    variant={server.productionCertified ? "default" : "secondary"}
                  >
                    {server.productionCertified ? t("certified") : t("notCertified")}
                  </Badge>,
                ],
                [
                  t("fields.id"),
                  <span key="id" className="font-mono">
                    {server.id}
                  </span>,
                ],
                [t("fields.topology"), t(`topology.${server.topology}` as "topology.compose")],
                [t("fields.publicUrl"), server.publicUrl || t("notAvailable")],
                [t("fields.revision"), String(server.targetRevision)],
                [t("fields.lastSeen"), relative(server.lastSeenAt)],
                [
                  t("fields.release"),
                  <span key="release" className="font-mono text-xs">
                    {server.releaseDigest ?? t("notAvailable")}
                  </span>,
                ],
              ]}
            />

            <div className="grid gap-3 md:grid-cols-2">
              <ActionTile
                icon={ScanSearchIcon}
                title={t("operationKinds.preflight")}
                description={t("actionsHelp.preflight")}
                actionLabel={t("actions.preflight")}
                onAction={actions.onPreflight}
              />
              <ActionTile
                icon={StethoscopeIcon}
                title={t("operationKinds.collect-status")}
                description={t("actionsHelp.collectStatus")}
                actionLabel={t("actions.collectStatus")}
                onAction={() => actions.onCollectStatus(includeRuntimeUsage)}
              >
                <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                  <Label htmlFor="collect-runtime-usage" className="text-xs font-normal">
                    {t("actions.includeRuntimeUsage")}
                  </Label>
                  <Switch
                    id="collect-runtime-usage"
                    checked={includeRuntimeUsage}
                    onCheckedChange={setIncludeRuntimeUsage}
                  />
                </div>
              </ActionTile>
              <ActionTile
                icon={DatabaseBackupIcon}
                title={t("operationKinds.backup")}
                description={t("actionsHelp.backup")}
                actionLabel={t("actions.backup")}
                onAction={actions.onBackup}
              />
              <ActionTile
                icon={FileTextIcon}
                title={t("operationKinds.collect-logs")}
                description={t("actionsHelp.collectLogs")}
                actionLabel={t("actions.collectLogs")}
                onAction={actions.onCollectLogs}
              />
            </div>

            {/*
              The two "server" vocabularies in this app never met. A machine
              you deploy Cognia onto here has an ops-controller id; a machine
              this app can drive has a `RemoteHost.id`, and nothing connected
              them, so the server you just deployed to could not be reached
              from `/devices` without hunting for its address by hand.

              This is a hand-off, not an auto-pair: the invitation is one-shot
              and is printed on the host by `cognia-server pair`. All the
              bridge can honestly do is carry the address across and say so.
            */}
            {server.publicUrl ? (
              <section className="rounded-lg border p-4" data-testid="server-add-as-host">
                <h3 className="text-sm font-medium">{t("addAsHost.title")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{t("addAsHost.description")}</p>
                <Button asChild variant="outline" size="sm" className="mt-3">
                  <Link href={`/devices?addHost=1&baseUrl=${encodeURIComponent(server.publicUrl)}`}>
                    <ServerIcon className="size-4" aria-hidden="true" />
                    {t("addAsHost.action")}
                  </Link>
                </Button>
              </section>
            ) : null}

            {latestBackup && (
              <section className="rounded-lg border bg-card p-4">
                <h3 className="text-sm font-medium">{t("overview.latestRecoveryPoint")}</h3>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">{latestBackup.id}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {absolute(latestBackup.createdAt)} · {formatBytes(latestBackup.sizeBytes)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setConfirmation({ kind: "restore", recoveryPointId: latestBackup.id })
                    }
                  >
                    <ArchiveRestoreIcon className="size-4" aria-hidden="true" />
                    {t("actions.restore")}
                  </Button>
                </div>
              </section>
            )}
          </TabsContent>

          <TabsContent value="deployments" className="space-y-4 p-4 md:p-6">
            <FactGrid
              items={[
                [
                  t("fields.release"),
                  <span key="digest" className="font-mono text-xs">
                    {server.releaseDigest ?? t("notAvailable")}
                  </span>,
                ],
                [t("fields.revision"), String(server.targetRevision)],
                [
                  t("fields.certification"),
                  server.productionCertified ? t("certified") : t("notCertified"),
                ],
                [t("fields.topology"), t(`topology.${server.topology}` as "topology.compose")],
              ]}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <ActionTile
                icon={SquareArrowUpIcon}
                title={t("upgrade.title")}
                description={t("actionsHelp.upgrade")}
                actionLabel={t("actions.upgrade")}
                onAction={() => setUpgradeOpen(true)}
              />
              <ActionTile
                icon={RotateCcwIcon}
                title={t("actions.rollback")}
                description={
                  server.releaseDigest
                    ? t("actionsHelp.rollback")
                    : t("actionsHelp.rollbackUnavailable")
                }
                actionLabel={t("actions.rollback")}
                disabled={!server.releaseDigest}
                onAction={() => setConfirmation({ kind: "rollback" })}
              />
            </div>
          </TabsContent>

          <TabsContent value="backups" className="space-y-3 p-4 md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">{t("backups.description")}</p>
              <Button variant="outline" size="sm" onClick={actions.onBackup}>
                <DatabaseBackupIcon className="size-4" aria-hidden="true" />
                {t("actions.backup")}
              </Button>
            </div>
            {backups.length === 0 ? (
              <Empty className={cn("rounded-lg border", loadingDetail && "opacity-60")}>
                <EmptyHeader>
                  <EmptyTitle>{t("backups.emptyTitle")}</EmptyTitle>
                  <EmptyDescription>{t("backups.empty")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="divide-y overflow-hidden rounded-lg border bg-card">
                {backups.map((backup) => (
                  <li
                    key={backup.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate font-mono text-sm">
                        {backup.id}
                        {backup.verified && (
                          <Badge variant="outline" className="font-normal">
                            {t("backups.verified")}
                          </Badge>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {absolute(backup.createdAt)} · {formatBytes(backup.sizeBytes)} ·{" "}
                        {t(`backups.kind.${backup.kind}` as "backups.kind.snapshot")}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setConfirmation({ kind: "restore", recoveryPointId: backup.id })
                      }
                    >
                      <ArchiveRestoreIcon className="size-4" aria-hidden="true" />
                      {t("actions.restore")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="logs" className="space-y-3 p-4 md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">{t("logs.description")}</p>
              <Button variant="outline" size="sm" onClick={actions.onCollectLogs}>
                <FileTextIcon className="size-4" aria-hidden="true" />
                {t("actions.collectLogs")}
              </Button>
            </div>
            {logs.length === 0 ? (
              <Empty className={cn("rounded-lg border", loadingDetail && "opacity-60")}>
                <EmptyHeader>
                  <EmptyTitle>{t("logs.emptyTitle")}</EmptyTitle>
                  <EmptyDescription>{t("logs.empty")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="divide-y overflow-hidden rounded-lg border bg-card font-mono text-xs">
                {logs.map((entry) => (
                  <li key={entry.id} className="flex gap-3 p-2.5">
                    <span className="w-36 shrink-0 text-muted-foreground">
                      {absolute(entry.timestamp)}
                    </span>
                    <span
                      className={cn(
                        "w-14 shrink-0 uppercase",
                        entry.level.toLowerCase() === "error" && "text-destructive",
                        entry.level.toLowerCase() === "warn" && "text-amber-600 dark:text-amber-400"
                      )}
                    >
                      {entry.level}
                    </span>
                    <span className="w-32 shrink-0 truncate text-muted-foreground">
                      {entry.component}
                    </span>
                    <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">
                      {entry.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="security" className="space-y-4 p-4 md:p-6">
            <FactGrid
              items={[
                [
                  t("fields.snapshotProviders"),
                  server.capabilities.snapshotProviders.join(", ") || t("notAvailable"),
                ],
                [
                  t("fields.secretProviders"),
                  server.capabilities.secretProviders.join(", ") || t("notAvailable"),
                ],
                [
                  t("fields.tlsProviders"),
                  server.capabilities.tlsProviders.join(", ") || t("notAvailable"),
                ],
                [
                  t("fields.certification"),
                  server.productionCertified ? t("certified") : t("notCertified"),
                ],
              ]}
            />

            <div className="grid gap-3 md:grid-cols-2">
              <ActionTile
                icon={PlugZapIcon}
                title={t("enroll.title")}
                description={t("actionsHelp.enroll")}
                actionLabel={t("enroll.action")}
                onAction={actions.onConnectAgent}
              />
              <ActionTile
                icon={KeyRoundIcon}
                title={t("actions.rotateKey")}
                description={t("actionsHelp.rotateKey")}
                actionLabel={t("actions.rotateKey")}
                disabled={!keyVersion.trim()}
                onAction={() =>
                  setConfirmation({ kind: "rotate-key", keyVersion: keyVersion.trim() })
                }
              >
                <Field>
                  <FieldLabel htmlFor="rotate-key-version">{t("fields.keyVersion")}</FieldLabel>
                  <Input
                    id="rotate-key-version"
                    value={keyVersion}
                    autoComplete="off"
                    placeholder={t("wizard.placeholders.keyVersion")}
                    onChange={(event) => setKeyVersion(event.target.value)}
                  />
                </Field>
              </ActionTile>
            </div>
          </TabsContent>
        </div>
      </ScrollArea>

      <UpgradeDialog
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        onUpgrade={actions.onUpgrade}
      />

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => !open && setConfirmation(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation
                ? t(`confirm.${confirmation.kind}` as "confirm.rollback", { label: server.label })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirm}>{t("confirm.confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  )
}
