import type { UpstashClient } from './client.js';

const PRO_WAITLIST_SET = 'pro:waitlist';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Add an email to the Pro monthly waitlist (Redis SET `pro:waitlist`).
 * Normalizes to lowercase; idempotent for the same address.
 */
export async function addToWaitlist(client: UpstashClient, email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new Error('Invalid email');
  await client.command(['SADD', PRO_WAITLIST_SET, e]);
}
