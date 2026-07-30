//! Persistent authority for WebRTC answerer registrations.
//!
//! Both Tauri and `cognia-server` install this store before accepting a pair.
//! The renderer may cache public metadata, but signaling recovery never
//! depends on a WebView or IndexedDB being available.

use std::{path::Path, sync::Arc};

use parking_lot::Mutex;
use rusqlite::{params, Connection};

use super::DeviceRegistration;

#[derive(Debug, thiserror::Error)]
pub enum RegistrationStoreError {
    #[error("signaling registration database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("signaling room descriptor is invalid: {0}")]
    Descriptor(#[from] serde_json::Error),
}

pub struct SignalingRegistrationStore {
    conn: Arc<Mutex<Connection>>,
}

static INSTALLED_STORE: once_cell::sync::Lazy<
    parking_lot::RwLock<Option<Arc<SignalingRegistrationStore>>>,
> = once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(None));

pub fn install(store: Option<Arc<SignalingRegistrationStore>>) {
    *INSTALLED_STORE.write() = store;
}

pub fn installed() -> Option<Arc<SignalingRegistrationStore>> {
    INSTALLED_STORE.read().clone()
}

impl SignalingRegistrationStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Arc<Self>, RegistrationStoreError> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Arc::new(Self {
            conn: Arc::new(Mutex::new(conn)),
        }))
    }

    #[cfg(test)]
    fn in_memory() -> Result<Arc<Self>, RegistrationStoreError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Arc::new(Self {
            conn: Arc::new(Mutex::new(conn)),
        }))
    }

    pub fn upsert(
        &self,
        registration: &DeviceRegistration,
        updated_at_ms: i64,
    ) -> Result<(), RegistrationStoreError> {
        let descriptor = serde_json::to_string(&registration.room_descriptor)?;
        self.conn.lock().execute(
            "INSERT INTO signaling_registrations
             (device_id, rendezvous_id, room_descriptor_json, signaling_key_ref, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(device_id) DO UPDATE SET
               rendezvous_id = excluded.rendezvous_id,
               room_descriptor_json = excluded.room_descriptor_json,
               signaling_key_ref = excluded.signaling_key_ref,
               updated_at_ms = excluded.updated_at_ms",
            params![
                registration.device_id,
                registration.rendezvous_id,
                descriptor,
                registration.signaling_key_ref,
                updated_at_ms,
            ],
        )?;
        Ok(())
    }

    pub fn replace_all(
        &self,
        registrations: &[DeviceRegistration],
        updated_at_ms: i64,
    ) -> Result<(), RegistrationStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM signaling_registrations", [])?;
        for registration in registrations {
            let descriptor = serde_json::to_string(&registration.room_descriptor)?;
            tx.execute(
                "INSERT INTO signaling_registrations
                 (device_id, rendezvous_id, room_descriptor_json, signaling_key_ref, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    registration.device_id,
                    registration.rendezvous_id,
                    descriptor,
                    registration.signaling_key_ref,
                    updated_at_ms,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn remove_device(&self, device_id: &str) -> Result<Option<String>, RegistrationStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let key_ref = tx
            .query_row(
                "SELECT signaling_key_ref FROM signaling_registrations WHERE device_id = ?1",
                [device_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        tx.execute(
            "DELETE FROM signaling_registrations WHERE device_id = ?1",
            [device_id],
        )?;
        tx.commit()?;
        Ok(key_ref)
    }

    pub fn load_all(&self) -> Result<Vec<DeviceRegistration>, RegistrationStoreError> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare(
            "SELECT device_id, rendezvous_id, room_descriptor_json, signaling_key_ref
             FROM signaling_registrations ORDER BY device_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        let mut registrations = Vec::new();
        for row in rows {
            let (device_id, rendezvous_id, descriptor, signaling_key_ref) = row?;
            registrations.push(DeviceRegistration {
                device_id,
                rendezvous_id,
                room_descriptor: serde_json::from_str(&descriptor)?,
                signaling_key_ref,
            });
        }
        Ok(registrations)
    }
}

use rusqlite::OptionalExtension as _;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS signaling_registrations (
  device_id TEXT PRIMARY KEY NOT NULL,
  rendezvous_id TEXT NOT NULL UNIQUE,
  room_descriptor_json TEXT NOT NULL,
  signaling_key_ref TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_signaling_core::proto::RoomDescriptorV2;

    fn registration(device: &str, room: &str, key: &str) -> DeviceRegistration {
        DeviceRegistration {
            device_id: device.into(),
            rendezvous_id: room.into(),
            room_descriptor: RoomDescriptorV2 {
                v: 2,
                room_id: room.into(),
                room_nonce: "nonce".into(),
                desktop_signing_key: "desktop".into(),
                mobile_signing_key: "mobile".into(),
                not_after: 1_900_000_000_000,
            },
            signaling_key_ref: key.into(),
        }
    }

    #[test]
    fn upsert_load_and_remove_are_restart_safe() {
        let store = SignalingRegistrationStore::in_memory().unwrap();
        store.upsert(&registration("d1", "r1", "k1"), 1).unwrap();
        store.upsert(&registration("d1", "r2", "k2"), 2).unwrap();

        let loaded = store.load_all().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].rendezvous_id, "r2");
        assert_eq!(loaded[0].signaling_key_ref, "k2");
        assert_eq!(store.remove_device("d1").unwrap(), Some("k2".into()));
        assert!(store.load_all().unwrap().is_empty());
        assert_eq!(store.remove_device("d1").unwrap(), None);
    }

    #[test]
    fn replace_all_removes_stale_registrations_atomically() {
        let store = SignalingRegistrationStore::in_memory().unwrap();
        store.upsert(&registration("d1", "r1", "k1"), 1).unwrap();
        store
            .replace_all(&[registration("d2", "r2", "k2")], 2)
            .unwrap();
        let loaded = store.load_all().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].device_id, "d2");
    }
}
