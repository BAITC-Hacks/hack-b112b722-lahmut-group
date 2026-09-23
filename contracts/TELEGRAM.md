# Optional Telegram adapter v1

Additive integration for backend/UI; the existing Meeting, Participant, Action,
ML interface, approval and DOCX contracts do not change. All routes are local
secretary operations under the same access restrictions as the existing API.
The bot uses long polling; there is no public webhook endpoint.

## HTTP

- `GET /api/meetings/{meeting_id}/telegram` →
  `{enabled, ready, bot_username: string|null, error: string|null,
  include_task_text: boolean, participants: [{participant_id, bound, blocked}],
  deliveries: {pending?: integer, sent?: integer, failed?: integer, cancelled?: integer},
  unmatched_action_ids: string[]}`.
- `POST /api/meetings/{meeting_id}/telegram/participants/{participant_id}/invite`
  → `{url, expires_at: ISO UTC}`. Ready bot required (otherwise 503); saved
  participant required (otherwise 404). Response `Cache-Control: no-store`.
  New invitation invalidates the previous unused invitation for that participant.
  Valid for 15 minutes, consumed atomically once; only its SHA-256 hash is stored.
- `POST /api/meetings/{meeting_id}/telegram/participants/{participant_id}/unlink`
  → `{unlinked: true}`. Revokes binding, unused invitation and old keyboards.
  Works even when the external channel is disabled.

Errors retain `{detail: string}`. Tokens/chat IDs do not become meeting fields.

## Identity, versions and delivery

`Action.assignee` is resolved against saved `Participant.display_name` using
case-insensitive exact equality with whitespace normalization. Exactly one match
is required; absent/ambiguous names are reported and never guessed. Binding is
scoped to `(meeting_id, participant_id)`. A private `/start <token>` binds numeric
Telegram user ID and chat ID; no username matching, groups or forwarded starts.

Dedicated SQLite tables persist bindings, invitation hashes, polling offset and
outbox. Dedupe key: `(action_id, delivery_version, kind)` where kind is `assigned`,
`due_soon`, `overdue`. The version changes transactionally on every deadline,
assignee, title or resolved participant change; also on rebinding, removal/return
and reopening completed tasks. Editing a deadline A→B→A between worker polls
therefore still invalidates old keyboards. Summary-only edits do not resend
already delivered tasks. Unsent cancelled deliveries resume after reapproval.

Only approved open tasks with a bound, active assignee are sent. Near deadline:
today through three days ahead, inclusive, in the meeting timezone. Overdue:
before today. No reminders for `due_date=null`. Each kind is sent once per version,
including across restarts; completion cancels queued reminders. A valid callback
checks private chat, user ID, binding, original message ID, current task version,
assignee and approval. Completion increments meeting revision once and preserves
the approved DOCX snapshot. `/stop` blocks all bindings of the requesting private
user; a fresh invitation restores delivery.

API failure cannot undo approval. Network errors/429 retry with backoff, respecting
`retry_after`; 400 is a failed delivery, 403 blocks that binding. A new invitation
and `/start` restore a blocked recipient. See operational limits in
[Telegram setup](../docs/TELEGRAM.md).

## Handoff to participants 1 and 3

ML input/output and fixtures are untouched. UI integration is isolated in
`frontend/src/TelegramPanel.tsx`; existing editing/approval calls are unchanged.
No hosted inference API is introduced. Test-only Telegram control routes live in
`backend.testing.server` and are absent from the production app.
