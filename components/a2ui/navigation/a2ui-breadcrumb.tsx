"use client"

import React, { memo } from "react"
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
} from "@/components/ui/breadcrumb"
import { ExternalLink } from "@/components/shared/external-link"
import { a2uiActionTarget, isWebHref, safeA2UIHref } from "@/lib/a2ui/url-policy"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UIBreadcrumbItem {
  label: string
  href?: string
  current?: boolean
  ellipsis?: boolean
}

export interface A2UIBreadcrumbComponent extends A2UIBaseComponent {
  component: "Breadcrumb"
  items: A2UIBreadcrumbItem[]
}

/**
 * Items with an `href` emit `navigate`. Only a web page (`lib/a2ui/url-policy.ts`,
 * ADR-0240) is also opened, through `ExternalLink`; any other target, an in-app
 * path included, stays an action so a model-written crumb cannot move the app
 * away from the conversation.
 */
function A2UIBreadcrumbTarget({
  item,
  onAction,
}: {
  item: A2UIBreadcrumbItem
  onAction: A2UIComponentProps["onAction"]
}) {
  if (!item.href) {
    return (
      <BreadcrumbLink href="#" onClick={(e) => e.preventDefault()}>
        {item.label}
      </BreadcrumbLink>
    )
  }
  const target = a2uiActionTarget(item.href)
  const select = () =>
    onAction("navigate", target ? { href: target, label: item.label } : { label: item.label })
  const href = safeA2UIHref(item.href)
  if (href && isWebHref(href)) {
    return (
      <BreadcrumbLink asChild>
        <ExternalLink href={href} onClick={select}>
          {item.label}
        </ExternalLink>
      </BreadcrumbLink>
    )
  }
  if (href) {
    return (
      <BreadcrumbLink href={href} onClick={select}>
        {item.label}
      </BreadcrumbLink>
    )
  }
  return (
    <BreadcrumbLink asChild>
      <button type="button" onClick={select}>
        {item.label}
      </button>
    </BreadcrumbLink>
  )
}

export const A2UIBreadcrumb = memo(function A2UIBreadcrumb({
  component,
  onAction,
}: A2UIComponentProps<A2UIBreadcrumbComponent>) {
  return (
    <Breadcrumb className={component.className} style={component.style as React.CSSProperties}>
      <BreadcrumbList>
        {component.items.map((item, i) => (
          <React.Fragment key={i}>
            <BreadcrumbItem>
              {item.ellipsis ? (
                <BreadcrumbEllipsis />
              ) : item.current ? (
                <BreadcrumbPage>{item.label}</BreadcrumbPage>
              ) : (
                <A2UIBreadcrumbTarget item={item} onAction={onAction} />
              )}
            </BreadcrumbItem>
            {i < component.items.length - 1 && <BreadcrumbSeparator />}
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
})
