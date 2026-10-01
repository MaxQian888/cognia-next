//! The two pieces every live stream on this server needs (ADR-0206).
//!
//! Shared chat, Canvas and the workspace feed each let a caller trade an
//! authenticated HTTP request for a short-lived single-use ticket, then open
//! a WebSocket with it and receive frames broadcast to one key (a session, a
//! document, an organisation). Chat and Canvas each carried a private copy of
//! both halves; a fix to ticket expiry or capacity had to land twice and, in
//! Canvas, never did (it had no capacity bound).
//!
//! - [`TicketBook`] mints, redeems, sweeps and revokes tickets.
//! - [`Channels`] hands out one `tokio::broadcast` sender per key.
//!
//! Both are process-local. Like the streams built on them, they assume one
//! server instance per organisation (ADR-0206, "Not decided").

use std::collections::HashMap;
use std::hash::Hash;

use parking_lot::RwLock;
use tokio::sync::broadcast;
use uuid::Uuid;

/// A ticket carries its own expiry; everything else is the stream's business.
pub trait Expiring {
    fn expires_at(&self) -> i64;
}

/// The book is full: a caller keeps minting tickets it never redeems.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TicketCapacity;

/// Single-use, expiring tickets under one value prefix (`st_`, `ct_`, `ft_`).
pub struct TicketBook<T> {
    prefix: &'static str,
    capacity: usize,
    tickets: RwLock<HashMap<String, T>>,
}

impl<T: Expiring> TicketBook<T> {
    pub fn new(prefix: &'static str, capacity: usize) -> Self {
        Self {
            prefix,
            capacity,
            tickets: RwLock::new(HashMap::new()),
        }
    }

    /// Mint a ticket at `now`. Expired tickets are swept first, so the book
    /// is bounded by live tickets rather than by every one ever issued.
    pub fn issue(&self, ticket: T, now: i64) -> Result<String, TicketCapacity> {
        let mut tickets = self.tickets.write();
        tickets.retain(|_, held| held.expires_at() > now);
        if tickets.len() >= self.capacity {
            return Err(TicketCapacity);
        }
        let value = format!("{}{}", self.prefix, Uuid::new_v4().simple());
        tickets.insert(value.clone(), ticket);
        Ok(value)
    }

    /// Redeem a ticket. It is removed whether or not it was still valid, so a
    /// leaked ticket cannot be replayed even by the person it was minted for.
    pub fn consume(&self, value: &str, now: i64) -> Option<T> {
        self.tickets
            .write()
            .remove(value)
            .filter(|ticket| ticket.expires_at() > now)
    }

    /// Redeem a ticket only if `accept` agrees; a refused ticket is still
    /// spent, for the same reason as [`consume`](Self::consume).
    pub fn consume_if(&self, value: &str, now: i64, accept: impl FnOnce(&T) -> bool) -> Option<T> {
        self.consume(value, now).filter(|ticket| accept(ticket))
    }

    /// Withdraw one ticket unredeemed, e.g. when the write it was minted for
    /// failed after the ticket had been issued.
    pub fn discard(&self, value: &str) {
        self.tickets.write().remove(value);
    }

    /// Drop expired tickets.
    pub fn sweep(&self, now: i64) {
        self.tickets
            .write()
            .retain(|_, ticket| ticket.expires_at() > now);
    }

    /// Drop every ticket `revoked` matches (an offboarded member, a closed
    /// session), so an unredeemed ticket cannot outlive the access it proved.
    pub fn revoke(&self, revoked: impl Fn(&T) -> bool) {
        self.tickets.write().retain(|_, ticket| !revoked(ticket));
    }

    pub fn len(&self) -> usize {
        self.tickets.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// One broadcast sender per key, created on first use.
pub struct Channels<K, F> {
    capacity: usize,
    senders: RwLock<HashMap<K, broadcast::Sender<F>>>,
}

impl<K: Eq + Hash + Clone, F: Clone> Channels<K, F> {
    /// `capacity` is each channel's backlog. A receiver that falls further
    /// behind sees `RecvError::Lagged` and must resynchronise.
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            senders: RwLock::new(HashMap::new()),
        }
    }

    pub fn sender(&self, key: &K) -> broadcast::Sender<F> {
        if let Some(sender) = self.senders.read().get(key) {
            return sender.clone();
        }
        self.senders
            .write()
            .entry(key.clone())
            .or_insert_with(|| broadcast::channel(self.capacity).0)
            .clone()
    }

    pub fn subscribe(&self, key: &K) -> broadcast::Receiver<F> {
        self.sender(key).subscribe()
    }

    /// Send to whoever is listening on `key`. Returns how many receivers got
    /// it; zero is not an error, since nobody may be connected.
    pub fn publish(&self, key: &K, frame: F) -> usize {
        let sender = self.senders.read().get(key).cloned();
        match sender {
            Some(sender) => sender.send(frame).unwrap_or(0),
            None => 0,
        }
    }

    /// Forget channels nobody listens on, so keys that come and go (sessions,
    /// documents) do not accumulate senders forever.
    pub fn prune_idle(&self) {
        self.senders
            .write()
            .retain(|_, sender| sender.receiver_count() > 0);
    }

    pub fn len(&self) -> usize {
        self.senders.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq)]
    struct Ticket {
        user: &'static str,
        expires_at: i64,
    }

    impl Expiring for Ticket {
        fn expires_at(&self) -> i64 {
            self.expires_at
        }
    }

    fn ticket(user: &'static str, expires_at: i64) -> Ticket {
        Ticket { user, expires_at }
    }

    #[test]
    fn tickets_are_single_use_and_carry_the_prefix() {
        let book = TicketBook::new("ft_", 8);
        let value = book.issue(ticket("a", 100), 0).unwrap();
        assert!(value.starts_with("ft_"));
        assert_eq!(book.consume(&value, 10), Some(ticket("a", 100)));
        assert_eq!(book.consume(&value, 10), None, "a redeemed ticket is gone");
    }

    #[test]
    fn an_expired_ticket_is_refused_and_spent() {
        let book = TicketBook::new("ft_", 8);
        let value = book.issue(ticket("a", 100), 0).unwrap();
        assert_eq!(book.consume(&value, 100), None);
        assert!(book.is_empty());
    }

    #[test]
    fn issuing_sweeps_expired_tickets_before_checking_capacity() {
        let book = TicketBook::new("ft_", 1);
        book.issue(ticket("a", 10), 0).unwrap();
        assert_eq!(book.issue(ticket("b", 100), 5), Err(TicketCapacity));
        // Once the first has expired it no longer counts against the cap.
        assert!(book.issue(ticket("b", 100), 10).is_ok());
        assert_eq!(book.len(), 1);
    }

    #[test]
    fn revoking_drops_every_matching_ticket() {
        let book = TicketBook::new("ft_", 8);
        let a1 = book.issue(ticket("a", 100), 0).unwrap();
        let a2 = book.issue(ticket("a", 100), 0).unwrap();
        let b = book.issue(ticket("b", 100), 0).unwrap();
        book.revoke(|t| t.user == "a");
        assert_eq!(book.consume(&a1, 1), None);
        assert_eq!(book.consume(&a2, 1), None);
        assert!(book.consume(&b, 1).is_some());
    }

    #[test]
    fn a_refused_conditional_ticket_is_still_spent() {
        let book = TicketBook::new("ft_", 8);
        let value = book.issue(ticket("a", 100), 0).unwrap();
        assert_eq!(book.consume_if(&value, 1, |t| t.user == "b"), None);
        assert_eq!(book.consume(&value, 1), None);
    }

    #[test]
    fn a_discarded_ticket_cannot_be_redeemed() {
        let book = TicketBook::new("ft_", 8);
        let value = book.issue(ticket("a", 100), 0).unwrap();
        book.discard(&value);
        assert_eq!(book.consume(&value, 1), None);
    }

    #[test]
    fn sweep_drops_only_expired_tickets() {
        let book = TicketBook::new("ft_", 8);
        book.issue(ticket("a", 10), 0).unwrap();
        let live = book.issue(ticket("b", 100), 0).unwrap();
        book.sweep(50);
        assert_eq!(book.len(), 1);
        assert!(book.consume(&live, 50).is_some());
    }

    #[tokio::test]
    async fn channels_fan_out_per_key() {
        let channels: Channels<String, u32> = Channels::new(8);
        let mut a = channels.subscribe(&"a".to_owned());
        let mut b = channels.subscribe(&"b".to_owned());
        assert_eq!(channels.publish(&"a".to_owned(), 1), 1);
        assert_eq!(a.recv().await.unwrap(), 1);
        assert!(b.try_recv().is_err(), "another key hears nothing");
    }

    #[test]
    fn publishing_to_a_key_nobody_opened_is_a_no_op() {
        let channels: Channels<String, u32> = Channels::new(8);
        assert_eq!(channels.publish(&"nobody".to_owned(), 1), 0);
        assert!(channels.is_empty(), "publishing does not create a channel");
    }

    #[test]
    fn a_receiver_that_falls_behind_is_told_it_lagged() {
        let channels: Channels<String, u32> = Channels::new(2);
        let mut rx = channels.subscribe(&"k".to_owned());
        for frame in 0..5 {
            channels.publish(&"k".to_owned(), frame);
        }
        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
    }

    #[test]
    fn pruning_forgets_channels_without_listeners() {
        let channels: Channels<String, u32> = Channels::new(8);
        let kept = channels.subscribe(&"kept".to_owned());
        drop(channels.subscribe(&"gone".to_owned()));
        channels.prune_idle();
        assert_eq!(channels.len(), 1);
        drop(kept);
    }
}
