import {
  AlertTriangle,
  AppWindow,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ChevronsUp,
  ChevronUp,
  Circle,
  CircleDot,
  Code2,
  Command,
  Cpu,
  Database,
  FileText,
  FolderTree,
  GitBranch,
  Info,
  KeyRound,
  Languages,
  Laptop,
  ListChecks,
  Menu,
  MessageSquare,
  Minus,
  Monitor,
  Moon,
  Play,
  Plug,
  Puzzle,
  Scale,
  ScrollText,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Sun,
  Terminal,
  Workflow,
  X,
} from "lucide-react"
import { cn } from "@web/lib/utils"

/**
 * The site's icon vocabulary (ADR-0092 §6, amended).
 *
 * A closed registry rather than direct imports at each call site, for three
 * reasons:
 *
 *  - **One place enforces `strokeWidth={1.5}`.** Lucide's default is 2px. The
 *    entire visual system is built on 1px hairlines used as measurement marks,
 *    and 2px glyphs beside 1px rules is precisely what would make this read as
 *    a generic SaaS template rather than as the instrument the spec describes.
 *  - **One place enforces `aria-hidden`.** Every icon here accompanies a text
 *    label that already exists; none of them is the accessible name of
 *    anything. That rule is what keeps every `getByRole(…, { name })` query in
 *    the site's suites valid.
 *  - **One screen shows the whole vocabulary**, so a reviewer can reject the
 *    next addition on sight.
 *
 * Tree-shaking survives a static object literal of imported components. Keep
 * this list under about forty entries: past that the registry becomes a barrel
 * and bundlers stop dropping the unreferenced ones.
 *
 * Note there is no brand mark for the repository link — lucide v1 removed its
 * brand icons, and hand-authoring an inline SVG would create a gated component
 * file needing its own test in exchange for one glyph. `Code2` stands in.
 */
const ICONS = {
  action: CircleDot,
  agents: ListChecks,
  alert: AlertTriangle,
  appWindow: AppWindow,
  approval: KeyRound,
  artifact: FileText,
  bell: Bell,
  chat: MessageSquare,
  check: Check,
  chevronDown: ChevronDown,
  close: X,
  command: Command,
  data: Database,
  external: ArrowUpRight,
  files: FolderTree,
  info: Info,
  knowledge: BookOpen,
  language: Languages,
  laptop: Laptop,
  license: Scale,
  menu: Menu,
  model: Cpu,
  pending: Circle,
  play: Play,
  plugin: Puzzle,
  record: ScrollText,
  repository: GitBranch,
  next: SkipForward,
  previous: SkipBack,
  source: Code2,
  system: Monitor,
  terminal: Terminal,
  themeDark: Moon,
  themeLight: Sun,
  tool: Plug,
  trust: ShieldCheck,
  workflow: Workflow,
  bumpMajor: ChevronsUp,
  bumpMinor: ChevronUp,
  bumpPatch: Minus,
} as const

export type IconName = keyof typeof ICONS

interface IconProps {
  name: IconName
  /**
   * 14 beside a 10px mono label, 16 beside `text-xs`/`text-sm` (the default),
   * 20 beside a section heading. Never larger: an icon must not exceed roughly
   * 1.25× the cap-height of the text it sits with, or it stops being a mark and
   * starts being an illustration.
   */
  size?: 14 | 16 | 20
  className?: string
}

/**
 * A decorative mark beside a label.
 *
 * Always `aria-hidden`: an icon here never carries information the adjacent
 * text does not. Never `fill` — the system is a line drawing.
 *
 * On colour: `text-action` (cyan) is only legible on the `--stage` /
 * `--graphite` substrate, where `globals.css` lifts it to `#4fdcea`. On paper
 * or surface it is 1.69:1 and must not be used, not even for a 1.5px stroke.
 */
export function Icon({ name, size = 16, className }: IconProps) {
  const Glyph = ICONS[name]
  return (
    <Glyph
      aria-hidden
      focusable="false"
      width={size}
      height={size}
      strokeWidth={1.5}
      className={cn("shrink-0", className)}
    />
  )
}
