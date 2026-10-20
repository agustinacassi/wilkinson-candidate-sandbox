# Solution documentation — "message disappears from a prospect"

This document walks through how I approached the bug: understanding the report,
forming a hypothesis, reproducing it deterministically, isolating the root cause,
implementing a focused fix, and verifying it with tests. It is meant to be read
top to bottom by a reviewer.

---

## 1. The reported problem

A message appears on a prospect's profile immediately after sending, but
**disappears** after a simulated provider webhook arrives and the history is
refreshed.

Reproduction contact (per the README): **Jordan Morgan**.
Steps: send a mock message → **Simulate sent webhook** → **Refresh history**
(or reload the page).

## 2. Initial hypotheses

Before reading the code, I considered three plausible causes:

- **(a)** The webhook overwrites or deletes the message in the store.
- **(b)** History is filtered by a field that the webhook mutates (owner, status, or id).
- **(c)** A duplicate-handling branch drops or moves the record.

A quick read of the code pointed at **(b)**: the API returns history filtered by
`prospectId` (`src/server.js`), and the webhook handler mutates `prospectId`.

## 3. Key observation in the seed data

`src/store.js` seeds **two prospects that share the same phone number**:

| id    | name          | phone          |
|-------|---------------|----------------|
| p-101 | Alex Morgan   | +12025550123   |
| p-102 | Jordan Morgan | +12025550123   |

So the phone number is **not a unique identifier** for a prospect. This detail is
central to the bug.

## 4. Reproduction (deterministic, via the HTTP API)

With the server running on `:4317` and fixtures reset (`npm run reset`):

1. **Send to Jordan**
   `POST /api/prospects/p-102/messages` with `{"body":"Hi Jordan, following up"}`
   → returns a message with `prospectId: "p-102"`.

2. **Before the webhook**
   - `GET /api/prospects/p-102/messages` → 1 message (Jordan) ✓
   - `GET /api/prospects/p-101/messages` → `[]` (Alex empty) ✓

3. **Fire the webhook**
   `POST /api/webhooks/messages` with
   `{"type":"message.sent","messageId":"<id>","externalNumber":"+12025550123","status":"sent","body":"..."}`
   → the response shows the **same** message id now has `prospectId: "p-101"`.

4. **After the webhook**
   - `GET /api/prospects/p-102/messages` → `[]` — Jordan is now empty (message "disappeared")
   - `GET /api/prospects/p-101/messages` → 1 message — it jumped to Alex

**Conclusion:** the message is not deleted — it is **reassigned to the wrong
prospect**.

## 5. Root cause

In `src/messages.js`, `processWebhook` re-derived the message owner from the phone
number on every event:

```js
const prospect = data.prospects.find(p => p.phone === event.externalNumber);
existing.prospectId = prospect.id;   // overwrites the real owner
```

Because Alex and Jordan share a phone number, `Array.find()` returns the first
match (Alex, `p-101`) regardless of who the message was actually sent to. The
webhook therefore clobbers the correct `prospectId` that `sendMessage` had already
stored at send time. Since history is filtered by `prospectId`, the message
vanishes from the intended prospect and appears on the first prospect that shares
the number.

> **Root cause, in one sentence:** the webhook handler recomputes a message's owner
> from a non-unique phone number instead of trusting the `prospectId` that was
> already assigned when the message was sent.

## 6. Requirements the fix must satisfy

1. A message stays on the prospect it was sent to after the webhook.
2. Repeated webhooks do not create duplicate messages.
3. Status-only events (no `body`) preserve the existing message text.

## 7. The fix

`src/messages.js` → `processWebhook`. Removed the phone-based owner lookup and the
reassignment.

**Removed:**
```js
const prospect = data.prospects.find(p => p.phone === event.externalNumber);
if (!prospect) throw new Error('Prospect not found');
existing.prospectId = prospect.id;
```

**Kept** (match on the unique `messageId`; update delivery state only):
```js
existing.status = event.status || existing.status;
if (typeof event.body === 'string') existing.body = event.body;
```

**Rationale.** The owner is set correctly at send time. A delivery/status event
should only advance the status (and the body when one is provided), never reassign
ownership. Phone number is not a unique key, so any lookup by phone is unsafe here.
I removed the `externalNumber` lookup and its `'Prospect not found'` error entirely
because, with the reassignment gone, the lookup served no purpose. This keeps the
change minimal and focused on the actual defect.

This also keeps the other two guarantees intact:
- **No duplicates** — the handler still finds the existing message by id and mutates
  it in place; it never pushes a new record, so repeated webhooks are idempotent.
- **Status-only preserves text** — the `typeof event.body === 'string'` guard means
  an event without a `body` leaves the stored text unchanged.

## 8. Verification

**Automated tests** — `npm test` → **6/6 pass** (3 original + 3 regression):

| # | Test | Requirement |
|---|------|-------------|
| 4 | webhook keeps the message on the prospect it was sent to | #1 (the incident) |
| 5 | repeated webhooks do not duplicate the message | #2 |
| 6 | status-only event preserves the message body | #3 |

**The tests genuinely catch the regression.** Temporarily reintroducing the buggy
line made tests 4 and 6 fail; restoring the fix made all 6 pass again.

**Live API verification** against the running server (reset → send to `p-102` →
webhook):
- The webhook response keeps `prospectId: "p-102"` (was `p-101` before the fix).
- Jordan (`p-102`) history still contains the message (was `[]` before the fix).
- Alex (`p-101`) history stays `[]` (held the stolen message before the fix).
- Firing the same webhook 3× keeps Jordan's message count at 1.
- A status-only event (`status: "delivered"`, no `body`) advances the status and
  preserves the body `"Hi Jordan"`.

## 9. How to run and verify

```bash
cp .env.example .env     # first time only
npm install              # no third-party dependencies
npm start                # http://localhost:4317
npm test                 # 6/6 pass
npm run reset            # restore fixtures if needed
```

Manual reproduction in the UI: select **Jordan Morgan** → send a message →
**Simulate sent webhook** → **Refresh history**. The message now stays on Jordan
(previously it jumped to Alex).

## 10. Remaining concerns / next steps

- **Shared phone numbers are the underlying data smell.** The fix makes the webhook
  correct, but a real inbound/unsolicited provider event that carries only a phone
  number (no `messageId`) would still be ambiguous about which prospect it belongs
  to. That is a product decision (de-duplicate contacts, or disambiguate inbound by
  thread) and is out of scope for this fix.
- **No payload validation** beyond the event type. A real integration should
  validate the webhook payload and verify the provider's signature.
- **The store is a single JSON file with read-modify-write**, so concurrent webhooks
  could race. Acceptable for a sandbox; a production system would use a database
  with atomic updates.

## 11. AI assistance

I used Claude Code to help read the codebase, reproduce the bug through the HTTP
API, and draft the fix, tests, and this documentation. I verified its output
myself by running the test suite, reproducing the issue live before and after the
change, and confirming that the regression tests fail on the buggy code and pass
on the fix.
