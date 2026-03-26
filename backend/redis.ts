import { Redis } from 'ioredis';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    redis.on('error', (err: Error) => {
      console.error('[Redis] Connection error:', err.message);
    });

    redis.connect().catch((err: Error) => {
      console.error('[Redis] Failed to connect:', err.message);
    });
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
