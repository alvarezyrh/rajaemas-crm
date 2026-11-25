import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authenticate } from '../src/middleware/auth.js';
import { can, Permissions as P } from '../src/security/rbac.js';
import { passwordProblem, temporaryPassword } from '../src/shared/password.js';

describe('Password rules', () => {
  const who = { email: 'rina.anggraini@rajaemas.id', fullName: 'Rina Anggraini' };

  it('accepts a long password with letters and numbers', () => {
    assert.equal(passwordProblem('Emas2026Kuat', who), null);
  });

  it('explains every rejection', () => {
    assert.match(passwordProblem('Ab1', who), /at least 10/);
    assert.match(passwordProblem('abcdefghijk', who), /letters and numbers/);
    assert.match(passwordProblem('12345678901', who), /letters and numbers/);
    assert.match(passwordProblem('Anggraini2026', who), /your name/);
    assert.match(passwordProblem('xrina.anggraini9', who), /email/);
    assert.match(passwordProblem('a1'.repeat(101), who), /at most/);
  });

  it('generates readable temporary passwords that pass the rules', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const pw = temporaryPassword();
      assert.match(pw, /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
      assert.doesNotMatch(pw, /[0O1lI]/);
      assert.equal(passwordProblem(pw), null);
      seen.add(pw);
    }
    assert.equal(seen.size, 200);
  });
});

describe('User management access', () => {
  it('only head office manages staff accounts', () => {
    assert.equal(can('HQ_STAFF', P.USER_MANAGE), true);
    for (const role of ['BRANCH_HEAD', 'APPRAISER', 'CUSTOMER_SERVICE'])
      assert.equal(can(role, P.USER_MANAGE), false, role);
  });

  it('a temporary password blocks everything except setting a new one', async () => {
    const auth = {
      resolveSession: async () => ({
        id: 'u1',
        role: 'HQ_STAFF',
        branchId: null,
        sessionId: 's1',
        mustChangePassword: true,
      }),
    };
    const run = async (path) => {
      const ctx = { path, req: { headers: { authorization: 'Bearer t' } }, state: {} };
      let reached = false;
      try {
        await authenticate(auth)(ctx, async () => {
          reached = true;
        });
        return reached ? 'allowed' : 'stopped';
      } catch (err) {
        return err.code;
      }
    };
    for (const path of [
      '/api/v1/auth/me',
      '/api/v1/auth/logout',
      '/api/v1/account',
      '/api/v1/account/password',
    ]) {
      assert.equal(await run(path), 'allowed', path);
    }
    for (const path of [
      '/api/v1/customers',
      '/api/v1/users',
      '/api/v1/account/sessions/revoke-others',
      '/api/v1/integrations',
    ]) {
      assert.equal(await run(path), 'PASSWORD_CHANGE_REQUIRED', path);
    }
  });
});
