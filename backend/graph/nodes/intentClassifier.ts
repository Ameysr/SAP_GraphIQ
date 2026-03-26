import type { O2CGraphState } from '../state.js';
import type { IntentType } from '../../types/index.js';
import { callLLM } from '../../services/llm.js';

export async function intentClassifier(
  state: O2CGraphState
): Promise<Partial<O2CGraphState>> {
  const msg = state.resolvedMessage.toLowerCase();

  // Step 1: Keyword rules (no LLM cost)
  const rules: Array<{ keywords: string[]; intent: IntentType }> = [
    {
      keywords: ['broken', 'missing', 'not billed', 'unpaid', 'incomplete', 'no delivery', 'cancelled', 'not paid', 'undelivered', 'unbilled'],
      intent: 'DETECT',
    },
    {
      keywords: ['trace', 'flow', 'path', 'end to end', 'full journey', 'from order to', 'follow', 'chain', 'lifecycle'],
      intent: 'TRAVERSE',
    },
    {
      keywords: ['top', 'most', 'count', 'how many', 'highest', 'lowest', 'rank', 'best', 'worst', 'total', 'sum', 'average'],
      intent: 'AGGREGATE',
    },
    {
      keywords: ['compare', 'vs', 'versus', 'difference between', 'which is better'],
      intent: 'COMPARE',
    },
    {
      keywords: ['show', 'get', 'what is', 'find me', 'tell me about', 'details of', 'look up', 'who is', 'what are', 'describe'],
      intent: 'LOOKUP',
    },
  ];

  for (const rule of rules) {
    if (rule.keywords.some((kw) => msg.includes(kw))) {
      const result: Partial<O2CGraphState> = { intentType: rule.intent };
      if (rule.intent === 'COMPARE') {
        result.pathTaken = 'template';
      }
      return result;
    }
  }

  // Step 2: LLM classification (only if no keyword match)
  try {
    const response = await callLLM({
      systemPrompt: 'Classify the user question into exactly one category: LOOKUP, TRAVERSE, AGGREGATE, DETECT, COMPARE, UNKNOWN. Reply with ONLY the category name, nothing else.',
      userPrompt: `Question: "${state.resolvedMessage}"`,
      tier: 1,
      maxTokens: 20,
      callerTag: 'intent-classifier',
    });

    const cleaned = response.text.trim().toUpperCase() as IntentType;
    const valid: IntentType[] = ['LOOKUP', 'TRAVERSE', 'AGGREGATE', 'DETECT', 'COMPARE', 'UNKNOWN'];

    if (valid.includes(cleaned)) {
      const result: Partial<O2CGraphState> = {
        intentType: cleaned,
        usedFallback: response.usedFallback,
      };
      if (cleaned === 'COMPARE') result.pathTaken = 'template';
      if (cleaned === 'UNKNOWN') result.pathTaken = 'constrained';
      return result;
    }

    return { intentType: 'UNKNOWN', pathTaken: 'constrained' };
  } catch {
    return { intentType: 'UNKNOWN', pathTaken: 'constrained' };
  }
}
