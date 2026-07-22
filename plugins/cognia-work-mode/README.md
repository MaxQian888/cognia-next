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
| Independent quality review                            | `work_review_deliverable` creates a linked review artifact                       |
| Finished documents, reports, tables, decks, and sites | Artifact API: Markdown, CSV-compatible text, or sandboxed HTML                   |
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

The plugin requests only `artifact:read`, `artifact:write`, and
`agent:dispatch`. Folder, shell, network, connector, and computer-use authority
remain outside the plugin and continue through their existing host gates.

## Deliberate non-equivalence

- Cognia artifacts currently export Markdown documents as DOCX/PDF, while this
  plugin represents spreadsheets as CSV-compatible text and presentations/sites
  as previewable HTML. Native XLSX/PPTX authoring remains a separate artifact
  writer capability, not something this plugin emulates with an unsafe private
  filesystem path.
- Cloud-offline execution depends on the configured Cognia host. Local-folder
  work cannot continue when no host with that folder is online.
- The plugin's reviewer evaluates deliverable quality. It does not replace the
  host's command/network approval system or expand the sandbox boundary.
