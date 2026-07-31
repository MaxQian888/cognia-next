//! Native Windows UI Automation event subscriptions.
//!
//! Every registration and removal is serialized on one dedicated MTA thread.
//! Microsoft explicitly warns against adding/removing UIA handlers from
//! multiple threads in one client process, so subscriptions communicate with
//! that thread through a command channel. COM invokes the registered handlers
//! directly; no polling or window-message pump is required.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;

use parking_lot::Mutex;
use uiautomation::events::{
    CustomEventHandlerFn, CustomFocusChangedEventHandlerFn, CustomPropertyChangedEventHandlerFn,
    CustomStructureChangedEventHandlerFn, UIEventHandler, UIEventType, UIFocusChangedEventHandler,
    UIPropertyChangedEventHandler, UIStructureChangeEventHandler,
};
use uiautomation::types::{StructureChangeType, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement, UITreeWalker};

use crate::automation::events::{emit_uia_event, UiaEventPayload};
use crate::automation::selection_events::{self, SelectionSignal, SelectionSignalKind};
use crate::automation::types::{AutomationError, EventFilter, EventKind, Result, SubscriptionId};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const FIRST_UIA_PROPERTY_ID: i32 = 30_000;
const LAST_UIA_PROPERTY_ID: i32 = 30_174;

fn backend_error(message: impl Into<String>) -> AutomationError {
    AutomationError::BackendError {
        message: message.into(),
    }
}

/// Empty kind lists are ambiguous and almost certainly an authoring error.
/// `None` means every supported event kind.
pub fn validate_filter(filter: &EventFilter) -> Result<()> {
    if filter.kinds.as_ref().is_some_and(Vec::is_empty) {
        return Err(backend_error("subscribe_events: kinds must not be empty"));
    }
    Ok(())
}

/// The kinds a filter of `None` means.
///
/// `TextSelectionChanged` is deliberately EXCLUDED. It fires on every caret
/// move in every text control, so folding it into the default set would make
/// every pre-existing subscription — including the workflow desktop-event
/// trigger — silently start registering a subtree-scoped 20014 handler and
/// paying for it. Callers that want it must name it.
fn requested_kinds(filter: &EventFilter) -> Vec<EventKind> {
    filter.kinds.clone().unwrap_or_else(|| {
        vec![
            EventKind::FocusChanged,
            EventKind::StructureChanged,
            EventKind::PropertyChanged,
        ]
    })
}

enum WorkerCommand {
    Subscribe {
        id: u64,
        filter: EventFilter,
        scope: Option<UIElement>,
        reply: mpsc::Sender<std::result::Result<(), String>>,
    },
    Unsubscribe {
        id: u64,
        reply: mpsc::Sender<std::result::Result<(), String>>,
    },
    Shutdown,
}

struct RegisteredHandlers {
    root: UIElement,
    focus: Option<UIFocusChangedEventHandler>,
    property: Option<UIPropertyChangedEventHandler>,
    structure: Option<UIStructureChangeEventHandler>,
    text_selection: Option<UIEventHandler>,
}

impl RegisteredHandlers {
    fn new(root: UIElement) -> Self {
        Self {
            root,
            focus: None,
            property: None,
            structure: None,
            text_selection: None,
        }
    }

    fn unregister(&self, automation: &UIAutomation) {
        if let Some(handler) = &self.text_selection {
            if let Err(err) = automation.remove_automation_event_handler(
                UIEventType::Text_TextSelectionChanged,
                &self.root,
                handler,
            ) {
                log::warn!("remove text-selection-changed handler failed: {err}");
            }
        }
        if let Some(handler) = &self.focus {
            if let Err(err) = automation.remove_focus_changed_event_handler(handler) {
                log::warn!("remove focus-changed handler failed: {err}");
            }
        }
        if let Some(handler) = &self.property {
            if let Err(err) = automation.remove_property_changed_event_handler(&self.root, handler)
            {
                log::warn!("remove property-changed handler failed: {err}");
            }
        }
        if let Some(handler) = &self.structure {
            if let Err(err) = automation.remove_structure_changed_event_handler(&self.root, handler)
            {
                log::warn!("remove structure-changed handler failed: {err}");
            }
        }
    }
}

/// Bookkeeping and command transport for the one native UIA registration
/// thread owned by a `UiaBackend`.
pub struct EventSubscriptions {
    next: AtomicU64,
    sender: mpsc::Sender<WorkerCommand>,
    active: Mutex<HashMap<u64, ()>>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl EventSubscriptions {
    pub fn new() -> Result<Self> {
        let (sender, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::channel();
        let join = std::thread::Builder::new()
            .name("uia-event-registration".into())
            .spawn(move || run_event_worker(receiver, ready_sender))
            .map_err(|err| backend_error(format!("spawn UIA event thread: {err}")))?;
        ready_receiver
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|err| backend_error(format!("initialize UIA event thread: {err}")))?
            .map_err(backend_error)?;
        Ok(Self::from_parts(sender, join))
    }

    fn from_parts(sender: mpsc::Sender<WorkerCommand>, join: JoinHandle<()>) -> Self {
        Self {
            next: AtomicU64::new(1),
            sender,
            active: Mutex::new(HashMap::new()),
            join: Mutex::new(Some(join)),
        }
    }

    /// Register exactly the requested kinds. `scope` is resolved by the
    /// backend cache before crossing onto the event-registration thread.
    pub fn subscribe(
        &self,
        filter: &EventFilter,
        scope: Option<UIElement>,
    ) -> Result<SubscriptionId> {
        validate_filter(filter)?;
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, response) = mpsc::channel();
        self.sender
            .send(WorkerCommand::Subscribe {
                id,
                filter: filter.clone(),
                scope,
                reply,
            })
            .map_err(|err| backend_error(format!("subscribe_events worker unavailable: {err}")))?;
        response
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|err| backend_error(format!("subscribe_events timed out: {err}")))?
            .map_err(backend_error)?;
        self.active.lock().insert(id, ());
        Ok(SubscriptionId(id))
    }

    pub fn unsubscribe(&self, sub: &SubscriptionId) -> Result<()> {
        if !self.active.lock().contains_key(&sub.0) {
            return Err(backend_error(format!(
                "unsubscribe: unknown subscription id {}",
                sub.0
            )));
        }
        let (reply, response) = mpsc::channel();
        self.sender
            .send(WorkerCommand::Unsubscribe { id: sub.0, reply })
            .map_err(|err| backend_error(format!("unsubscribe worker unavailable: {err}")))?;
        response
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|err| backend_error(format!("unsubscribe timed out: {err}")))?
            .map_err(backend_error)?;
        self.active.lock().remove(&sub.0);
        Ok(())
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.active.lock().len()
    }
}

impl Drop for EventSubscriptions {
    fn drop(&mut self) {
        let _ = self.sender.send(WorkerCommand::Shutdown);
        if let Some(join) = self.join.lock().take() {
            let _ = join.join();
        }
        self.active.lock().clear();
    }
}

fn run_event_worker(
    receiver: mpsc::Receiver<WorkerCommand>,
    ready: mpsc::Sender<std::result::Result<(), String>>,
) {
    let automation = match UIAutomation::new() {
        Ok(automation) => automation,
        Err(err) => {
            let _ = ready.send(Err(format!("UIAutomation::new failed: {err}")));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let mut handlers: HashMap<u64, RegisteredHandlers> = HashMap::new();
    while let Ok(command) = receiver.recv() {
        match command {
            WorkerCommand::Subscribe {
                id,
                filter,
                scope,
                reply,
            } => {
                let result = register_handlers(&automation, id, &filter, scope);
                match result {
                    Ok(registered) => {
                        handlers.insert(id, registered);
                        let _ = reply.send(Ok(()));
                    }
                    Err(message) => {
                        let _ = reply.send(Err(message));
                    }
                }
            }
            WorkerCommand::Unsubscribe { id, reply } => {
                let result = match handlers.remove(&id) {
                    Some(registered) => {
                        registered.unregister(&automation);
                        Ok(())
                    }
                    None => Err(format!("unsubscribe: unknown subscription id {id}")),
                };
                let _ = reply.send(result);
            }
            WorkerCommand::Shutdown => break,
        }
    }
    for (_, registered) in handlers.drain() {
        registered.unregister(&automation);
    }
}

fn register_handlers(
    automation: &UIAutomation,
    id: u64,
    filter: &EventFilter,
    scope: Option<UIElement>,
) -> std::result::Result<RegisteredHandlers, String> {
    let root = match scope.as_ref() {
        Some(element) => element.clone(),
        None => automation
            .get_root_element()
            .map_err(|err| format!("get UIA root for subscription {id}: {err}"))?,
    };
    let mut registered = RegisteredHandlers::new(root.clone());
    let kinds = requested_kinds(filter);

    if kinds.contains(&EventKind::FocusChanged) {
        let callback_automation = automation.clone();
        let callback_scope = scope.clone();
        let walker = automation
            .get_control_view_walker()
            .map_err(|err| format!("create focus scope walker: {err}"))?;
        let callback: Box<CustomFocusChangedEventHandlerFn> = Box::new(move |sender| {
            if callback_scope.as_ref().is_none_or(|scope| {
                element_is_in_scope(&callback_automation, &walker, scope, sender)
            }) {
                emit_element_event(id, "focus-changed", sender, None, None, None);
            }
            Ok(())
        });
        let handler: UIFocusChangedEventHandler = callback.into();
        if let Err(err) = automation.add_focus_changed_event_handler(None, &handler) {
            return Err(format!("register focus-changed handler: {err}"));
        }
        registered.focus = Some(handler);
    }

    if kinds.contains(&EventKind::TextSelectionChanged) {
        // Two consumers, one registration: the Tauri event bus (so the workflow
        // desktop-event trigger can fire on it) and the in-process selection
        // bus (so the selection toolbar can stop polling on every click).
        //
        // `selected_len` is -1 because UIA hands the callback only the element;
        // asking it for a text range here would mean a cross-process COM call
        // on every caret move. Consumers that care about size re-check after
        // they read the text.
        let callback: Box<CustomEventHandlerFn> = Box::new(move |sender, _event_type| {
            emit_element_event(id, "text-selection-changed", sender, None, None, None);
            selection_events::publish(SelectionSignal {
                kind: SelectionSignalKind::SelectionChanged,
                pid: sender.get_process_id().ok(),
                selected_len: -1,
                at_ms: now_ms(),
            });
            Ok(())
        });
        let handler: UIEventHandler = callback.into();
        if let Err(err) = automation.add_automation_event_handler(
            UIEventType::Text_TextSelectionChanged,
            &root,
            TreeScope::Subtree,
            None,
            &handler,
        ) {
            registered.unregister(automation);
            return Err(format!("register text-selection-changed handler: {err}"));
        }
        registered.text_selection = Some(handler);
    }

    if kinds.contains(&EventKind::PropertyChanged) {
        let callback: Box<CustomPropertyChangedEventHandlerFn> =
            Box::new(move |sender, property: UIProperty, _value: Variant| {
                emit_element_event(
                    id,
                    "property-changed",
                    sender,
                    Some(format!("{property:?}")),
                    None,
                    None,
                );
                Ok(())
            });
        let handler: UIPropertyChangedEventHandler = callback.into();
        let properties = all_uia_properties();
        if let Err(err) = automation.add_property_changed_event_handler(
            &root,
            TreeScope::Subtree,
            None,
            &handler,
            &properties,
        ) {
            registered.unregister(automation);
            return Err(format!("register property-changed handler: {err}"));
        }
        registered.property = Some(handler);
    }

    if kinds.contains(&EventKind::StructureChanged) {
        let callback: Box<CustomStructureChangedEventHandlerFn> = Box::new(
            move |sender, change_type: StructureChangeType, runtime_id: Option<&[i32]>| {
                emit_element_event(
                    id,
                    "structure-changed",
                    sender,
                    None,
                    Some(format!("{change_type:?}")),
                    runtime_id.map(<[i32]>::to_vec),
                );
                Ok(())
            },
        );
        let handler: UIStructureChangeEventHandler = callback.into();
        if let Err(err) = automation.add_structure_changed_event_handler(
            &root,
            TreeScope::Subtree,
            None,
            &handler,
        ) {
            registered.unregister(automation);
            return Err(format!("register structure-changed handler: {err}"));
        }
        registered.structure = Some(handler);
    }

    Ok(registered)
}

fn all_uia_properties() -> Vec<UIProperty> {
    (FIRST_UIA_PROPERTY_ID..=LAST_UIA_PROPERTY_ID)
        .filter_map(|id| UIProperty::try_from(id).ok())
        .collect()
}

fn element_is_in_scope(
    automation: &UIAutomation,
    walker: &UITreeWalker,
    scope: &UIElement,
    sender: &UIElement,
) -> bool {
    let mut current = sender.clone();
    for _ in 0..256 {
        if automation
            .compare_elements(scope, &current)
            .unwrap_or(false)
        {
            return true;
        }
        current = match walker.get_parent(&current) {
            Ok(parent) => parent,
            Err(_) => return false,
        };
    }
    false
}

/// Same clock the selection bus and the input monitor stamp with, so a
/// consumer can compare a selection signal against a mouse or key event.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn emit_element_event(
    subscription_id: u64,
    kind: &str,
    element: &UIElement,
    property: Option<String>,
    structure_change_type: Option<String>,
    runtime_id: Option<Vec<i32>>,
) {
    emit_uia_event(UiaEventPayload {
        subscription_id,
        kind: kind.into(),
        name: element.get_name().ok().filter(|name| !name.is_empty()),
        control_type: element
            .get_control_type()
            .ok()
            .map(|control_type| format!("{control_type:?}")),
        process_id: element.get_process_id().ok(),
        property,
        structure_change_type,
        runtime_id,
        at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(kinds: Option<Vec<EventKind>>) -> EventFilter {
        EventFilter { kinds, scope: None }
    }

    fn fake_subscriptions() -> EventSubscriptions {
        let (sender, receiver) = mpsc::channel();
        let join = std::thread::spawn(move || {
            while let Ok(command) = receiver.recv() {
                match command {
                    WorkerCommand::Subscribe { reply, .. }
                    | WorkerCommand::Unsubscribe { reply, .. } => {
                        let _ = reply.send(Ok(()));
                    }
                    WorkerCommand::Shutdown => break,
                }
            }
        });
        EventSubscriptions::from_parts(sender, join)
    }

    #[test]
    fn validate_accepts_every_supported_kind_and_rejects_empty_lists() {
        assert!(validate_filter(&filter(None)).is_ok());
        assert!(validate_filter(&filter(Some(vec![EventKind::FocusChanged]))).is_ok());
        assert!(validate_filter(&filter(Some(vec![EventKind::StructureChanged]))).is_ok());
        assert!(validate_filter(&filter(Some(vec![EventKind::PropertyChanged]))).is_ok());
        assert!(validate_filter(&filter(Some(vec![EventKind::TextSelectionChanged]))).is_ok());
        assert!(validate_filter(&filter(Some(vec![]))).is_err());
    }

    #[test]
    fn omitted_kinds_expands_to_all_supported_events() {
        assert_eq!(
            requested_kinds(&filter(None)),
            vec![
                EventKind::FocusChanged,
                EventKind::StructureChanged,
                EventKind::PropertyChanged,
            ]
        );
    }

    /// Text-selection events fire on every caret move in every text control.
    /// If `None` ever started to include them, every pre-existing subscription
    /// — notably the workflow desktop-event trigger — would silently begin
    /// registering a subtree-scoped 20014 handler and paying for it.
    #[test]
    fn text_selection_is_opt_in_and_never_part_of_the_default_set() {
        assert!(!requested_kinds(&filter(None)).contains(&EventKind::TextSelectionChanged));
        assert_eq!(
            requested_kinds(&filter(Some(vec![EventKind::TextSelectionChanged]))),
            vec![EventKind::TextSelectionChanged]
        );
    }

    #[test]
    fn property_subscription_covers_the_complete_uia_property_enum() {
        let properties = all_uia_properties();
        assert_eq!(properties.len(), 175);
        assert_eq!(properties.first(), Some(&UIProperty::RuntimeId));
        assert_eq!(properties.last(), Some(&UIProperty::IsDialog));
    }

    #[test]
    fn subscribe_and_unsubscribe_track_live_ids() {
        let subscriptions = fake_subscriptions();
        let id = subscriptions
            .subscribe(&filter(Some(vec![EventKind::StructureChanged])), None)
            .unwrap();
        assert_eq!(subscriptions.active_count(), 1);
        subscriptions.unsubscribe(&id).unwrap();
        assert_eq!(subscriptions.active_count(), 0);
        assert!(subscriptions.unsubscribe(&id).is_err());
    }
}
