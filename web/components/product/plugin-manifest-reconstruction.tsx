import { AppFrame, PaneHeading } from "@web/components/product/app-frame"
import { Icon } from "@web/components/icon"
import { DEMO_TASK } from "@web/content/demo-task"
import type { ReconstructionCopy } from "@web/content/types"

interface PluginManifestReconstructionProps {
  copy: ReconstructionCopy
  className?: string
}

/**
 * A plugin's declaration, and the one call it did not declare.
 *
 * Everything shown is read from a manifest that ships in this repository
 * (`plugins/web-tools/plugin.json`, via `DEMO_TASK.plugin`): what the plugin
 * contributes, the permissions it declares, and a real permission id it does
 * not declare, shown refused. The /plugins page claims that undeclared APIs
 * are denied and that the declaration can be read before installing. This is
 * that declaration, readable.
 */
export function PluginManifestReconstruction({
  copy,
  className,
}: PluginManifestReconstructionProps) {
  const { plugin } = copy
  const manifest = DEMO_TASK.plugin

  return (
    <AppFrame
      title={manifest.id}
      meta={plugin.manifestLabel}
      label={copy.label}
      className={className}
    >
      <div className="grid gap-px bg-hairline md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5 bg-surface p-5 md:p-6">
          <div>
            <PaneHeading>{plugin.capabilitiesLabel}</PaneHeading>
            <ul className="mt-2.5 flex flex-wrap gap-2">
              {manifest.capabilities.map((capability) => (
                <li
                  key={capability}
                  className="rounded-control border border-hairline-strong bg-paper px-2.5 py-1 font-mono text-xs text-ink"
                >
                  {capability}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <PaneHeading>{plugin.permissionsLabel}</PaneHeading>
            <ul className="mt-2.5 flex flex-col">
              {manifest.permissions.map((permission) => (
                <li
                  key={permission}
                  className="flex items-center gap-3 border-t border-hairline py-2.5 first:border-t-0 first:pt-0"
                >
                  <Icon name="check" size={14} className="shrink-0 text-success" />
                  <span className="font-mono text-xs text-ink">{permission}</span>
                  <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted">
                    {plugin.grantedLabel}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex flex-col gap-3 bg-paper p-5 md:p-6">
          <PaneHeading>{plugin.deniedLabel}</PaneHeading>
          <div className="rounded-control border border-destructive/50 px-3 py-2.5">
            <p className="flex items-center gap-3">
              <Icon name="close" size={14} className="shrink-0 text-destructive" />
              <span className="font-mono text-xs text-ink line-through decoration-destructive/60">
                {manifest.denied}
              </span>
            </p>
          </div>
          <p className="text-sm leading-relaxed text-muted">{plugin.deniedNote}</p>
        </div>
      </div>
    </AppFrame>
  )
}
