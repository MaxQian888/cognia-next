"use client"

/**
 * Opening a shared Canvas document.
 *
 * The link carries three identifiers and nothing else (see
 * `lib/canvas/collaboration/share-link.ts`). This page resolves them against
 * the joiner's own membership, loads the document, and only then opens Canvas.
 *
 * What it used to do instead: decode a JSON blob containing the session, its
 * owner, its participants and its permission flags, write an arbitrary
 * `?server=` URL into persisted settings with `enabled: true` and no
 * validation, and then report success without joining anything at all. Both
 * buttons pushed `/` and the decoded ids were dropped. It also never worked,
 * because the panel emitted raw JSON into a parameter this page `atob`ed.
 */

import { Suspense, useCallback, useEffect, useMemo } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, AlertCircle } from "lucide-react"
import { useUIStore } from "@/stores/ui"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { PageLoading } from "@/components/ui/loading-states"
import {
  isLegacyCanvasShareLink,
  parseCanvasShareLink,
  type CanvasShareTarget,
} from "@/lib/canvas/collaboration/share-link"
import { loggers } from "@cognia/logging"

export default function CanvasJoinPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <CanvasJoinInner />
    </Suspense>
  )
}

type JoinStatus = "joining" | "success" | "error"

/** What went wrong, in the joiner's terms rather than the transport's. */
type JoinFailure = "missing" | "malformed" | "expired" | "not-found"

interface JoinOutcome {
  status: JoinStatus
  failure: JoinFailure | null
  target: CanvasShareTarget | null
}

/**
 * Read the link and decide the outcome. Pure, and derived during render rather
 * than assigned from an effect, which is what the local eslint config asks for
 * and what makes the page testable without a mounted effect.
 */
function readShareLink(params: Pick<URLSearchParams, "get"> | null): JoinOutcome {
  // An old link names a session id from another device's memory and a server
  // this client must not trust. "Expired, ask for a new one" is both true and
  // actionable, unlike a decode failure.
  if (isLegacyCanvasShareLink(params)) {
    return { status: "error", failure: "expired", target: null }
  }
  const parsed = parseCanvasShareLink(params)
  if (!parsed.ok) {
    return { status: "error", failure: parsed.error, target: null }
  }
  return { status: "joining", failure: null, target: parsed.target }
}

function CanvasJoinInner() {
  const t = useTranslations("canvas.join")
  const router = useRouter()
  const params = useSearchParams()
  const setGuild = useUIStore((s) => s.setSelectedGuild)

  const link = useMemo(() => readShareLink(params), [params])
  // Resolved from this device's own workspace mirror. Fetching a document this
  // client has never seen needs the collaboration server's Canvas routes, which
  // do not exist yet, and guessing would mean opening an empty document that
  // looks like a successful join.
  const resolved = useMemo(() => {
    if (!link.target) return null
    return useArtifactStore.getState().getCanvasDocumentForWorkspace(link.target.documentId)
  }, [link.target])

  // Resolution is synchronous, so there is no in-between state to render: the
  // link either names a document this device has or it does not.
  const status: Exclude<JoinStatus, "joining"> =
    link.status === "error" ? "error" : resolved ? "success" : "error"
  const failure: JoinFailure | null = link.failure ?? (resolved ? null : "not-found")

  const openCanvas = useCallback(() => {
    if (resolved) useArtifactStore.getState().setActiveCanvas(resolved.id)
    setGuild({ kind: "canvas" })
    router.push("/")
  }, [resolved, router, setGuild])

  useEffect(() => {
    if (link.target && !resolved) {
      loggers.canvas.info("canvas join: document not available on this device", {
        documentId: link.target.documentId,
      })
    }
  }, [link.target, resolved])

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md" data-testid="canvas-join-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            {status === "success" ? (
              <CheckCircle2 className="size-5 text-emerald-600" />
            ) : (
              <AlertCircle className="size-5 text-destructive" />
            )}
            {status === "success" ? t("success") : t("error")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          {link.target && (
            <p>
              {t("documentLabel")}:{" "}
              <Badge variant="outline" className="font-mono text-[11px]">
                {link.target.documentId}
              </Badge>
            </p>
          )}
          {failure && (
            <p className="text-destructive" data-testid="canvas-join-error">
              {t(`failure.${failure}`)}
            </p>
          )}
          <div className="flex gap-2 pt-2">
            {/*
              Only offered on success. It used to be shown for every outcome,
              next to a "Back home" button that did exactly the same thing.
            */}
            {status === "success" && (
              <Button onClick={openCanvas} className="flex-1" data-testid="canvas-join-open">
                {t("openCanvas")}
              </Button>
            )}
            <Button variant="ghost" onClick={() => router.push("/")} className="flex-1">
              {t("home")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
