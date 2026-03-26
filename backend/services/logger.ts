import { getRedis } from '../redis.js';
import type { ObservabilityLog } from '../types/index.js';

const LOG_KEY = 'observability_logs';
const MAX_ENTRIES = 500;

export async function log(data: ObservabilityLog): Promise<void> {
  try {
    const redis = getRedis();
    await redis.lpush(LOG_KEY, JSON.stringify(data));
    await redis.ltrim(LOG_KEY, 0, MAX_ENTRIES - 1);
  } catch (err: unknown) {
    console.error('[Logger] Failed to write log:', err);
  }
}

export async function getLogs(): Promise<ObservabilityLog[]> {
  try {
    const redis = getRedis();
    const raw = await redis.lrange(LOG_KEY, 0, MAX_ENTRIES - 1);
    return raw.map((s: string) => JSON.parse(s) as ObservabilityLog);
  } catch {
    return [];
  }
}
