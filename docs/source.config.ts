import { defineDocs, defineConfig } from "fumadocs-mdx/config"
import { remarkMermaid } from "./lib/remark-mermaid"

export const docs = defineDocs({
  dir: "content/docs",
})

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMermaid],
  },
})
