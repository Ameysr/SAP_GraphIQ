import { getRedis } from '../redis.js';
import { getLocalEmbedding } from './embedding.js';
import crypto from 'crypto';

const CACHE_TTL = 86400; // 24 hours
const SIMILARITY_THRESHOLD = 0.85; // Lowered slightly for domain-vocab vectors
const SEMCACHE_SCAN_KEYS = parseInt(process.env.SEMCACHE_SCAN_KEYS ?? '200', 10);
const SEMCACHE_VERSION = process.env.SEMCACHE_VERSION ?? 'v2';
const SEMCACHE_INDEX_KEY = `semcache:index:${SEMCACHE_VERSION}`;

function hashKey(text: string): string {
  const payload = `${SEMCACHE_VERSION}|` + text.toLowerCase().trim();
  return 'semcache:' + crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export async function saveToCache(question: string, answer: string): Promise<void> {
  try {
    // Important: keep semantic cache free-tier friendly.
    // Local embedding only (no LLM fingerprinting).
    const embedding = getLocalEmbedding(question);
    const hasSignal = embedding.some(v => v > 0);
    if (!hasSignal) {
      console.log('  [SemanticCache] Skip save — no embedding');
      return;
    }

    const redis = getRedis();
    const key = hashKey(question);

    await redis.set(
      key,
      JSON.stringify({ question, answer, embedding }),
      'EX',
      CACHE_TTL
    );

    // Also add key to index set for scanning
    await redis.sadd(SEMCACHE_INDEX_KEY, key);
    console.log(`  [SemanticCache] Saved: "${question.substring(0, 50)}..."`);
    
  } catch (err: unknown) {
    console.error('[SemanticCache] Save failed:', err);
  }
}

export async function checkCache(question: string): Promise<string | null> {
  try {
    // Important: keep semantic cache free-tier friendly.
    // Local embedding only (no LLM fingerprinting).
    const queryEmbedding = getLocalEmbedding(question);
    const hasSignal = queryEmbedding.some(v => v > 0);
    if (!hasSignal) {
      console.log('  [SemanticCache] MISS — no embedding');
      return null;
    }

    const redis = getRedis();

    // Check exact hash first
    const exactKey = hashKey(question);
    const exact = await redis.get(exactKey);
    if (exact) {
      const parsed = JSON.parse(exact) as { answer: string };
      console.log('  [SemanticCache] HIT (exact match)');
      return parsed.answer;
    }

    // Scan cached embeddings for semantic similarity.
    // Performance: never iterate the full index set (can grow unbounded).
    // Using SRANDMEMBER gives a bounded approximation while keeping latency stable.
    const keysRaw = await redis.srandmember(SEMCACHE_INDEX_KEY, SEMCACHE_SCAN_KEYS);
    const keys = Array.isArray(keysRaw) ? keysRaw : keysRaw ? [keysRaw] : [];
    let bestSim = 0;
    let bestAnswer: string | null = null;
    let bestQuestion = '';
    
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) {
        await redis.srem(SEMCACHE_INDEX_KEY, key);
        continue;
      }

      const parsed = JSON.parse(raw) as { question: string; answer: string; embedding: number[] };
      const sim = cosineSimilarity(queryEmbedding, parsed.embedding);

      if (sim > bestSim) {
        bestSim = sim;
        bestAnswer = parsed.answer;
        bestQuestion = parsed.question;
      }
    }

    if (bestSim >= SIMILARITY_THRESHOLD && bestAnswer) {
      console.log(`  [SemanticCache] HIT (similarity: ${bestSim.toFixed(3)}, matched: "${bestQuestion.substring(0, 40)}...")`);
      return bestAnswer;
    }

    console.log(`  [SemanticCache] MISS (best similarity: ${bestSim.toFixed(3)}, threshold: ${SIMILARITY_THRESHOLD})`);
    return null;
  } catch (err: unknown) {
    console.error('[SemanticCache] Check failed:', err);
    return null;
  }
}
