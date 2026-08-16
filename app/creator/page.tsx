"use client"

import { CreatorGate, CreatorWorkbench } from "@/components/creator"

/**
 * The Creator workbench route (ADR-0117, Phase 3).
 *
 * The route is part of the static export — `output: "export"` prerenders every
 * route at build time, so the developer-mode check cannot remove the page, only
 * refuse to render its contents. `CreatorGate` is that refusal, and it reads the
 * same signal that decides whether the Creator chat preset is offered.
 */
export default function CreatorPage() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-bg-target="chat">
      <CreatorGate>
        <CreatorWorkbench />
      </CreatorGate>
    </div>
  )
}
