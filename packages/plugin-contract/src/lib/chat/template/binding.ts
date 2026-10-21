/**
 * The plugin contract's share of `lib/chat/template/binding.ts`, which re-exports these.
 */
/**
 * One parameter's value.
 *
 * A resource carries `{id, label}` rather than a bare id on purpose. Ids are
 * device-local — a workspace, a squad, an MCP server or a file path resolved on
 * one machine may not exist on another — and a template is meant to travel. The
 * label is what the send path falls back to when the id no longer resolves, so
 * a shared template degrades to a human-readable phrase instead of leaking a
 * raw nanoid into the prompt or silently substituting nothing.
 */
export type ChatTemplateParamValue =
  | { kind: "text"; value: string }
  | {
      kind: "resource"
      resourceKind: string
      id: string
      label: string
      /**
       * The exact token the `@` menu would have inserted for this pick, e.g.
       * `@src/app.ts`. Absent on a value that arrived from a device where the
       * pick could not be replayed, which is precisely when the label is the
       * only honest thing left to say.
       */
      raw?: string
    }
