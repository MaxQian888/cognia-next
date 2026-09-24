WITH RECURSIVE session_ids(session_id, position) AS (
    SELECT MIN(session_id), 1 FROM entries
    WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
    UNION ALL
    SELECT (SELECT MIN(session_id) FROM entries
            WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
              AND session_id > session_ids.session_id), position + 1
    FROM session_ids WHERE session_id IS NOT NULL AND position < 256
)
SELECT session_id, (SELECT written_at FROM entries
                   WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                     AND session_id = session_ids.session_id
                   ORDER BY written_at DESC LIMIT 1) AS mtime
FROM session_ids WHERE session_id IS NOT NULL
UNION ALL
SELECT session_id, MAX(written_at) AS mtime FROM entries
WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
  AND session_id > (SELECT MAX(session_id) FROM session_ids)
GROUP BY session_id
ORDER BY mtime DESC