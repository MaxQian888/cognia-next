"use client"

/**
 * "Share via link" entry for the Discover inspector.
 *
 * Two routes. The four portable definition kinds (character / skill / team /
 * workflowTemplate) are sanitized into a `SharedDiscoverDefinition` and shared
 * as `discover-item`. Squad templates (`teamTemplate`) are template-platform
 * releases, so they are shared whole as `template-definition`, which the
 * recipient can hash-verify. Everything else renders nothing (config /
 * credentials and personal twin data are never publicly shareable).
 *
 * Privacy gate: the sanitized definition is scanned with `hasNoLeakingPii`
 * BEFORE anything is encrypted/uploaded. Clean → opens `ShareLinkDialog`
 * directly. PII detected → a confirm step offers "remove and continue"
 * (default-safe redaction) or "share anyway", mirroring the mobile twin
 * redact-review flow. The dialog's own preview lets the owner see exactly what
 * recipients receive before publishing.
 */

import { useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Link2Icon, ShieldAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ShareLinkDialog } from "@/components/share/share-link-dialog"
import { TemplateDefinitionShareButton } from "@/components/share/template-definition-share-button"
import { useTemplateCatalog } from "@/hooks/use-template-catalog"
import { discoverItemPayload } from "@/lib/share/payload"
import {
  buildSharedDefinition,
  definitionHasPii,
  parseTeamTemplateDefinitionRef,
  redactSharedDefinition,
  type SharedDiscoverDefinition,
} from "@/lib/share/discover-item"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

/**
 * Squad templates take the other route.
 *
 * They have no `SharedDiscoverDefinition` projection, because they are not a
 * fifth hand-sanitized shape: they ARE template-platform releases, and the
 * `template-definition` kind carries one whole, with a content hash the
 * recipient can verify. Everything else keeps the sanitize-and-redact path.
 */
export function DiscoverShareButton({ item }: { item: DiscoverItem }) {
  if (item.kind === "teamTemplate") return <TeamTemplateShareButton itemId={item.id} />
  return <PortableDefinitionShareButton item={item} />
}

function TeamTemplateShareButton({ itemId }: { itemId: string }) {
  const t = useTranslations("discover.share")
  // The same snapshot the Discover query itself reads, so the row and the
  // release behind it can never disagree about which envelope is current.
  const { definitions } = useTemplateCatalog({ domain: "agentTeam" })
  const definition = useMemo(() => {
    const ref = parseTeamTemplateDefinitionRef(itemId)
    if (!ref) return undefined
    return definitions.find(
      (candidate) => candidate.id === ref.definitionId && candidate.version === ref.version
    )
  }, [definitions, itemId])

  if (!definition) {
    return (
      <div className="self-start" data-testid="discover-team-template-share">
        <Button type="button" variant="outline" disabled>
          <Link2Icon className="size-4" />
          {t("action")}
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">{t("teamTemplateUnavailable")}</p>
      </div>
    )
  }
  return <TemplateDefinitionShareButton definition={definition} className="self-start" />
}

function PortableDefinitionShareButton({ item }: { item: DiscoverItem }) {
  const t = useTranslations("discover.share")
  const locale = useLocale()
  const def = useMemo(
    () => buildSharedDefinition(item, locale === "zh-CN" ? "zh-CN" : "en"),
    [item, locale]
  )
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [pendingDef, setPendingDef] = useState<SharedDiscoverDefinition | null>(null)

  if (!def) return null

  const onShareClick = () => {
    if (definitionHasPii(def)) {
      setConfirmOpen(true)
    } else {
      setPendingDef(def)
      setShareOpen(true)
    }
  }

  const continueWith = (redact: boolean) => {
    setPendingDef(redact ? redactSharedDefinition(def) : def)
    setConfirmOpen(false)
    setShareOpen(true)
  }

  const active = pendingDef ?? def

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={onShareClick}
        data-testid="discover-share-button"
      >
        <Link2Icon className="size-4" />
        {t("action")}
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlertIcon className="size-4 text-destructive" />
              {t("piiTitle")}
            </DialogTitle>
            <DialogDescription>{t("piiBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              data-testid="discover-share-cancel"
            >
              {t("cancel")}
            </Button>
            <Button
              variant="outline"
              onClick={() => continueWith(false)}
              data-testid="discover-share-original"
            >
              {t("shareOriginal")}
            </Button>
            <Button onClick={() => continueWith(true)} data-testid="discover-share-redacted">
              {t("shareRedacted")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShareLinkDialog
        open={shareOpen}
        onOpenChange={(open) => {
          setShareOpen(open)
          if (!open) setPendingDef(null)
        }}
        buildPayload={() => discoverItemPayload(active, active.name)}
      />
    </>
  )
}
