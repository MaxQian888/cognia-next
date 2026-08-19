"use client"

/**
 * What this deployment target will actually put on the host.
 *
 * `renderDeploymentTarget` has been in the tree — with its own tests — since
 * the cloud-neutral deploy work landed, and nothing ever called it. That is the
 * whole gap this closes: a `DeploymentTarget` is thirty-odd fields of indirection
 * (credential *references*, provider names, class names), and the only way to
 * check that they compose into the intended Compose environment or Kustomize
 * overlay was to deploy and look at the host.
 *
 * Preview only. The controller renders its own copy agent-side from the
 * registered target; this is the same pure function run locally so the numbers
 * agree, never a source of truth the agent consumes.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { renderDeploymentTarget } from "@/lib/server-ops/deployment-renderer"
import type { DeploymentTarget } from "@/lib/server-ops/deployment-target"

/** The revision the agent stamps on a first deploy, used for the preview. */
const PREVIEW_REVISION = "1"

function CopyBlock({ label, content }: { label: string; content: string }) {
  const t = useTranslations("servers")
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground">{label}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          onClick={() => {
            void navigator.clipboard
              .writeText(content)
              .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              })
              .catch(() => toast.error(t("operations.copyFailed")))
          }}
        >
          {copied ? (
            <CheckIcon className="size-3" aria-hidden="true" />
          ) : (
            <CopyIcon className="size-3" aria-hidden="true" />
          )}
          {t("operations.copy")}
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
        {content}
      </pre>
    </div>
  )
}

export function DeploymentPreview({ target }: { target: DeploymentTarget }) {
  const t = useTranslations("servers")

  const rendered = useMemo(() => {
    try {
      return { ok: true as const, value: renderDeploymentTarget(target, PREVIEW_REVISION) }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }, [target])

  if (!rendered.ok) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("preview.unavailable")}</AlertTitle>
        {/* The renderer's own message names the missing field — far more use
            than a generic "invalid configuration". */}
        <AlertDescription>{rendered.message}</AlertDescription>
      </Alert>
    )
  }

  if (rendered.value.topology === "compose") {
    const { projectName, deploymentRoot, environment } = rendered.value
    const env = Object.entries(environment)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")
    return (
      <div className="space-y-4">
        <dl className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2">
          <div className="bg-background p-3">
            <dt className="text-xs text-muted-foreground">{t("wizard.projectName")}</dt>
            <dd className="mt-1 font-mono text-sm break-all">{projectName}</dd>
          </div>
          <div className="bg-background p-3">
            <dt className="text-xs text-muted-foreground">{t("wizard.deploymentRoot")}</dt>
            <dd className="mt-1 font-mono text-sm break-all">{deploymentRoot}</dd>
          </div>
        </dl>
        <CopyBlock label=".env" content={env} />
        <p className="text-xs text-muted-foreground">{t("preview.notice")}</p>
      </div>
    )
  }

  const files = Object.entries(rendered.value.files)
  return (
    <div className="space-y-3">
      <Tabs defaultValue={files[0]?.[0]}>
        <TabsList variant="line">
          {files.map(([name]) => (
            <TabsTrigger key={name} value={name} className="font-mono text-xs">
              {name}
            </TabsTrigger>
          ))}
        </TabsList>
        {files.map(([name, content]) => (
          <TabsContent key={name} value={name} className="pt-3">
            <CopyBlock label={name} content={content} />
          </TabsContent>
        ))}
      </Tabs>
      <p className="text-xs text-muted-foreground">{t("preview.notice")}</p>
    </div>
  )
}
