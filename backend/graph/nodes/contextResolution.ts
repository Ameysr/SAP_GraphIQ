import type { O2CGraphState } from '../state.js';

export async function contextResolution(
  state: O2CGraphState
): Promise<Partial<O2CGraphState>> {
  const msg = state.userMessage;
  const entities = state.entities;

  // Only resolve pronouns if:
  // 1. The message is short (likely a follow-up like "show me its details")
  // 2. Contains explicit pronoun patterns like "that order" or "show it"
  // Do NOT replace "that" when used as a relative pronoun ("documents that were...")

  let resolved = msg;

  // Only attempt resolution for short follow-up messages (< 50 chars)
  // Long, self-contained questions should not have entities injected
  if (msg.length < 50) {
    const replacements: Array<{ pattern: RegExp; value: string | undefined }> = [
      { pattern: /\bthat order\b/gi, value: entities.SalesOrder },
      { pattern: /\bthat customer\b/gi, value: entities.Customer },
      { pattern: /\bthat delivery\b/gi, value: entities.DeliveryHeader },
      { pattern: /\bthat billing\b/gi, value: entities.BillingHeader },
      { pattern: /\bthat invoice\b/gi, value: entities.BillingHeader },
      { pattern: /\bthe same order\b/gi, value: entities.SalesOrder },
      { pattern: /\bthe same customer\b/gi, value: entities.Customer },
    ];

    for (const { pattern, value } of replacements) {
      if (value && pattern.test(resolved)) {
        resolved = resolved.replace(pattern, value);
      }
    }
  }

  return { resolvedMessage: resolved };
}
