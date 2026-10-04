"use client"

/**
 * How long a run may take and how failures are retried, plus the Cognia model
 * binding for agents that can route through the gateway.
 *
 * `collapsible` exists because the phone already folds every technical field
 * behind one "Advanced settings" section; a second fold inside it hid the
 * retry fields two taps deep for no gain.
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
import { Textarea } from "@/components/ui/textarea"
import { tokenizeShellCommand } from "@/lib/mcp/config-transfer"
import {
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  DEFAULT_RETRY_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
} from "@/lib/ai/agent/external/config/add-agent-form"
import type { AddAgentFormState } from "@/hooks/agent/use-add-agent-form"
import { CogniaModelPicker } from "../cognia-model-picker"

export interface ExecutionTuningFieldsProps {
  form: AddAgentFormState
  collapsible?: boolean
}

function TuningInputs({ form }: { form: AddAgentFormState }) {
  const tSettings = useTranslations("externalAgent.settings")
  const { data, setField } = form
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor="timeoutMs">{tSettings("executionTimeoutMs")}</Label>
        <Input
          id="timeoutMs"
          type="number"
          inputMode="numeric"
          min={1000}
          step={1000}
          value={data.timeoutMs}
          onChange={(e) => setField("timeoutMs", e.target.value)}
          placeholder={DEFAULT_TIMEOUT_MS}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="retryMaxRetries">{tSettings("maxRetries")}</Label>
          <Input
            id="retryMaxRetries"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={data.retryMaxRetries}
            onChange={(e) => setField("retryMaxRetries", e.target.value)}
            placeholder={DEFAULT_RETRY_MAX_RETRIES}
          />
        </div>
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="retryDelayMs">{tSettings("retryDelayMs")}</Label>
          <Input
            id="retryDelayMs"
            type="number"
            inputMode="numeric"
            min={0}
            step={100}
            value={data.retryDelayMs}
            onChange={(e) => setField("retryDelayMs", e.target.value)}
            placeholder={DEFAULT_RETRY_DELAY_MS}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="retryMaxDelayMs">{tSettings("maxRetryDelayMs")}</Label>
          <Input
            id="retryMaxDelayMs"
            type="number"
            inputMode="numeric"
            min={0}
            step={100}
            value={data.retryMaxDelayMs}
            onChange={(e) => setField("retryMaxDelayMs", e.target.value)}
            placeholder={DEFAULT_RETRY_MAX_DELAY_MS}
          />
        </div>
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="retryExponentialBackoff">{tSettings("backoffStrategy")}</Label>
          <Select
            value={data.retryExponentialBackoff ? "true" : "false"}
            onValueChange={(value) => setField("retryExponentialBackoff", value === "true")}
          >
            <SelectTrigger id="retryExponentialBackoff" className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">{tSettings("backoffExponential")}</SelectItem>
              <SelectItem value="false">{tSettings("backoffFixedDelay")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="retryOnErrors">{tSettings("retryErrorPatterns")}</Label>
        <Textarea
          id="retryOnErrors"
          className="min-h-20 text-sm"
          value={data.retryOnErrors}
          onChange={(e) => setField("retryOnErrors", e.target.value)}
          placeholder={tSettings("retryErrorPatternsPlaceholder")}
        />
      </div>
    </>
  )
}

export function ExecutionTuningFields({ form, collapsible = true }: ExecutionTuningFieldsProps) {
  const tManager = useTranslations("externalAgent.manager")
  if (!collapsible) {
    return (
      <fieldset className="grid gap-4" data-testid="add-agent-tuning-fields">
        <legend className="mb-1 text-sm font-medium">{tManager("advancedOptions")}</legend>
        <TuningInputs form={form} />
      </fieldset>
    )
  }
  return (
    <Collapsible className="rounded-md border" data-testid="add-agent-tuning-fields">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium">
        <span>{tManager("advancedOptions")}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-4 px-3 pb-3">
        <TuningInputs form={form} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The Cognia model binding, judged against the connection the form describes. */
export function AddAgentCogniaModelField({ form }: { form: AddAgentFormState }) {
  const { data, setField, shape } = form
  return (
    <CogniaModelPicker
      config={{
        protocol: data.protocol,
        transport: data.transport,
        process: {
          command: data.command || (data.autoSpawnServer ? "opencode" : ""),
          args: tokenizeShellCommand(data.args) ?? [],
        },
        network:
          data.transport !== "stdio" && !data.autoSpawnServer
            ? { endpoint: data.endpoint }
            : undefined,
        metadata: { ...shape.preset?.metadata, autoSpawnServer: data.autoSpawnServer },
      }}
      value={data.cogniaModel}
      onChange={(cogniaModel) => setField("cogniaModel", cogniaModel)}
    />
  )
}
