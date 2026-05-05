"use client"

// Lark/Feishu adapter configuration dialog.
// Fields:
//   - Display name
//   - App ID (cli_...) — required
//   - App Secret — required, secret
//   - Encrypt Key — optional, secret
//   - Verification Token — required, secret
//   - Transport — select: "Long connection" (default) | "Webhook"
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TatTestResult {
  ok: boolean
  appId?: string
  error?: string
}

type TransportMode = "long-connection" | "webhook"

// ---------------------------------------------------------------------------
// Test connection via tenant_access_token/internal
// ---------------------------------------------------------------------------

async function testLarkConnection(appId: string, appSecret: string): Promise<TatTestResult> {
  try {
    const resp = await connectorsHttpRequest({
      url: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      timeoutMs: 8000,
    })
    const parsed = JSON.parse(resp.body) as {
      code: number
      tenant_access_token?: string
      msg?: string
    }
    if (parsed.code === 0 && parsed.tenant_access_token) {
      return { ok: true, appId }
    }
    return { ok: false, error: parsed.msg ?? `code ${parsed.code}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

interface LarkConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

export function LarkConfigDialog({ open, onOpenChange, row }: LarkConfigDialogProps) {
  const isNew = row === null

  const [displayName, setDisplayName] = useState(row?.displayName ?? "My Lark Bot")
  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [encryptKey, setEncryptKey] = useState("")
  const [verificationToken, setVerificationToken] = useState("")
  const [transport, setTransport] = useState<TransportMode>(
    (row?.settings as { transport?: TransportMode } | undefined)?.transport ?? "long-connection"
  )

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TatTestResult | null>(null)

  const [saving, setSaving] = useState(false)

  const desktop = isTauri()

  const handleTest = async () => {
    if (!appId.trim() || !appSecret.trim()) {
      toast.error("Enter App ID and App Secret first.")
      return
    }
    setTesting(true)
    setTestResult(null)
    const result = await testLarkConnection(appId.trim(), appSecret.trim())
    setTestResult(result)
    setTesting(false)
    if (result.ok) {
      toast.success(`Connected: ${result.appId ?? "unknown app"}`)
    } else {
      toast.error(result.error ?? "Connection failed")
    }
  }

  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error("Display name is required.")
      return
    }
    if (isNew && !appId.trim()) {
      toast.error("App ID is required.")
      return
    }
    if (isNew && !appSecret.trim()) {
      toast.error("App Secret is required.")
      return
    }
    if (isNew && !verificationToken.trim()) {
      toast.error("Verification Token is required.")
      return
    }

    setSaving(true)
    try {
      let adapterId: string
      const transportMode = transport === "long-connection" ? "gateway" : "webhook"

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "lark",
          displayName: displayName.trim(),
          enabled: true,
          transportMode,
          settings: { transport },
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: ["appId", "appSecret", "encryptKey", "verificationToken"],
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
      if (appId.trim()) {
        await connectorsKeyringSet(adapterId, "appId", appId.trim())
      }
      if (appSecret.trim()) {
        await connectorsKeyringSet(adapterId, "appSecret", appSecret.trim())
      }
      if (encryptKey.trim()) {
        await connectorsKeyringSet(adapterId, "encryptKey", encryptKey.trim())
      }
      if (verificationToken.trim()) {
        await connectorsKeyringSet(adapterId, "verificationToken", verificationToken.trim())
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
          <DialogTitle>{isNew ? "Add Lark Bot" : "Configure Lark Bot"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Display name */}
          <div className="space-y-1.5">
            <Label htmlFor="lk-display-name">Display name</Label>
            <Input
              id="lk-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="My Lark Bot"
              disabled={saving}
            />
          </div>

          {/* App ID */}
          <div className="space-y-1.5">
            <Label htmlFor="lk-app-id">
              App ID<span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">
              cli_... from Lark Developer Console &gt; App. Stored encrypted in the OS keyring.
            </p>
            <div className="flex gap-2">
              <Input
                id="lk-app-id"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="cli_..."
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
                {testResult.ok ? `Connected: ${testResult.appId ?? "unknown"}` : testResult.error}
              </div>
            )}

            {!desktop && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Connection testing requires the desktop runtime.
              </p>
            )}
          </div>

          {/* App Secret */}
          <div className="space-y-1.5">
            <Label htmlFor="lk-app-secret">
              App Secret<span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">
              From Lark Developer Console &gt; App &gt; Credentials.
            </p>
            <Input
              id="lk-app-secret"
              type="password"
              autoComplete="new-password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="App secret…"
              disabled={saving}
            />
          </div>

          {/* Transport */}
          <div className="space-y-1.5">
            <Label htmlFor="lk-transport">Transport</Label>
            <Select
              value={transport}
              onValueChange={(v) => setTransport(v as TransportMode)}
              disabled={saving}
            >
              <SelectTrigger id="lk-transport">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="long-connection">Long connection</SelectItem>
                <SelectItem value="webhook">Webhook</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* Verification Token */}
          <div className="space-y-1.5">
            <Label htmlFor="lk-verification-token">
              Verification Token<span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">
              From Lark App &gt; Event subscriptions &gt; Verification Token.
            </p>
            <Input
              id="lk-verification-token"
              type="password"
              autoComplete="new-password"
              value={verificationToken}
              onChange={(e) => setVerificationToken(e.target.value)}
              placeholder="Verification token…"
              disabled={saving}
            />
          </div>

          {/* Encrypt Key (optional) */}
          <div className="space-y-1.5">
            <Label htmlFor="lk-encrypt-key">Encrypt Key</Label>
            <p className="text-xs text-muted-foreground">
              Optional. Required only when Encrypt Key is enabled in Lark App &gt; Event
              subscriptions. Enables AES-256-CBC decryption of incoming events.
            </p>
            <Input
              id="lk-encrypt-key"
              type="password"
              autoComplete="new-password"
              value={encryptKey}
              onChange={(e) => setEncryptKey(e.target.value)}
              placeholder="Encrypt key (optional)…"
              disabled={saving}
            />
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
