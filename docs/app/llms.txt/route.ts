import { i18n } from "@/lib/i18n"
import { renderLlmsIndex } from "@/lib/llms"

// Static export (D8): route handlers are pre-rendered to disk at their
// pathname, so this becomes `out/llms.txt`.
export const dynamic = "force-static"
export const revalidate = false

export function GET() {
  return new Response(renderLlmsIndex([...i18n.languages]), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
