"use client"

import { Suspense, useSyncExternalStore, type AnchorHTMLAttributes } from "react"
import { ProjectFileLink } from "@/components/chat/project-file-link"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import { ExternalLink } from "@/components/shared/external-link"
import {
  parseProjectFileReference,
  type ProjectFileReference,
} from "@/lib/files/project-file-reference"
import {
  getLinkMatcher,
  getLinkMatchersRevision,
  subscribeLinkMatchers,
} from "@/lib/plugin/api/link-matchers"

interface ChatLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  projectRoot?: string | null
  onOpenProjectFile?: (target: ProjectFileReference) => void
  messageId?: string
  isStreaming?: boolean
  /** Reasoning shares Markdown styles, but does not expose links to plugins. */
  allowPlugins?: boolean
}

/**
 * Shared live lookup for both sanitized Markdown pipelines. Keeping the
 * subscription here lets existing messages react to plugin enable/disable even
 * when their renderer's memoized components object has not changed.
 */
export function ChatLink({
  href = "",
  children,
  projectRoot,
  onOpenProjectFile,
  messageId,
  isStreaming,
  allowPlugins = true,
  ...props
}: ChatLinkProps) {
  const revision = useSyncExternalStore(
    subscribeLinkMatchers,
    getLinkMatchersRevision,
    getLinkMatchersRevision
  )
  const target = href ? parseProjectFileReference(href, projectRoot) : null
  if (target) {
    return (
      <ProjectFileLink target={target} projectRoot={projectRoot} onOpenFile={onOpenProjectFile}>
        {children}
      </ProjectFileLink>
    )
  }
  const fallback = (
    <ExternalLink href={href} className="text-primary hover:underline" preferEmbedded {...props}>
      {children}
    </ExternalLink>
  )
  const matcher = allowPlugins && href ? getLinkMatcher(href) : undefined
  if (!matcher) return fallback
  const Renderer = matcher.component
  return (
    <PluginSurface
      key={`${matcher.pluginId}:${matcher.id}:${href}:${revision}`}
      pluginId={matcher.pluginId}
      surfaceId={`link-matcher:${matcher.pluginId}:${matcher.id}`}
      formFactor="row"
      inline
      fallback={fallback}
    >
      <Suspense fallback={fallback}>
        <Renderer href={href} messageId={messageId} isStreaming={isStreaming}>
          {children}
        </Renderer>
      </Suspense>
    </PluginSurface>
  )
}
