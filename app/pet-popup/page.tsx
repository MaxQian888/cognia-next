"use client"

import { PetPopupView } from "@/components/pet/pet-popup-view"

// Transparent desktop-pet click popup route. Rendered inside the frameless,
// always-on-top "pet-popup" Tauri window opened by the Rust `open_pet_popup`
// command when the user right-clicks the sprite. The desktop shell bypasses
// this prefix (see `desktop-app-shell.tsx` BYPASS_PREFIXES) so no chrome paints,
// and PetPopupView marks <html> with `data-pet-overlay` for a transparent page.
export default function PetPopupPage() {
  return <PetPopupView />
}
