"use client"

/**
 * The listener `ctx.permissions.requestPermission()` never had.
 *
 * `lib/plugin/security/permission-requests.ts` implements a proper queue:
 * `requestPluginPermission` enqueues, stores the promise's resolver, and
 * returns the promise. `subscribePermissionRequests` and
 * `resolvePluginPermission` had ZERO callers outside that module's own test,
 * so nothing ever rendered a prompt and nothing ever called the resolver. A
 * plugin asking for an optional permission at runtime awaited a promise that
 * could not settle, and the call hung for the life of the session.
 *
 * This is not the same surface as `PluginConsentOverlay`. That one answers the
 * consent broker's tier-`"confirm"` interception of a call the plugin already
 * had permission to attempt, and it auto-rejects on a timeout. This one
 * answers a plugin explicitly asking to be GRANTED something, which has no
 * timeout and no "always" tier.
 *
 * Mounted at the app root next to the other plugin hosts: a plugin can ask
 * from any page, so a host that only exists on `/plugins` would reintroduce
 * the hang everywhere else.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { KeyRoundIcon } from "lucide-react"

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
import {
  resolvePluginPermission,
  subscribePermissionRequests,
  type PermissionRequestState,
} from "@/lib/plugin/security/permission-requests"

const EMPTY: PermissionRequestState = { current: null, queue: [] }

export function PluginPermissionRequestHost() {
  const t = useTranslations("plugins.permissionRequest")
  const [state, setState] = useState<PermissionRequestState>(EMPTY)

  useEffect(() => subscribePermissionRequests(setState), [])

  const request = state.current
  if (!request) return null

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Dismissing has to resolve, not just close: the plugin is awaiting
        // this promise, and leaving it pending is the exact hang this host
        // exists to end. Dismissal is a denial.
        if (!open) resolvePluginPermission(request.id, false)
      }}
    >
      <AlertDialogContent data-testid="plugin-permission-request">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <KeyRoundIcon className="size-4 shrink-0" />
            {t("title", { plugin: request.pluginId })}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("permissionLabel")}</span>
                <Badge variant="outline" className="font-mono text-xs">
                  {request.permission}
                </Badge>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">{t("reasonLabel")}</span>
                <p className="text-xs">{request.reason || t("noReason")}</p>
              </div>
              {/* A manifest-declared permission and one invented at runtime are
                  very different asks, and the queue already distinguishes them. */}
              <p className="text-xs text-muted-foreground">
                {request.kind === "manifest" ? t("manifestHint") : t("apiHint")}
              </p>
              <p className="text-xs text-muted-foreground">{t("denyOnDismissHint")}</p>
              {state.queue.length > 0 && (
                <p className="text-xs text-muted-foreground" data-testid="plugin-permission-queued">
                  {t("queued", { count: state.queue.length })}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => resolvePluginPermission(request.id, false)}>
            {t("deny")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => resolvePluginPermission(request.id, true)}
            data-testid="plugin-permission-allow"
          >
            {t("allow")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
