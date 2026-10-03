"use client"

/**
 * A VS Code label with its `$(icon)` parts drawn. VS Code's codicon font is
 * not shipped, so the common codicons map to the matching lucide icons; an
 * icon with no counterpart is left out rather than shown as its name.
 */

import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Bell,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleX,
  Clock,
  Cloud,
  Copy,
  Edit,
  Eye,
  File,
  FileText,
  Filter,
  Folder,
  GitBranch,
  Globe,
  Info,
  Key,
  Link,
  Loader2,
  Lock,
  type LucideIcon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  Sparkles,
  Square,
  Star,
  Terminal,
  Trash2,
  Unlock,
  User,
  X,
  Zap,
} from "lucide-react"

import { parseCodiconText } from "@/lib/plugin/vscode-shim/codicon-text"
import { cn } from "@/lib/utils"

const CODICONS: Record<string, LucideIcon> = {
  account: User,
  add: Plus,
  "arrow-left": ArrowLeft,
  bell: Bell,
  bug: Bug,
  check: Check,
  "check-all": CircleCheck,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "circle-filled": Circle,
  "circle-outline": Circle,
  clock: Clock,
  close: X,
  cloud: Cloud,
  copy: Copy,
  "debug-pause": Pause,
  "debug-start": Play,
  edit: Edit,
  error: CircleX,
  eye: Eye,
  file: File,
  "file-text": FileText,
  filter: Filter,
  folder: Folder,
  gear: Settings,
  "git-branch": GitBranch,
  globe: Globe,
  info: Info,
  key: Key,
  link: Link,
  loading: Loader2,
  lock: Lock,
  pass: CircleCheck,
  "pass-filled": CircleCheck,
  play: Play,
  "primitive-square": Square,
  refresh: RefreshCw,
  rocket: Rocket,
  search: Search,
  settings: Settings,
  "settings-gear": Settings,
  sparkle: Sparkles,
  star: Star,
  "star-full": Star,
  stop: Square,
  sync: RefreshCw,
  terminal: Terminal,
  trash: Trash2,
  unlock: Unlock,
  warning: AlertTriangle,
  "workspace-trusted": CircleCheck,
  zap: Zap,
  issues: AlertCircle,
}

export function CodiconIcon({
  name,
  spin = false,
  className,
}: {
  name: string
  spin?: boolean
  className?: string
}) {
  const Icon = CODICONS[name]
  if (!Icon) return null
  return (
    <Icon
      aria-hidden
      data-codicon={name}
      className={cn(
        "inline size-3.5 shrink-0",
        (spin || name === "loading") && "animate-spin",
        className
      )}
    />
  )
}

export function CodiconLabel({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {parseCodiconText(label).map((segment, index) =>
        "text" in segment ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <CodiconIcon key={index} name={segment.icon} spin={segment.spin} />
        )
      )}
    </span>
  )
}
