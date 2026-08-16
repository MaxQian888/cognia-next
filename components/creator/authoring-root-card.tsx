"use client"

/**
 * Authoring-root grant UI (ADR-0117, Phase 3).
 *
 * The grant is an explicit user gesture and nothing else. There is no "use the
 * current workspace" shortcut, because that is precisely the affordance a
 * prompt-injected instruction would reach for — the whole point of the root is
 * that a model cannot talk Creator into a directory the user did not pick.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderOpen, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { useCreatorStore } from "@/stores/creator/creator-store"
import type { AuthoringRootRejection } from "@/lib/creator/authoring-root"

export function AuthoringRootCard() {
  const t = useTranslations("creator.root")
  const root = useCreatorStore((state) => state.authoringRoot)
  const grantAuthoringRoot = useCreatorStore((state) => state.grantAuthoringRoot)
  const revokeAuthoringRoot = useCreatorStore((state) => state.revokeAuthoringRoot)
  const [rejection, setRejection] = useState<AuthoringRootRejection | null>(null)
  const [busy, setBusy] = useState(false)

  const choose = useCallback(async () => {
    setRejection(null)
    if (!canUseTauriInvoke()) return
    setBusy(true)
    try {
      const dialog = await import("@tauri-apps/plugin-dialog")
      const picked = await dialog.open({
        directory: true,
        multiple: false,
        title: t("choose"),
      })
      if (typeof picked !== "string") return // cancelled
      const result = grantAuthoringRoot({ path: picked, now: Date.now() })
      if (!result.ok) setRejection(result.reason)
    } finally {
      setBusy(false)
    }
  }, [grantAuthoringRoot, t])

  const hostSupported = canUseTauriInvoke()

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
          {t("title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {root ? (
        <div className="space-y-2">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="font-medium">{root.label}</span>
            <span className="text-xs text-muted-foreground">{t(`origin.${root.origin}`)}</span>
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {t("pathLabel")}: {root.path}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={choose} disabled={busy || !hostSupported}>
              {t("change")}
            </Button>
            <Button size="sm" variant="ghost" onClick={revokeAuthoringRoot}>
              {t("revoke")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
          <Button size="sm" onClick={choose} disabled={busy || !hostSupported}>
            <FolderOpen className="size-4" aria-hidden />
            {t("choose")}
          </Button>
        </div>
      )}

      {rejection ? (
        <p className="text-xs text-destructive" role="alert">
          {t(`rejected.${rejection}`)}
        </p>
      ) : null}
    </section>
  )
}

export default AuthoringRootCard
