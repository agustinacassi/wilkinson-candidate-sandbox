# Handoff — disappearing message fix

## Nontechnical update (for a CRM user)
When you sent a text to a prospect, it showed up correctly at first, but after the
delivery confirmation came back it would silently move to a different contact who
happened to share the same phone number — so it looked like the message had
disappeared. We've fixed it: messages now stay on the exact prospect you sent them
to, delivery updates no longer move them, and repeated confirmations won't create
duplicates.

## Root cause
Two seed prospects share a phone number:

| id    | name          | phone          |
|-------|---------------|----------------|
| p-101 | Alex Morgan   | +12025550123   |
| p-102 | Jordan Morgan | +12025550123   |

`processWebhook` in `src/messages.js` re-derived the message owner from the phone
number on every provider event:

```js
const prospect = data.prospects.find(p => p.phone === event.externalNumber);
existing.prospectId = prospect.id;
```

`Array.find()` returns the first match, so every message was reassigned to Alex
(p-101) regardless of who it was sent to. The API filters history by `prospectId`
(`src/server.js`), so the message vanished from the intended prospect and appeared
on the first one sharing the number.

The true owner is already stored at send time by `sendMessage`. A delivery/status
event should only advance status (and body when present), keyed on the unique
`messageId` — it should never recompute ownership from a non-unique phone number.

## Changes
- **`src/messages.js`** — removed the phone-based owner lookup and the
  `existing.prospectId = prospect.id` reassignment (plus its now-meaningless
  `'Prospect not found'` error). The handler now matches on `messageId` and
  updates `status`/`body` in place.
- **`test/messages.test.js`** — added 3 regression tests (see below).

## Verification
- `npm test` → 6/6 pass (3 original + 3 regression).
- Confirmed the regression tests catch the bug: reintroducing the buggy line makes
  the owner/status tests fail; restoring the fix makes all 6 pass again.
- Live API re-reproduction against a running server (`npm run reset`, send to
  p-102, fire `message.sent` webhook):
  - webhook response keeps `prospectId: "p-102"` (was `p-101` before the fix)
  - Jordan (p-102) history still contains the message (was `[]` before)
  - Alex (p-101) history stays `[]` (held the stolen message before)

### Regression tests added
1. Webhook keeps the message on the prospect it was sent to (the core incident).
2. Repeated webhooks do not duplicate the message (idempotency).
3. Status-only event (no `body`) preserves the existing message text.

## How to run and verify
```bash
cp .env.example .env     # first time only
npm install              # no third-party deps
npm start                # http://localhost:4317
npm test                 # 6/6 pass
npm run reset            # restore fixtures if needed
```

## Remaining risks / next steps
- **Shared phone numbers are the underlying data smell.** The fix makes the webhook
  correct, but inbound/unsolicited provider events that carry only a phone number
  (no `messageId`) would still be ambiguous about which prospect they belong to.
  Out of scope here, but worth a product decision (e.g. de-duplicate contacts, or
  disambiguate inbound by thread).
- **No input validation on `externalNumber`/`status` values** beyond event type —
  acceptable for a sandbox; a real integration would validate the payload and the
  provider signature.
- **Store is a single JSON file with read-modify-write**, so concurrent webhooks
  could race. Fine for the sandbox; a real system would use a database with atomic
  updates.

## AI assistance
Used Claude Code to read the codebase, reproduce the bug via the HTTP API, and
draft the fix, tests, and this handoff. I verified its output by running the tests,
reproducing the issue live before and after the change, and confirming the
regression tests fail on the buggy code and pass on the fix.

## Time spent
~60 minutes including setup.
