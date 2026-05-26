import { useMemo } from "react"
import type { SharePayload } from "@/lib/share/types"

/**
 * Renders a decrypted payload by kind. HTML goes into a sandboxed iframe so the
 * shared document can never script the viewer origin; text formats render as
 * preformatted text; images as a data URL; backups as a download.
 */
export function PayloadView({ payload }: { payload: SharePayload }) {
  switch (payload.kind) {
    case "chat-html":
      return <HtmlFrame html={payload.data} allowScripts={false} title={payload.title} />
    case "chat-animated":
      return <HtmlFrame html={payload.data} allowScripts title={payload.title} />
    case "chat-md":
    case "chat-json":
    case "chat-text":
      return <PreText text={payload.data} title={payload.title} />
    case "workflow-png":
      return <ImageView dataB64={payload.data} mime={payload.mime} title={payload.title} />
    case "backup":
      return <DownloadCard payload={payload} kind="backup" />
    case "a2ui":
      return <DownloadCard payload={payload} kind="a2ui" />
  }
}

function HtmlFrame({
  html,
  allowScripts,
  title,
}: {
  html: string
  allowScripts: boolean
  title?: string
}) {
  return (
    <iframe
      className="viewer__frame"
      title={title ?? "Shared conversation"}
      sandbox={allowScripts ? "allow-scripts" : ""}
      srcDoc={html}
    />
  )
}

function PreText({ text, title }: { text: string; title?: string }) {
  return (
    <div className="viewer__doc">
      {title ? <h1>{title}</h1> : null}
      <pre className="viewer__pre">{text}</pre>
    </div>
  )
}

function ImageView({ dataB64, mime, title }: { dataB64: string; mime: string; title?: string }) {
  return (
    <div className="viewer__doc viewer__doc--center">
      {title ? <h1>{title}</h1> : null}
      <img
        className="viewer__img"
        alt={title ?? "Shared workflow"}
        src={`data:${mime};base64,${dataB64}`}
      />
    </div>
  )
}

const DOWNLOAD_COPY: Record<
  "backup" | "a2ui",
  { fallbackTitle: string; body: string; file: string }
> = {
  backup: {
    fallbackTitle: "Shared backup",
    body: "This is a cognia backup package. Download it, then import it from Settings → Data.",
    file: "cognia-backup",
  },
  a2ui: {
    fallbackTitle: "Shared app",
    body: "This is a cognia app. Download it, then import it in cognia to view and run it interactively.",
    file: "cognia-app",
  },
}

function DownloadCard({ payload, kind }: { payload: SharePayload; kind: "backup" | "a2ui" }) {
  const copy = DOWNLOAD_COPY[kind]
  const href = useMemo(() => {
    const bytes =
      payload.encoding === "base64"
        ? base64ToBytes(payload.data)
        : new TextEncoder().encode(payload.data)
    const blob = new Blob([bytes as BlobPart], { type: payload.mime || "application/json" })
    return URL.createObjectURL(blob)
  }, [payload])

  return (
    <div className="viewer__centered">
      <h1>{payload.title ?? copy.fallbackTitle}</h1>
      <p>{copy.body}</p>
      <a
        className="viewer__button"
        href={href}
        download={`${slug(payload.title) || copy.file}.json`}
      >
        Download
      </a>
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
