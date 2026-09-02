"use client"

/**
 * Choose what goes into an exported package.
 *
 * The Studio's export button built a one-release package named after that
 * release, with no description and no compatibility range, from a manifest
 * format that accepts up to 256 definitions plus both of those fields. A user
 * who wanted to hand someone a team template and the three skills it depends on
 * had to export four files and explain the order.
 *
 * The list offered is every published release the catalogue holds, because a
 * package is built from releases: `service.exportPackage` reads each one out of
 * the repository by `{id, version}` and refuses a draft.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"
import {
  getPublisherIdentity,
  type TemplatePublisherIdentity,
} from "@/lib/templates/publisher-identity"

export interface TemplateExportRequest {
  id: string
  version: string
  name: string
  description?: string
  definitionIds: Array<{ id: string; version: string }>
  /**
   * Sign the manifest with this device's publisher key.
   *
   * The caller resolves the signer, because creating the key on first use is a
   * write and this dialog is a form. Absent or false exports unsigned, which is
   * what every export did before signing existed.
   */
  sign?: boolean
}

export interface TemplateExportDialogProps {
  /** The release the export was started from, or undefined when closed. */
  origin?: TemplateDefinitionEnvelope
  /** Every release available to bundle. Drafts are filtered out by the caller. */
  releases: TemplateDefinitionEnvelope[]
  onOpenChange(open: boolean): void
  onExport(request: TemplateExportRequest): void
}

function releaseKey(definition: TemplateDefinitionEnvelope): string {
  return `${definition.id}@${definition.version}`
}

export function TemplateExportDialog({
  origin,
  releases,
  onOpenChange,
  onExport,
}: TemplateExportDialogProps) {
  const t = useTranslations("templateStudio.exportDialog")
  return (
    <Dialog open={Boolean(origin)} onOpenChange={onOpenChange}>
      <DialogContent data-testid="template-export-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {/* Keyed on the release the export started from, so starting a second
            export re-seeds the fields. Seeding through an effect instead would
            wipe a description the user had already typed on every unrelated
            catalogue refresh. */}
        {origin ? (
          <ExportForm
            key={releaseKey(origin)}
            origin={origin}
            releases={releases}
            onOpenChange={onOpenChange}
            onExport={onExport}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ExportForm({
  origin,
  releases,
  onOpenChange,
  onExport,
}: TemplateExportDialogProps & { origin: TemplateDefinitionEnvelope }) {
  const t = useTranslations("templateStudio.exportDialog")
  const [packageId, setPackageId] = useState(`${origin.id}.package`)
  const [packageName, setPackageName] = useState(origin.metadata.name)
  const [description, setDescription] = useState(origin.metadata.description ?? "")
  const [selected, setSelected] = useState<string[]>([releaseKey(origin)])
  const [identity, setIdentity] = useState<TemplatePublisherIdentity | null>(null)
  const [sign, setSign] = useState(false)

  // Signing is on by default once a key exists, and off when one does not:
  // ticking the box would then MINT a key as a side effect of an export, which
  // is a decision that belongs to the Packages tab's identity block.
  useEffect(() => {
    let active = true
    void getPublisherIdentity()
      .then((next) => {
        if (!active || !next) return
        setIdentity(next)
        setSign(true)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const grouped = useMemo(
    () =>
      [...releases].sort((left, right) => left.metadata.name.localeCompare(right.metadata.name)),
    [releases]
  )

  const toggle = (key: string, checked: boolean) =>
    setSelected((prev) => (checked ? [...new Set([...prev, key])] : prev.filter((k) => k !== key)))

  const submit = () => {
    if (selected.length === 0) return
    const chosen = grouped.filter((definition) => selected.includes(releaseKey(definition)))
    onExport({
      id: packageId.trim() || `${origin.id}.package`,
      // The package version tracks the release the export started from, which
      // is what the single-release export always did implicitly.
      version: origin.version!,
      name: packageName.trim() || origin.metadata.name,
      ...(description.trim() ? { description: description.trim() } : {}),
      definitionIds: chosen.map((definition) => ({
        id: definition.id,
        version: definition.version!,
      })),
      ...(sign && identity ? { sign: true } : {}),
    })
  }

  return (
    <>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="export-package-id">{t("packageId")}</Label>
          <Input
            id="export-package-id"
            className="h-8 font-mono text-xs"
            value={packageId}
            onChange={(event) => setPackageId(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="export-package-name">{t("packageName")}</Label>
          <Input
            id="export-package-name"
            className="h-8"
            value={packageName}
            onChange={(event) => setPackageName(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="export-package-description">{t("packageDescription")}</Label>
          <Textarea
            id="export-package-description"
            className="min-h-16 text-sm"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("contents", { count: selected.length })}</Label>
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
            {grouped.map((definition) => {
              const key = releaseKey(definition)
              return (
                <label
                  key={key}
                  className="flex items-center gap-2 text-sm"
                  data-testid="template-export-row"
                >
                  <Checkbox
                    checked={selected.includes(key)}
                    aria-label={key}
                    onCheckedChange={(checked) => toggle(key, checked === true)}
                  />
                  <span className="min-w-0 flex-1 truncate">{definition.metadata.name}</span>
                  <Badge variant="outline">{definition.version}</Badge>
                </label>
              )
            })}
            {grouped.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noReleases")}</p>
            ) : null}
          </div>
        </div>
        {/* Signing, said plainly. `TemplatePackageSignature` has been on the
            manifest format since it landed and nothing ever filled it in, so
            every package this app produced arrived `unsigned` on the other
            side. */}
        <div className="space-y-1.5" data-testid="template-export-signing">
          {identity ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={sign}
                  aria-label={t("signWithKey")}
                  onCheckedChange={(checked) => setSign(checked === true)}
                />
                <span>{t("signWithKey")}</span>
              </label>
              <p
                className="break-all pl-6 font-mono text-xs text-muted-foreground"
                data-testid="template-export-fingerprint"
              >
                {identity.fingerprint}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="template-export-no-key">
              {t("noPublisherKey")}
            </p>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t("cancel")}
        </Button>
        <Button onClick={submit} disabled={selected.length === 0}>
          {t("confirm")}
        </Button>
      </DialogFooter>
    </>
  )
}
