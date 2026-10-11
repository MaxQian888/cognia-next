"use client"

// Unified dependency view: plugin dependencies (installed / missing / version),
// required system binaries (probed via `detectCli`), and python dependencies.
// Reused by the marketplace detail sheet, the installed-plugin overview, and
// the GitHub install preview so all three surfaces agree. Renders nothing when
// the manifest declares no dependencies of any kind.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { CheckCircle2Icon, CircleHelpIcon, XCircleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { usePluginDisplayName } from "@/hooks/plugins/use-plugin-display-name"
import { listPlugins } from "@/lib/db/plugins"
import { detectCli, satisfiesMinVersion } from "@/lib/cli-bridge/detect-cli"
import type { PluginManifest } from "@/types/plugin"

type ManifestDeps = Pick<
  PluginManifest,
  "dependencies" | "optionalDependencies" | "requires" | "pythonDependencies"
>

interface Props {
  manifest: ManifestDeps
  className?: string
  /**
   * Makes an INSTALLED plugin dependency a link to its own detail. Passed by
   * the installed-plugin overview only: in the marketplace sheet and the
   * GitHub install preview there is no detail pane to move to.
   */
  onOpenDependency?: (pluginId: string) => void
}

interface BinaryProbe {
  available: boolean
  version: string | null
}

export function PluginDependencyPanel({ manifest, className, onOpenDependency }: Props) {
  const t = useTranslations("plugins.dependencies")

  const required = useMemo(
    () => Object.entries(manifest.dependencies ?? {}),
    [manifest.dependencies]
  )
  const optional = useMemo(
    () => Object.entries(manifest.optionalDependencies ?? {}),
    [manifest.optionalDependencies]
  )
  const binaries = useMemo(() => manifest.requires?.binaries ?? [], [manifest.requires])
  const pythonDeps = useMemo(() => manifest.pythonDependencies ?? [], [manifest.pythonDependencies])

  const installedRows = useLiveQuery(() => listPlugins(), [])
  const installedIds = useMemo(
    () => new Set((Array.isArray(installedRows) ? installedRows : []).map((r) => r.id)),
    [installedRows]
  )

  const binariesKey = binaries.map((b) => b.name).join(",")
  const [probes, setProbes] = useState<Record<string, BinaryProbe>>({})
  useEffect(() => {
    if (binaries.length === 0) return
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        binaries.map(async (b) => {
          try {
            const r = await detectCli(b.name)
            return [b.name, { available: r.available, version: r.version }] as const
          } catch {
            return [b.name, { available: false, version: null }] as const
          }
        })
      )
      if (!cancelled) setProbes(Object.fromEntries(entries))
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binariesKey])

  const isEmpty =
    required.length === 0 &&
    optional.length === 0 &&
    binaries.length === 0 &&
    pythonDeps.length === 0
  if (isEmpty) return null

  return (
    <section
      className={`space-y-3 border-t pt-2 ${className ?? ""}`}
      data-testid="plugin-dependency-panel"
    >
      <h3 className="text-xs font-semibold">{t("title")}</h3>

      {(required.length > 0 || optional.length > 0) && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">{t("pluginDeps")}</div>
          <ul className="divide-y">
            {required.map(([dep, version]) => (
              <DepRow
                key={dep}
                name={dep}
                version={version}
                installed={installedIds.has(dep)}
                onOpen={onOpenDependency}
                t={t}
              />
            ))}
            {optional.map(([dep, version]) => (
              <DepRow
                key={dep}
                name={dep}
                version={version}
                installed={installedIds.has(dep)}
                optional
                onOpen={onOpenDependency}
                t={t}
              />
            ))}
          </ul>
        </div>
      )}

      {binaries.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">{t("binaries")}</div>
          {binaries.map((bin) => {
            const probe = probes[bin.name]
            const satisfied =
              !!probe && probe.available && satisfiesMinVersion(probe.version, bin.minVersion)
            return (
              <div
                key={bin.name}
                className="flex items-center justify-between gap-2 text-xs"
                data-testid={`binary-${bin.name}`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <code className="font-mono">{bin.name}</code>
                  {bin.minVersion && (
                    <Badge variant="outline" className="text-[10px]">
                      {t("minVersion", { version: bin.minVersion })}
                    </Badge>
                  )}
                </div>
                {!probe ? (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <CircleHelpIcon className="size-3" />
                    {t("checking")}
                  </span>
                ) : satisfied ? (
                  <span className="flex items-center gap-1 text-emerald-600">
                    <CheckCircle2Icon className="size-3" />
                    {probe.version ?? t("detected")}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-destructive">
                    <XCircleIcon className="size-3" />
                    {probe.version ? probe.version : t("notFound")}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {pythonDeps.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">{t("pythonDeps")}</div>
          <div className="flex flex-wrap gap-1">
            {pythonDeps.map((dep) => (
              <Badge key={dep} variant="outline" className="text-[10px] font-mono">
                {dep}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * One dependency per divided row: name, the version range it asks for, and
 * whether it is installed. It used to be a bordered package card per
 * dependency, so two dependencies cost two boxes inside a section inside the
 * pane, with the version on a line of its own.
 */
function DepRow({
  name,
  version,
  installed,
  optional,
  onOpen,
  t,
}: {
  name: string
  version: string
  installed: boolean
  optional?: boolean
  onOpen?: (pluginId: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const displayName = usePluginDisplayName(name)
  const showsId = displayName !== name
  const label = (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-medium">{displayName}</span>
      {showsId ? (
        <span className="truncate font-mono text-[10px] text-muted-foreground">{name}</span>
      ) : null}
    </span>
  )
  return (
    <li className="flex items-center gap-2 py-1.5 text-xs" data-testid={`dep-${name}`}>
      {installed && onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(name)}
          className="min-w-0 rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-10"
          aria-label={t("openDependencyAria", { name: displayName })}
        >
          {label}
        </button>
      ) : (
        <span className="min-w-0">{label}</span>
      )}
      <code className="shrink-0 font-mono text-[11px] text-muted-foreground">{version}</code>
      {optional && (
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {t("optional")}
        </Badge>
      )}
      {installed ? (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-emerald-600">
          <CheckCircle2Icon className="size-3" aria-hidden />
          {t("installed")}
        </span>
      ) : (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-amber-600">
          <XCircleIcon className="size-3" aria-hidden />
          {t("missing")}
        </span>
      )}
    </li>
  )
}
