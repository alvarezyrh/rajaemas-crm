import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { createBlastService } from '../src/modules/blasts/blast.service.js';
import { createMetaGateway } from '../src/modules/blasts/metaGateway.js';
import { createBlastRepository } from '../src/modules/blasts/blast.repository.js';

const metaConfig = {
  accessToken: 'test-access-token',
  phoneNumberId: '123456789012',
  appSecret: 'test-app-secret',
  webhookVerifyToken: 'test-verify-token',
  graphApiVersion: 'v24.0',
};

describe('Meta WhatsApp gateway', () => {
  it('verifies webhook challenge and HMAC signature using constant-time comparisons', () => {
    const gateway = createMetaGateway({ config: metaConfig });
    const raw = Buffer.from('{"entry":[]}');
    const signature = `sha256=${createHmac('sha256', metaConfig.appSecret).update(raw).digest('hex')}`;

    assert.equal(gateway.verifyWebhook('subscribe', 'test-verify-token'), true);
    assert.equal(gateway.verifyWebhook('subscribe', 'wrong'), false);
    assert.equal(gateway.verifySignature(raw, signature), true);
    assert.equal(gateway.verifySignature(raw, `${signature}x`), false);
  });

  it('sends an approved template without exposing the access token in the payload', async () => {
    let request;
    const gateway = createMetaGateway({
      config: metaConfig,
      validateUrl: async () => {},
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.123' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const result = await gateway.sendTemplate({
      phone: '+628123456789',
      templateName: 'monthly_update',
      languageCode: 'id',
      customerName: 'Customer',
    });

    assert.equal(result.messageId, 'wamid.123');
    assert.match(request.url, /graph\.facebook\.com\/v24\.0\/123456789012\/messages$/);
    assert.equal(request.options.headers.authorization, 'Bearer test-access-token');
    const body = JSON.parse(request.options.body);
    assert.equal(body.to, '628123456789');
    assert.equal(body.template.components[0].parameters[0].text, 'Customer');
    assert.equal(body.accessToken, undefined);
  });
});

describe('Blast audience and consent', () => {
  it('binds audience filters and always enforces active marketing consent', async () => {
    let captured;
    const repo = createBlastRepository({
      query: async (text, params) => {
        captured = { text, params };
        return { rows: [{ count: 2 }] };
      },
    });

    assert.equal(
      await repo.countEligible({
        city: 'Jakarta',
        channels: ['STORE', 'ECOMMERCE'],
      }),
      2,
    );
    assert.match(captured.text, /c\.marketing_consent IS TRUE/);
    assert.match(captured.text, /c\.phone_encrypted IS NOT NULL/);
    assert.match(captured.text, / OR /);
    assert.deepEqual(captured.params, ['Jakarta', 'STORE', 'ECOMMERCE']);
    assert.equal(captured.text.includes('Jakarta'), false);
  });

  it('rejects unknown filters and applies STOP opt-out through the phone blind index', async () => {
    let appliedHash;
    let audited = false;
    const uow = {
      repos: { blasts: { countEligible: async () => 1 } },
      run: async (work) =>
        work({
          customers: {
            findIdByPhoneHash: async (hash) => {
              appliedHash = hash;
              return 'customer-1';
            },
            update: async (_id, changes) => changes.marketingConsent === false,
          },
          audit: { append: async () => (audited = true) },
        }),
    };
    const service = createBlastService({
      uow,
      pii: {},
      blindIndex: (_domain, phone) => `blind:${phone}`,
      gateway: { isSenderConfigured: () => false },
      logger: { error() {} },
    });

    await assert.rejects(service.preview({ arbitrarySql: '1=1' }), {
      status: 422,
    });
    assert.equal(await service.processOptOut('081234567890', ' STOP '), true);
    assert.equal(appliedHash, 'blind:+6281234567890');
    assert.equal(audited, true);
    assert.equal(await service.processOptOut('081234567890', 'hello'), false);
  });

  it('requires an explicit timezone when scheduling', async () => {
    let transactionStarted = false;
    const service = createBlastService({
      uow: {
        repos: { blasts: {} },
        run: async (work) => {
          transactionStarted = true;
          return work({});
        },
      },
      pii: {},
      blindIndex: () => 'unused',
      gateway: { isSenderConfigured: () => true },
      logger: { error() {} },
    });

    await assert.rejects(service.schedule({}, 'blast-1', '2030-01-01T10:00:00'), { status: 422 });
    assert.equal(transactionStarted, false);
  });

  it('checks consent again immediately before sending a claimed recipient', async () => {
    const calls = [];
    const recipient = {
      id: 'recipient-1',
      customerId: 'customer-1',
      phoneEncrypted: 'ciphertext',
      fullName: 'Customer',
    };
    const repository = {
      workSnapshot: async () => ({ hasPendingWork: true }),
      claimDue: async () => [],
      failInterruptedRecipients: async () => 0,
      skipRevokedQueued: async () => 0,
      activeRuns: async () => [
        {
          blast_id: 'blast-1',
          blast_run_id: 'run-1',
          template_name: 'monthly_update',
          language_code: 'id',
          personalize_name: false,
        },
      ],
      isConsented: async () => false,
      claimQueued: async () => [recipient],
      markSkipped: async (id) => calls.push(['skip', id]),
      finishIfDrained: async () => true,
    };
    const uow = {
      repos: { blasts: repository },
      run: async (work) => work({ blasts: repository }),
    };
    const gateway = {
      isSenderConfigured: () => true,
      sendTemplate: async () => assert.fail('must not send after consent revocation'),
    };
    const service = createBlastService({
      uow,
      pii: { decrypt: () => '+6281234567890' },
      blindIndex: () => 'unused',
      gateway,
      logger: { error() {} },
    });

    await service.runScheduled();
    assert.deepEqual(calls, [['skip', 'recipient-1']]);
  });

  it('sends only the customer first name when template personalization is enabled', async () => {
    let sent;
    const repository = {
      workSnapshot: async () => ({ hasPendingWork: true }),
      claimDue: async () => [],
      failInterruptedRecipients: async () => 0,
      skipRevokedQueued: async () => 0,
      activeRuns: async () => [
        {
          blast_id: 'blast-1',
          blast_run_id: 'run-1',
          template_name: 'monthly_update',
          language_code: 'id',
          personalize_name: true,
        },
      ],
      claimQueued: async () => [
        {
          id: 'recipient-1',
          customerId: 'customer-1',
          phoneEncrypted: 'ciphertext',
          fullName: 'Ayu Permata',
        },
      ],
      isConsented: async () => true,
      markSent: async () => {},
      finishIfDrained: async () => true,
    };
    const uow = {
      repos: { blasts: repository },
      run: async (work) => work({ blasts: repository }),
    };
    const service = createBlastService({
      uow,
      pii: { decrypt: () => '+6281234567890' },
      blindIndex: () => 'unused',
      gateway: {
        isSenderConfigured: () => true,
        sendTemplate: async (message) => {
          sent = message;
          return { messageId: 'wamid.123' };
        },
      },
      logger: { error() {} },
    });

    await service.runScheduled();
    assert.deepEqual(sent, {
      phone: '+6281234567890',
      templateName: 'monthly_update',
      languageCode: 'id',
      customerName: 'Ayu',
    });
  });
});
