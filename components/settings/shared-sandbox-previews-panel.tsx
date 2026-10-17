"use client"

import { useId } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useSharedSandboxPreviews } from "@/hooks/sandbox/use-shared-sandbox-previews"
import type { RemoteHostEndpoint } from "@/lib/tauri/transport-routing"

/** On a paired desktop: the preview grants the Host owner shared with this device. */
export function SharedSandboxPreviewsPanel({
  endpoint,
  projectId,
}: {
  endpoint: RemoteHostEndpoint
  projectId: string
}) {
  const t = useTranslations("sandboxManagement")
  const id = useId()
  const state = useSharedSandboxPreviews(endpoint, projectId)

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 border-t pt-3">
      <h4 id={`${id}-title`} className="text-sm font-medium">
        {t("shared.title")}
      </h4>
      <p className="text-xs text-muted-foreground">{t("shared.description")}</p>
      <Button
        size="sm"
        variant="outline"
        disabled={state.busy || state.loading}
        onClick={() => void state.refresh()}
      >
        {t("refresh")}
      </Button>
      {state.error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`shared.errors.${state.error}`)}
        </p>
      ) : null}
      {state.loading ? (
        <p role="status" className="text-xs">
          {t("loading")}
        </p>
      ) : !state.previews.length ? (
        <p className="text-xs text-muted-foreground">{t("shared.empty")}</p>
      ) : null}
      <ul className="space-y-2">
        {state.previews.map((preview) => {
          const minutes = Math.max(0, Math.ceil((preview.expiresAt - state.checkedAt) / 60_000))
          const opened = state.opened[preview.id]
          return (
            <li key={preview.id} className="space-y-2 rounded-md border p-3">
              <p className="text-xs">
                {t("shared.port", { port: preview.resolvedPort, workspace: preview.workspaceId })}
              </p>
              <p className="text-xs text-muted-foreground">{t("shared.remaining", { minutes })}</p>
              {opened ? <p className="break-all text-xs">{opened}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.busy}
                  onClick={() => void state.open(preview.id)}
                >
                  {t("shared.open")}
                </Button>
                {opened ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={state.busy}
                    onClick={() => void state.close(preview.id)}
                  >
                    {t("shared.close")}
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
