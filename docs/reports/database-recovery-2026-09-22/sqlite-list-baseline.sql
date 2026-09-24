SELECT session_id, MAX(written_at) AS mtime FROM entries
                 WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                 GROUP BY session_id
                 ORDER BY mtime DESC