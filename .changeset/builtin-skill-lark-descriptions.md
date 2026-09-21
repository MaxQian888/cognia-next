---
"cognia-next": minor
---

Fix the model-facing wording of the built-in Lark skill tools (settings + MCP descriptions) and close their id-discovery gaps. Descriptions no longer reference tools that do not exist (`lark-contact`, `lark-drive`) or use internal dot-ids instead of the callable `lark_*` tool names, and no longer contradict their own schemas (freebusy "set of users" vs single open_id, pageSize ranges vs `max()`, `doc.update` missing `str_replace`, `sheets.create` implying a required folder). Adds three read tools so every opaque id is resolvable in-band: `lark_calendar_list_calendars` (calendar ids), `lark_sheets_list_sheets` (worksheet ids), and `lark_task_search_tasklists` (tasklist GUIDs). Renames the plugin-conversion tools to the `family_verb` convention used everywhere else: `plugin_conversion_inspect` and `plugin_conversion_apply`.
