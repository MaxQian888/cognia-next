"use client"

import { VideoGenerationCard } from "./media-generation/video-generation-card"

/**
 * Settings → Media generation (ADR-0205, G12). Holds the defaults for media
 * generated from chat; video is its only card today (G14: text-to-image stays
 * with the chat image workbench).
 */
export function MediaGenerationSection() {
  return (
    <div className="space-y-4">
      <VideoGenerationCard />
    </div>
  )
}
