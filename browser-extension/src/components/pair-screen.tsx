import { useState } from "react"
import { Alert, AlertDescription, Button, Input, Label } from "@cognia/plugin-ui"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import type { PairFailure } from "@ext/src/lib/client"

export interface PairScreenProps {
  api: BrowserApi
  busy: boolean
  failure?: PairFailure
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
      // The decoder's own message: "expired" and "does not name this machine's
      // browser listener" want different actions from the user.
      return failure.message
    case "rejected":
      return api.message("pairFailed", [failure.message])
  }
}

export function PairScreen({ api, busy, failure, onSubmit }: PairScreenProps) {
  const [code, setCode] = useState("")
  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (code.trim()) onSubmit(code.trim())
      }}
    >
      <div className="space-y-1">
        <h1 className="text-sm font-semibold">{api.message("pairTitle")}</h1>
        <p className="text-xs text-muted-foreground">{api.message("pairIntro")}</p>
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
      {/* The permission is requested from this button's own handler: Chrome
          rejects `permissions.request` outside a user gesture, and a prompt
          that never appears is indistinguishable from one that was denied. */}
      <Button type="submit" disabled={busy || !code.trim()}>
        {busy ? api.message("pairing") : api.message("pairSubmit")}
      </Button>
      {failure ? (
        <Alert variant="destructive" data-testid="pair-failure">
          <AlertDescription>{failureMessage(api, failure)}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  )
}
