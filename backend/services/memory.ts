import { getRedis } from '../redis.js';
import type { HistoryMessage, EntityMap } from '../types/index.js';

const MAX_MESSAGES = 10;
const HISTORY_TTL = 3600; // 1 hour
const ENTITY_TTL = 3600;
const MAX_ENTITY_TYPES = 3;

function historyKey(sessionId: string): string {
  return `memory:history:${sessionId}`;
}

function entityKey(sessionId: string): string {
  return `memory:entities:${sessionId}`;
}

export async function saveHistory(
  sessionId: string,
  userMsg: string,
  aiMsg: string
): Promise<void> {
  try {
    const redis = getRedis();
    const key = historyKey(sessionId);

    const messages: HistoryMessage[] = [
      { role: 'user', content: userMsg },
      { role: 'assistant', content: aiMsg },
    ];

    for (const msg of messages) {
      await redis.rpush(key, JSON.stringify(msg));
    }

    // Keep last MAX_MESSAGES
    const len = await redis.llen(key);
    if (len > MAX_MESSAGES) {
      await redis.ltrim(key, len - MAX_MESSAGES, -1);
    }

    await redis.expire(key, HISTORY_TTL);
  } catch (err: unknown) {
    console.error('[Memory] Save history failed:', err);
  }
}

export async function getHistory(sessionId: string): Promise<HistoryMessage[]> {
  try {
    const redis = getRedis();
    const raw = await redis.lrange(historyKey(sessionId), 0, -1);
    return raw.map((s: string) => JSON.parse(s) as HistoryMessage);
  } catch {
    return [];
  }
}

export async function saveEntities(
  sessionId: string,
  newEntities: EntityMap
): Promise<void> {
  try {
    const redis = getRedis();
    const key = entityKey(sessionId);

    // Load existing
    const existing = await getEntities(sessionId);

    // Last-wins per type
    const merged: EntityMap = { ...existing, ...newEntities };

    // Keep only MAX_ENTITY_TYPES (most recently added)
    const entries = Object.entries(merged).filter(([, v]) => v !== undefined);
    const trimmed: EntityMap = {};
    const recentEntries = entries.slice(-MAX_ENTITY_TYPES);
    for (const [k, v] of recentEntries) {
      trimmed[k] = v;
    }

    await redis.set(key, JSON.stringify(trimmed), 'EX', ENTITY_TTL);
  } catch (err: unknown) {
    console.error('[Memory] Save entities failed:', err);
  }
}

export async function getEntities(sessionId: string): Promise<EntityMap> {
  try {
    const redis = getRedis();
    const raw = await redis.get(entityKey(sessionId));
    if (!raw) return {};
    return JSON.parse(raw) as EntityMap;
  } catch {
    return {};
  }
}
