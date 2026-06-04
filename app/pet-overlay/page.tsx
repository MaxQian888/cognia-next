"use client"

import { PetOverlayView } from "@/components/pet/pet-overlay-view"

// Transparent desktop-pet overlay route. Rendered inside the frameless,
// always-on-top "pet" Tauri window. The desktop shell bypasses this prefix
// (see `desktop-app-shell.tsx` BYPASS_PREFIXES) so no chrome paints, and
// PetOverlayView marks <html> with `data-pet-overlay` to make the page
// background transparent.
export default function PetOverlayPage() {
  return <PetOverlayView />
}
