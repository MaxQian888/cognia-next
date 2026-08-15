"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import DOMPurify from "dompurify"
import type { FileViewerRenderProps } from "@/lib/file-viewer/types"

/**
 * Sandboxed HTML preview.
 *
 * Two things are non-negotiable here and are pinned by tests:
 *
 * `allow-same-origin` is never granted. Without it the frame runs in an opaque
 * origin and cannot reach the host document at all.
 *
 * `connect-src 'none'` closes the hole the old project preview left open. That
 * one granted `allow-scripts` with no CSP, so a previewed file could `fetch()`
 * its own contents to any origin — the opaque origin stops a frame reading the
 * host, not talking to the network.
 *
 * Scripts stay enabled for the project preview because that markup is the
 * user's own draft and disabling them would quietly break every existing
 * preview. They are disabled for a terminal link, where the file is far more
 * likely to be tool-generated or downloaded than authored, and the body is
 * sanitised as well — belt and braces, since a frame that cannot run scripts
 * gains nothing from carrying them.
 *
 * `allow-forms`, `allow-modals` and `allow-popups` are gone. Popups let a
 * preview spawn windows and modals let it `alert()`-loop the app; neither is
 * needed to look at a page.
 */
export default function HtmlViewer({ text, source }: FileViewerRenderProps) {
  const t = useTranslations("fileViewer")
  const scriptsAllowed = source === "project-preview"

  const srcDoc = useMemo(() => {
    const body = scriptsAllowed ? text : DOMPurify.sanitize(text, { WHOLE_DOCUMENT: true })
    const scriptPolicy = scriptsAllowed ? "; script-src 'unsafe-inline'" : ""
    // No `blob:` in img-src/media-src: a `srcDoc` frame mints no blob URLs, so
    // allowing them would only widen the policy for nothing.
    const csp =
      "default-src 'none'; connect-src 'none'; img-src data:; media-src data:; " +
      `style-src 'unsafe-inline'${scriptPolicy}`
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><body>${body}</body>`
  }, [scriptsAllowed, text])

  return (
    <iframe
      className="h-full w-full border-0 bg-white"
      sandbox={scriptsAllowed ? "allow-scripts" : ""}
      srcDoc={srcDoc}
      title={t("frameTitle")}
      data-testid="project-html-preview"
    />
  )
}
