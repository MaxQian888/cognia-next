# Cognia Work Mode

`cognia-work-mode` is a first-party Plugin SDK bundle for outcome-to-deliverable
knowledge work. It composes Cognia's existing agent, artifact, permission, team,
connector, browser, and scheduler modules instead of introducing another agent
runtime.

The source comparison is documented in
[`docs/research/claude-cowork-chatgpt-work-capability-comparison-2026-07-22.md`](../../docs/research/claude-cowork-chatgpt-work-capability-comparison-2026-07-22.md).

## Capability mapping

| Cowork / ChatGPT Work behavior                        | Cognia implementation                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Select a longer-running Work experience               | Plugin-contributed `Work` agent mode                                             |
| Bundle role knowledge and workflows                   | Five portable inline Agent Skills                                                |
| Split independent work into specialists               | `work_parallelize` with a bounded four-task fan-out                              |
| Reusable specialist roles                             | Researcher, analyst, and deliverable-reviewer subagents                          |
| Explicit plan and review criteria                     | Work mode instruction contract + plan-approved team template                     |
| Independent quality review                            | `work_review_deliverable` creates a linked review artifact with a parsed status  |
| Finished documents, reports, tables, decks, and sites | Markdown, a cognia-documents DOCX, a cognia-office workbook, or sandboxed HTML   |
| In-place iteration and review                         | Artifact versions, annotations, `work_update_deliverable`, and Context Workbench |
| Local files, apps, connectors, browser, and MCP       | Existing host capabilities and permission gates; the plugin does not bypass them |
| Sandboxed execution and approvals                     | Existing workspace confinement, OS sandbox, and approval journal                 |
| Background/scheduled/cross-device work                | Existing Background Tasks, Scheduler, Companion, and Fleet modules               |

## Plugin contributions

- Mode: `cognia-work-mode:work`
- Skills: source-grounded research, document, spreadsheet, presentation/site,
  and deliverable QA
- Subagents: `researcher`, `analyst`, `deliverable-reviewer`
- Team template: `knowledge-work-cell`
- Tools: `work_create_deliverable`, `work_update_deliverable`,
  `work_review_deliverable`, `work_parallelize`

## Deliverable formats

`work_create_deliverable` takes a `kind` and an optional `format`; the first
format listed is the default.

| Kind                   | Formats            | Written by                                                        |
| ---------------------- | ------------------ | ----------------------------------------------------------------- |
| `document`, `report`   | `markdown`, `docx` | this plugin (Markdown) or `cognia-documents` (`documents_create`) |
| `spreadsheet`          | `xlsx`             | `cognia-office` (`office_create_workbook`, from CSV)              |
| `presentation`, `site` | `html`             | this plugin (sandboxed HTML)                                      |

Native formats are routed through one table (`src/deliverables.ts`): each
entry names its owning plugin, its create/read tools, and its edit tools.
Creating goes through the owner's create tool; `work_review_deliverable` reads
the artifact as text through the owner's read tool (`office_read_range`,
`documents_read_markdown`) instead of reviewing its JSON model; and
`work_update_deliverable` refuses a native artifact and names the owner's edit
tool. Adding a native format is one entry plus the dependency in
`plugin.json`.

`format: "docx"` builds a native Word document from the same Markdown:
headings, nested lists, tables, quotes, and code become Word structure, while
bold, italic, and links are flattened to plain text. The result's
`conversionNotes` list what was flattened so the assistant can tell the user.

`work_review_deliverable` returns the reviewer's verdict text plus `status`:
`pass`, `pass-with-caveats`, `revise`, or `unknown` when the reviewer did not
end with one of the three verdicts.

## Permissions

The plugin requests `artifact:read`, `artifact:write`, `agent:dispatch`, and
`agent:control`:

- `artifact:read` / `artifact:write` — create, update, open, and review Work
  artifacts;
- `agent:dispatch` — run the researcher / analyst / reviewer subagents;
- `agent:control` — call the tools of its declared dependencies:
  `cognia-office` (`office_create_workbook`, `office_read_range`) for
  spreadsheets and `cognia-documents` (`documents_create`,
  `documents_read_markdown`) for DOCX documents.

Folder, shell, network, connector, and computer-use authority remain outside
the plugin and continue through their existing host gates.

## Deliberate non-equivalence

- Documents and reports are Markdown artifacts by default (exportable as
  DOCX/PDF from the artifact panel), or native cognia-documents DOCX documents
  with `format: "docx"`; presentations and sites are previewable, sandboxed
  HTML. Spreadsheets are routed to the `cognia-office` plugin, which writes a
  native workbook artifact. Follow-up edits to a workbook or DOCX document go
  through its owner's operations (`office_apply_operations`,
  `documents_apply_operations`), not `work_update_deliverable`. Native PPTX
  authoring belongs to the separate `cognia-presentations` plugin; this plugin
  does not route presentations there.
- `work_review_deliverable` reviews at most the first 60,000 characters of a
  deliverable in one prompt; the result says `truncated: true` when a larger
  one was cut.
- The four `work_*` tools are offered in every chat while the plugin is
  enabled, not only in Work mode: the Plugin SDK has no way yet to scope a
  plugin tool to a mode.
- Cloud-offline execution depends on the configured Cognia host. Local-folder
  work cannot continue when no host with that folder is online.
- The plugin's reviewer evaluates deliverable quality. It does not replace the
  host's command/network approval system or expand the sandbox boundary.
