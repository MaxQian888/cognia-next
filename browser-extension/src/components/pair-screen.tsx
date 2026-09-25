import { useState } from "react"
import type { BrowserEnrollmentInvalidReason } from "@cognia/companion-client"
import { Alert, AlertDescription, AlertTitle, Button, Input, Label } from "@cognia/plugin-ui"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import type { PairFailure } from "@ext/src/lib/client"

export interface PairScreenProps {
  api: BrowserApi
  busy: boolean
  /**
   * Whether connecting will also raise Chrome's host-permission prompt.
   *
   * It changes both the label and whether the notice appears, because "Connect"
   * followed by an unexplained system dialog and "Grant access" followed by an
   * explained one are different experiences — and after the first pairing on a
   * profile, the permission is already held and the notice would be a warning
   * about something that will not happen.
   */
  needsPermission: boolean
  failure?: PairFailure
  /**
   * Set when this screen is showing because the user just disconnected.
   *
   * Disconnecting forgets the key on this browser only. The Host still lists
   * the device until it is revoked there, and saying so here is the one place
   * the user is looking at the moment it matters.
   */
  disconnected?: boolean
  onSubmit: (code: string) => void
}

/**
 * Turn a refusal into the sentence that names the remedy.
 *
 * Four different things go wrong here and three are fixed somewhere other than
 * this screen — in Cognia, by updating the extension, or in a permission
 * prompt. A single "pairing failed" would send everyone to retype the code,
 * which fixes exactly one of them.
 */
function failureMessage(api: BrowserApi, failure: PairFailure): string {
  switch (failure.code) {
    case "wrong_format":
      return api.message("pairWrongFormat")
    case "version_mismatch":
      return api.message("pairVersionMismatch")
    case "permission_denied":
      return api.message("pairPermissionDenied")
    case "invalid":
      // By reason, never the decoder's own message: that is an English
      // diagnostic, and "expired", "names another machine" and "damaged in
      // copying" want different actions from the user.
      return invalidMessage(api, failure.reason)
    case "rejected":
      return api.message("pairFailed", [failure.message])
  }
}

/**
 * The sentence for each reason a recognisably-Cognia code was refused.
 *
 * A `switch` with literal keys rather than a lookup table: the locale coverage
 * test finds message keys by reading the source, and a key reached only
 * through a table variable reads as unused.
 */
function invalidMessage(api: BrowserApi, reason: BrowserEnrollmentInvalidReason): string {
  switch (reason) {
    case "expired":
      return api.message("pairExpired")
    case "not_loopback":
      return api.message("pairNotLoopback")
    case "malformed":
      return api.message("pairMalformed")
  }
}

export function PairScreen({
  api,
  busy,
  needsPermission,
  failure,
  disconnected = false,
  onSubmit,
}: PairScreenProps) {
  const [code, setCode] = useState("")
  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (code.trim()) onSubmit(code.trim())
      }}
    >
      {disconnected ? (
        <Alert data-testid="pair-disconnected">
          <AlertTitle>{api.message("disconnectDone")}</AlertTitle>
          <AlertDescription>{api.message("disconnectDoneHint")}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-1">
        <h1 className="text-sm font-semibold">{api.message("pairTitle")}</h1>
        <p className="text-xs text-muted-foreground">{api.message("pairIntro")}</p>
      </div>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{api.message("pairOriginLabel")}</p>
        <code
          className="block break-all rounded-control bg-muted px-2 py-1.5 font-mono text-[11px]"
          data-testid="pair-extension-origin"
        >
          {api.extensionOrigin()}
        </code>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cognia-pair-code" className="text-xs">
          {api.message("pairPlaceholder")}
        </Label>
        <Input
          id="cognia-pair-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={api.message("pairPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
          disabled={busy}
        />
      </div>
      {/* Said before the click, not after it. Chrome's own prompt appears with
          no explanation of who is asking or what for, and a user who has just
          been told what is coming is a user who can answer it. */}
      {needsPermission ? (
        <p className="text-xs text-muted-foreground" data-testid="pair-permission-notice">
          {api.message("pairPermissionNeeded")}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || !code.trim()}>
        {busy
          ? api.message("pairing")
          : needsPermission
            ? api.message("pairGrant")
            : api.message("pairSubmit")}
      </Button>
      {failure ? (
        <Alert variant="destructive" data-testid="pair-failure">
          <AlertDescription>{failureMessage(api, failure)}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  )
}
