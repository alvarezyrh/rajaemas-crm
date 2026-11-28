import { createHmac } from 'node:crypto';
import { assertSafeUrl, FetchError } from '../integrations/fetcher.js';
import { safeEqual } from '../../security/crypto.js';

const RESPONSE_LIMIT = 64 * 1024;
const TIMEOUT_MS = 15_000;

export class MetaGatewayError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'MetaGatewayError';
    this.code = code;
    this.retryable = retryable;
  }
}

async function safeJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > RESPONSE_LIMIT) {
      throw new MetaGatewayError('META_RESPONSE_TOO_LARGE', 'Meta response was too large');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MetaGatewayError('META_INVALID_RESPONSE', 'Meta returned an invalid response');
  }
}

export function createMetaGateway({ config, fetchImpl = fetch, validateUrl = assertSafeUrl }) {
  const { accessToken, phoneNumberId, appSecret, webhookVerifyToken, graphApiVersion } = config;
  const senderConfigured = Boolean(accessToken && phoneNumberId);
  const webhookConfigured = Boolean(appSecret && webhookVerifyToken);

  return Object.freeze({
    isSenderConfigured: () => senderConfigured,
    isWebhookConfigured: () => webhookConfigured,

    verifyWebhook(mode, token) {
      return (
        webhookConfigured &&
        mode === 'subscribe' &&
        typeof token === 'string' &&
        safeEqual(webhookVerifyToken, token)
      );
    },

    verifySignature(rawBody, signature) {
      if (!webhookConfigured || typeof signature !== 'string') return false;
      const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
      return safeEqual(expected, signature);
    },

    async sendTemplate({ phone, templateName, languageCode, customerName }) {
      if (!senderConfigured) {
        throw new MetaGatewayError(
          'META_NOT_CONFIGURED',
          'Meta WhatsApp sending is not configured',
        );
      }

      const url = `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`;
      try {
        await validateUrl(url, { allowPrivateHosts: false });
      } catch (err) {
        if (err instanceof FetchError) {
          throw new MetaGatewayError('META_URL_UNSAFE', 'Meta endpoint validation failed');
        }
        throw err;
      }

      const template = { name: templateName, language: { code: languageCode } };
      if (customerName) {
        template.components = [
          {
            type: 'body',
            parameters: [{ type: 'text', text: customerName }],
          },
        ];
      }
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone.replace(/\D/g, ''),
            type: 'template',
            template,
          }),
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new MetaGatewayError(
          err.name === 'TimeoutError' ? 'META_TIMEOUT' : 'META_CONNECTION_FAILED',
          'Meta WhatsApp could not be reached',
          true,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        throw new MetaGatewayError('META_REDIRECT_REFUSED', 'Meta returned a redirect');
      }

      const payload = await safeJson(response);
      if (!response.ok) {
        const code = payload.error?.code;
        throw new MetaGatewayError(
          Number.isInteger(code) ? `META_${code}` : `META_HTTP_${response.status}`,
          'Meta rejected the WhatsApp template message',
          response.status === 429 || response.status >= 500,
        );
      }
      const messageId = payload.messages?.[0]?.id;
      if (typeof messageId !== 'string' || !messageId) {
        throw new MetaGatewayError('META_BAD_RESPONSE', 'Meta did not return a message ID');
      }
      return { messageId };
    },
  });
}
