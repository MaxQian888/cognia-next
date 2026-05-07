"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DEFAULT_WORKFLOW_SETTINGS, DEFAULT_RETRY_POLICY } from "@/types/workflow/visual"
import { Badge } from "@/components/ui/badge"

/**
 * Read-only view of the global workflow defaults that new workflows inherit.
 * Per-workflow overrides live in the editor's settings panel; this tab
 * surfaces the baseline so users understand what they're starting from.
 */
export function DefaultsTab() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run policy</CardTitle>
          <CardDescription>Inherited by every new workflow at creation time.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Error policy">
            <Badge variant="outline" className="font-normal">
              {DEFAULT_WORKFLOW_SETTINGS.errorPolicy}
            </Badge>
          </Field>
          <Field label="Run timeout">
            {(DEFAULT_WORKFLOW_SETTINGS.timeoutMs / 1000).toFixed(0)} seconds
          </Field>
          <Field label="Concurrent runs">{DEFAULT_WORKFLOW_SETTINGS.concurrency}</Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Retry defaults</CardTitle>
          <CardDescription>Applies per-step unless the node overrides it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Attempts">{DEFAULT_RETRY_POLICY.attempts}</Field>
          <Field label="Backoff">
            <Badge variant="outline" className="font-normal">
              {DEFAULT_RETRY_POLICY.backoff}
            </Badge>
          </Field>
          <Field label="Base delay">{DEFAULT_RETRY_POLICY.baseMs} ms</Field>
          {DEFAULT_RETRY_POLICY.maxMs ? (
            <Field label="Max delay">{DEFAULT_RETRY_POLICY.maxMs} ms</Field>
          ) : null}
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Secrets &amp; credentials</CardTitle>
          <CardDescription>
            Workflows reference secrets by id only — nothing sensitive is ever embedded in the
            workflow JSON. Configure provider keys in Settings → Providers and Anthropic OAuth in
            Settings → Subscription. Tauri builds use the OS keyring; web-mode falls back to a
            per-browser store.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{children}</span>
    </div>
  )
}
