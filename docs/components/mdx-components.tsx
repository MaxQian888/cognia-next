import defaultMdxComponents from "fumadocs-ui/mdx"
import { Cards, Card } from "fumadocs-ui/components/card"
import { Step, Steps } from "fumadocs-ui/components/steps"
import { Tab, Tabs } from "fumadocs-ui/components/tabs"
import { Files, Folder, File } from "fumadocs-ui/components/files"
import { Callout } from "fumadocs-ui/components/callout"
import { TypeTable } from "fumadocs-ui/components/type-table"
import { Accordion, Accordions } from "fumadocs-ui/components/accordion"
import { InlineTOC } from "fumadocs-ui/components/inline-toc"
import type { MDXComponents } from "mdx/types"
import { Mermaid } from "./mermaid"
import { TLDR } from "./tldr"
import { Status } from "./status-badge"
import { Kbd } from "./kbd"
import { Term } from "./term"
import { LinkCard } from "./link-card"
import { Stat, StatGrid } from "./stat-grid"

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Cards,
    Card,
    Steps,
    Step,
    Tabs,
    Tab,
    Files,
    Folder,
    File,
    Callout,
    TypeTable,
    Accordion,
    Accordions,
    InlineTOC,
    Mermaid,
    // Cognia custom components
    TLDR,
    Status,
    Kbd,
    Term,
    LinkCard,
    Stat,
    StatGrid,
    ...components,
  }
}
