"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

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
import { saveBinaryFileAs } from "@/lib/files/file-bridge"
import { cogpackFilename } from "@/lib/plugin/cogpack/manifest"
import {
  exportCogsetPreview,
  previewCogsetExport,
  suggestCogpackId,
  type CogpackExportPreview,
  type CogpackExportPreviewMember,
} from "@/lib/plugin/cogpack/export"
import { isTauri } from "@/lib/tauri"
import { createPublisherSigner, getPublisherIdentity } from "@/lib/templates/publisher-identity"
import { PACKAGE_ID, SEMVER } from "@/lib/templates/package-manifest"
import { COGPACK_FILE_EXTENSION, type CogsetRow } from "@/types/plugin/plugin-cogset"

export interface CogpackExportDialogProps {
  cogset: CogsetRow | null
  onOpenChange: (open: boolean) => void
  displayName: (cogset: Pick<CogsetRow, "name" | "source">) => string
  pluginName: (pluginId: string) => string
}

function SourceLabel({ member }: { member: CogpackExportPreviewMember }) {
  const t = useTranslations("plugins.cogpacks.export")
  const source = member.source
  switch (source.kind) {
    case "embedded":
      return <Badge variant="secondary">{t("embedded")}</Badge>
    case "github":
    case "git":
      return (
        <Badge variant="outline">
          {t(`source.${source.kind}`, { commit: source.commit.slice(0, 7) })}
        </Badge>
      )
    case "registry":
    case "openvsx":
      return (
        <Badge variant="outline">{t(`source.${source.kind}`, { version: source.version })}</Badge>
      )
    default:
      return <Badge variant="outline">{t(`source.${source.kind}`)}</Badge>
  }
}

/**
 * Review, then export a cogset as a `.cogpack` (ADR-0209). Every value that
 * leaves the device is shown, member by member, and can be left out.
 */
export function CogpackExportDialog({
  cogset,
  onOpenChange,
  displayName,
  pluginName,
}: CogpackExportDialogProps) {
  const t = useTranslations("plugins.cogpacks.export")
  const [preview, setPreview] = useState<CogpackExportPreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [id, setId] = useState("")
  const [version, setVersion] = useState("1.0.0")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [withoutConfig, setWithoutConfig] = useState<Set<string>>(new Set())
  const [hasKey, setHasKey] = useState(false)
  const [sign, setSign] = useState(true)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!cogset) return
    let cancelled = false
    void (async () => {
      try {
        const [next, identity] = await Promise.all([
          previewCogsetExport(cogset.id),
          getPublisherIdentity().catch(() => null),
        ])
        if (cancelled) return
        setPreview(next)
        setHasKey(identity !== null)
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [cogset])

  // Reset the form for each cogset the dialog opens on.
  const [formFor, setFormFor] = useState<string | null>(null)
  if (cogset && formFor !== cogset.id) {
    setFormFor(cogset.id)
    setPreview(null)
    setLoadError(null)
    setId(suggestCogpackId(displayName(cogset)))
    setVersion("1.0.0")
    setName(displayName(cogset))
    setDescription(cogset.description ?? "")
    setWithoutConfig(new Set())
    setSign(true)
    setTouched(false)
  }

  const idValid = PACKAGE_ID.test(id)
  const versionValid = SEMVER.test(version)
  const nameValid = name.trim().length > 0
  const needsDesktop = !!preview?.members.some((m) => m.source.kind === "embedded") && !isTauri()
  const canExport =
    !!preview && preview.members.length > 0 && idValid && versionValid && nameValid && !needsDesktop

  const submit = async () => {
    setTouched(true)
    if (!preview || !canExport) return
    setBusy(true)
    try {
      const signer = sign ? await createPublisherSigner() : undefined
      const exported = await exportCogsetPreview({
        preview,
        id,
        version,
        name: name.trim(),
        description: description.trim() || undefined,
        withoutConfig,
        signer,
      })
      const file = cogpackFilename(exported.manifest)
      const saved = await saveBinaryFileAs({
        defaultName: file,
        bytes: exported.bytes,
        filters: [{ name: t("fileFilter"), extensions: [COGPACK_FILE_EXTENSION.slice(1)] }],
        mimeType: "application/zip",
      })
      if (saved) {
        toast.success(t("saved", { file }))
        onOpenChange(false)
      }
    } catch (error) {
      toast.error(t("failed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  const names = (ids: readonly string[]) => ids.map(pluginName).join(", ")

  return (
    <Dialog open={cogset !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85dvh] w-[95vw] max-w-2xl flex-col"
        data-testid="cogpack-export"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("title", { name: cogset ? displayName(cogset) : "" })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-1">
          {loadError && (
            <div className="space-y-1 text-sm" role="alert">
              <p className="font-medium text-destructive">{t("loadFailed")}</p>
              <p className="text-xs break-words text-muted-foreground">{loadError}</p>
            </div>
          )}
          {!preview && !loadError && (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          )}
          {preview && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="cogpack-id">{t("id")}</Label>
                  <Input
                    id="cogpack-id"
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    aria-invalid={touched && !idValid}
                  />
                  <p className="text-xs text-muted-foreground">
                    {touched && !idValid ? t("invalidId") : t("idHint")}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cogpack-version">{t("version")}</Label>
                  <Input
                    id="cogpack-version"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    aria-invalid={touched && !versionValid}
                  />
                  {touched && !versionValid && (
                    <p className="text-xs text-destructive">{t("invalidVersion")}</p>
                  )}
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="cogpack-name">{t("name")}</Label>
                  <Input
                    id="cogpack-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-invalid={touched && !nameValid}
                  />
                  {touched && !nameValid && (
                    <p className="text-xs text-destructive">{t("nameRequired")}</p>
                  )}
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="cogpack-description">{t("description")}</Label>
                  <Textarea
                    id="cogpack-description"
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <h3 className="text-sm font-medium">{t("members")}</h3>
                {preview.members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("empty")}</p>
                ) : (
                  <ul className="divide-y rounded-md border text-sm">
                    {preview.members.map((member) => {
                      const includeId = `cogpack-include-${member.pluginId}`
                      return (
                        <li
                          key={member.pluginId}
                          className="space-y-1.5 px-3 py-2"
                          data-testid={`cogpack-export-member-${member.pluginId}`}
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium break-words">{member.name}</span>
                            <span className="text-xs text-muted-foreground">{member.version}</span>
                            <SourceLabel member={member} />
                          </div>
                          {member.config && (
                            <div className="space-y-1">
                              <label
                                htmlFor={includeId}
                                className="flex items-center gap-1.5 text-xs"
                              >
                                <Checkbox
                                  id={includeId}
                                  checked={!withoutConfig.has(member.pluginId)}
                                  onCheckedChange={(checked) =>
                                    setWithoutConfig((current) => {
                                      const next = new Set(current)
                                      if (checked === true) next.delete(member.pluginId)
                                      else next.add(member.pluginId)
                                      return next
                                    })
                                  }
                                />
                                {t("includeSettings")}
                              </label>
                              <pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-xs break-all whitespace-pre-wrap">
                                {JSON.stringify(member.config, null, 2)}
                              </pre>
                            </div>
                          )}
                          {member.secretFields.length > 0 && (
                            <p className="text-xs text-muted-foreground">
                              {t("secretsLeftOut", { fields: member.secretFields.join(", ") })}
                            </p>
                          )}
                          {member.licenseText && (
                            <p className="text-xs text-muted-foreground">{t("license")}</p>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              {preview.missing.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("missing", { names: names(preview.missing) })}
                </p>
              )}
              {preview.unportable.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("unportable", { names: preview.unportable.map((u) => u.name).join(", ") })}
                </p>
              )}
              {preview.alwaysOnExcluded.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("alwaysOnExcluded", { names: names(preview.alwaysOnExcluded) })}
                </p>
              )}
              {needsDesktop && (
                <p className="text-sm text-destructive" role="alert">
                  {t("needsDesktop")}
                </p>
              )}

              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={sign}
                  onCheckedChange={(checked) => setSign(checked === true)}
                  className="mt-0.5"
                />
                <span className="flex flex-col">
                  <span>{hasKey ? t("sign") : t("signCreate")}</span>
                  <span className="text-xs text-muted-foreground">{t("signHint")}</span>
                </span>
              </label>
            </>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || !preview || (touched && !canExport)}
            data-testid="cogpack-export-submit"
          >
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
