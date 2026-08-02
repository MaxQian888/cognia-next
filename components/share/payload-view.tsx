"use client"

/**
 * Renders a decrypted share payload by kind. This is the single rendering unit
 * for the public share viewer (`app/share/view`) and for the owner's
 * preview-before-publish in `share-link-dialog`. It runs unchanged inside the
 * desktop (Tauri) shell and on the public Cloudflare Pages deployment.
 *
 * Security-critical: HTML conversations render inside a sandboxed iframe so a
 * shared document can never script the viewer origin. The two sandbox levels
 * are intentional and must not be widened:
 *   - `chat-html`     → `sandbox=""`            (no scripts)
 *   - `chat-animated` → `sandbox="allow-scripts"` (animations need JS)
 *
 * A2UI apps render for real (ADR-0037 Phase 4) via the app's own renderer in
 * read-only mode — user actions are inert, so a public viewer can't be driven
 * to navigate or exfiltrate.
 */

import { useEffect, useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AnimatedActionIcon, CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { DownloadIcon as AnimatedDownloadIcon } from "@/components/ui/download"
import { cn } from "@/lib/utils"
import { downloadBlob, copyBlobToClipboard } from "@/lib/files/download"
import { useA2UIStore } from "@/stores/a2ui"
import { createA2UISurface } from "@/lib/a2ui/parser"
import { A2UISurface } from "@/components/a2ui/a2ui-surface"
import type { A2UIComponent, A2UISurfaceType } from "@/types/a2ui/schema"
import type { SharePayload } from "@/lib/share/types"
import type { SharedDiscoverDefinition } from "@/lib/share/discover-item"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"

export function PayloadView({ payload, className }: { payload: SharePayload; className?: string }) {
  switch (payload.kind) {
    case "chat-html":
    // Usage cards and message quote cards are self-contained static HTML —
    // same no-script sandbox.
    case "usage-card":
    case "chat-quote":
      return <HtmlFrame html={payload.data} allowScripts={false} className={className} />
    case "chat-animated":
      return <HtmlFrame html={payload.data} allowScripts className={className} />
    case "chat-md":
      return <MarkdownText text={payload.data} title={payload.title} className={className} />
    case "chat-json":
    case "chat-text":
      return <PreText text={payload.data} title={payload.title} className={className} />
    case "workflow-png":
      return (
        <ImageView
          dataB64={payload.data}
          mime={payload.mime}
          title={payload.title}
          className={className}
        />
      )
    case "backup":
      return <BackupCard payload={payload} className={className} />
    case "a2ui":
      return <A2UIShareView payload={payload} className={className} />
    case "discover-item":
      return <DiscoverItemView payload={payload} className={className} />
  }
}

function MarkdownText({
  text,
  title,
  className,
}: {
  text: string
  title?: string
  className?: string
}) {
  return (
    <article className={cn("mx-auto w-full max-w-3xl", className)}>
      {title ? <h1 className="mb-4 text-xl font-semibold text-foreground">{title}</h1> : null}
      <MarkdownRenderer
        content={text}
        enableEnhancedImages={false}
        className="rounded-lg border border-border bg-muted/20 p-4"
      />
    </article>
  )
}

function DiscoverItemView({ payload, className }: { payload: SharePayload; className?: string }) {
  const t = useTranslations("share.view")
  const def = useMemo<SharedDiscoverDefinition | null>(() => {
    try {
      const parsed = JSON.parse(payload.data) as Partial<SharedDiscoverDefinition>
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.kind === "string" &&
        typeof parsed.name === "string"
      ) {
        return parsed as SharedDiscoverDefinition
      }
    } catch {
      // fall through to the invalid state below
    }
    return null
  }, [payload.data])

  if (!def) {
    return (
      <div className={cn("mx-auto max-w-md text-center text-sm text-muted-foreground", className)}>
        {t("discoverItem.invalid")}
      </div>
    )
  }

  return (
    <div className={cn("mx-auto w-full max-w-3xl space-y-4", className)}>
      <div>
        <span className="inline-block rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t(`discoverItem.kind.${def.kind}`)}
        </span>
        <h1 className="mt-2 text-xl font-semibold text-foreground">{def.name}</h1>
        {def.description ? (
          <p className="mt-1 text-sm text-muted-foreground">{def.description}</p>
        ) : null}
      </div>

      {def.kind === "character" ? (
        <>
          <DiscoverField label={t("discoverItem.systemPrompt")} body={def.systemPrompt} />
          {def.model ? <DiscoverInline label={t("discoverItem.model")} value={def.model} /> : null}
        </>
      ) : null}

      {def.kind === "skill" ? (
        <>
          <DiscoverField label={t("discoverItem.content")} body={def.content} />
          {def.tags?.length ? (
            <DiscoverInline label={t("discoverItem.tags")} value={def.tags.join(", ")} />
          ) : null}
        </>
      ) : null}

      {def.kind === "team" ? (
        <div className="space-y-2">
          <DiscoverInline label={t("discoverItem.orchestration")} value={def.orchestration} />
          <p className="text-xs font-medium text-muted-foreground">{t("discoverItem.members")}</p>
          <ul className="space-y-2">
            {def.members.map((m, i) => (
              <li key={i} className="rounded-md border border-border bg-muted/30 p-2 text-sm">
                <span className="font-medium text-foreground">
                  {m.role || t("discoverItem.memberRole", { index: i + 1 })}
                </span>
                {m.systemPromptOverride ? (
                  <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                    {m.systemPromptOverride}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-xs italic text-muted-foreground">{t("discoverItem.teamNote")}</p>
        </div>
      ) : null}

      {def.kind === "workflowTemplate" ? (
        <div className="space-y-2">
          {def.tags?.length ? (
            <DiscoverInline label={t("discoverItem.tags")} value={def.tags.join(", ")} />
          ) : null}
          <p className="text-xs font-medium text-muted-foreground">{t("discoverItem.slots")}</p>
          <ul className="space-y-1">
            {def.slots.map((slot) => (
              <li
                key={slot.key}
                className="rounded-md border border-border bg-muted/30 p-2 text-sm"
              >
                <span className="font-medium text-foreground">{slot.label}</span>
                <span className="ml-2 text-xs text-muted-foreground">{slot.type}</span>
                {slot.required ? (
                  <span className="ml-2 text-xs text-destructive">
                    {t("discoverItem.slotRequired")}
                  </span>
                ) : null}
                {slot.description ? (
                  <p className="mt-1 text-xs text-muted-foreground">{slot.description}</p>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-xs italic text-muted-foreground">{t("discoverItem.templateNote")}</p>
        </div>
      ) : null}
    </div>
  )
}

function DiscoverField({ label, body }: { label: string; body: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
        {body}
      </pre>
    </div>
  )
}

function DiscoverInline({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-sm text-foreground">
      <span className="text-muted-foreground">{label}: </span>
      {value}
    </p>
  )
}

function HtmlFrame({
  html,
  allowScripts,
  className,
}: {
  html: string
  allowScripts: boolean
  className?: string
}) {
  const t = useTranslations("share.view")
  return (
    <iframe
      className={cn(
        "h-full min-h-[60vh] w-full rounded-lg border border-border bg-white",
        className
      )}
      title={t("conversationTitle")}
      sandbox={allowScripts ? "allow-scripts" : ""}
      srcDoc={html}
    />
  )
}

function PreText({ text, title, className }: { text: string; title?: string; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-3xl", className)}>
      {title ? <h1 className="mb-4 text-xl font-semibold text-foreground">{title}</h1> : null}
      <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-4 text-sm text-foreground">
        {text}
      </pre>
    </div>
  )
}

function ImageView({
  dataB64,
  mime,
  title,
  className,
}: {
  dataB64: string
  mime: string
  title?: string
  className?: string
}) {
  const t = useTranslations("share.view")
  const [copied, setCopied] = useState(false)
  const blob = useMemo(
    () => new Blob([base64ToBytes(dataB64) as BlobPart], { type: mime || "image/png" }),
    [dataB64, mime]
  )
  const filename = `${slug(title) || "cognia-image"}.${mime.includes("png") ? "png" : "img"}`

  const onCopy = async () => {
    if (await copyBlobToClipboard(blob)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className={cn("mx-auto flex w-full max-w-4xl flex-col items-center gap-4", className)}>
      {title ? <h1 className="text-xl font-semibold text-foreground">{title}</h1> : null}
      {/* eslint-disable-next-line @next/next/no-img-element -- raw data URL, not an optimizable asset */}
      <img
        className="max-w-full rounded-lg border border-border"
        alt={title ?? t("workflowAlt")}
        src={`data:${mime};base64,${dataB64}`}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => downloadBlob(blob, filename)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <AnimatedActionIcon icon={AnimatedDownloadIcon} size={14} />
          {t("downloadImage")}
        </button>
        <button
          type="button"
          onClick={() => void onCopy()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <CopyFeedbackIcon copied={copied} size={14} />
          {copied ? t("copyImageDone") : t("copyImage")}
        </button>
      </div>
    </div>
  )
}

function BackupCard({ payload, className }: { payload: SharePayload; className?: string }) {
  const t = useTranslations("share.view")
  const href = useMemo(() => {
    const bytes =
      payload.encoding === "base64"
        ? base64ToBytes(payload.data)
        : new TextEncoder().encode(payload.data)
    const blob = new Blob([bytes as BlobPart], { type: payload.mime || "application/json" })
    return URL.createObjectURL(blob)
  }, [payload])

  return (
    <div className={cn("mx-auto flex max-w-md flex-col items-center gap-4 text-center", className)}>
      <h1 className="text-xl font-semibold text-foreground">{payload.title ?? t("backupTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("backupBody")}</p>
      <a
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        href={href}
        download={`${slug(payload.title) || "cognia-backup"}.json`}
      >
        {t("download")}
      </a>
    </div>
  )
}

interface ExportedA2UIApp {
  components?: unknown
  dataModel?: Record<string, unknown>
  surfaceType?: A2UISurfaceType
  title?: string
}

function A2UIShareView({ payload, className }: { payload: SharePayload; className?: string }) {
  const t = useTranslations("share.view")
  const processMessages = useA2UIStore((s) => s.processMessages)
  const deleteSurface = useA2UIStore((s) => s.deleteSurface)
  const surfaceId = useId()

  // Validity is a pure function of the payload, so derive it during render
  // instead of pushing it through an effect's setState (cascading renders).
  const app = useMemo<ExportedA2UIApp | null>(() => {
    try {
      const parsed = JSON.parse(payload.data) as { app?: ExportedA2UIApp }
      const candidate = parsed?.app
      if (candidate && Array.isArray(candidate.components)) {
        return candidate
      }
    } catch {
      // fall through to the invalid state below
    }
    return null
  }, [payload.data])

  useEffect(() => {
    if (!app) return
    const messages = createA2UISurface(
      surfaceId,
      app.components as A2UIComponent[],
      app.dataModel ?? {},
      { surfaceType: app.surfaceType ?? "inline", title: app.title }
    )
    processMessages(messages)
    return () => deleteSurface(surfaceId)
  }, [app, surfaceId, processMessages, deleteSurface])

  if (!app) {
    return (
      <div className={cn("mx-auto max-w-md text-center text-sm text-muted-foreground", className)}>
        {t("appInvalid")}
      </div>
    )
  }

  return (
    <div className={cn("mx-auto flex w-full max-w-4xl flex-col gap-2", className)}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("a2uiReadonly")}
      </p>
      <A2UISurface surfaceId={surfaceId} readOnly showLoading={false} />
    </div>
  )
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function slug(title?: string): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
