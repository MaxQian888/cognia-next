"use client"

/**
 * How Cognia reaches an external agent: the protocol and transport, and then
 * whichever of the launch command, the network endpoint, the OpenCode server
 * or the managed runtime that pair implies, plus the process environment.
 *
 * Laid out single-column below `sm`: side-by-side selects on a phone truncated
 * the protocol name and let the two triggers overlap.
 */

import { useTranslations } from "next-intl"
import { ChevronDown } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { KvEditor } from "@/components/settings/mcp/kv-editor"
import { externalProtocolOptions } from "@/lib/ai/agent/external/protocol-options"
import {
  transportForProtocol,
  usesDirectEnvironment,
} from "@/lib/ai/agent/external/config/add-agent-form"
import type { AddAgentFormState } from "@/hooks/agent/use-add-agent-form"
import type { AddAgentFormData } from "@/types/agent/component-types"

export interface ConnectionFieldsProps {
  form: AddAgentFormState
  /**
   * Why the active Host cannot start a process, when it cannot. Shown next to
   * the fields that would need one, so the user learns it before submitting.
   */
  planeWarning: string | null
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      {children}
    </div>
  )
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="cursor-pointer text-sm">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </div>
  )
}

export function ConnectionFields({ form, planeWarning }: ConnectionFieldsProps) {
  const tSettings = useTranslations("externalAgent.settings")
  const tManager = useTranslations("externalAgent.manager")
  const { data, setData, setField, presetId, processEnvRows, setProcessEnvRows, shape } = form
  const { isOpenCode, isOpenCodeV2, isStdio, managedRuntime } = shape
  const directEnvironment = usesDirectEnvironment(data, presetId)

  return (
    <div className="grid gap-4" data-testid="add-agent-connection-fields">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="protocol">{tSettings("protocol")}</Label>
          <Select
            value={data.protocol}
            onValueChange={(value: AddAgentFormData["protocol"]) => {
              // Radix can emit "" when the controlled value matches no
              // built-in item (e.g. a plugin-contributed protocol like
              // `${pluginId}:${id}`); ignore it so the preset's protocol
              // isn't silently wiped.
              if (!value) return
              setData((current) => ({
                ...current,
                protocol: value,
                transport: transportForProtocol(value, current.transport),
              }))
            }}
          >
            <SelectTrigger id="protocol" className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Derived from the REGISTERED protocols, plus whatever the form
                  already holds. The hand-written list this replaced offered
                  http/websocket/custom as "coming soon" — none of them has
                  ever had an adapter — while omitting the three protocols
                  that do. */}
              {externalProtocolOptions(data.protocol).map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={!option.selectable}>
                  {option.value === "opencode-v2" ? tSettings("opencodeV2Protocol") : option.label}
                  {option.reasonKey ? ` — ${tManager(option.reasonKey)}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="transport">{tSettings("transport")}</Label>
          <Select
            value={data.transport}
            onValueChange={(value: AddAgentFormData["transport"]) => setField("transport", value)}
          >
            <SelectTrigger id="transport" className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">{tManager("transportStdioLocal")}</SelectItem>
              <SelectItem value="http">{tManager("transportHttp")}</SelectItem>
              <SelectItem value="websocket">{tManager("transportWebsocket")}</SelectItem>
              <SelectItem value="sse">{tManager("transportSse")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isOpenCode ? (
        <>
          <div className="rounded-md border bg-muted/20 p-3">
            <ToggleRow
              id="auto-spawn"
              label={tManager("autoSpawnServer")}
              hint={tManager("autoSpawnServerHint")}
              checked={data.autoSpawnServer}
              onCheckedChange={(value) => setField("autoSpawnServer", value)}
            />
          </div>
          {data.autoSpawnServer ? (
            <>
              {planeWarning && (
                <Warning>
                  {tManager("opencodeAutoSpawnNeedsAProcess")} {planeWarning}
                </Warning>
              )}
              <div className="grid gap-2">
                <Label htmlFor="command">{tSettings("command")}</Label>
                <Input
                  id="command"
                  value={data.command}
                  onChange={(e) => setField("command", e.target.value)}
                  // i18n-exempt: example CLI command, not UI prose
                  placeholder="opencode"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="port">{tManager("serverPort")}</Label>
                  <Input
                    id="port"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={data.port}
                    onChange={(e) => setField("port", e.target.value)}
                    placeholder="0"
                  />
                </div>
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="hostname">{tManager("serverHostname")}</Label>
                  <Input
                    id="hostname"
                    value={data.hostname}
                    onChange={(e) => setField("hostname", e.target.value)}
                    // i18n-exempt: example hostname, not UI prose
                    placeholder="127.0.0.1"
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="endpoint">{tSettings("endpoint")}</Label>
              <Input
                id="endpoint"
                inputMode="url"
                value={data.endpoint}
                onChange={(e) => setField("endpoint", e.target.value)}
                placeholder="http://127.0.0.1:4096"
                required={!data.autoSpawnServer}
              />
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="server-password">{tManager("serverPassword")}</Label>
              <Input
                id="server-password"
                type="password"
                value={data.serverPassword}
                onChange={(e) => setField("serverPassword", e.target.value)}
                placeholder="••••••••"
              />
            </div>
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="server-username">{tManager("serverUsername")}</Label>
              <Input
                id="server-username"
                value={data.serverUsername}
                onChange={(e) => setField("serverUsername", e.target.value)}
                // i18n-exempt: the server's documented default Basic-Auth user
                placeholder="opencode"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{tManager("serverPasswordHint")}</p>
          <div className="grid gap-2">
            <Label htmlFor="opencode-model">{tManager("defaultModel")}</Label>
            <Input
              id="opencode-model"
              value={data.model}
              onChange={(e) => setField("model", e.target.value)}
              // i18n-exempt: example provider/model id, not UI prose
              placeholder="anthropic/claude-sonnet-4-5"
            />
            <p className="text-xs text-muted-foreground">{tManager("defaultModelHint")}</p>
          </div>
        </>
      ) : isStdio ? (
        <>
          {managedRuntime && (
            <div className="grid gap-2">
              <p className="text-xs text-muted-foreground">
                {tSettings("deepseekHarness.managedLaunchNotice")}
              </p>
              <Label htmlFor="dsh-api-key">{tSettings("apiKey")}</Label>
              <Input
                id="dsh-api-key"
                type="password"
                autoComplete="new-password"
                value={data.dshApiKey ?? ""}
                onChange={(event) => setField("dshApiKey", event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {tSettings("deepseekHarness.credentialNotice")}
              </p>
              <Label htmlFor="dsh-workspace">{tSettings("workingDirectory")}</Label>
              <Input
                id="dsh-workspace"
                value={data.dshWorkspace ?? ""}
                onChange={(event) => setField("dshWorkspace", event.target.value)}
              />
            </div>
          )}
          {planeWarning && (
            <Warning>
              {tManager("stdioNeedsAProcess")} {planeWarning}
            </Warning>
          )}
          <div className="grid gap-2">
            <Label htmlFor="command">{tSettings("command")}</Label>
            <Input
              id="command"
              value={data.command}
              onChange={(e) => setField("command", e.target.value)}
              // i18n-exempt: example CLI command, not UI prose
              placeholder="npx"
              required={isStdio && !managedRuntime}
              disabled={managedRuntime}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="args">{tSettings("arguments")}</Label>
            <Input
              id="args"
              value={data.args}
              onChange={(e) => setField("args", e.target.value)}
              // i18n-exempt: example CLI arguments, not UI prose
              placeholder="@anthropics/claude-code --stdio"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          {directEnvironment ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="aider-cwd">{tSettings("workingDirectory")}</Label>
                <Input
                  id="aider-cwd"
                  value={data.processCwd ?? ""}
                  onChange={(event) => setField("processCwd", event.target.value)}
                />
              </div>
              <KvEditor
                label={tSettings(
                  presetId === "qoder"
                    ? "qoderEnvironment"
                    : presetId === "kimi"
                      ? "kimiEnvironment"
                      : presetId === "cline"
                        ? "clineEnvironment"
                        : "aiderEnvironment"
                )}
                maskValues
                rows={processEnvRows}
                onChange={setProcessEnvRows}
                keyPlaceholder={tSettings("aiderEnvironmentKey")}
                valuePlaceholder={tSettings("aiderEnvironmentValue")}
              />
            </>
          ) : (
            <div className="space-y-3 rounded-md border bg-muted/20 p-3">
              <ToggleRow
                id="bare-flag"
                label={tSettings("passBareFlag")}
                hint={tSettings("passBareFlagHint")}
                checked={data.bare}
                onCheckedChange={(value) => setField("bare", value)}
              />
              <ToggleRow
                id="debug-flag"
                label={tSettings("passDebugFlag")}
                hint={tSettings("passDebugFlagHint")}
                checked={data.debug}
                onCheckedChange={(value) => setField("debug", value)}
              />
            </div>
          )}
        </>
      ) : isOpenCodeV2 ? null : (
        // OpenCode V2 discovers the local service through the sidecar: no
        // endpoint is read or stored for it, so none is asked for.
        <div className="grid gap-2">
          <Label htmlFor="endpoint">{tSettings("endpoint")}</Label>
          <Input
            id="endpoint"
            inputMode="url"
            value={data.endpoint}
            onChange={(e) => setField("endpoint", e.target.value)}
            placeholder="http://localhost:8080"
            required={!isStdio}
          />
        </div>
      )}

      {(isStdio || (isOpenCode && data.autoSpawnServer)) && !directEnvironment && (
        <Collapsible className="rounded-md border">
          <CollapsibleTrigger className="group flex w-full items-center justify-between px-3 py-2 text-sm font-medium">
            {tSettings("processEnvironment")}
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-3 px-3 pb-3">
            <p className="text-xs text-muted-foreground">{tSettings("processEnvironmentHint")}</p>
            {!managedRuntime && (
              <div className="grid gap-2">
                <Label htmlFor="process-cwd">{tSettings("workingDirectory")}</Label>
                <Input
                  id="process-cwd"
                  value={data.processCwd ?? ""}
                  onChange={(event) => setField("processCwd", event.target.value)}
                />
              </div>
            )}
            <KvEditor
              label={tSettings("processEnvironment")}
              maskValues
              rows={processEnvRows}
              onChange={setProcessEnvRows}
              keyPlaceholder={tSettings("aiderEnvironmentKey")}
              valuePlaceholder={tSettings("aiderEnvironmentValue")}
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
