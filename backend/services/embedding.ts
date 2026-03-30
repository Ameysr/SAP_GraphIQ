// ── EMBEDDING SERVICE ─────────────────────────────────────────────────────────
// Dual-mode: Uses Xenova/transformers (all-MiniLM-L6-v2) for real semantic
// embeddings with automatic fallback to enhanced TF-IDF if model load fails.

import Groq from 'groq-sdk';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

let groqClient: Groq | null = null;

function getGroq(): Groq {
  if (!groqClient) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY ?? '' });
  return groqClient;
}

// ── REAL SEMANTIC EMBEDDINGS (all-MiniLM-L6-v2 via ONNX) ──────────────────────
// 384-dimensional vectors with actual semantic understanding.
// Model is ~23MB, auto-downloaded on first use, cached locally.

let transformerPipeline: any = null;
let transformerLoadFailed = false;
let transformerLoading: Promise<void> | null = null;

async function loadTransformerModel(): Promise<void> {
  if (transformerPipeline || transformerLoadFailed) return;
  if (transformerLoading) {
    await transformerLoading;
    return;
  }

  transformerLoading = (async () => {
    try {
      // ── PRE-CHECK: Can onnxruntime-node load on this platform? ──
      // On Alpine Linux (musl libc), onnxruntime-node requires glibc's dynamic
      // linker (ld-linux-x86-64.so.2) which doesn't exist. The native .node
      // binary loading crashes the process with ERR_DLOPEN_FAILED BEFORE any
      // try-catch can intercept it.
      // Solution: check if we're on a glibc-incompatible system first.
      if (process.platform === 'linux') {
        const fs = await import('fs');
        const glibcLoader = '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2';
        const glibcLoader2 = '/lib64/ld-linux-x86-64.so.2';
        const hasGlibc = fs.existsSync(glibcLoader) || fs.existsSync(glibcLoader2);
        if (!hasGlibc) {
          // Check if we're on Alpine (musl-based)
          const isMusl = fs.existsSync('/etc/alpine-release') ||
            (fs.existsSync('/lib/ld-musl-x86_64.so.1'));
          if (isMusl || !hasGlibc) {
            console.log('  [Embedding] Platform lacks glibc (Alpine/musl detected) — onnxruntime-node incompatible');
            console.log('  [Embedding] Falling back to enhanced TF-IDF embeddings');
            transformerLoadFailed = true;
            return;
          }
        }
      }

      console.log('  [Embedding] Loading all-MiniLM-L6-v2 model...');
      // Dynamic import since @xenova/transformers is ESM-first
      const { pipeline } = await import('@xenova/transformers');
      transformerPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true, // Use quantized model for faster load + smaller footprint
      });
      console.log('  [Embedding] ✓ Model loaded — semantic embeddings active');
    } catch (err) {
      console.error('  [Embedding] ✗ Model load failed, falling back to enhanced TF-IDF:', (err as Error).message?.substring(0, 80));
      transformerLoadFailed = true;
    }
  })();
  await transformerLoading;
}

/**
 * Generate a real 384-dim semantic embedding using sentence-transformers.
 * Returns null if the model hasn't loaded yet (first call triggers async load).
 */
async function getTransformerEmbedding(text: string): Promise<number[] | null> {
  if (transformerLoadFailed) return null;
  if (!transformerPipeline) {
    // Trigger load but don't block — return null this time, next call will have it
    loadTransformerModel().catch(() => {});
    return null;
  }

  try {
    const output = await transformerPipeline(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  } catch (err) {
    console.error('  [Embedding] Transformer inference failed:', (err as Error).message?.substring(0, 60));
    return null;
  }
}

// ── ENHANCED TF-IDF EMBEDDING (fallback) ──────────────────────────────────────
// SAP O2C domain vocabulary — each word maps to a dimension
const VOCAB: string[] = [
  'customer', 'order', 'sales', 'delivery', 'billing', 'invoice', 'payment',
  'product', 'material', 'plant', 'revenue', 'amount', 'total', 'net',
  'cancel', 'blocked', 'unpaid', 'outstanding', 'overdue', 'anomaly',
  'trace', 'journey', 'cycle', 'days', 'duration', 'time',
  'top', 'highest', 'lowest', 'most', 'least', 'count', 'number',
  'compare', 'versus', 'between', 'difference',
  'delivered', 'billed', 'paid', 'posted', 'fulfilled',
  'document', 'header', 'item', 'line',
  'concentration', 'risk', 'report', 'summary', 'analysis',
  'journal', 'entry', 'accounting', 'fi', 'gap',
  'distinct', 'unique', 'group', 'aggregate',
  'who', 'which', 'what', 'how', 'many', 'much',
  'never', 'without', 'not', 'no', 'missing',
  // Financial & AR terms
  'dso', 'receivable', 'credit', 'exposure', 'aging', 'bucket', 'debit',
  'currency', 'inr', 'clearing', 'collection', 'late', 'overdue',
  // Process terms
  'fulfillment', 'rate', 'percentage', 'breakdown', 'distribution',
  'status', 'type', 'category', 'classification',
  // SAP terms
  'organization', 'channel', 'incoterms', 'schedule', 'warehouse',
  'profit', 'center', 'cost', 'fiscal', 'year', 'quarter', 'month',
  'expensive', 'cheap', 'average', 'median', 'rank',
];

// Synonyms map for better matching
const SYNONYMS: Record<string, string> = {
  'money': 'amount', 'owed': 'unpaid', 'owe': 'unpaid',
  'received': 'paid', 'shipped': 'delivered', 'sent': 'delivered',
  'stuff': 'product', 'things': 'product', 'goods': 'product',
  'bill': 'billing', 'inv': 'invoice', 'doc': 'document',
  'biggest': 'highest', 'largest': 'highest', 'smallest': 'lowest',
  'richest': 'highest', 'costliest': 'highest', 'cheapest': 'lowest',
  'track': 'trace', 'follow': 'trace', 'path': 'journey',
  'buyer': 'customer', 'client': 'customer', 'vendor': 'customer',
  'so': 'order', 'po': 'order',
  'cancelled': 'cancel', 'reversed': 'cancel', 'voided': 'cancel',
  'problems': 'anomaly', 'issues': 'anomaly', 'exceptions': 'anomaly',
  'audit': 'report', 'health': 'report', 'check': 'report',
  // Financial synonyms
  'income': 'revenue', 'earnings': 'revenue', 'proceeds': 'revenue', 'turnover': 'revenue',
  'debt': 'outstanding', 'receivables': 'receivable', 'ar': 'receivable',
  'payout': 'payment', 'remittance': 'payment', 'settlement': 'clearing',
  'factory': 'plant', 'facility': 'plant', 'warehouse': 'plant', 'location': 'plant',
  // Process synonyms
  'completion': 'fulfillment', 'fill': 'fulfillment',
  'delay': 'late', 'delayed': 'late', 'slow': 'late',
  'open': 'outstanding', 'pending': 'outstanding',
  'types': 'type', 'kinds': 'type', 'categories': 'category',
  'expensive': 'expensive', 'costly': 'expensive', 'pricey': 'expensive',
  'cheap': 'cheap', 'low cost': 'cheap', 'inexpensive': 'cheap',
  'rapid': 'fast', 'quick': 'fast', 'speedy': 'fast',
};

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1)
    .map(w => SYNONYMS[w] || w);
}

export function getLocalEmbedding(text: string): number[] {
  const tokens = tokenize(text);
  const vec = new Array(VOCAB.length).fill(0);

  for (const token of tokens) {
    const idx = VOCAB.indexOf(token);
    if (idx >= 0) {
      vec[idx] += 1;
    }
    // Partial match (e.g. "deliveries" matches "delivery")
    for (let i = 0; i < VOCAB.length; i++) {
      if (token.startsWith(VOCAB[i]) || VOCAB[i].startsWith(token)) {
        vec[i] += 0.5;
      }
    }
  }

  // Normalize to unit vector
  const mag = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
  if (mag === 0) return vec;
  return vec.map((v: number) => v / mag);
}

// ── SEMANTIC EMBEDDING: Try transformer first, fall back to TF-IDF ────────────
// This is the PRIMARY embedding function used by questionPlans and GraphRAG.
// It produces 384-dim vectors when the model is loaded, or falls back to VOCAB-dim.

let semanticEmbeddingCache = new Map<string, number[]>();
const SEMANTIC_CACHE_MAX = 500;

export async function getSemanticEmbedding(text: string): Promise<number[]> {
  const key = text.trim().toLowerCase();
  const cached = semanticEmbeddingCache.get(key);
  if (cached) return cached;

  // Try real transformer embedding first
  const transformerEmb = await getTransformerEmbedding(text);
  if (transformerEmb) {
    semanticEmbeddingCache.set(key, transformerEmb);
    if (semanticEmbeddingCache.size > SEMANTIC_CACHE_MAX) {
      const oldestKey = semanticEmbeddingCache.keys().next().value as string | undefined;
      if (oldestKey) semanticEmbeddingCache.delete(oldestKey);
    }
    return transformerEmb;
  }

  // Fallback to local TF-IDF
  const localEmb = getLocalEmbedding(text);
  semanticEmbeddingCache.set(key, localEmb);
  return localEmb;
}

/**
 * Synchronous embedding — always uses local TF-IDF.
 * Used in hot paths where async isn't feasible (initial library embedding).
 */
export function getLocalEmbeddingSync(text: string): number[] {
  return getLocalEmbedding(text);
}

/**
 * Initialize the transformer model eagerly.
 * Call this at server startup so the model is ready before first query.
 */
export async function initEmbeddings(): Promise<void> {
  await loadTransformerModel();
}

/**
 * Check if semantic (transformer) embeddings are available.
 */
export function isSemanticReady(): boolean {
  return !!transformerPipeline && !transformerLoadFailed;
}

// ── GROQ-POWERED SEMANTIC FINGERPRINT (legacy, kept as option) ───────────────
let groqEmbeddingEnabled = (process.env.GROQ_EMBEDDING_ENABLED ?? 'false').toLowerCase() === 'true';
let groqFailCount = 0;

async function getGroqFingerprint(text: string): Promise<number[] | null> {
  if (!groqEmbeddingEnabled || !process.env.GROQ_API_KEY) return null;

  try {
    const client = getGroq();
    const response = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Extract exactly 10 key concepts from this SAP O2C question. Reply with ONLY a JSON array of lowercase single words. Example: ["customer","revenue","top","billing","compare"]`,
        },
        { role: 'user', content: text },
      ],
      max_tokens: 50,
      temperature: 0,
    });

    const conceptsText = response.choices[0]?.message?.content ?? '[]';
    const concepts = JSON.parse(conceptsText.replace(/```json\s*/g, '').replace(/\s*```/g, '')) as string[];
    
    // Convert concepts to embedding using VOCAB
    const vec = new Array(VOCAB.length).fill(0);
    for (const concept of concepts) {
      const mapped = SYNONYMS[concept] || concept;
      const idx = VOCAB.indexOf(mapped);
      if (idx >= 0) vec[idx] = 2.0;
      for (let i = 0; i < VOCAB.length; i++) {
        if (mapped.startsWith(VOCAB[i]) || VOCAB[i].startsWith(mapped)) {
          vec[i] = Math.max(vec[i], 1.0);
        }
      }
    }

    const mag = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
    if (mag === 0) return null;
    groqFailCount = 0;
    return vec.map((v: number) => v / mag);
  } catch (err) {
    groqFailCount++;
    if (groqFailCount >= 3) {
      groqEmbeddingEnabled = false;
      console.log('  [Embedding] Groq fingerprinting disabled after 3 failures');
    }
    console.error('  [Embedding] Groq fingerprint failed:', (err as Error).message?.substring(0, 60));
    return null;
  }
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
export async function getEmbedding(text: string): Promise<number[] | null> {
  // Try transformer first (most accurate)
  const transformerEmb = await getTransformerEmbedding(text);
  if (transformerEmb) {
    return transformerEmb;
  }

  // Try Groq fingerprint (if enabled)
  const groqEmb = await getGroqFingerprint(text);
  if (groqEmb) {
    console.log('  [Embedding] Groq fingerprint generated');
    return groqEmb;
  }

  // Fallback: local TF-IDF-like embedding (instant, free)
  const localEmb = getLocalEmbedding(text);
  const hasSignal = localEmb.some(v => v > 0);
  if (hasSignal) {
    return localEmb;
  }

  return null;
}
