import { getRedis } from '../redis.js';
import type { LLMProvider } from '../types/index.js';

const FAILURE_WINDOW = 60; // seconds
const THRESHOLD = 3;
const COOLDOWN = 300; // 5 minutes

function failureKey(provider: LLMProvider): string {
  return `cb:failures:${provider}`;
}

function downKey(provider: LLMProvider): string {
  return `cb:down:${provider}`;
}

export async function getStatus(provider: LLMProvider): Promise<'UP' | 'DOWN'> {
  try {
    const redis = getRedis();
    const isDown = await redis.get(downKey(provider));
    return isDown ? 'DOWN' : 'UP';
  } catch {
    return 'UP'; // fail open
  }
}

export async function recordFailure(provider: LLMProvider): Promise<void> {
  try {
    const redis = getRedis();
    const key = failureKey(provider);
    const now = Date.now();

    await redis.rpush(key, String(now));
    await redis.expire(key, FAILURE_WINDOW);

    // Count recent failures
    const all = await redis.lrange(key, 0, -1);
    const cutoff = now - FAILURE_WINDOW * 1000;
    const recentCount = all.filter((ts: string) => Number(ts) > cutoff).length;

    if (recentCount >= THRESHOLD) {
      await redis.set(downKey(provider), '1', 'EX', COOLDOWN);
      console.warn(`[CircuitBreaker] ${provider} is now DOWN for ${COOLDOWN}s`);
    }
  } catch (err: unknown) {
    console.error('[CircuitBreaker] Error recording failure:', err);
  }
}
