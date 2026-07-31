# Safe Lark Docx editing

## Prefer precise edits

| Scenario | Command |
|---|---|
| Add a section/block | `block_insert_after --block-id <anchor>` |
| Replace inline text | `str_replace` |
| Replace one structural block | `block_replace --block-id <id>` |
| Rebuild the entire document | `overwrite`, only with explicit destructive-write approval |

Fetch with `--detail with-ids` before editing. Full overwrite can remove comments, media, and collaborative content.

## Render diagrams as whiteboards

Use a `<whiteboard>` block for Mermaid that must render:

```xml
<whiteboard type="mermaid">flowchart TB
  subgraph L0["Current"]
    a["Journey source"]
  end
  L0 ==&gt; L1</whiteboard>
```

Quote labels that contain punctuation. Escape `>` as `&gt;` in XML. Avoid syntax that the Lark Mermaid parser cannot support. For a repository-owned shared board, use the dedicated whiteboard workflow rather than embedding a disconnected duplicate.

## Keep checkboxes structural

Do not nest `<checkbox>` inside list items:

```xml
<p><b>Acceptance:</b></p>
<checkbox done="false">First condition</checkbox>
<checkbox done="false">Second condition</checkbox>
```

## Escape XML text

Inside prose and code blocks:

- `<` → `&lt;`
- `>` → `&gt;`
- `&` → `&amp;`

Preflight a large XML fragment locally:

```bash
rtk python3 -c "import xml.etree.ElementTree as ET; ET.fromstring('<root>'+open('doc.xml',encoding='utf-8').read()+'</root>'); print('WELL-FORMED')"
```

## Verify after writing

Fetch the exact section or a unique keyword. Confirm:

- intended content exists once;
- no escaped sequences are rendered literally;
- Mermaid is a whiteboard, not a code block;
- checkboxes and callouts have valid structure;
- unrelated blocks, comments, and media remain.

Destructive Docx overwrite and whiteboard `--overwrite` each need explicit approval. A prior approval for one does not authorize the other.
