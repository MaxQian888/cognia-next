"use client"

/**
 * The open-source acknowledgements grid on the About page.
 *
 * Brand path data for Next.js / React / Tauri / Capacitor / Tailwind CSS /
 * shadcn-ui / Radix UI is vendored from Simple Icons (CC0,
 * https://simpleicons.org) so the credits show real, recognizable marks
 * without adding an npm dependency — the same convention as
 * `components/connectors/platform-icons`. Each mark is a 24×24 `currentColor`
 * path, tinted by the entry's `tint` class so the vendor colour survives both
 * themes. Zustand and next-intl have no Simple Icons entry, so they keep a
 * lucide glyph.
 */

import type { ComponentType } from "react"
import { LanguagesIcon, LayersIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { openExternal } from "@/lib/tauri/opener"

type MarkProps = { className?: string }

/** Wrap a vendored Simple Icons path in a 24×24 currentColor svg. */
function simpleIcon(path: string, title: string): ComponentType<MarkProps> {
  function Mark({ className }: MarkProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        fill="currentColor"
        aria-hidden
        focusable="false"
      >
        <path d={path} />
      </svg>
    )
  }
  Mark.displayName = `${title}Mark`
  return Mark
}

const NextMark = simpleIcon(
  "M18.665 21.978C16.758 23.255 14.465 24 12 24 5.377 24 0 18.623 0 12S5.377 0 12 0s12 5.377 12 12c0 3.583-1.574 6.801-4.067 9.001L9.219 7.2H7.2v9.596h1.615V9.251l9.85 12.727Zm-3.332-8.533 1.6 2.061V7.2h-1.6v6.245Z",
  "NextJs"
)

const ReactMark = simpleIcon(
  "M14.23 12.004a2.236 2.236 0 0 1-2.235 2.236 2.236 2.236 0 0 1-2.236-2.236 2.236 2.236 0 0 1 2.235-2.236 2.236 2.236 0 0 1 2.236 2.236zm2.648-10.69c-1.346 0-3.107.96-4.888 2.622-1.78-1.653-3.542-2.602-4.887-2.602-.41 0-.783.093-1.106.278-1.375.793-1.683 3.264-.973 6.365C1.98 8.917 0 10.42 0 12.004c0 1.59 1.99 3.097 5.043 4.03-.704 3.113-.39 5.588.988 6.38.32.187.69.275 1.102.275 1.345 0 3.107-.96 4.888-2.624 1.78 1.654 3.542 2.603 4.887 2.603.41 0 .783-.09 1.106-.275 1.374-.792 1.683-3.263.973-6.365C22.02 15.096 24 13.59 24 12.004c0-1.59-1.99-3.097-5.043-4.032.704-3.11.39-5.587-.988-6.38-.318-.184-.688-.277-1.092-.278zm-.005 1.09v.006c.225 0 .406.044.558.127.666.382.955 1.835.73 3.704-.054.46-.142.945-.25 1.44-.96-.236-2.006-.417-3.107-.534-.66-.905-1.345-1.727-2.035-2.447 1.592-1.48 3.087-2.292 4.105-2.295zm-9.77.02c1.012 0 2.514.808 4.11 2.28-.686.72-1.37 1.537-2.02 2.442-1.107.117-2.154.298-3.113.538-.112-.49-.195-.964-.254-1.42-.23-1.868.054-3.32.714-3.707.19-.09.4-.127.563-.132zm4.882 3.05c.455.468.91.992 1.36 1.564-.44-.02-.89-.034-1.345-.034-.46 0-.915.01-1.36.034.44-.572.895-1.096 1.345-1.565zM12 8.1c.74 0 1.477.034 2.202.093.406.582.802 1.203 1.183 1.86.372.64.71 1.29 1.018 1.946-.308.655-.646 1.31-1.013 1.95-.38.66-.773 1.288-1.18 1.87-.728.063-1.466.098-2.21.098-.74 0-1.477-.035-2.202-.093-.406-.582-.802-1.204-1.183-1.86-.372-.64-.71-1.29-1.018-1.946.303-.657.646-1.313 1.013-1.954.38-.66.773-1.286 1.18-1.868.728-.064 1.466-.098 2.21-.098zm-3.635.254c-.24.377-.48.763-.704 1.16-.225.39-.435.782-.635 1.174-.265-.656-.49-1.31-.676-1.947.64-.15 1.315-.283 2.015-.386zm7.26 0c.695.103 1.365.23 2.006.387-.18.632-.405 1.282-.66 1.933-.2-.39-.41-.783-.64-1.174-.225-.392-.465-.774-.705-1.146zm3.063.675c.484.15.944.317 1.375.498 1.732.74 2.852 1.708 2.852 2.476-.005.768-1.125 1.74-2.857 2.475-.42.18-.88.342-1.355.493-.28-.958-.646-1.956-1.1-2.98.45-1.017.81-2.01 1.085-2.964zm-13.395.004c.278.96.645 1.957 1.1 2.98-.45 1.017-.812 2.01-1.086 2.964-.484-.15-.944-.318-1.37-.5-1.732-.737-2.852-1.706-2.852-2.474 0-.768 1.12-1.742 2.852-2.476.42-.18.88-.342 1.356-.494zm11.678 4.28c.265.657.49 1.312.676 1.948-.64.157-1.316.29-2.016.39.24-.375.48-.762.705-1.158.225-.39.435-.788.636-1.18zm-9.945.02c.2.392.41.783.64 1.175.23.39.465.772.705 1.143-.695-.102-1.365-.23-2.006-.386.18-.63.406-1.282.66-1.933zM17.92 16.32c.112.493.2.968.254 1.423.23 1.868-.054 3.32-.714 3.708-.147.09-.338.128-.563.128-1.012 0-2.514-.807-4.11-2.28.686-.72 1.37-1.536 2.02-2.44 1.107-.118 2.154-.3 3.113-.54zm-11.83.01c.96.234 2.006.415 3.107.532.66.905 1.345 1.727 2.035 2.446-1.595 1.483-3.092 2.295-4.11 2.295-.22-.005-.406-.05-.553-.132-.666-.38-.955-1.834-.73-3.703.054-.46.142-.944.25-1.438zm4.56.64c.44.02.89.034 1.345.034.46 0 .915-.01 1.36-.034-.44.572-.895 1.095-1.345 1.565-.455-.47-.91-.993-1.36-1.565z",
  "React"
)

const TauriMark = simpleIcon(
  "M13.912 0a8.72 8.72 0 0 0-8.308 6.139c1.05-.515 2.18-.845 3.342-.976 2.415-3.363 7.4-3.412 9.88-.097 2.48 3.315 1.025 8.084-2.883 9.45a6.131 6.131 0 0 1-.3 2.762 8.72 8.72 0 0 0 3.01-1.225A8.72 8.72 0 0 0 13.913 0zm.082 6.451a2.284 2.284 0 1 0-.15 4.566 2.284 2.284 0 0 0 .15-4.566zm-5.629.27a8.72 8.72 0 0 0-3.031 1.235 8.72 8.72 0 1 0 13.06 9.9131 10.173 10.174 0 0 1-3.343.965 6.125 6.125 0 1 1-7.028-9.343 6.114 6.115 0 0 1 .342-2.772zm1.713 6.27a2.284 2.284 0 0 0-2.284 2.283 2.284 2.284 0 0 0 2.284 2.284 2.284 2.284 0 0 0 2.284-2.284 2.284 2.284 0 0 0-2.284-2.284z",
  "Tauri"
)

const CapacitorMark = simpleIcon(
  "M24 3.7l-5.766 5.766 5.725 5.736-3.713 3.712L5.073 3.742 8.786.03l5.736 5.726L20.284 0 24 3.7zM.029 8.785l3.713-3.713 15.173 15.173-3.713 3.714-5.732-5.726L3.7 24 0 20.285l5.754-5.764L.029 8.785z",
  "Capacitor"
)

const TailwindMark = simpleIcon(
  "M12.001,4.8c-3.2,0-5.2,1.6-6,4.8c1.2-1.6,2.6-2.2,4.2-1.8c0.913,0.228,1.565,0.89,2.288,1.624 C13.666,10.618,15.027,12,18.001,12c3.2,0,5.2-1.6,6-4.8c-1.2,1.6-2.6,2.2-4.2,1.8c-0.913-0.228-1.565-0.89-2.288-1.624 C16.337,6.182,14.976,4.8,12.001,4.8z M6.001,12c-3.2,0-5.2,1.6-6,4.8c1.2-1.6,2.6-2.2,4.2-1.8c0.913,0.228,1.565,0.89,2.288,1.624 c1.177,1.194,2.538,2.576,5.512,2.576c3.2,0,5.2-1.6,6-4.8c-1.2,1.6-2.6,2.2-4.2,1.8c-0.913-0.228-1.565-0.89-2.288-1.624 C10.337,13.382,8.976,12,6.001,12z",
  "Tailwind"
)

const ShadcnMark = simpleIcon(
  "M22.219 11.784 11.784 22.219c-.407.407-.407 1.068 0 1.476.407.407 1.068.407 1.476 0L23.695 13.26c.407-.408.407-1.069 0-1.476-.408-.407-1.069-.407-1.476 0ZM20.132.305.305 20.132c-.407.407-.407 1.068 0 1.476.408.407 1.069.407 1.476 0L21.608 1.781c.407-.407.407-1.068 0-1.476-.408-.407-1.069-.407-1.476 0Z",
  "Shadcn"
)

const RadixMark = simpleIcon(
  "M11.52 24a7.68 7.68 0 0 1-7.68-7.68 7.68 7.68 0 0 1 7.68-7.68V24Zm0-24v7.68H3.84V0h7.68Zm4.8 7.68a3.84 3.84 0 1 1 0-7.68 3.84 3.84 0 0 1 0 7.68Z",
  "Radix"
)

interface StackEntry {
  /** Proper-noun project name — not translated. */
  name: string
  url: string
  mark: ComponentType<MarkProps>
  /** Vendor brand colour; monochrome marks inherit the foreground. */
  tint: string
}

const STACK: StackEntry[] = [
  { name: "Next.js", url: "https://nextjs.org", mark: NextMark, tint: "text-foreground" },
  { name: "React", url: "https://react.dev", mark: ReactMark, tint: "text-[#149ECA]" },
  { name: "Tauri", url: "https://tauri.app", mark: TauriMark, tint: "text-[#1197A5]" },
  {
    name: "Capacitor",
    url: "https://capacitorjs.com",
    mark: CapacitorMark,
    tint: "text-[#119EFF]",
  },
  {
    name: "Tailwind CSS",
    url: "https://tailwindcss.com",
    mark: TailwindMark,
    tint: "text-[#06B6D4]",
  },
  { name: "shadcn/ui", url: "https://ui.shadcn.com", mark: ShadcnMark, tint: "text-foreground" },
  { name: "Radix UI", url: "https://www.radix-ui.com", mark: RadixMark, tint: "text-foreground" },
  {
    name: "Zustand",
    url: "https://zustand-demo.pmnd.rs",
    mark: LayersIcon,
    tint: "text-[#B4783A]",
  },
  { name: "next-intl", url: "https://next-intl.dev", mark: LanguagesIcon, tint: "text-foreground" },
]

/**
 * Tech-stack credits as a tile grid: each entry is a real brand mark on a
 * tinted plate above its name, and opens the project's site. Two columns on a
 * phone, three from `sm` up.
 */
export function TechStack() {
  return (
    <div
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      data-testid="acknowledgements"
      role="list"
    >
      {STACK.map(({ name, url, mark: Mark, tint }) => (
        <Button
          key={name}
          type="button"
          variant="outline"
          role="listitem"
          onClick={() => void openExternal(url)}
          data-testid={`stack-${name}`}
          className="group h-auto justify-start gap-2.5 rounded-lg bg-background/40 p-2.5 text-left font-normal transition-all duration-200 hover:-translate-y-px hover:border-foreground/20 hover:bg-accent/50 hover:shadow-sm"
        >
          <span
            className={`flex size-7 shrink-0 items-center justify-center rounded-md bg-current/10 ${tint}`}
          >
            <Mark className="size-4" />
          </span>
          <span className="min-w-0 truncate text-xs font-medium">{name}</span>
        </Button>
      ))}
    </div>
  )
}
