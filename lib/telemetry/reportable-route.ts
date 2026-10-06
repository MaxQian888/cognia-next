// Shared by early performance collection and app-session telemetry. Keep this
// leaf free of logging/database imports so diagnostics do not delay app boot.
const ROUTE_SEGMENT = /^[a-z][a-z0-9-]{0,31}$/

export function toReportableRoute(pathname: string | null | undefined): string {
  if (!pathname) return "other"
  const [path] = pathname.split(/[?#]/)
  const segments = path.split("/").filter(Boolean)
  if (segments.length === 0) return "/"
  const kept = segments.slice(0, 2)
  if (!kept.every((segment) => ROUTE_SEGMENT.test(segment))) return "other"
  return `/${kept.join("/")}`
}
