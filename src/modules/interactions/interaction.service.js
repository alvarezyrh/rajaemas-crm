const SUMMARY_MAX = 500;
const truncate = (text) =>
  text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;

export function createInteractionService({ uow, customers, blindIndex, logger }) {
  return Object.freeze({
    /** Manual entry by staff (phone call, visit, …). */
    async log(actor, customerId, input) {
      await customers.requireVisible(actor, customerId);
      return uow.run(async ({ interactions, audit }) => {
        const id = await interactions.insert({
          customerId,
          branchId: actor.branchId,
          channel: input.channel,
          direction: input.direction,
          summary: truncate(input.summary),
          handledBy: actor.id,
        });
        await audit.append({
          actor,
          action: 'INTERACTION_LOGGED',
          entityType: 'customer',
          entityId: customerId,
          diff: { interactionId: id, channel: input.channel },
        });
        return { id };
      });
    },

    /** Handles inbound messages from the omnichannel webhook (asynchronous). */
    async recordInboundMessage(event) {
      const customerId = await uow.repos.customers.findIdByPhoneHash(
        blindIndex('phone', event.from),
      );
      if (!customerId) {
        logger.info('omnichannel.unknown_sender', {
          eventId: event.eventId,
          channel: event.channel,
        });
        return;
      }
      await uow.repos.interactions.insert({
        customerId,
        channel: event.channel,
        direction: 'INBOUND',
        summary: truncate(event.text ?? '(message without text)'),
        externalRef: event.messageId ?? event.eventId,
        occurredAt: event.occurredAt,
      });
    },
  });
}
