import test from 'node:test';
import assert from 'node:assert/strict';
import { issueToken, validToken, matchesPassword } from '../lib/jarvis/auth.ts';
import { safeFilename, messageText, validId } from '../lib/jarvis/validation.ts';

test('private session expires, rejects tampering and is revoked by password rotation', () => {
  process.env.JARVIS_ACCESS_PASSWORD = 'test-only-password-123456';
  const now = 1800000000000;
  const token = issueToken(now);
  assert.equal(validToken(token, now), true);
  assert.equal(validToken(token + 'x', now), false);
  assert.equal(validToken(token, now + 8 * 86400000), false);
  process.env.JARVIS_ACCESS_PASSWORD = 'different-test-password-123';
  assert.equal(validToken(token, now), false);
  assert.equal(matchesPassword('different-test-password-123'), true);
  assert.equal(matchesPassword('wrong'), false);
  delete process.env.JARVIS_ACCESS_PASSWORD;
  assert.equal(validToken(issueToken(now), now), false);
});
test('uploads cannot escape their assigned directory or inject download headers', () => {
  for (const input of ['../../secret', '\r\nX-Evil: true', '.env', 'a/b\\c', '']) {
    const name = safeFilename(input);
    assert.match(name, /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/);
    assert.ok(name.length <= 120);
  }
});
test('message and identifier boundaries reject malformed input', () => {
  for (const value of ['', '  ', null, 42, 'x'.repeat(32001)]) assert.throws(() => messageText(value));
  assert.equal(messageText(' hello '), 'hello');
  assert.equal(validId('../foreign'), false);
  assert.equal(validId('sess_test-123'), true);
});
