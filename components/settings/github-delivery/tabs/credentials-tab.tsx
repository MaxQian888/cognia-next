"use client"

/**
 * Credentials sub-tab. Walks the user through adding a repo via App or PAT
 * authentication. The actual setup wizard (5-step App flow, 2-step PAT
 * flow) is M4 scope — Phase M4-shell ships a placeholder card with the
 * conceptual flow + a CTA that opens the wizard.
 */

import { useState } from "react"
import { GitBranchIcon, KeyIcon, ShieldCheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

type WizardMode = "idle" | "app" | "pat"

export function CredentialsTab() {
  const [mode, setMode] = useState<WizardMode>("idle")

  if (mode === "app") {
    return (
      <Card className="p-4 space-y-3" data-testid="credentials-app-wizard">
        <h3 className="text-sm font-semibold">GitHub App setup</h3>
        <ol className="list-decimal pl-5 text-sm space-y-1 text-muted-foreground">
          <li>Create a new GitHub App at github.com/settings/apps</li>
          <li>Set Webhook URL to your local cognia receiver (Settings → Workflows → Webhook URL)</li>
          <li>Generate + download a private key</li>
          <li>Install the App on the target repositories</li>
          <li>Paste App ID + private key + installation ID below</li>
        </ol>
        <Alert>
          <ShieldCheckIcon className="h-4 w-4" />
          <AlertTitle>The private key never leaves your machine</AlertTitle>
          <AlertDescription>
            Stored in the OS keyring (Tauri) or a per-user encrypted blob (Web). Cognia never
            transmits it.
          </AlertDescription>
        </Alert>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setMode("idle")}>
            Back
          </Button>
          <Button disabled>Save (M4 wizard pending)</Button>
        </div>
      </Card>
    )
  }

  if (mode === "pat") {
    return (
      <Card className="p-4 space-y-3" data-testid="credentials-pat-wizard">
        <h3 className="text-sm font-semibold">Personal Access Token (PAT)</h3>
        <p className="text-sm text-muted-foreground">
          PAT is the simpler kickstart credential. Generate a fine-scoped token at github.com →
          Settings → Developer settings → Personal access tokens (fine-grained) and grant the
          repos you want to manage.
        </p>
        <Alert>
          <KeyIcon className="h-4 w-4" />
          <AlertTitle>Use a fine-scoped token</AlertTitle>
          <AlertDescription>
            Pick "Only select repositories" and the specific permissions
            (issues: read/write, pull-requests: read/write, contents: read).
          </AlertDescription>
        </Alert>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setMode("idle")}>
            Back
          </Button>
          <Button disabled>Save (M4 wizard pending)</Button>
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-3" data-testid="credentials-picker">
      <Card className="p-4 cursor-pointer hover:bg-accent" onClick={() => setMode("app")}>
        <div className="flex items-center gap-3">
          <GitBranchIcon className="h-5 w-5" />
          <div className="flex-1">
            <p className="font-medium text-sm">GitHub App (recommended)</p>
            <p className="text-xs text-muted-foreground">
              Higher rate limits, granular installation scopes, audit trail per installation.
            </p>
          </div>
          <Button size="sm">Set up App</Button>
        </div>
      </Card>
      <Card className="p-4 cursor-pointer hover:bg-accent" onClick={() => setMode("pat")}>
        <div className="flex items-center gap-3">
          <KeyIcon className="h-5 w-5" />
          <div className="flex-1">
            <p className="font-medium text-sm">Personal Access Token (kickstart)</p>
            <p className="text-xs text-muted-foreground">
              Faster to set up. Tied to your account; use for personal repos and trial runs.
            </p>
          </div>
          <Button size="sm" variant="outline">
            Set up PAT
          </Button>
        </div>
      </Card>
    </div>
  )
}
