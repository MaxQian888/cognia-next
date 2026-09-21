---
name: rfc-write-plan
description: Structured technical-design (RFC) planning. Use when the user needs a technical proposal, a design document, or a structured plan for a bug fix, a new feature, or a refactor — it loads the matching task guide and output template, researches the codebase, and writes a precise design document. Do not use for direct code edits or for repository-specific proposal formats already defined by project rules.
---

# RFC Write Plan

## Primary task

Given the user's requirement and the context gathered beforehand, design a complete, rigorous technical proposal and write the result to the path the user specifies.

## Core principles

1. **Fact-driven**: every claim in the proposal comes from the user's input or from tool results. Never speculate, infer, or fill gaps. When information is missing, summarize only what is known and mark the gap explicitly.
2. **Reuse first**: prefer existing architecture, shared components, utilities, and established project patterns over new machinery.
3. **Design, not implementation**: provide the design approach and the critical path. Key logic may be illustrated with short example snippets, but the proposal is not a complete implementation.
4. **Verify in source**: do not rely on documentation alone — confirm against the actual source (Glob, Read, Grep, and any repository search/knowledge tools available in the environment).
5. **Validate what the plan touches**: where feasible, verify that file paths and components named in the proposal actually exist. When validation is impossible, say so and name the limitation.
6. **Be critical of input**: user-supplied technical approaches and file paths are claims to verify against the codebase, not facts to repeat.
7. **Information sufficiency**: before writing, judge whether the gathered context is enough. If key information is missing, keep researching until nothing more can be obtained — do not produce a proposal on assumptions.
8. **Use tools at every step**: each step before the final write must call at least one tool.

## Capabilities

1. **Requirement capture**: fully record the user's requirement without dropping details.
2. **Technical proposal authoring**: structured documents covering requirement analysis, technology choices, and design.
3. **Code-path location**: precisely identify the files to modify.
4. **Field/contract detail**: record form fields, API fields, defaults, and validation rules in full.
5. **Three task types**: bug fix, new feature, and refactor — each with its own guide and output template.

## Workflow

1. **Identify the task type**:
   - **Bug fix**: repair existing behavior, a defect, or an anomaly.
   - **Refactor**: restructure code, performance, or architecture without changing business behavior.
   - **New feature**: add business functionality or modules.
   - **[Required] Load the matching task guide** — it defines the line of attack:
     - Bug fix: `${COGNIA_PLUGIN_ROOT}/skills/rfc-write-plan/references/bugfix-guide.txt`
     - New feature: `${COGNIA_PLUGIN_ROOT}/skills/rfc-write-plan/references/newfeature-guide.txt`
     - Refactor: `${COGNIA_PLUGIN_ROOT}/skills/rfc-write-plan/references/refactor.txt`
   - **[Required] Load the matching output template** — never free-format the document:
     - Priority 1: if the user or project rules (e.g. `AGENTS.md`, `CLAUDE.md`) name a template, use that one and skip the default.
     - Priority 2: otherwise load the default for the task type:
       - Bug fix: `${COGNIA_PLUGIN_ROOT}/skills/rfc-write-plan/references/bugfix-template.md`
       - Refactor: `${COGNIA_PLUGIN_ROOT}/skills/rfc-write-plan/references/refactor-template.md`
       - New feature: `${COGNIA_PLUGIN_ROOT}/skills/rfc-write-plan/references/newfeature-template.md`

2. **Gather context**:
   - When a module's location is unclear, locate it through available repository search/navigation tools first (a repo-wiki or codebase-search integration when installed), then confirm with `Glob`/`Read`.
   - Use `Grep`, `Glob`, `Read`, and available search tools deliberately; prefer direct source reads for known paths.
   - Follow the loaded task guide strictly.
   - Pay special attention to technical details the user already mentioned — file paths, form fields, field attributes.
   - Read the relevant code widely; identify reusable components, functions, utilities, and existing best practices.

3. **Assess information sufficiency**: check whether the requirement, project rules, gathered context, and search results contain enough to design a reliable proposal. If key information is missing, return to step 2 until nothing more can be obtained.

4. **Design and consolidate**:
   - With sufficient information: produce the detailed design.
   - With insufficient information: summarize only the knowns, mark the gaps, and list the questions that still need answers.
   - For complex or high-uncertainty work, apply the `rfc-reflect` skill (same plugin) to critique the draft before writing it out.
   - Follow the task guide strictly; use tables, lists, and Mermaid diagrams where they help.

5. **Write the output**:
   - Use `Write` to produce the document at the path the user specified, following the loaded template exactly. For long documents, append with `Edit` rather than truncating.
   - When emitting Mermaid, apply the `mermaid-visualizer` skill's syntax rules — do not hand-write diagrams without them.
   - Do not add sections the template does not define.
   - Unless the user asks otherwise, do NOT write the proposal into the repository — write to the path they specify.

6. **Constraint check** — unless the user explicitly asks, the proposal must not contain (edit them out if they crept in):
   - Implementation schedules or staffing estimates
   - High-level concept filler
   - Testing or deployment content
   - Running the app for end-to-end verification
   - User training or doc-creation plans
   - Business-process or organizational changes
   - Marketing or communication activities
   - Functional integration verification such as `npm run dev`

## Tooling strategy

- Priority, high to low:
  - Locating modules from vague descriptions or visual references: available repository search/navigation tools first, then `Glob`/`Read` to confirm.
  - Known file or directory paths: `Read` directly.
  - Finding files by name: `Glob`, search tools second.
- Never conclude from search results alone for in-repo knowledge — confirm in the actual source.
- Heavy search tools are expensive; use them only when `Glob`/`Read`/`Grep` cannot answer.

## Related skills in this plugin

- **rfc-reflect**: critique the proposal for completeness, knowledge sufficiency, and feasibility before it is written out.
- **mermaid-visualizer**: apply its syntax rules whenever emitting a Mermaid code block.

## Notes

- All information must come from user input or gathered evidence — never from assumptions.
- File paths in the proposal must be complete and accurate enough to locate directly.
- Form/API field details must be complete: name, type, required, default, validation.
- For Mermaid labels containing special characters, wrap the text in double quotes to avoid parse failures.
- Unless the user asks, keep implementation plans, testing, and deployment out of the proposal.
- Follow the loaded task guide and output template for the identified type exactly.
