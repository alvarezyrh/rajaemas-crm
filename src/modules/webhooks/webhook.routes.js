import { Errors } from '../../core/errors.js';
import { ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { EMAIL_PATTERN } from '../../shared/email.js';
import { normalizeIndonesianPhone } from '../../shared/phone.js';
import { isSideAllowed } from '../../shared/segments.js';
import { verifyWebhookSignature } from './signature.js';

export const OMNICHANNEL_EVENTS = Object.freeze({
  INBOUND: 'omnichannel.message.inbound',
  STATUS: 'omnichannel.message.status',
});

/** Events from the mobile app and e-commerce website (the source of customer clusters). */
export const COMMERCE_EVENT = 'commerce.event';

const commerceSchema = v.object(
  {
    eventId: v.string({ required: true, max: 128 }),
    type: v.oneOf(['account.registered', 'order.completed'], { required: true }),
    source: v.oneOf(['MOBILE_APP', 'ECOMMERCE'], { required: true }),
    accountId: v.string({ required: true, max: 128 }),
    phone: v.string({
      max: 20,
      transform: normalizeIndonesianPhone,
      message: 'invalid Indonesian phone number',
    }),
    fullName: v.string({ min: 2, max: 120 }),
    email: v.string({ max: 160, pattern: EMAIL_PATTERN, transform: (s) => s.toLowerCase() }),
    orderId: v.string({ max: 128 }),
    side: v.oneOf(['BUY', 'SELL']),
    description: v.string({ max: 200 }),
    weightGram: v.number({ min: 0.001, max: 100_000 }),
    amount: v.number({ min: 0, max: 99_999_999_999 }),
    occurredAt: v.datetime(),
  },
  { allowUnknown: true },
);

/** Cross-field rules that per-field schemas cannot express. */
function commerceRuleErrors(event) {
  const errors = [];
  if (event.type === 'account.registered' && !event.phone) {
    errors.push({ field: 'phone', message: 'is required for account registration' });
  }
  if (event.type === 'order.completed') {
    for (const field of ['orderId', 'side', 'weightGram', 'amount']) {
      if (event[field] === undefined) errors.push({ field, message: 'is required for orders' });
    }
    if (event.side && !isSideAllowed(event.source, event.side)) {
      errors.push({ field: 'side', message: `${event.side} is not allowed for ${event.source}` });
    }
  }
  return errors;
}

const TYPE_TO_EVENT = {
  'message.inbound': OMNICHANNEL_EVENTS.INBOUND,
  'message.status': OMNICHANNEL_EVENTS.STATUS,
};
const DEDUPE_TTL_SEC = 3 * 24 * 60 * 60;

// Providers may add fields → allowUnknown, but every field we use is still strictly validated.
const eventSchema = v.object(
  {
    eventId: v.string({ required: true, max: 128 }),
    type: v.oneOf(Object.keys(TYPE_TO_EVENT), { required: true }),
    channel: v.oneOf(['WHATSAPP', 'EMAIL'], { required: true }),
    from: v.string({ max: 20, transform: normalizeIndonesianPhone }),
    messageId: v.string({ max: 128 }),
    text: v.string({ max: 4000 }),
    status: v.string({ max: 32 }),
    occurredAt: v.datetime(),
  },
  { allowUnknown: true },
);

export function registerWebhookRoutes(router, { cache, bus, webhookSecret }) {
  const assertSigned = (ctx) => {
    const verified = verifyWebhookSignature({
      secret: webhookSecret,
      rawBody: ctx.rawBody,
      signature: ctx.req.headers['x-signature'],
      timestamp: ctx.req.headers['x-timestamp'],
    });
    if (!verified) throw Errors.unauthorized('Invalid webhook signature');
  };

  router.post('/api/v1/webhooks/commerce', async (ctx) => {
    assertSigned(ctx);
    const event = validate(commerceSchema, ctx.body);
    const ruleErrors = commerceRuleErrors(event);
    if (ruleErrors.length > 0) throw Errors.validation(ruleErrors);

    const isNew = await cache.setIfAbsent(`wh:commerce:${event.eventId}`, 1, DEDUPE_TTL_SEC);
    if (isNew) bus.publish(COMMERCE_EVENT, event);

    ok(ctx, { eventId: event.eventId, duplicate: !isNew }, { status: 202, code: 'ACCEPTED' });
  });

  router.post('/api/v1/webhooks/omnichannel', async (ctx) => {
    assertSigned(ctx);

    const event = validate(eventSchema, ctx.body);
    if (event.type === 'message.inbound' && !event.from) {
      throw Errors.validation([{ field: 'from', message: 'is required for inbound messages' }]);
    }

    const isNew = await cache.setIfAbsent(`wh:omni:${event.eventId}`, 1, DEDUPE_TTL_SEC);
    if (isNew) bus.publish(TYPE_TO_EVENT[event.type], event);

    ok(ctx, { eventId: event.eventId, duplicate: !isNew }, { status: 202, code: 'ACCEPTED' });
  });
}
