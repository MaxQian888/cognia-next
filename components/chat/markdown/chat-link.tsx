"use client"

import { Suspense, useSyncExternalStore, type AnchorHTMLAttributes } from "react"
import { LinkHoverPreview } from "@/components/chat/link-preview/link-hover-preview"
import { LinkSiteIcon } from "@/components/chat/link-preview/link-site-icon"
import { useChatLinkOptions } from "@/components/chat/markdown/chat-link-options"
import { ProjectFileLink } from "@/components/chat/project-file-link"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import { ExternalLink } from "@/components/shared/external-link"
import { describeLink } from "@/lib/chat/link-display"
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
  const linkOptions = useChatLinkOptions()
  const target = href ? parseProjectFileReference(href, projectRoot) : null
  if (target) {
    return (
      <ProjectFileLink target={target} projectRoot={projectRoot} onOpenFile={onOpenProjectFile}>
        {children}
      </ProjectFileLink>
    )
  }
  const isWebLink = /^https?:\/\//i.test(href)
  // A bare autolinked URL reads as its own href; show the same short label the
  // composer folds it to (`owner/repo` for a GitHub URL) and keep the full URL
  // in the tooltip, so a link looks the same before and after it is sent.
  const isBareUrl = isWebLink && typeof children === "string" && children.trim() === href
  const fallbackLink = (
    <ExternalLink
      href={href}
      className="chat-link"
      preferEmbedded
      title={isBareUrl ? href : undefined}
      data-chat-link={isWebLink ? "web" : "other"}
      {...props}
    >
      {isWebLink && linkOptions.siteIcon ? (
        <LinkSiteIcon url={href} allowFetch={linkOptions.preview !== "off" && !isStreaming} />
      ) : null}
      {isBareUrl ? describeLink(href).label : children}
    </ExternalLink>
  )
  const fallback =
    isWebLink && linkOptions.preview !== "off" ? (
      <LinkHoverPreview url={href} allowFetch={!isStreaming}>
        {fallbackLink}
      </LinkHoverPreview>
    ) : (
      fallbackLink
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
