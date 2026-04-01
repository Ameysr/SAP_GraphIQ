import Groq from 'groq-sdk';
import OpenAI from 'openai';
import type { TierNumber, LLMProvider } from '../types/index.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? '';

let groqClient: Groq | null = null;
let deepseekClient: OpenAI | null = null;

// ── LLM CALL COUNTER + CREDIT BURN MONITORING ──
let totalLLMCalls = 0;
let totalTokensIn = 0;
let totalTokensOut = 0;

// Credit burn tracking
const ALERT_THRESHOLD_HOURLY = 50_000;  // tokens per hour
const ALERT_THRESHOLD_DAILY = 500_000;  // tokens per day
let hourlyTokens = 0;
let dailyTokens = 0;
let lastHourReset = Date.now();
let lastDayReset = Date.now();
let alertsSent = 0;

function trackCreditBurn(tokensUsed: number): void {
  const now = Date.now();
  
  // Reset hourly counter
  if (now - lastHourReset > 3600_000) {
    hourlyTokens = 0;
    lastHourReset = now;
  }
  // Reset daily counter
  if (now - lastDayReset > 86400_000) {
    dailyTokens = 0;
    lastDayReset = now;
    alertsSent = 0;
  }
  
  hourlyTokens += tokensUsed;
  dailyTokens += tokensUsed;
  
  if (hourlyTokens > ALERT_THRESHOLD_HOURLY && alertsSent < 5) {
    console.warn(`  ⚠️ [CreditAlert] Hourly token usage: ${hourlyTokens.toLocaleString()} (threshold: ${ALERT_THRESHOLD_HOURLY.toLocaleString()})`);
    alertsSent++;
  }
  if (dailyTokens > ALERT_THRESHOLD_DAILY && alertsSent < 10) {
    console.error(`  🚨 [CreditAlert] Daily token usage: ${dailyTokens.toLocaleString()} (threshold: ${ALERT_THRESHOLD_DAILY.toLocaleString()}) — consider pausing the service`);
    alertsSent++;
  }
}

export function getLLMStats() {
  return { 
    totalLLMCalls, 
    totalTokensIn, 
    totalTokensOut,
    hourlyTokens,
    dailyTokens,
    estimatedCostUSD: Math.round((totalTokensIn * 0.00015 + totalTokensOut * 0.0006) * 100) / 100,
  };
}

function getGroq(): Groq {
  if (!groqClient) groqClient = new Groq({ apiKey: GROQ_API_KEY });
  return groqClient;
}

function getDeepSeek(): OpenAI {
  if (!deepseekClient) {
    deepseekClient = new OpenAI({
      apiKey: DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com',
    });
  }
  return deepseekClient;
}

export interface LLMCallOptions {
  systemPrompt: string;
  userPrompt: string;
  tier: TierNumber;
  maxTokens?: number;
  callerTag?: string; // e.g. 'guardrail', 'intent', 'cypher-gen' — for logging
}

export interface LLMResponse {
  text: string;
  provider: LLMProvider;
  usedFallback: boolean;
  tokensIn?: number;
  tokensOut?: number;
}

const TIER_CONFIG: Record<TierNumber, { provider: LLMProvider; model: string }> = {
  1: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  2: { provider: 'deepseek', model: 'deepseek-chat' },
  3: { provider: 'deepseek', model: 'deepseek-reasoner' },
};

interface RawLLMResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

async function callGroq(systemPrompt: string, userPrompt: string, maxTokens: number): Promise<RawLLMResult> {
  const client = getGroq();
  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature: 0.1,
  });
  return {
    text: response.choices[0]?.message?.content ?? '',
    tokensIn: response.usage?.prompt_tokens ?? 0,
    tokensOut: response.usage?.completion_tokens ?? 0,
  };
}

async function callDeepSeek(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number
): Promise<RawLLMResult> {
  const client = getDeepSeek();

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    model === 'deepseek-reasoner'
      ? [{ role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }]
      : [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ];

  const response = await client.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
  });

  let text = response.choices[0]?.message?.content ?? '';

  // Strip <think>...</think> from Reasoner responses
  if (model === 'deepseek-reasoner') {
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }

  // Strip ```json``` fences
  text = text.replace(/^```json\s*/g, '').replace(/\s*```$/g, '').trim();

  return {
    text,
    tokensIn: response.usage?.prompt_tokens ?? 0,
    tokensOut: response.usage?.completion_tokens ?? 0,
  };
}

export async function callLLM(options: LLMCallOptions): Promise<LLMResponse> {
  const { systemPrompt, userPrompt, tier, maxTokens = 1000, callerTag = 'unknown' } = options;
  const config = TIER_CONFIG[tier];
  const callStart = Date.now();

  // ── LOG: What we're SENDING to LLM ──
  console.log(`\n  [LLM:${callerTag}] ▶ SENDING to ${config.provider}/${config.model} (tier ${tier}, max ${maxTokens} tokens)`);
  console.log(`  [LLM:${callerTag}]   System: ${systemPrompt.substring(0, 120)}...`);
  console.log(`  [LLM:${callerTag}]   User:   ${userPrompt.substring(0, 150)}${userPrompt.length > 150 ? '...' : ''}`);

  // Try primary provider
  try {
    let result: RawLLMResult;
    if (config.provider === 'groq') {
      result = await callGroq(systemPrompt, userPrompt, maxTokens);
    } else {
      result = await callDeepSeek(config.model, systemPrompt, userPrompt, maxTokens);
    }

    totalLLMCalls++;
    totalTokensIn += result.tokensIn;
    totalTokensOut += result.tokensOut;
    trackCreditBurn(result.tokensIn + result.tokensOut);
    const elapsed = Date.now() - callStart;

    // ── LOG: What we GOT BACK from LLM ──
    console.log(`  [LLM:${callerTag}] ◀ RECEIVED in ${elapsed}ms | tokens: ${result.tokensIn}→${result.tokensOut} | call #${totalLLMCalls}`);
    console.log(`  [LLM:${callerTag}]   Response: ${result.text.substring(0, 200)}${result.text.length > 200 ? '...' : ''}`);

    return { text: result.text, provider: config.provider, usedFallback: false, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
  } catch (err: unknown) {
    console.error(`  [LLM:${callerTag}] ✗ Primary ${config.provider} failed:`, err instanceof Error ? err.message : err);
  }

  // Fallback: if Groq failed → try DeepSeek chat, if DeepSeek failed → try Groq
  const fallbackProvider: LLMProvider = config.provider === 'groq' ? 'deepseek' : 'groq';
  try {
    let result: RawLLMResult;
    if (fallbackProvider === 'groq') {
      result = await callGroq(systemPrompt, userPrompt, maxTokens);
    } else {
      result = await callDeepSeek('deepseek-chat', systemPrompt, userPrompt, maxTokens);
    }

    totalLLMCalls++;
    totalTokensIn += result.tokensIn;
    totalTokensOut += result.tokensOut;
    trackCreditBurn(result.tokensIn + result.tokensOut);
    const elapsed = Date.now() - callStart;
    console.log(`  [LLM:${callerTag}] ◀ FALLBACK ${fallbackProvider} in ${elapsed}ms | tokens: ${result.tokensIn}→${result.tokensOut}`);
    console.log(`  [LLM:${callerTag}]   Response: ${result.text.substring(0, 200)}${result.text.length > 200 ? '...' : ''}`);

    return { text: result.text, provider: fallbackProvider, usedFallback: true, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
  } catch (err: unknown) {
    console.error(`  [LLM:${callerTag}] ✗ Fallback ${fallbackProvider} also failed:`, err instanceof Error ? err.message : err);
    throw new Error('LLM unavailable — please retry in a moment');
  }
}
