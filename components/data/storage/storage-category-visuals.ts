/**
 * One icon + one colour per storage category, shared by every surface that
 * draws the breakdown: the desktop stacked bar (`storage-breakdown.tsx`), the
 * mobile hero bar and the mobile category rows (`components/mobile/me/`).
 *
 * The two maps used to live inside the desktop component, so the phone page
 * had to draw an unlabelled `bg-primary` bar per row and could not colour
 * its segments to match the desktop. Both shells now read the same table,
 * and the test pins that every `StorageCategory` is covered.
 */

import {
  BotIcon,
  CogIcon,
  DatabaseIcon,
  FileCodeIcon,
  FileTextIcon,
  HistoryIcon,
  KeyRoundIcon,
  Layers3Icon,
  type LucideIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PawPrintIcon,
  PuzzleIcon,
  SettingsIcon,
  ShieldIcon,
} from "lucide-react"

import type { StorageCategory } from "@/lib/storage"

export const CATEGORY_ICONS: Readonly<Record<StorageCategory, LucideIcon>> = Object.freeze({
  settings: SettingsIcon,
  session: MessageSquareIcon,
  chat: MessageCircleIcon,
  character: BotIcon,
  skill: PuzzleIcon,
  team: Layers3Icon,
  mcp: PuzzleIcon,
  preset: FileTextIcon,
  canvas: FileCodeIcon,
  trustedWorkspace: ShieldIcon,
  ttsKey: KeyRoundIcon,
  backupHistory: HistoryIcon,
  vector: DatabaseIcon,
  artifact: FileTextIcon,
  pet: PawPrintIcon,
  system: CogIcon,
  other: MoreHorizontalIcon,
})

/** Filled background (`bg-*`) for a bar segment, a legend dot or an icon tile. */
export const CATEGORY_COLORS: Readonly<Record<StorageCategory, string>> = Object.freeze({
  settings: "bg-blue-500",
  session: "bg-green-500",
  chat: "bg-emerald-500",
  character: "bg-orange-500",
  skill: "bg-yellow-500",
  team: "bg-cyan-500",
  mcp: "bg-purple-500",
  preset: "bg-indigo-500",
  canvas: "bg-amber-500",
  trustedWorkspace: "bg-rose-500",
  ttsKey: "bg-pink-500",
  backupHistory: "bg-teal-500",
  vector: "bg-violet-500",
  artifact: "bg-violet-500",
  pet: "bg-pink-500",
  system: "bg-slate-500",
  other: "bg-zinc-500",
})

/** Neutral fill for the "everything else" segment once the top N are drawn. */
export const OTHER_SEGMENT_COLOR = "bg-zinc-400"

export function categoryIcon(category: StorageCategory): LucideIcon {
  return CATEGORY_ICONS[category] ?? CATEGORY_ICONS.other
}

export function categoryColor(category: StorageCategory): string {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other
}
