import type {
  LinkMatcherProps,
  PluginLinkMatcherDef,
  PluginLinkMatcherRegistrationDef,
} from "./plugin-link-matcher"

it("keeps manifest and imperative definitions compatible with the inline render props", () => {
  const manifest: PluginLinkMatcherDef = {
    id: "pull",
    patterns: ["github.com/**/pull/*"],
    entry: "links.js",
    export: "PullLink",
  }
  const props: LinkMatcherProps = {
    href: "https://github.com/a/b/pull/1",
    children: "PR",
    messageId: "m",
    isStreaming: true,
  }
  const runtime: PluginLinkMatcherRegistrationDef = { ...manifest, component: () => null }
  expect(runtime.patterns).toEqual(manifest.patterns)
  expect(props).toMatchObject({ messageId: "m", isStreaming: true })
})
