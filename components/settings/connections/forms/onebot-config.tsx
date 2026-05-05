"use client"

// OneBot adapter configuration dialog.
//
// OneBot uses a reverse-WebSocket connection — the QQ client (NapCat/Lagrange/
// LLOneBot) connects TO cognia-next. There is no "Test connection" button;
// instead the user is shown the reverse-WS endpoint URL to paste into NapCat
// config, and a "Verify" button that listens for an `open` event for ~10 s.
//
// Fields:
//   - Display name (required)
//   - Bot UIN / QQ number (required)
//   - Optional bearer token (secret)
//   - Expected client hint (cosmetic)

import { useState, useCallback } from "react"
import { CheckCircle2Icon, LoaderIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringSet, connectorsHealth } from "@/lib/connectors/tauri/commands"
import { isTauri } from "@/lib/tauri"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultGroupChatPolicy } from "@/types/connectors/policy"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExpectedClient = "napcat" | "lagrange" | "llonebot" | "other"

interface OneBotConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = creating a new instance */
  row: AdapterInstanceRow | null
}

// ---------------------------------------------------------------------------
// Helper: resolve the WS endpoint URL
// ---------------------------------------------------------------------------

async function resolveWsEndpoint(adapterId: string): Promise<string> {
  try {
    const health = await connectorsHealth()
    const addr = health.boundAddr ?? "127.0.0.1:8080"
    return `ws://${addr}/ws/onebot/${adapterId}`
  } catch {
    return `ws://127.0.0.1:8080/ws/onebot/${adapterId}`
  }
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function OneBotConfigDialog({ open, onOpenChange, row }: OneBotConfigDialogProps) {
  const isNew = row === null
  const settings = (row?.settings ?? {}) as {
    selfBotUin?: string
    expectedClient?: ExpectedClient
  }

  const [displayName, setDisplayName] = useState(row?.displayName ?? "My QQ Bot")
  const [botUin, setBotUin] = useState(settings.selfBotUin ?? "")
  const [bearerToken, setBearerToken] = useState("")
  const [expectedClient, setExpectedClient] = useState<ExpectedClient>(
    settings.expectedClient ?? "napcat"
  )
  const [saving, setSaving] = useState(false)
  const [savedAdapterId, setSavedAdapterId] = useState<string | null>(row?.id ?? null)
  const [wsEndpoint, setWsEndpoint] = useState<string>("")
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<"connected" | "timeout" | null>(null)

  const desktop = isTauri()

  // Resolve endpoint once we have an adapterId
  const resolveEndpoint = useCallback(async (adapterId: string) => {
    const url = await resolveWsEndpoint(adapterId)
    setWsEndpoint(url)
  }, [])

  // After save, trigger endpoint resolution
  const handleSave = async () => {
    if (!displayName.trim()) {
      toast.error("Display name is required.")
      return
    }
    if (!botUin.trim()) {
      toast.error("Bot UIN is required.")
      return
    }

    setSaving(true)
    try {
      let adapterId: string

      if (isNew) {
        const newRow = await createAdapterInstance({
          type: "onebot",
          displayName: displayName.trim(),
          enabled: true,
          transportMode: "reverse-ws",
          settings: {
            selfBotUin: botUin.trim(),
            expectedClient,
          },
          credentialsRef: {
            keyringService: "com.cognia.platforms",
            accounts: bearerToken.trim() ? ["onebotBearer"] : [],
          },
          trigger: defaultGroupChatPolicy(),
          defaultMode: "auto",
        })
        adapterId = newRow.id
      } else {
        adapterId = row.id
        await updateAdapterInstance(adapterId, {
          displayName: displayName.trim(),
          settings: {
            selfBotUin: botUin.trim(),
            expectedClient,
          },
        })
      }

      // Write bearer token to keyring if provided
      if (bearerToken.trim()) {
        await connectorsKeyringSet(adapterId, "onebotBearer", bearerToken.trim())
      }

      setSavedAdapterId(adapterId)
      await resolveEndpoint(adapterId)

      toast.success(
        isNew ? "Adapter created. Paste the endpoint URL into NapCat config." : "Adapter updated."
      )
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleVerify = async () => {
    if (!savedAdapterId) {
      toast.error("Save the adapter first, then verify the connection.")
      return
    }

    setVerifying(true)
    setVerifyResult(null)

    // Listen for the open event for up to 10 s
    try {
      const { listen } = await import("@tauri-apps/api/event")
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("timeout"))
        }, 10_000)

        listen<void>(`connectors://onebot/${savedAdapterId}/open`, () => {
          clearTimeout(timer)
          resolve()
        }).then((unlisten) => {
          // Cleanup after 10 s regardless
          setTimeout(unlisten, 10_500)
        })
      })
      setVerifyResult("connected")
      toast.success("NapCat connected successfully.")
    } catch {
      setVerifyResult("timeout")
      toast.error(
        "No connection received within 10 s. Is NapCat running and pointing to the correct URL?"
      )
    } finally {
      setVerifying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "Add OneBot (QQ) Adapter" : "Configure OneBot (QQ) Adapter"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Display name */}
          <div className="space-y-1.5">
            <Label htmlFor="ob-display-name">Display name</Label>
            <Input
              id="ob-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="My QQ Bot"
              disabled={saving}
            />
          </div>

          {/* Bot UIN */}
          <div className="space-y-1.5">
            <Label htmlFor="ob-uin">
              Bot UIN (QQ number)<span className="ml-1 text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">
              The QQ number of the bot account (e.g. 123456789).
            </p>
            <Input
              id="ob-uin"
              value={botUin}
              onChange={(e) => setBotUin(e.target.value)}
              placeholder="123456789"
              disabled={saving}
            />
          </div>

          {/* Bearer token */}
          <div className="space-y-1.5">
            <Label htmlFor="ob-bearer">Bearer Token (optional)</Label>
            <p className="text-xs text-muted-foreground">
              If NapCat / Lagrange has <code className="text-xs">accessToken</code> configured,
              paste the same value here. Stored encrypted in the OS keyring.
            </p>
            <Input
              id="ob-bearer"
              type="password"
              autoComplete="new-password"
              value={bearerToken}
              onChange={(e) => setBearerToken(e.target.value)}
              placeholder="Optional secret token"
              disabled={saving}
            />
          </div>

          {/* Expected client hint */}
          <div className="space-y-1.5">
            <Label htmlFor="ob-client">Expected Client</Label>
            <Select
              value={expectedClient}
              onValueChange={(v) => setExpectedClient(v as ExpectedClient)}
              disabled={saving}
            >
              <SelectTrigger id="ob-client">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="napcat">NapCat</SelectItem>
                <SelectItem value="lagrange">Lagrange</SelectItem>
                <SelectItem value="llonebot">LLOneBot</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Purely cosmetic — used for documentation links.
            </p>
          </div>

          <Separator />

          {/* Reverse-WS endpoint display */}
          {savedAdapterId && wsEndpoint && (
            <div className="space-y-1.5">
              <Label>Reverse-WS Endpoint URL</Label>
              <p className="text-xs text-muted-foreground">
                Paste this URL into your NapCat / Lagrange{" "}
                <code className="text-xs">wsReverse</code> config.
              </p>
              <div
                className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all"
                aria-label="reverse-ws endpoint"
              >
                {wsEndpoint}
              </div>

              {/* Verify connection button */}
              {desktop && (
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleVerify}
                    disabled={verifying}
                    aria-label="Verify reverse-WS reception"
                  >
                    {verifying ? (
                      <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "Verify connection"
                    )}
                  </Button>
                  {verifyResult === "connected" && (
                    <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2Icon className="h-3.5 w-3.5" />
                      Connected
                    </span>
                  )}
                  {verifyResult === "timeout" && (
                    <span className="flex items-center gap-1 text-xs text-destructive">
                      <XCircleIcon className="h-3.5 w-3.5" />
                      No connection
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          <Separator />

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
