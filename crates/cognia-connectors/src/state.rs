use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

use super::types::AdapterRegistration;

#[derive(Default)]
pub struct ConnectorsStateInner {
    pub registered_adapters: HashMap<String, AdapterRegistration>,
    pub server_running: bool,
    pub bound_addr: Option<String>,
}

#[derive(Clone, Default)]
pub struct ConnectorsState {
    pub inner: Arc<Mutex<ConnectorsStateInner>>,
}

impl ConnectorsState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns a clone of self — used when the lifecycle needs to pass state
    /// into the axum server without consuming the managed copy.
    pub fn inner_state(&self) -> Self {
        self.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AdapterRegistration;

    #[test]
    fn registers_and_unregisters() {
        let s = ConnectorsState::new();
        s.inner.lock().registered_adapters.insert(
            "a".into(),
            AdapterRegistration {
                adapter_id: "a".into(),
                adapter_type: "telegram".into(),
                webhook_path: None,
            },
        );
        assert_eq!(s.inner.lock().registered_adapters.len(), 1);
        s.inner.lock().registered_adapters.remove("a");
        assert_eq!(s.inner.lock().registered_adapters.len(), 0);
    }
}
