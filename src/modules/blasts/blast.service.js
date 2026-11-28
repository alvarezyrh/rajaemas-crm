import { Errors } from '../../core/errors.js';
import { PII_CONTEXT } from '../customers/customer.service.js';
import { normalizeIndonesianPhone } from '../../shared/phone.js';

const CHANNELS = new Set(['STORE', 'MOBILE_APP', 'ECOMMERCE', 'MULTI', 'NONE']);
const OPT_OUT_WORDS = new Set(['STOP', 'UNSUBSCRIBE', 'CANCEL', 'BERHENTI']);

export function normalizeCriteria(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Errors.validation([{ field: 'criteria', message: 'must be an object' }]);
  }
  const allowed = new Set(['city', 'tierCode', 'channels', 'lastTransactionDays']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw Errors.validation(
      unknown.map((field) => ({
        field: `criteria.${field}`,
        message: 'is not supported',
      })),
    );
  }
  const criteria = {};
  if (input.city !== undefined && input.city !== '') {
    if (typeof input.city !== 'string' || input.city.trim().length > 100) {
      throw Errors.validation([
        {
          field: 'criteria.city',
          message: 'must be text up to 100 characters',
        },
      ]);
    }
    criteria.city = input.city.trim();
  }
  if (input.tierCode !== undefined && input.tierCode !== '') {
    if (typeof input.tierCode !== 'string' || !/^[a-z0-9_-]{1,16}$/i.test(input.tierCode)) {
      throw Errors.validation([{ field: 'criteria.tierCode', message: 'is invalid' }]);
    }
    criteria.tierCode = input.tierCode;
  }
  if (input.channels !== undefined) {
    if (
      !Array.isArray(input.channels) ||
      input.channels.length > CHANNELS.size ||
      input.channels.some((channel) => !CHANNELS.has(channel))
    ) {
      throw Errors.validation([
        { field: 'criteria.channels', message: 'contains an invalid segment' },
      ]);
    }
    criteria.channels = [...new Set(input.channels)];
  }
  if (input.lastTransactionDays !== undefined && input.lastTransactionDays !== '') {
    const days = Number(input.lastTransactionDays);
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
      throw Errors.validation([
        {
          field: 'criteria.lastTransactionDays',
          message: 'must be an integer from 1 to 3650',
        },
      ]);
    }
    criteria.lastTransactionDays = days;
  }
  return criteria;
}

function assertCampaignInput(input) {
  const errors = [];
  if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.length > 120) {
    errors.push({
      field: 'name',
      message: 'must be text between 2 and 120 characters',
    });
  }
  if (typeof input.templateName !== 'string' || !/^[a-z0-9_]{1,512}$/.test(input.templateName)) {
    errors.push({
      field: 'templateName',
      message: 'must be a valid approved Meta template name',
    });
  }
  if (
    typeof input.languageCode !== 'string' ||
    !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(input.languageCode)
  ) {
    errors.push({
      field: 'languageCode',
      message: 'must be a valid template language code',
    });
  }
  if (input.personalizeName !== undefined && typeof input.personalizeName !== 'boolean') {
    errors.push({ field: 'personalizeName', message: 'must be true or false' });
  }
  if (errors.length) throw Errors.validation(errors);
  return {
    name: input.name.trim(),
    templateName: input.templateName,
    languageCode: input.languageCode,
    personalizeName: input.personalizeName === true,
    criteria: normalizeCriteria(input.criteria),
  };
}

function optOutMessage(message) {
  if (typeof message !== 'string') return false;
  const command = message
    .trim()
    .toUpperCase()
    .replace(/[.!]+$/g, '');
  return OPT_OUT_WORDS.has(command);
}

export function createBlastService({ uow, pii, blindIndex, gateway, logger }) {
  async function hasPendingWork() {
    const snapshot = await uow.repos.blasts.workSnapshot();
    return snapshot.hasPendingWork;
  }

  async function updateDeliveryStatus(messageId, status) {
    const normalizedStatus = {
      sent: 'SENT',
      delivered: 'DELIVERED',
      read: 'READ',
      failed: 'FAILED',
    }[status];
    if (!normalizedStatus || typeof messageId !== 'string' || messageId.length > 160) return false;
    return uow.repos.blasts.updateProviderStatus(messageId, normalizedStatus);
  }

  async function processOptOut(phoneInput, message) {
    if (!optOutMessage(message)) return false;
    const phone = normalizeIndonesianPhone(phoneInput);
    if (!phone) return false;
    const phoneHash = blindIndex('phone', phone);
    return uow.run(async ({ customers, audit }) => {
      const customerId = await customers.findIdByPhoneHash(phoneHash);
      if (!customerId) return false;
      const changed = await customers.update(customerId, { marketingConsent: false });
      if (changed) {
        await audit.append({
          actor: { id: null, requestId: 'meta-whatsapp-webhook', ip: null },
          action: 'MARKETING_CONSENT_REVOKED',
          entityType: 'customer',
          entityId: customerId,
          diff: { source: 'meta_whatsapp_opt_out' },
        });
      }
      return changed;
    });
  }

  return Object.freeze({
    hasPendingWork,

    async preview(criteria) {
      return {
        eligibleCustomers: await uow.repos.blasts.countEligible(normalizeCriteria(criteria)),
      };
    },

    list() {
      return uow.repos.blasts.list();
    },

    async create(actor, rawInput) {
      const input = assertCampaignInput(rawInput);
      return uow.run(async ({ blasts, audit }) => {
        const id = await blasts.createDraft(input, actor.id);
        await audit.append({
          actor,
          action: 'BLAST_DRAFT_CREATED',
          entityType: 'dynamic_blast',
          entityId: id,
          diff: {
            name: input.name,
            templateName: input.templateName,
            criteria: input.criteria,
          },
        });
        return blasts.findById(id);
      });
    },

    async schedule(actor, id, scheduledAt) {
      if (!gateway.isSenderConfigured()) {
        throw Errors.notImplemented('Meta WhatsApp sending is not configured on this server');
      }
      const when = new Date(scheduledAt);
      if (
        typeof scheduledAt !== 'string' ||
        !/(?:Z|[+-]\d{2}:\d{2})$/i.test(scheduledAt) ||
        !Number.isFinite(when.getTime()) ||
        when.getTime() <= Date.now()
      ) {
        throw Errors.validation([
          { field: 'scheduledAt', message: 'must be a future date and time' },
        ]);
      }
      return uow.run(async ({ blasts, audit }) => {
        const draft = await blasts.findById(id);
        if (!draft) throw Errors.notFound('Blast');
        if (draft.status !== 'DRAFT') throw Errors.conflict('Only a draft blast can be scheduled');
        const count = await blasts.countEligible(draft.criteria);
        if (count === 0)
          throw Errors.conflict('No customers currently match this consented audience');
        const scheduled = await blasts.schedule(id, when.toISOString(), draft.criteria);
        if (!scheduled) throw Errors.conflict('Blast could not be scheduled');
        await audit.append({
          actor,
          action: 'BLAST_SCHEDULED',
          entityType: 'dynamic_blast',
          entityId: id,
          diff: { scheduledAt: when.toISOString(), eligibleCustomers: count },
        });
        return blasts.findById(id);
      });
    },

    async cancel(actor, id) {
      return uow.run(async ({ blasts, audit }) => {
        const blast = await blasts.findById(id);
        if (!blast) throw Errors.notFound('Blast');
        if (!['DRAFT', 'SCHEDULED'].includes(blast.status)) {
          throw Errors.conflict('Only draft or scheduled blasts can be cancelled');
        }
        await blasts.cancel(id);
        await audit.append({
          actor,
          action: 'BLAST_CANCELLED',
          entityType: 'dynamic_blast',
          entityId: id,
          diff: { previousStatus: blast.status },
        });
        return blasts.findById(id);
      });
    },

    async runScheduled() {
      if (!(await hasPendingWork())) return { processed: 0 };
      if (!gateway.isSenderConfigured()) {
        throw Errors.unavailable('Meta WhatsApp sending is not configured');
      }
      await uow.run(async ({ blasts }) => {
        await blasts.claimDue();
        await blasts.failInterruptedRecipients();
      });

      const runs = await uow.repos.blasts.activeRuns();
      let processed = 0;
      for (const run of runs) {
        await uow.run(async ({ blasts }) => {
          await blasts.skipRevokedQueued(run.blast_id);
        });
        const recipients = await uow.run(({ blasts }) =>
          blasts.claimQueued(run.blast_id, run.blast_run_id, 25),
        );
        for (const recipient of recipients) {
          try {
            const consented = await uow.repos.blasts.isConsented(recipient.customerId);
            if (!consented) {
              await uow.repos.blasts.markSkipped(recipient.id);
              processed += 1;
              continue;
            }
            const phone = pii.decrypt(recipient.phoneEncrypted, PII_CONTEXT.phone);
            const response = await gateway.sendTemplate({
              phone,
              templateName: run.template_name,
              languageCode: run.language_code,
              customerName: run.personalize_name ? recipient.fullName.trim().split(/\s+/)[0] : null,
            });
            await uow.repos.blasts.markSent(recipient.id, response.messageId);
          } catch (err) {
            const code = typeof err.code === 'string' ? err.code.slice(0, 80) : 'SEND_FAILED';
            await uow.repos.blasts.markFailed(recipient.id, code);
            logger.error('blast.recipient_failed', {
              blastId: run.blast_id,
              recipientId: recipient.id,
              code,
            });
          }
          processed += 1;
        }
        await uow.run(({ blasts }) => blasts.finishIfDrained(run.blast_id, run.blast_run_id));
      }
      return { processed };
    },

    updateDeliveryStatus,
    processOptOut,

    async handleWebhook(payload) {
      if (!payload || !Array.isArray(payload.entry)) {
        throw Errors.badRequest('Invalid Meta webhook payload');
      }
      let updates = 0;
      let optOuts = 0;
      for (const entry of payload?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          const value = change?.value;
          for (const status of value?.statuses ?? []) {
            if (await updateDeliveryStatus(status.id, status.status)) updates += 1;
          }
          for (const message of value?.messages ?? []) {
            const body =
              message.text?.body ??
              message.button?.text ??
              message.interactive?.button_reply?.title ??
              message.interactive?.list_reply?.title;
            if (await processOptOut(message.from, body)) optOuts += 1;
          }
        }
      }
      return { updates, optOuts };
    },
  });
}
