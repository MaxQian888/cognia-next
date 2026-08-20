-- Indexes for the triage console's two list queries.
--
-- Both were unindexed because nothing ever read `incident_groups` back or
-- listed incidents by anything other than the processing worker's due-date
-- predicate. Expand-only: no column or constraint changes, so an older release
-- keeps serving against this schema.

-- `GET /v1/groups`: tenant + project, optionally narrowed by status, ordered by
-- most recent activity.
CREATE INDEX IF NOT EXISTS incident_groups_triage_idx
    ON incident_groups (tenant_id, project_id, status, last_seen_at DESC);

-- The assignee filter ("what is on my plate") is selective enough to deserve
-- its own partial index rather than a scan of every group in the project.
CREATE INDEX IF NOT EXISTS incident_groups_assignee_idx
    ON incident_groups (tenant_id, project_id, assigned_to)
    WHERE assigned_to IS NOT NULL;

-- `GET /v1/incidents`: newest first within a project. `incidents_group_idx`
-- already covers the group-filtered form.
CREATE INDEX IF NOT EXISTS incidents_recent_idx
    ON incidents (tenant_id, project_id, created_at DESC);

-- `GET /v1/incidents/{id}/audit` walks one incident's trail newest-first. The
-- table only ever grows, so without this the console's detail pane degrades
-- linearly with total audit volume.
CREATE INDEX IF NOT EXISTS audit_events_incident_idx
    ON audit_events (tenant_id, incident_id, occurred_at DESC)
    WHERE incident_id IS NOT NULL;
