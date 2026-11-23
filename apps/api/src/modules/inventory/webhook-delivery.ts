import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';

export function publicAddress(address: string): boolean {
  return ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';
}

export function webhookUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !hostname ||
    (ipaddr.isValid(hostname)
      ? !publicAddress(hostname)
      : !hostname.includes('.') || /(?:^|\.)(localhost|local|internal|home|lan)$/i.test(hostname))
  )
    throw new Error('Enter a public HTTPS webhook URL');
  return url;
}

export function webhookPayload(
  provider: string,
  event: string,
  title: string,
  text: string,
  channel?: string | null,
  botname?: string | null,
) {
  const plain = `${title}\n${text}`;
  switch (provider) {
    case 'slack':
      return {
        text: plain.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        ...(channel ? { channel } : {}),
        ...(botname ? { username: botname } : {}),
      };
    case 'google':
      return { text: plain };
    case 'microsoft':
      return {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            contentUrl: null,
            content: {
              type: 'AdaptiveCard',
              version: '1.2',
              body: [
                { type: 'TextBlock', text: title, weight: 'Bolder', wrap: true },
                { type: 'TextBlock', text, wrap: true },
              ],
            },
          },
        ],
      };
    default:
      return { event, title, message: text };
  }
}

export async function postWebhook(endpoint: string, payload: unknown, deliveryId: string) {
  const url = webhookUrl(endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  const first = addresses[0];
  if (!first || addresses.some(({ address }) => !publicAddress(address)))
    throw new Error('Webhook destination unavailable');
  const body = JSON.stringify(payload);
  await new Promise<void>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        family: first.family,
        agent: false,
        timeout: 8000,
        lookup: (_host, _options, callback) => callback(null, first.address, first.family),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Idempotency-Key': deliveryId,
        },
      },
      (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300)
          resolve();
        else reject(new Error('Webhook rejected the delivery'));
      },
    );
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('Webhook delivery timed out')));
    req.end(body);
  });
}
