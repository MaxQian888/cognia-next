import { i18n } from "@/lib/i18n"
import { renderLlmsFullText } from "@/lib/llms"

// Static export (D8): pre-rendered to `out/{lang}/llms-full.txt`. Split per
// locale rather than one combined file — a single document holding both
// languages would be ~8 MB and half of it useless to any given reader.
export const dynamic = "force-static"
export const revalidate = false

export async function GET(_request: Request, { params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params

  // `languages` is a narrowed tuple; widen it to compare against a route param.
  if (!(i18n.languages as readonly string[]).includes(lang)) {
    return new Response("Not found", { status: 404 })
  }

  return new Response(await renderLlmsFullText(lang), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }))
}
