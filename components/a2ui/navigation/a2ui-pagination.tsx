"use client"

import React, { memo, useCallback } from "react"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import { useA2UIData } from "../a2ui-context"
import type { A2UIComponentProps, A2UIBaseComponent, A2UINumberOrPath } from "@/types/a2ui/schema"

export interface A2UIPaginationComponent extends A2UIBaseComponent {
  component: "Pagination"
  currentPage: A2UINumberOrPath
  totalPages: number
  siblingCount?: number
  pageChangeAction?: string
}

function getPageRange(current: number, total: number, siblings: number): (number | "ellipsis")[] {
  const pages: (number | "ellipsis")[] = []
  const left = Math.max(2, current - siblings)
  const right = Math.min(total - 1, current + siblings)

  pages.push(1)
  if (left > 2) pages.push("ellipsis")
  for (let i = left; i <= right; i++) pages.push(i)
  if (right < total - 1) pages.push("ellipsis")
  if (total > 1) pages.push(total)
  return pages
}

export const A2UIPagination = memo(function A2UIPagination({
  component,
  onAction,
}: A2UIComponentProps<A2UIPaginationComponent>) {
  const { resolveNumber } = useA2UIData()
  const current = resolveNumber(component.currentPage, 1)
  const total = component.totalPages
  const siblings = component.siblingCount || 1

  const handlePage = useCallback(
    (page: number) => {
      if (component.pageChangeAction) {
        onAction(component.pageChangeAction, { page })
      }
    },
    [component.pageChangeAction, onAction]
  )

  if (total <= 1) return null

  const pages = getPageRange(current, total, siblings)

  return (
    <Pagination className={component.className} style={component.style as React.CSSProperties}>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            onClick={() => current > 1 && handlePage(current - 1)}
            className={current <= 1 ? "pointer-events-none opacity-50" : ""}
          />
        </PaginationItem>
        {pages.map((page, i) => (
          <PaginationItem key={i}>
            {page === "ellipsis" ? (
              <PaginationEllipsis />
            ) : (
              <PaginationLink isActive={page === current} onClick={() => handlePage(page)}>
                {page}
              </PaginationLink>
            )}
          </PaginationItem>
        ))}
        <PaginationItem>
          <PaginationNext
            onClick={() => current < total && handlePage(current + 1)}
            className={current >= total ? "pointer-events-none opacity-50" : ""}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  )
})
