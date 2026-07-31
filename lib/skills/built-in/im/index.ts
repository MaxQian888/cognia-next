/**
 * Platform-neutral `im.*` built-in skill family (W2 multi-bot).
 *
 * | id                  | mutation    | imAccess | requires            |
 * |---------------------|-------------|----------|---------------------|
 * | im.create_chat      | write       | always   | ["chat.create"]     |
 * | im.invite_members   | write       | always   | ["chat.members"]    |
 * | im.remove_members   | destructive | opt-in   | ["chat.members"]    |
 * | im.update_chat      | write       | always   | ["chat.update"]     |
 * | im.resolve_contact  | read        | always   | ["contact.resolve"] |
 * | im.broadcast        | write       | opt-in   | []                  |
 * | im.dispatch_task    | write       | opt-in   | []                  |
 *
 * Unlike the lark.* families these never touch lark-cli — they call the
 * RUNNING ADAPTER INSTANCE through the optional chat-management methods on
 * `PlatformAdapter`, so any platform that implements the methods + declares
 * the flags serves them with zero changes here.
 */

import "./create-chat"
import "./members"
import "./update-chat"
import "./resolve-contact"
import "./broadcast"
import "./dispatch-task"
