import { fromMarkdownSlug } from "@/lib/llms-format"
import { getPageMarkdown, markdownRouteParams } from "@/lib/llms"

// Static export (D8): pre-rendered to `out/md/{lang}/{...slug}.md`. The `.md`
// on the final slug segment is what makes Cloudflare Pages serve these as
// readable text — see the note in lib/llms.ts.
export const dynamic = "force-static"
export const revalidate = false

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ lang: string; slug?: string[] }> }
) {
  const { lang, slug } = await params

  const slugs = fromMarkdownSlug(slug)
  if (!slugs) return new Response("Not found", { status: 404 })

  const markdown = await getPageMarkdown(lang, slugs)
  if (!markdown) return new Response("Not found", { status: 404 })

  return new Response(markdown, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  })
}

export function generateStaticParams() {
  return markdownRouteParams()
}
