"use client"

import { Suspense } from "react"

import { BrowserDesktopBody } from "@/components/browser/browser-desktop-body"

export default function BrowserPage() {
  return (
    <Suspense fallback={null}>
      <div className="h-full w-full min-h-0 flex-1" data-bg-target="chat">
        <BrowserDesktopBody />
      </div>
    </Suspense>
  )
}
