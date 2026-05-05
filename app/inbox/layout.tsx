/**
 * /inbox layout.
 *
 * Bare wrapper — the InboxShell component (Task 48) is rendered inside each
 * child route page so each page can pass view/scope props. This layout
 * only provides the min-h-screen container.
 */
export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-background">{children}</div>
}
