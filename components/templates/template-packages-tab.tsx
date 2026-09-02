"use client"

/**
 * The Packages tab, which used to be a list of nouns.
 *
 * It rendered a card per imported package with a name, a key, a trust label and
 * a fingerprint, and offered nothing to do with any of them. A package could be
 * imported and then never re-checked, withdrawn, uninstalled or handed on, and
 * `StoredTemplatePackage.yankedAt` sat on the record type with nothing in the
 * app able to write it.
 *
 * Two of the four actions are honest about their limits, and say so in the UI
 * rather than in a comment nobody reads:
 *
 *  - Verify cannot re-check the signature, because the repository stores the
 *    manifest and the definitions and not the zip. It re-resolves publisher
 *    trust against the ledger and re-hashes every stored release.
 *  - Re-export rebuilds the bytes unsigned. This device can sign its OWN
 *    packages (see the publisher identity block below), but it does not hold
 *    the key that signed someone else's, and re-signing their bytes under a
 *    local identity would be a forgery. So a signed package cannot come back
 *    out signed.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { BadgeCheckIcon, DownloadIcon, FileArchiveIcon, Trash2Icon, UndoIcon } from "lucide-react"

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TEMPLATE_FULL_DOMAINS, type TemplateDomain } from "@/lib/templates/contracts"
import type { StoredTemplatePackage } from "@/lib/templates/repository"
import type { TemplatePackageVerification } from "@/lib/templates/service"
import { TemplatePublisherIdentityCard } from "./template-publisher-identity-card"
import { TemplateTrustedPublishersCard } from "./template-trusted-publishers-card"

export interface TemplatePackagesTabProps {
  packages: StoredTemplatePackage[]
  /** Verification reports keyed by package key, for the packages checked so far. */
  reports: Record<string, TemplatePackageVerification>
  onVerify(key: string): void
  onYank(key: string, yanked: boolean): void
  onRemove(key: string): void
  onReexport(key: string): void
  onRollbackMigration(domain: TemplateDomain): void
  /** Bumped by the Studio after an export created or rotated the signing key. */
  publisherRefreshToken?: number
  /** Bumped by the Studio after an import accepted a new publisher key. */
  trustRefreshToken?: number
}

export function TemplatePackagesTab({
  packages,
  reports,
  onVerify,
  onYank,
  onRemove,
  onReexport,
  onRollbackMigration,
  publisherRefreshToken = 0,
  trustRefreshToken = 0,
}: TemplatePackagesTabProps) {
  const t = useTranslations("templateStudio")
  const [pendingRemoval, setPendingRemoval] = useState<StoredTemplatePackage>()
  const [rollbackDomain, setRollbackDomain] = useState<TemplateDomain>("skill")
  const [pendingRollback, setPendingRollback] = useState<TemplateDomain>()

  return (
    <div className="space-y-4" data-testid="template-packages-tab">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {packages.map((item) => {
          const report = reports[item.key]
          return (
            <Card key={item.key} data-testid="template-package-card">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileArchiveIcon className="size-4" />
                  {item.manifest.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>{item.key}</p>
                <div className="flex flex-wrap gap-1">
                  <Badge variant="secondary">{t(`trust.${item.trust}`)}</Badge>
                  {item.yankedAt ? (
                    <Badge variant="destructive" data-testid="template-package-yanked">
                      {t("packages.yanked")}
                    </Badge>
                  ) : null}
                </div>
                <p className="break-all font-mono text-xs">{item.fingerprint}</p>
                {report ? (
                  <ul className="space-y-0.5 text-xs" data-testid="template-package-report">
                    <li>{report.signed ? t("packages.signed") : t("packages.unsignedManifest")}</li>
                    {report.definitions.map((definition) => (
                      <li
                        key={`${definition.id}@${definition.version}`}
                        className={definition.state === "verified" ? undefined : "text-destructive"}
                      >
                        {definition.id}@{definition.version} ·{" "}
                        {t(`packages.state.${definition.state}`)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => onVerify(item.key)}>
                    <BadgeCheckIcon className="size-3.5" />
                    {t("packages.verify")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onReexport(item.key)}>
                    <DownloadIcon className="size-3.5" />
                    {t("packages.reexport")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onYank(item.key, !item.yankedAt)}
                    data-testid="template-package-yank"
                  >
                    <UndoIcon className="size-3.5" />
                    {item.yankedAt ? t("packages.unyank") : t("packages.yank")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => setPendingRemoval(item)}
                    data-testid="template-package-remove"
                  >
                    <Trash2Icon className="size-3.5" />
                    {t("packages.remove")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
        {packages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("packages.none")}</p>
        ) : null}
      </div>

      {/* Signing and trust are the two ends of one question, so they sit
          together on the tab that already answers it: which key does this
          device publish under, and whose keys does it accept. */}
      <div className="grid gap-3 md:grid-cols-2">
        <TemplatePublisherIdentityCard refreshToken={publisherRefreshToken} />
        <TemplateTrustedPublishersCard refreshToken={trustRefreshToken} />
      </div>

      {/* Migration rollback lived behind a service method with no caller. It
          undoes a legacy-store import by domain, which is the one thing a user
          whose old skills arrived wrong cannot otherwise do. */}
      <div className="space-y-2 rounded-md border p-3">
        <p className="text-sm font-medium">{t("packages.maintenance")}</p>
        <p className="text-xs text-muted-foreground">{t("packages.rollbackHint")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={rollbackDomain}
            onValueChange={(value) => setRollbackDomain(value as TemplateDomain)}
          >
            <SelectTrigger className="h-8 w-44" aria-label={t("packages.rollbackDomain")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATE_FULL_DOMAINS.map((item) => (
                <SelectItem key={item} value={item}>
                  {t(`domains.${item}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPendingRollback(rollbackDomain)}
            data-testid="template-rollback-migration"
          >
            {t("packages.rollback")}
          </Button>
        </div>
      </div>

      <AlertDialog
        open={Boolean(pendingRemoval)}
        onOpenChange={(open) => !open && setPendingRemoval(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("packages.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("packages.removeDescription", {
                name: pendingRemoval?.manifest.name ?? "",
                count: pendingRemoval?.manifest.definitions.length ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRemoval) onRemove(pendingRemoval.key)
                setPendingRemoval(undefined)
              }}
            >
              {t("packages.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(pendingRollback)}
        onOpenChange={(open) => !open && setPendingRollback(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("packages.rollbackTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("packages.rollbackDescription", {
                domain: pendingRollback ? t(`domains.${pendingRollback}`) : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRollback) onRollbackMigration(pendingRollback)
                setPendingRollback(undefined)
              }}
            >
              {t("packages.rollback")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
