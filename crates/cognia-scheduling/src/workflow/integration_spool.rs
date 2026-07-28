//! Durable encrypted ingress spool for Marketplace integrations.
//!
//! Delivery metadata lives beside the workflow run mirror in SQLite. Raw bodies
//! are stored through `cognia-secrets`, whose single-keychain store encrypts
//! values with AES-256-GCM. A delivery is removed only after the renderer
//! normalizes and persists its canonical event envelope.

use std::path::PathBuf;

use cognia_secrets::keyring_secrets;
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SECRET_NAMESPACE: &str = "integration-ingress-spool";
const MAX_QUEUED_DELIVERIES: i64 = 10_000;

#[derive(Debug, thiserror::Error)]
pub enum SpoolError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("secret store: {0}")]
    Secret(String),
    #[error("serde_json: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("integration ingress spool is full")]
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolDelivery {
    pub route_id: String,
    pub delivery_id: String,
    pub event_type: Option<String>,
    pub headers: std::collections::BTreeMap<String, String>,
    pub body: String,
    pub received_at: String,
    pub attempts: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueOutcome {
    Inserted,
    Duplicate,
}

pub struct IntegrationSpool {
    path: Option<PathBuf>,
    conn: OnceCell<Mutex<Connection>>,
}

impl IntegrationSpool {
    pub fn open(path: PathBuf) -> Self {
        Self {
            path: Some(path),
            conn: OnceCell::new(),
        }
    }

    pub fn open_in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("integration spool memory db");
        init_schema(&conn).expect("integration spool schema");
        let cell = OnceCell::new();
        let _ = cell.set(Mutex::new(conn));
        Self {
            path: None,
            conn: cell,
        }
    }

    fn conn(&self) -> Result<&Mutex<Connection>, SpoolError> {
        self.conn.get_or_try_init(|| {
            let path = self.path.clone().ok_or_else(|| {
                SpoolError::Secret("integration spool path is unavailable".into())
            })?;
            let conn = Connection::open(path)?;
            init_schema(&conn)?;
            Ok(Mutex::new(conn))
        })
    }

    pub fn enqueue(&self, delivery: &SpoolDelivery) -> Result<EnqueueOutcome, SpoolError> {
        let conn = self.conn()?.lock();
        let duplicate: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM integration_ingress_spool WHERE route_id = ?1 AND delivery_id = ?2",
                params![delivery.route_id, delivery.delivery_id],
                |row| row.get(0),
            )
            .optional()?;
        if duplicate.is_some() {
            return Ok(EnqueueOutcome::Duplicate);
        }
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM integration_ingress_spool WHERE status != 'deadlettered'",
            [],
            |row| row.get(0),
        )?;
        if count >= MAX_QUEUED_DELIVERIES {
            return Err(SpoolError::Full);
        }

        let secret_key = secret_key(&delivery.route_id, &delivery.delivery_id);
        keyring_secrets::set(SECRET_NAMESPACE, &secret_key, &delivery.body)
            .map_err(SpoolError::Secret)?;
        let headers_json = serde_json::to_string(&delivery.headers)?;
        if let Err(error) = conn.execute(
            r#"
            INSERT INTO integration_ingress_spool
                (route_id, delivery_id, event_type, headers_json, secret_key,
                 received_at, status, attempts, next_attempt_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', 0, NULL)
            "#,
            params![
                delivery.route_id,
                delivery.delivery_id,
                delivery.event_type,
                headers_json,
                secret_key,
                delivery.received_at,
            ],
        ) {
            let _ = keyring_secrets::clear(SECRET_NAMESPACE, &secret_key);
            return Err(error.into());
        }
        Ok(EnqueueOutcome::Inserted)
    }

    pub fn pending(&self, limit: usize) -> Result<Vec<SpoolDelivery>, SpoolError> {
        let conn = self.conn()?.lock();
        let mut statement = conn.prepare(
            r#"
            SELECT route_id, delivery_id, event_type, headers_json, secret_key,
                   received_at, attempts
            FROM integration_ingress_spool
            WHERE status IN ('queued', 'retry_wait')
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
            ORDER BY received_at ASC
            LIMIT ?2
            "#,
        )?;
        let now = chrono::Utc::now().timestamp_millis();
        let rows = statement.query_map(params![now, limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, u8>(6)?,
            ))
        })?;
        let mut deliveries = Vec::new();
        for row in rows {
            let (
                route_id,
                delivery_id,
                event_type,
                headers_json,
                secret_key,
                received_at,
                attempts,
            ) = row?;
            let Some(body) =
                keyring_secrets::get(SECRET_NAMESPACE, &secret_key).map_err(SpoolError::Secret)?
            else {
                continue;
            };
            deliveries.push(SpoolDelivery {
                route_id,
                delivery_id,
                event_type,
                headers: serde_json::from_str(&headers_json)?,
                body,
                received_at,
                attempts,
            });
        }
        Ok(deliveries)
    }

    pub fn ack(&self, route_id: &str, delivery_id: &str) -> Result<(), SpoolError> {
        let conn = self.conn()?.lock();
        let secret_key: Option<String> = conn
            .query_row(
                "SELECT secret_key FROM integration_ingress_spool WHERE route_id = ?1 AND delivery_id = ?2",
                params![route_id, delivery_id],
                |row| row.get(0),
            )
            .optional()?;
        conn.execute(
            "DELETE FROM integration_ingress_spool WHERE route_id = ?1 AND delivery_id = ?2",
            params![route_id, delivery_id],
        )?;
        if let Some(secret_key) = secret_key {
            keyring_secrets::clear(SECRET_NAMESPACE, &secret_key).map_err(SpoolError::Secret)?;
        }
        Ok(())
    }

    pub fn nack(&self, route_id: &str, delivery_id: &str) -> Result<(), SpoolError> {
        let conn = self.conn()?.lock();
        let attempts: Option<u8> = conn
            .query_row(
                "SELECT attempts FROM integration_ingress_spool WHERE route_id = ?1 AND delivery_id = ?2",
                params![route_id, delivery_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(attempts) = attempts else {
            return Ok(());
        };
        let next_attempt = attempts.saturating_add(1);
        let status = if next_attempt >= 5 {
            "deadlettered"
        } else {
            "retry_wait"
        };
        let delay_ms = 1_000_i64 * 2_i64.pow(next_attempt.saturating_sub(1) as u32);
        conn.execute(
            r#"
            UPDATE integration_ingress_spool
            SET attempts = ?3, status = ?4, next_attempt_at = ?5
            WHERE route_id = ?1 AND delivery_id = ?2
            "#,
            params![
                route_id,
                delivery_id,
                next_attempt,
                status,
                chrono::Utc::now().timestamp_millis() + delay_ms,
            ],
        )?;
        Ok(())
    }
}

fn init_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS integration_ingress_spool (
            route_id       TEXT NOT NULL,
            delivery_id    TEXT NOT NULL,
            event_type     TEXT,
            headers_json   TEXT NOT NULL,
            secret_key     TEXT NOT NULL,
            received_at    TEXT NOT NULL,
            status         TEXT NOT NULL,
            attempts       INTEGER NOT NULL,
            next_attempt_at INTEGER,
            PRIMARY KEY (route_id, delivery_id)
        );
        CREATE INDEX IF NOT EXISTS idx_integration_spool_status
            ON integration_ingress_spool(status, next_attempt_at);
        "#,
    )
}

fn secret_key(route_id: &str, delivery_id: &str) -> String {
    let digest = Sha256::digest(format!("{route_id}\0{delivery_id}").as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn delivery() -> SpoolDelivery {
        SpoolDelivery {
            route_id: "route-1".into(),
            delivery_id: "delivery-1".into(),
            event_type: Some("issue.created".into()),
            headers: BTreeMap::from([("x-delivery-id".into(), "delivery-1".into())]),
            body: r#"{"id":"1"}"#.into(),
            received_at: "2026-07-28T00:00:00.000Z".into(),
            attempts: 0,
        }
    }

    #[test]
    fn encrypts_deduplicates_retries_and_acknowledges_deliveries() {
        let spool = IntegrationSpool::open_in_memory();
        assert_eq!(
            spool.enqueue(&delivery()).unwrap(),
            EnqueueOutcome::Inserted
        );
        assert_eq!(
            spool.enqueue(&delivery()).unwrap(),
            EnqueueOutcome::Duplicate
        );
        assert_eq!(spool.pending(10).unwrap()[0].body, r#"{"id":"1"}"#);
        spool.nack("route-1", "delivery-1").unwrap();
        assert!(spool.pending(10).unwrap().is_empty());
        spool.ack("route-1", "delivery-1").unwrap();
        assert!(spool.pending(10).unwrap().is_empty());
    }
}
