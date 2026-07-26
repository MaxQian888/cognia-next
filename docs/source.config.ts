import { defineDocs, defineConfig } from "fumadocs-mdx/config"
import { remarkMermaid } from "./lib/remark-mermaid"
import { remarkLlmUnwrap } from "./lib/remark-llm-unwrap"

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // `includeProcessedMarkdown` exports the stringified MDAST alongside the
    // compiled component, which is what `page.data.getText("processed")`
    // reads. Without it that call throws, and the /llms.txt + per-page
    // Markdown routes (app/llms.txt, app/md/) have nothing to serve.
    //
    // Which JSX survives into that output is controlled by `remarkLlmUnwrap`,
    // not by the `filterElement` option here — see the note in that module.
    postprocess: { includeProcessedMarkdown: true },
  },
})

export default defineConfig({
  mdxOptions: {
    // Order matters: both plugins rewrite the tree that `remarkLLMs` later
    // stringifies, so they have to run before the postprocess pass.
    remarkPlugins: [remarkMermaid, remarkLlmUnwrap],
  },
})
