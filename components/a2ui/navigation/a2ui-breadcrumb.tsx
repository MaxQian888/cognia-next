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
                <BreadcrumbLink
                  href={item.href || "#"}
                  onClick={(e) => {
                    if (item.href) onAction("navigate", { href: item.href })
                    else e.preventDefault()
                  }}
                >
                  {item.label}
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {i < component.items.length - 1 && <BreadcrumbSeparator />}
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
})
