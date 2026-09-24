WITH RECURSIVE session_ids(session_id) AS (
    SELECT MIN(session_id) FROM entries
    WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
    UNION ALL
    SELECT (SELECT MIN(session_id) FROM entries
            WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
              AND session_id > session_ids.session_id)
    FROM session_ids WHERE session_id IS NOT NULL
)
SELECT session_id, (SELECT written_at FROM entries
                   WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                     AND session_id = session_ids.session_id
                   ORDER BY written_at DESC LIMIT 1) AS mtime
FROM session_ids WHERE session_id IS NOT NULL ORDER BY mtime DESC