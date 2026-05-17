import * as React from "react"

// Shared Jest manual mock for `@/components/ui/sidebar`. Every component is a
// semantic-element pass-through so the DOM tree is queryable in JSDOM without
// mounting the real SidebarProvider context.
//
// Notes:
//   - `SidebarTrigger` is the only export that takes click behavior; render a
//     real <button> with forwarded props so tests can fire clicks and assert
//     aria-label / data-testid / className.
//   - `useSidebar` is only consumed inside the real sidebar.tsx, but expose a
//     stub returning safe defaults in case future tests import it directly.

type DivProps = React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean
  isActive?: boolean
  children?: React.ReactNode
}

function ignoreSidebarOnlyProps<T extends Record<string, unknown>>(
  props: T
): Omit<T, "isActive" | "asChild" | "tooltip" | "size" | "variant"> {
  const {
    isActive: _a,
    asChild: _b,
    tooltip: _c,
    size: _d,
    variant: _e,
    ...rest
  } = props as T & {
    isActive?: unknown
    asChild?: unknown
    tooltip?: unknown
    size?: unknown
    variant?: unknown
  }
  void _a
  void _b
  void _c
  void _d
  void _e
  return rest
}

export function SidebarProvider({ children, ...rest }: DivProps) {
  return (
    <div data-testid="sidebar-provider" {...rest}>
      {children}
    </div>
  )
}

export function Sidebar({ children, ...rest }: DivProps) {
  return (
    <div data-testid="sidebar" {...rest}>
      {children}
    </div>
  )
}

export function SidebarInset({ children, ...rest }: DivProps) {
  return <div {...rest}>{children}</div>
}

export function SidebarRail({ children, ...rest }: DivProps) {
  return <div {...rest}>{children}</div>
}

export function SidebarHeader({ children, ...rest }: DivProps) {
  return <header {...(rest as React.HTMLAttributes<HTMLElement>)}>{children}</header>
}

export function SidebarFooter({ children, ...rest }: DivProps) {
  return <footer {...(rest as React.HTMLAttributes<HTMLElement>)}>{children}</footer>
}

export function SidebarContent({ children, ...rest }: DivProps) {
  return <div {...rest}>{children}</div>
}

export function SidebarGroup({ children, ...rest }: DivProps) {
  return <section {...(rest as React.HTMLAttributes<HTMLElement>)}>{children}</section>
}

export function SidebarGroupLabel({ children, ...rest }: DivProps) {
  return <h3 {...(rest as React.HTMLAttributes<HTMLHeadingElement>)}>{children}</h3>
}

export function SidebarGroupContent({ children, ...rest }: DivProps) {
  return <div {...rest}>{children}</div>
}

export function SidebarGroupAction({ children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...(ignoreSidebarOnlyProps(rest) as React.ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {children}
    </button>
  )
}

export function SidebarMenu({
  children,
  ...rest
}: React.HTMLAttributes<HTMLUListElement> & { children?: React.ReactNode }) {
  return <ul {...rest}>{children}</ul>
}

export function SidebarMenuSub({
  children,
  ...rest
}: React.HTMLAttributes<HTMLUListElement> & { children?: React.ReactNode }) {
  return <ul {...rest}>{children}</ul>
}

export function SidebarMenuItem({
  children,
  ...rest
}: React.LiHTMLAttributes<HTMLLIElement> & { children?: React.ReactNode }) {
  return <li {...rest}>{children}</li>
}

export function SidebarMenuSubItem({
  children,
  ...rest
}: React.LiHTMLAttributes<HTMLLIElement> & { children?: React.ReactNode }) {
  return <li {...rest}>{children}</li>
}

export function SidebarMenuButton({ children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...(ignoreSidebarOnlyProps(rest) as React.ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {children}
    </button>
  )
}

export function SidebarMenuSubButton({ children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...(ignoreSidebarOnlyProps(rest) as React.ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {children}
    </button>
  )
}

export function SidebarMenuAction({ children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...(ignoreSidebarOnlyProps(rest) as React.ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {children}
    </button>
  )
}

export function SidebarMenuBadge({ children, ...rest }: DivProps) {
  return <span {...(rest as React.HTMLAttributes<HTMLSpanElement>)}>{children}</span>
}

export function SidebarMenuSkeleton({ children, ...rest }: DivProps) {
  return <div {...rest}>{children}</div>
}

export function SidebarSeparator(props: React.HTMLAttributes<HTMLHRElement>) {
  return <hr {...props} />
}

export function SidebarInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />
}

export function SidebarTrigger({
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) {
  return (
    <button type="button" className={className} {...rest}>
      {children}
    </button>
  )
}

export function useSidebar() {
  return {
    state: "expanded" as const,
    open: true,
    setOpen: () => {},
    openMobile: false,
    setOpenMobile: () => {},
    isMobile: false,
    toggleSidebar: () => {},
  }
}
