import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../src/store.js';
import { sendMessage, processWebhook } from '../src/messages.js';
function memoryStore() { let data = seed(); return { read: () => structuredClone(data), write: value => { data = structuredClone(value); } }; }
test('sending persists the selected prospect and text', () => {
  const store = memoryStore();
  const message = sendMessage(store, 'p-102', 'Hello');
  assert.equal(message.prospectId, 'p-102');
  assert.equal(store.read().messages[0].body, 'Hello');
});
test('blank message is rejected', () => { assert.throws(() => sendMessage(memoryStore(), 'p-102', ' ')); });
test('unknown webhook message is rejected', () => { assert.throws(() => processWebhook(memoryStore(), { type: 'message.sent', messageId: 'missing' })); });
// --- Regression coverage for the reported incident ---
// p-101 (Alex) and p-102 (Jordan) share the phone +12025550123. A provider
// webhook must not re-derive the owner from that non-unique number.

test('regression: webhook keeps the message on the prospect it was sent to', () => {
  const store = memoryStore();
  const message = sendMessage(store, 'p-102', 'Hi Jordan');
  processWebhook(store, {
    type: 'message.sent',
    messageId: message.id,
    externalNumber: '+12025550123',
    status: 'sent',
    body: 'Hi Jordan'
  });
  const messages = store.read().messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].prospectId, 'p-102'); // must NOT jump to p-101
});

test('regression: repeated webhooks do not duplicate the message', () => {
  const store = memoryStore();
  const message = sendMessage(store, 'p-102', 'Hi Jordan');
  const event = {
    type: 'message.sent',
    messageId: message.id,
    externalNumber: '+12025550123',
    status: 'sent'
  };
  processWebhook(store, event);
  processWebhook(store, event);
  processWebhook(store, event);
  assert.equal(store.read().messages.length, 1);
});

test('regression: status-only event preserves the message body', () => {
  const store = memoryStore();
  const message = sendMessage(store, 'p-102', 'Original text');
  processWebhook(store, {
    type: 'message.status_updated',
    messageId: message.id,
    externalNumber: '+12025550123',
    status: 'delivered'
    // no body field
  });
  const updated = store.read().messages[0];
  assert.equal(updated.status, 'delivered');
  assert.equal(updated.body, 'Original text'); // body must survive
  assert.equal(updated.prospectId, 'p-102');
});
