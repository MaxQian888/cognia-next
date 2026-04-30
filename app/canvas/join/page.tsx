"use client"

/**
 * /canvas/join — entry point for shared canvas collaboration links.
 * Decodes the session payload from the `?session=` query string,
 * stores the share URL on the canvas-settings store, and switches the
 * shell to the Canvas guild. Real-time sync only kicks in if the user
 * has enabled collaboration in Settings → Canvas → Collaboration.
 */

import { Suspense, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react"
import { useUIStore } from "@/stores/ui"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"

export default function CanvasJoinPage() {
  return (
    <Suspense fallback={<JoinLoading />}>
      <CanvasJoinInner />
    </Suspense>
  )
}

function CanvasJoinInner() {
  const t = useTranslations("canvas.join")
  const router = useRouter()
  const params = useSearchParams()
  const setGuild = useUIStore((s) => s.setSelectedGuild)
  const setSettings = useCanvasSettingsStore((s) => s.updateSettings)

  const sessionParam = params?.get("session") ?? null
  const serverParam = params?.get("server") ?? null

  const [status, setStatus] = useState<"idle" | "joining" | "success" | "error">("idle")
  const [error, setError] = useState<string | null>(null)

  const decoded = useMemo(() => {
    if (!sessionParam) return null
    try {
      return JSON.parse(atob(sessionParam.replace(/-/g, "+").replace(/_/g, "/"))) as {
        sessionId?: string
        documentId?: string
        ownerId?: string
        shareUrl?: string
        permissions?: Record<string, boolean>
      }
    } catch {
      return null
    }
  }, [sessionParam])

  useEffect(() => {
    if (!sessionParam) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus("error")
      setError(t("missingPayload", { default: "No session payload was provided." }))
      return
    }
    if (!decoded) {
      setStatus("error")
      setError(t("invalid", { default: "The share link is invalid or expired." }))
      return
    }

    setStatus("joining")
    if (serverParam) {
      const errs = setSettings({
        collaboration: {
          enabled: true,
          serverUrl: serverParam,
          showCursors: true,
          showAvatars: true,
          showSelections: true,
          cursorSmoothing: true,
          presenceTimeout: 60000,
          syncInterval: 100,
        },
      })
      if (errs.length > 0) {
        setStatus("error")
        setError(errs.join("; "))
        return
      }
    }
    setGuild({ kind: "canvas" })

    setStatus("success")
  }, [decoded, sessionParam, serverParam, setGuild, setSettings, t])

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            {status === "joining" ? (
              <Loader2 className="size-5 animate-spin text-primary" />
            ) : status === "success" ? (
              <CheckCircle2 className="size-5 text-emerald-600" />
            ) : (
              <AlertCircle className="size-5 text-destructive" />
            )}
            {status === "success"
              ? t("success", { default: "Joined" })
              : status === "error"
                ? t("error", { default: "Couldn't join" })
                : t("joining", { default: "Joining…" })}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          {decoded && (
            <div className="space-y-1">
              <p>
                {t("sessionLabel", { default: "Session id" })}:{" "}
                <Badge variant="outline" className="font-mono text-[11px]">
                  {decoded.sessionId ?? "—"}
                </Badge>
              </p>
              {decoded.documentId && (
                <p>
                  {t("documentLabel", { default: "Document" })}:{" "}
                  <Badge variant="outline" className="font-mono text-[11px]">
                    {decoded.documentId}
                  </Badge>
                </p>
              )}
            </div>
          )}
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex gap-2 pt-2">
            <Button onClick={() => router.push("/")} className="flex-1">
              {t("openCanvas", { default: "Open Canvas" })}
            </Button>
            <Button variant="ghost" onClick={() => router.push("/")} className="flex-1">
              {t("home", { default: "Back home" })}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function JoinLoading() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6 text-sm text-muted-foreground">
      <Loader2 className="mr-2 size-4 animate-spin" />
      Loading…
    </div>
  )
}
