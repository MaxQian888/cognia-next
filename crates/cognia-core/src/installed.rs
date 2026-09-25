//! Process-global service slots a host binary fills at boot (ADR-0196).
//!
//! A library crate that needs something only the host can provide — the
//! desktop app's screenshot backend, a sidecar locator, a credential store —
//! declares a slot and the host installs into it once. Before these types
//! every crate hand-rolled its own setter, and they disagreed on what happens
//! when the host never calls it (an empty list, an error string, a panic) and
//! on a second call (silently ignored, or replaced). A slot here behaves one
//! way: it names itself, a second install is reported, and reading an empty
//! slot is a typed error that says which slot and who should have filled it.
//!
//! - [`Installed`] is write-once, for services fixed for the process.
//! - [`Replaceable`] can be swapped or cleared, for sinks tests or a host
//!   reconfiguration need to change.

use std::fmt;
use std::sync::{Arc, OnceLock, RwLock};

/// Reading a slot the host never filled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotInstalled {
    /// The slot's name, as given to [`Installed::new`] / [`Replaceable::new`].
    pub slot: &'static str,
}

impl fmt::Display for NotInstalled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} is not installed: the host binary must install it at boot",
            self.slot
        )
    }
}

impl std::error::Error for NotInstalled {}

/// A second install into a write-once slot. The first value stays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlreadyInstalled {
    pub slot: &'static str,
}

impl fmt::Display for AlreadyInstalled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} is already installed; the second install was ignored",
            self.slot
        )
    }
}

impl std::error::Error for AlreadyInstalled {}

/// A write-once, process-global slot.
///
/// ```
/// use cognia_core::installed::Installed;
///
/// static GREETING: Installed<&'static str> = Installed::new("example.greeting");
///
/// assert!(GREETING.get().is_err());
/// GREETING.install("hello").unwrap();
/// assert_eq!(*GREETING.get().unwrap(), "hello");
/// assert!(GREETING.install("again").is_err());
/// ```
pub struct Installed<T> {
    name: &'static str,
    cell: OnceLock<T>,
}

impl<T> Installed<T> {
    pub const fn new(name: &'static str) -> Self {
        Self {
            name,
            cell: OnceLock::new(),
        }
    }

    /// The slot's name, for logs and boot checks.
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// Fill the slot. A second call leaves the first value in place and
    /// reports [`AlreadyInstalled`]; the caller decides whether that is worth
    /// a warning.
    pub fn install(&self, value: T) -> Result<(), AlreadyInstalled> {
        self.cell
            .set(value)
            .map_err(|_| AlreadyInstalled { slot: self.name })
    }

    /// The installed value, or [`NotInstalled`] naming this slot.
    pub fn get(&self) -> Result<&T, NotInstalled> {
        self.cell.get().ok_or(NotInstalled { slot: self.name })
    }

    /// The installed value, when absence is an expected state.
    pub fn try_get(&self) -> Option<&T> {
        self.cell.get()
    }

    pub fn is_installed(&self) -> bool {
        self.cell.get().is_some()
    }
}

/// A process-global slot the host may set, replace or clear.
pub struct Replaceable<T: ?Sized> {
    name: &'static str,
    cell: RwLock<Option<Arc<T>>>,
}

impl<T: ?Sized> Replaceable<T> {
    pub const fn new(name: &'static str) -> Self {
        Self {
            name,
            cell: RwLock::new(None),
        }
    }

    pub fn name(&self) -> &'static str {
        self.name
    }

    /// Install or replace the value; returns the previous one.
    pub fn set(&self, value: Arc<T>) -> Option<Arc<T>> {
        self.write().replace(value)
    }

    /// Empty the slot; returns what it held.
    pub fn clear(&self) -> Option<Arc<T>> {
        self.write().take()
    }

    /// The current value, or [`NotInstalled`] naming this slot.
    pub fn get(&self) -> Result<Arc<T>, NotInstalled> {
        self.try_get().ok_or(NotInstalled { slot: self.name })
    }

    /// The current value, when absence is an expected state.
    pub fn try_get(&self) -> Option<Arc<T>> {
        self.cell
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn is_installed(&self) -> bool {
        self.try_get().is_some()
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Option<Arc<T>>> {
        // A writer that panicked left a complete `Option`; the slot is still
        // coherent, so keep serving it rather than poisoning every reader.
        self.cell
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_installed_slot_names_itself() {
        let slot: Installed<u8> = Installed::new("test.empty");
        assert!(!slot.is_installed());
        assert_eq!(slot.try_get(), None);
        let err = slot.get().unwrap_err();
        assert_eq!(err, NotInstalled { slot: "test.empty" });
        assert_eq!(
            err.to_string(),
            "test.empty is not installed: the host binary must install it at boot"
        );
    }

    #[test]
    fn installed_is_write_once_and_keeps_the_first_value() {
        let slot = Installed::new("test.once");
        slot.install(1_u8).unwrap();
        assert_eq!(slot.install(2), Err(AlreadyInstalled { slot: "test.once" }));
        assert_eq!(*slot.get().unwrap(), 1);
        assert!(slot.is_installed());
        assert_eq!(slot.name(), "test.once");
    }

    #[test]
    fn installed_works_as_a_static_with_trait_objects() {
        static SLOT: Installed<fn() -> u8> = Installed::new("test.static_fn");
        fn seven() -> u8 {
            7
        }
        SLOT.install(seven).unwrap();
        assert_eq!((SLOT.get().unwrap())(), 7);
    }

    trait Sink: Send + Sync {
        fn id(&self) -> u8;
    }
    struct Fixed(u8);
    impl Sink for Fixed {
        fn id(&self) -> u8 {
            self.0
        }
    }

    #[test]
    fn replaceable_sets_replaces_and_clears() {
        let slot: Replaceable<dyn Sink> = Replaceable::new("test.sink");
        assert_eq!(slot.get().err(), Some(NotInstalled { slot: "test.sink" }));

        assert!(slot.set(Arc::new(Fixed(1))).is_none());
        assert_eq!(slot.get().unwrap().id(), 1);

        let previous = slot.set(Arc::new(Fixed(2))).expect("previous value");
        assert_eq!(previous.id(), 1);
        assert_eq!(slot.get().unwrap().id(), 2);

        assert_eq!(slot.clear().map(|sink| sink.id()), Some(2));
        assert!(!slot.is_installed());
    }

    #[test]
    fn replaceable_survives_a_poisoned_lock() {
        let slot: Arc<Replaceable<dyn Sink>> = Arc::new(Replaceable::new("test.poisoned"));
        slot.set(Arc::new(Fixed(3)));
        let writer = Arc::clone(&slot);
        let _ = std::thread::spawn(move || {
            let _guard = writer.cell.write().unwrap();
            panic!("poison the slot");
        })
        .join();
        assert_eq!(slot.get().unwrap().id(), 3);
        slot.set(Arc::new(Fixed(4)));
        assert_eq!(slot.get().unwrap().id(), 4);
    }
}
