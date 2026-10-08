"use client"

/**
 * Settings → Image catalog (ADR-0182).
 *
 * The tenant's view of what the deployment offers to run agents in: the
 * baseline images (read-only here — the Ops Controller or the operator's
 * baseline file owns them), the images this tenant added, and the tenant
 * entries the merge refused, with the facts every entry is read against —
 * the isolation floor, the size classes, the network presets and the agent
 * bundle.
 *
 * Reachable only where the `sandbox-pool` capability is (a server-backed
 * host); even there a deployment that never turned the pool on says so and
 * offers nothing (Q39).
 *
 * # Labeled as not yet real (Working Rule 7)
 *
 * - GPU size classes (`SizeClassView.gpu`): listed, marked unavailable.
 * - Network presets (`SandboxPlacementReport.egressEnforced`): listed, said to
 *   be recorded and not enforced.
 *
 * # Layout
 *
 * One page, not six stacked Cards. The images lead and take the width; the
 * deployment facts they are judged against sit beside them on a wide pane
 * (under them on a narrow one) as frameless chapters. Columns size off the
 * section's own width (`@container/console-pane`), because the settings
 * panel is capped and inset differently from the window.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ContainerIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConsoleSection } from "@/components/surface/console-section"
import { CatalogProblemText } from "@/components/settings/image-catalog/catalog-problem-text"
import { ImageCatalogEntryEditor } from "@/components/settings/image-catalog/image-catalog-entry-editor"
import {
  useImageCatalog,
  type CatalogProblem,
  type ImageCatalogActions,
  type ImageCatalogState,
} from "@/hooks/sandbox/use-image-catalog"
import type {
  CatalogEntryRecord,
  CatalogEntryRow,
  CatalogRows,
} from "@/lib/project-environment/environment-client"

type Editing = { existing?: CatalogEntryRecord }

export function ImageCatalogSection() {
  return <ImageCatalogView catalog={useImageCatalog()} />
}

/**
 * The page for a catalog state it is handed. Split from the hook so the
 * layout can be rendered from a fixture (Storybook) without a Host, which is
 * the only place this page is otherwise reachable.
 */
export function ImageCatalogView({
  catalog,
}: {
  catalog: ImageCatalogState & ImageCatalogActions
}) {
  const t = useTranslations("settings.imageCatalog")
  const tTier = useTranslations("projectEnvironment.runtime.tier")
  // The record is held here, not looked up by id, so a reload behind an open
  // editor does not re-seed it with the Host's newer copy mid-edit.
  const [editing, setEditing] = useState<Editing | null>(null)
  const [revoking, setRevoking] = useState<CatalogEntryRecord | null>(null)
  const [revokeProblem, setRevokeProblem] = useState<CatalogProblem>()

  const { status, facts, rows, rejected, driver, driverProblem, loadProblem, busy } = catalog

  const onRevoke = async () => {
    if (!revoking) return
    const result = await catalog.revoke(revoking.id)
    if (result.ok) {
      toast.success(t("revoke.done", { label: revoking.label }))
      setRevoking(null)
    } else {
      setRevokeProblem(result.problem)
    }
  }

  return (
    <div className="@container/console-pane space-y-6" data-testid="image-catalog-section">
      {/* The page's own intro, not a Card around the first paragraph: the
          settings header already frames the page. */}
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ContainerIcon className="size-4.5 text-muted-foreground" aria-hidden="true" />
            {t("title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={status === "loading" || busy}
          onClick={() => void catalog.reload()}
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          {t("reload")}
        </Button>
      </header>

      {status === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      ) : null}
      {status === "pool-off" ? (
        <Alert data-testid="image-catalog-pool-off">
          <AlertTitle>{t("poolOff.title")}</AlertTitle>
          <AlertDescription>{t("poolOff.body")}</AlertDescription>
        </Alert>
      ) : null}
      {status === "failed" ? (
        <div className="space-y-1">
          <p className="text-sm">{t("failed")}</p>
          {loadProblem ? <CatalogProblemText problem={loadProblem} /> : null}
        </div>
      ) : null}

      {status === "ready" && facts ? (
        <>
          {/*
            Six stacked Cards became one page with two columns on a wide
            pane. The images are what this page is for (the only thing on it
            that can be changed), so they lead and take the width. What every
            image is judged against (isolation floor, driver, sizes, network
            presets, bundle) is a spec sheet beside them, chapters under a
            rule rather than a Card each, so the facts can be read alongside
            the entry they explain instead of four screens below it.
          */}
          <div className="grid items-start gap-x-10 gap-y-8 @4xl/console-pane:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0 space-y-8">
              <ConsoleSection
                id="entries"
                idPrefix="image-catalog-section"
                variant="sheet"
                title={t("entries.title")}
                description={t("entries.description")}
                meta={
                  <Button
                    type="button"
                    size="sm"
                    className="-my-1"
                    disabled={busy || !facts.sizeClasses.some((sizeClass) => !sizeClass.gpu)}
                    onClick={() => setEditing({})}
                  >
                    <PlusIcon className="size-4" aria-hidden="true" />
                    {t("entries.add")}
                  </Button>
                }
              >
                {rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("entries.empty")}</p>
                ) : (
                  <ul className="-mt-3 divide-y">
                    {rows.map((row) => (
                      <EntryRow
                        key={row.entry.id}
                        row={row}
                        facts={facts}
                        busy={busy}
                        onEdit={() => setEditing({ existing: row.entry })}
                        onRevoke={() => {
                          setRevokeProblem(undefined)
                          setRevoking(row.entry)
                        }}
                      />
                    ))}
                  </ul>
                )}
              </ConsoleSection>

              {rejected.length > 0 ? (
                <ConsoleSection
                  id="rejected"
                  idPrefix="image-catalog-section"
                  variant="sheet"
                  icon={TriangleAlertIcon}
                  title={t("rejected.title")}
                  description={t("rejected.description")}
                  meta={rejected.length}
                >
                  <ul className="divide-y" data-testid="image-catalog-rejected">
                    {rejected.map((row) => (
                      <li key={row.id} className="space-y-0.5 py-2 first:pt-0">
                        <p className="font-mono text-xs">{row.id}</p>
                        <CatalogProblemText problem={{ code: row.code, message: row.message }} />
                      </li>
                    ))}
                  </ul>
                </ConsoleSection>
              ) : null}
            </div>

            <aside className="min-w-0 space-y-8" aria-label={t("facts.title")}>
              <ConsoleSection
                id="facts"
                idPrefix="image-catalog-section"
                variant="sheet"
                title={t("facts.title")}
              >
                <ul className="space-y-1.5 text-sm" data-testid="image-catalog-facts">
                  <li>{t("facts.floor", { tier: tTier(facts.floor) })}</li>
                  <li>{facts.multiTenant ? t("facts.multiTenant") : t("facts.singleTenant")}</li>
                  {driver ? (
                    <>
                      <li>
                        {t("facts.driver", { driver: driver.driver })} ·{" "}
                        {driver.reachable
                          ? t("facts.driverReachable")
                          : driver.unreachableReason
                            ? t("facts.driverUnreachable", { reason: driver.unreachableReason })
                            : t("facts.driverUnreachableUnknown")}
                      </li>
                      <li>
                        {driver.availableTiers.length > 0
                          ? t("facts.tiers", {
                              tiers: driver.availableTiers.map((tier) => tTier(tier)).join(", "),
                            })
                          : t("facts.tiersNone")}
                      </li>
                    </>
                  ) : null}
                  {driverProblem ? (
                    <li className="space-y-1">
                      <p>{t("facts.driverProblem")}</p>
                      <CatalogProblemText problem={driverProblem} />
                    </li>
                  ) : null}
                </ul>
              </ConsoleSection>

              <ConsoleSection
                id="sizes"
                idPrefix="image-catalog-section"
                variant="sheet"
                title={t("sizes.title")}
                meta={facts.sizeClasses.length || undefined}
              >
                {facts.sizeClasses.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("sizes.empty")}</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {facts.sizeClasses.map((sizeClass) =>
                      sizeClass.gpu ? (
                        <li key={sizeClass.id} className="text-muted-foreground" data-dormant="gpu">
                          {sizeClass.label}:{" "}
                          {t("sizes.gpuDormant", {
                            count: sizeClass.gpu.count,
                            resource: sizeClass.gpu.resourceName,
                          })}
                        </li>
                      ) : (
                        <li key={sizeClass.id} className="break-words">
                          {t("sizes.spec", {
                            label: sizeClass.label,
                            cpu: sizeClass.cpuMillis / 1000,
                            memory: sizeClass.memoryMib,
                            storage: sizeClass.ephemeralStorageMib,
                            volume: sizeClass.volumeMib,
                          })}
                        </li>
                      )
                    )}
                  </ul>
                )}
              </ConsoleSection>

              <ConsoleSection
                id="egress"
                idPrefix="image-catalog-section"
                variant="sheet"
                title={t("egress.title")}
                meta={facts.egressPresets.length || undefined}
              >
                <p
                  className="mb-2.5 text-xs leading-snug text-amber-700 dark:text-amber-400"
                  data-dormant="egress"
                >
                  {t("egress.notEnforced")}
                </p>
                {facts.egressPresets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("egress.empty")}</p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {facts.egressPresets.map((preset) => (
                      <li key={preset.id}>
                        <p className="font-medium">{preset.label}</p>
                        <p className="break-all font-mono text-xs text-muted-foreground">
                          {preset.domains.join(", ")}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </ConsoleSection>

              <ConsoleSection
                id="bundle"
                idPrefix="image-catalog-section"
                variant="sheet"
                title={t("bundle.title")}
              >
                <div className="space-y-1 text-sm">
                  {facts.bundle ? (
                    <>
                      <p>{t("bundle.current", { tag: facts.bundle.current.releaseTag })}</p>
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        {t("bundle.digest", { digest: facts.bundle.current.digest })}
                      </p>
                      {facts.bundle.retained.length > 0 ? (
                        <p>
                          {t("bundle.retained", {
                            tags: facts.bundle.retained
                              .map((bundle) => bundle.releaseTag)
                              .join(", "),
                          })}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-muted-foreground">{t("bundle.none")}</p>
                  )}
                </div>
              </ConsoleSection>
            </aside>
          </div>

          <ImageCatalogEntryEditor
            open={editing !== null}
            onOpenChange={(open) => {
              if (!open) setEditing(null)
            }}
            existing={editing?.existing}
            facts={facts}
            busy={busy}
            inspect={catalog.inspect}
            save={catalog.save}
          />
        </>
      ) : null}

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("revoke.title", { label: revoking?.label ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("revoke.body", { id: revoking?.id ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revokeProblem ? <CatalogProblemText problem={revokeProblem} /> : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("revoke.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                // Stay open until the Host answers: a refusal is shown here.
                event.preventDefault()
                void onRevoke()
              }}
            >
              {t("revoke.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function EntryRow({
  row,
  facts,
  busy,
  onEdit,
  onRevoke,
}: {
  row: CatalogEntryRow
  facts: CatalogRows["facts"]
  busy: boolean
  onEdit(): void
  onRevoke(): void
}) {
  const t = useTranslations("settings.imageCatalog.entries")
  const tTier = useTranslations("projectEnvironment.runtime.tier")
  const { entry } = row
  const { image } = entry
  const name = `${image.registry}/${image.repository}`
  const sizeLabel = (id: string) =>
    facts.sizeClasses.find((sizeClass) => sizeClass.id === id)?.label ?? id

  return (
    <li
      className="flex flex-wrap items-start justify-between gap-3 py-3"
      data-testid={`catalog-entry-${entry.id}`}
    >
      {/* A basis, so on a narrow pane the actions wrap under the entry
          instead of squeezing a digest into a column four words wide. */}
      <div className="min-w-0 flex-1 basis-72 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{entry.label}</span>
          <span className="font-mono text-xs text-muted-foreground">{entry.id}</span>
          <Badge variant={entry.scope === "tenant" ? "default" : "secondary"}>
            {t(`scope.${entry.scope}`)}
          </Badge>
          {row.defaultEntry ? <Badge variant="outline">{t("default")}</Badge> : null}
          <Badge variant="outline">{t(`source.${entry.source}`)}</Badge>
        </div>
        {entry.description ? (
          <p className="text-sm text-muted-foreground">{entry.description}</p>
        ) : null}
        <p className="break-all font-mono text-xs">
          {image.digest
            ? `${name}${image.tag ? `:${image.tag}` : ""}@${image.digest}`
            : `${name}:${image.tag ?? "latest"}`}
        </p>
        {image.digest ? null : (
          <p className="text-xs text-amber-700 dark:text-amber-400">{t("unpinned")}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("floor", { tier: tTier(row.effectiveFloor) })} ·{" "}
          {entry.imageUser ? t("user", { user: entry.imageUser }) : t("userRoot")} ·{" "}
          {t("sizes", { sizes: entry.sizeClassIds.map(sizeLabel).join(", ") })}
        </p>
      </div>
      {entry.scope === "tenant" ? (
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={t("editFor", { label: entry.label })}
            onClick={onEdit}
          >
            <PencilIcon className="size-4" aria-hidden="true" />
            {t("edit")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={t("revokeFor", { label: entry.label })}
            onClick={onRevoke}
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
            {t("revoke")}
          </Button>
        </div>
      ) : null}
    </li>
  )
}
