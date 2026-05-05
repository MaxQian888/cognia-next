"use client"

// Slack-specific adapter configuration dialog.
// Fields:
//   - Display name
//   - Bot Token (xoxb-...) — required, secret, tested via auth.test
//   - Signing Secret — required, secret
//   - App Token (xapp-...) — required only for socket mode, secret
//   - Transport — select: "Socket Mode" (default) | "Events API webhook"
//   - "Connect via OAuth" button — opens the OAuth URL
//
// On Save: creates / updates the AdapterInstanceRow and writes secrets to keyring.

import { useState } from "react"
import { CheckCircle2Icon, LoaderIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsHttpRequest, connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"
import { buildSlackOAuthUrl } from "@/lib/connectors/adapters/slack/oauth"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthTestResult {
  ok: boolean
  team?: string
  user?: string
  userId?: string
  error?: string
}

type TransportMode = "socket-mode" | "events-api-webhook"

// ---------------------------------------------------------------------------
// Test connection via auth.test
// ---------------------------------------------------------------------------

async function testSlackToken(token: string): Promise<AuthTestResult> {
  try {
    const resp = await connectorsHttpRequest({
      url: "https://slack.com/api/auth.test",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
      timeoutMs: 8000,
    })
    const parsed = JSON.parse(resp.body) as {
      ok: boolean
      team?: string
      user?: string
      user_id?: string
      error?: string
    }
    if (parsed.ok) {
      return { ok: true, team: parsed.team, user: parsed.user, userId: parsed.user_id }
    }
    return { ok: false, error: parsed.error ?? "Unknown error" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

interface SlackConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

export function SlackConfigDialog({ open, onOpenChange, row }: SlackConfigDialogProps) {
  const isNew = row === null

  const [displayName, setDisplayName] = useState(row?.displayName ?? "My Slack Bot")
  const [botToken, setBotToken] = useState("")
  const [signingSecret, setSigningSecret] = useState("")
  const [appToken, setAppToken] = useState("")
  const [transport, setTransport] = useState<TransportMode>(
    (row?.settings as { transport?: TransportMode } | undefined)?.transport ?? "socket-mode"
  )

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AuthTestResult | null>(null)

  const [saving, setSaving] = useState(false)

  const desktop = isTauri()

  const handleTest = async () => {
    if (!botToken.trim()) {
      toast.error("Enter a bot token first.")
      return
    }
    setTesting(true)
    setTestResult(null)
    const result = await testSlackToken(botToken.trim())
    setTestResult(result)
    setTesting(false)
    if (result.ok) {
      toast.success(
        `Connected: ${result.user ?? "unknown"} @ ${result.team ?? "unknown workspace"}`
      )
    } else {
      toast.error(result.error ?? "Connection failed")
    }
  }

  const handleOAuth = () => {
    const clientId = process.env.NEXT_PUBLIC_SLACK_CLIENT_ID ?? ""
    if (!clientId) {
      toast.error("NEXT_PUBLIC_SLACK_CLIENT_ID is not set.")
      return
    }
    // Generate a random CSRF state and store it
    const state =
      typeof crypto !== "undefined" ? crypto.randomUUID() : Math.random().toString(36).slice(2)
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("slack_oauth_state", state)
    }
    const url = buildSlackOAuthUrl({
      clientId,
      scopes: ["chat:write", "channels:history", "im:history", "app_mentions:read"],
      redirectUri: "cognia://connector/oauth/slack",
      state,
    })
    if (desktop) {
      // Use Tauri shell open for the desktop runtime
      import("@tauri-apps/plugin-shell")
        .then(({ open }) => open(url))
        .catch(() => {
          window.open(url, "_blank")
        })
    } else {
      window.open(url, "_blank")
    }
  }

  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error("Display name is required.")
      return
    }
    if (isNew && !botToken.trim()) {
      toast.error("Bot token is required.")
      return
    }
    if (isNew && !signingSecret.trim()) {
      toast.error("Signing secret is required.")
      return
    }
    if (isNew && transport === "socket-mode" && !appToken.trim()) {
      toast.error("App token is required for Socket Mode.")
      return
    }

    setSaving(true)
    try {
      let adapterId: string
      const transportMode = transport === "socket-mode" ? "gateway" : "webhook"

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "slack",
          displayName: displayName.trim(),
          enabled: true,
          transportMode,
          settings: { transport },
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: ["botToken", "signingSecret", "appToken"],
          },
          trigger: defaultPrivateChatPolicy(),
          defaultMode: "auto",
        })
        adapterId = newRow.id
      } else {
        adapterId = row.id
        await updateAdapterInstance(adapterId, {
          displayName: displayName.trim(),
          transportMode,
          settings: { transport },
        })
      }

      // Write secrets to keyring (Tauri only)
      if (botToken.trim()) {
        await connectorsKeyringSet(adapterId, "botToken", botToken.trim())
      }
      if (signingSecret.trim()) {
        await connectorsKeyringSet(adapterId, "signingSecret", signingSecret.trim())
      }
      if (appToken.trim()) {
        await connectorsKeyringSet(adapterId, "appToken", appToken.trim())
      }

      toast.success(isNew ? "Adapter created." : "Adapter updated.")
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add Slack Bot" : "Configure Slack Bot"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Display name */}
          <div className="space-y-1.5">
            <Label htmlFor="sl-display-name">Display name</Label>
            <Input
              id="sl-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="My Slack Bot"
              disabled={saving}
            />
          </div>

          {/* Bot token + test */}
          <div className="space-y-1.5">
            <Label htmlFor="sl-bot-token">
              Bot Token<span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">
              xoxb-... token from the Slack App OAuth page. Stored encrypted in the OS keyring.
            </p>
            <div className="flex gap-2">
              <Input
                id="sl-bot-token"
                type="password"
                autoComplete="new-password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="xoxb-..."
                disabled={saving}
                className="flex-1"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={testing || saving || !desktop}
                aria-label="Test connection"
              >
                {testing ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : "Test"}
              </Button>
            </div>

            {/* Test result */}
            {testResult !== null && (
              <div
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${
                  testResult.ok
                    ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                    : "bg-destructive/10 text-destructive"
                }`}
                role="status"
                aria-label={testResult.ok ? "Connection successful" : "Connection failed"}
              >
                {testResult.ok ? (
                  <CheckCircle2Icon className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <XCircleIcon className="h-3.5 w-3.5 shrink-0" />
                )}
                {testResult.ok
                  ? `${testResult.user ?? "unknown"} @ ${testResult.team ?? "unknown"} (id: ${testResult.userId ?? "?"})`
                  : testResult.error}
              </div>
            )}

            {!desktop && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Token testing requires the desktop runtime.
              </p>
            )}
          </div>

          <Separator />

          {/* Signing secret */}
          <div className="space-y-1.5">
            <Label htmlFor="sl-signing-secret">
              Signing Secret<span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">
              From Slack App &gt; Basic Information. Used to verify incoming webhook requests.
            </p>
            <Input
              id="sl-signing-secret"
              type="password"
              autoComplete="new-password"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              placeholder="Signing secret…"
              disabled={saving}
            />
          </div>

          {/* Transport */}
          <div className="space-y-1.5">
            <Label htmlFor="sl-transport">Transport</Label>
            <Select
              value={transport}
              onValueChange={(v) => setTransport(v as TransportMode)}
              disabled={saving}
            >
              <SelectTrigger id="sl-transport">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="socket-mode">Socket Mode</SelectItem>
                <SelectItem value="events-api-webhook">Events API webhook</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* App token (socket mode only) */}
          {transport === "socket-mode" && (
            <div className="space-y-1.5">
              <Label htmlFor="sl-app-token">
                App Token<span className="ml-1 text-destructive">*</span>
              </Label>
              <p className="text-xs text-muted-foreground">
                xapp-... app-level token with connections:write scope. Required for Socket Mode.
              </p>
              <Input
                id="sl-app-token"
                type="password"
                autoComplete="new-password"
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                placeholder="xapp-..."
                disabled={saving}
              />
            </div>
          )}

          <Separator />

          {/* OAuth button */}
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Alternatively, authorize via OAuth to let Slack generate the bot token automatically.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleOAuth}
              disabled={saving}
              aria-label="Connect via OAuth"
            >
              Connect via OAuth
            </Button>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : isNew ? "Create" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
