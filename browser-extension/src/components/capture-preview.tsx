import type { BrowserCaptureMode, BrowserContextLimits } from "@cognia/companion-client"
import { utf8ByteLength } from "@cognia/companion-client"
import { Badge, Card, CardContent, Checkbox, Label } from "@cognia/plugin-ui"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import type { CapturedPage } from "@ext/src/lib/panel-state"

export interface CapturePreviewProps {
  api: BrowserApi
  page: CapturedPage
  mode: BrowserCaptureMode
  limits: BrowserContextLimits
  includeFullUrl: boolean
  onToggleFullUrl: (next: boolean) => void
}

const MODE_KEY: Record<BrowserCaptureMode, string> = {
  metadata: "captureModeMetadata",
  selection: "captureModeSelection",
  "readable-page": "captureModeReadable",
}

/**
 * Show exactly what will be sent, before it is sent.
 *
 * This is the consent mechanism, not a nicety. Everything the user is agreeing
 * to leaves this screen: the address after normalization, the mode, how many
 * bytes of page text, and whether anything was cut. A preview that showed only
 * a title would make "send this page" a promise the user could not check.
 */
export function CapturePreview({
  api,
  page,
  mode,
  limits,
  includeFullUrl,
  onToggleFullUrl,
}: CapturePreviewProps) {
  const bodyBytes =
    utf8ByteLength(page.selection?.text ?? "") + utf8ByteLength(page.readableText?.text ?? "")
  const truncated = Boolean(page.selection?.truncated || page.readableText?.truncated)

  return (
    <Card data-testid="capture-preview">
      <CardContent className="space-y-2 px-3 py-3">
        <p className="line-clamp-2 text-sm font-medium">{page.title || page.url}</p>
        <p
          className="break-all font-mono text-[11px] text-muted-foreground"
          data-testid="capture-url"
        >
          {page.url}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{api.message(MODE_KEY[mode])}</Badge>
          {bodyBytes > 0 ? (
            <Badge variant="outline" data-testid="capture-bytes">
              {api.message("captureBytes", [(bodyBytes / 1024).toFixed(1)])}
            </Badge>
          ) : null}
          {truncated ? (
            <Badge variant="warning" data-testid="capture-truncated">
              {api.message("captureTruncated")}
            </Badge>
          ) : null}
          {bodyBytes > limits.requestBytes ? (
            <Badge variant="destructive">{api.message("captureTruncated")}</Badge>
          ) : null}
        </div>
        {/* Only offered when the address actually has something to add back.
            A checkbox that changes nothing invites the user to think about a
            decision they do not have. */}
        {page.strippedQuery ? (
          <div className="flex items-start gap-2">
            <Checkbox
              id="cognia-full-url"
              checked={includeFullUrl}
              onCheckedChange={(next) => onToggleFullUrl(next === true)}
              data-testid="capture-full-url"
            />
            <Label htmlFor="cognia-full-url" className="flex-col items-start gap-0.5 text-xs">
              <span>{api.message("captureFullUrl")}</span>
              <span className="font-normal text-muted-foreground">
                {api.message("captureFullUrlHint")}
              </span>
            </Label>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
