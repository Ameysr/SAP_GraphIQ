// ── EMBEDDING SERVICE ─────────────────────────────────────────────────────────
// Pure TF-IDF with expanded SAP O2C domain vocabulary + synonym mapping.
// No native dependencies, works on every platform (Alpine, Render, Docker, etc.)

import Groq from 'groq-sdk';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

let groqClient: Groq | null = null;

function getGroq(): Groq {
  if (!groqClient) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY ?? '' });
  return groqClient;
}

// ── DOMAIN-TUNED TF-IDF EMBEDDING ─────────────────────────────────────────────
// 100+ dimension vocabulary covering SAP O2C business terms.
// Each word maps to a dimension. Synonyms are normalized before lookup.
// This is fast, free, deterministic, and works everywhere.

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
  'currency', 'inr', 'clearing', 'collection', 'late',
  // Process terms
  'fulfillment', 'rate', 'percentage', 'breakdown', 'distribution',
  'status', 'type', 'category', 'classification',
  // SAP terms
  'organization', 'channel', 'incoterms', 'schedule', 'warehouse',
  'profit', 'center', 'cost', 'fiscal', 'year', 'quarter', 'month',
  'expensive', 'cheap', 'average', 'median', 'rank',
  // Health & summary
  'health', 'pipeline', 'overview', 'cross', 'domain',
  // Value & order
  'high', 'value', 'recency', 'lead', 'single',
];

// Synonym normalization — maps alternate phrasings to VOCAB terms
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
  'audit': 'report', 'check': 'report',
  // Financial synonyms
  'income': 'revenue', 'earnings': 'revenue', 'proceeds': 'revenue', 'turnover': 'revenue',
  'debt': 'outstanding', 'receivables': 'receivable', 'ar': 'receivable',
  'payout': 'payment', 'remittance': 'payment', 'settlement': 'clearing',
  'factory': 'plant', 'facility': 'plant', 'location': 'plant',
  // Process synonyms
  'completion': 'fulfillment', 'fill': 'fulfillment',
  'delay': 'late', 'delayed': 'late', 'slow': 'late',
  'open': 'outstanding', 'pending': 'outstanding',
  'types': 'type', 'kinds': 'type', 'categories': 'category',
  'costly': 'expensive', 'pricey': 'expensive',
  'inexpensive': 'cheap',
  'rapid': 'time', 'quick': 'time', 'speedy': 'time',
  // Health/summary
  'overall': 'summary', 'snapshot': 'summary', 'dashboard': 'summary',
  'complete': 'full', 'entire': 'full', 'whole': 'full',
};

// N-gram patterns — boost score when specific multi-word phrases are detected
const PHRASE_BOOSTS: Array<{ pattern: RegExp; boosts: Record<string, number> }> = [
  { pattern: /ar\s*aging/i, boosts: { aging: 3, bucket: 2, receivable: 2 } },
  { pattern: /days?\s*sales?\s*outstanding|dso/i, boosts: { dso: 3, days: 2, clearing: 2 } },
  { pattern: /credit\s*exposure/i, boosts: { credit: 3, exposure: 3, unpaid: 2 } },
  { pattern: /cancell?ation\s*rate/i, boosts: { cancel: 3, rate: 3, percentage: 2 } },
  { pattern: /delivery\s*lead\s*time/i, boosts: { delivery: 2, lead: 3, time: 3, days: 2 } },
  { pattern: /fulfillment\s*rate/i, boosts: { fulfillment: 3, rate: 3, delivery: 2 } },
  { pattern: /cycle\s*time/i, boosts: { cycle: 3, time: 3, days: 2, duration: 2 } },
  { pattern: /broken\s*flow/i, boosts: { anomaly: 3, missing: 2, gap: 2 } },
  { pattern: /revenue\s*concentration/i, boosts: { revenue: 3, concentration: 3, customer: 2 } },
  { pattern: /order\s*to\s*(?:cash|payment)/i, boosts: { order: 2, payment: 2, cycle: 3, journey: 2 } },
  { pattern: /health\s*(?:summary|check|report)/i, boosts: { health: 3, summary: 3, pipeline: 2, overview: 2 } },
  { pattern: /cross[- ]?domain/i, boosts: { cross: 3, domain: 3, summary: 2, customer: 2 } },
  { pattern: /blocked\s*customer/i, boosts: { blocked: 3, customer: 3, risk: 2 } },
  { pattern: /high\s*value\s*order/i, boosts: { high: 2, value: 3, order: 2, expensive: 2 } },
  { pattern: /posting\s*gap|fi\s*gap/i, boosts: { fi: 3, gap: 3, journal: 2, posted: 2 } },
  { pattern: /single\s*customer\s*product/i, boosts: { single: 3, customer: 2, product: 3, risk: 2 } },
  { pattern: /order\s*value\s*distribution/i, boosts: { order: 2, value: 3, distribution: 3, average: 2 } },
  { pattern: /delivery\s*status/i, boosts: { delivery: 3, status: 3, breakdown: 2 } },
  { pattern: /incoterms/i, boosts: { incoterms: 3, classification: 2 } },
  { pattern: /debit.*credit|credit.*debit/i, boosts: { debit: 3, credit: 3, journal: 2, entry: 2 } },
  { pattern: /overdue\s*deliver/i, boosts: { overdue: 3, delivery: 3, late: 2, schedule: 2 } },
  { pattern: /customer\s*recency|churn/i, boosts: { recency: 3, customer: 3, order: 2, risk: 2 } },
];

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

  // Standard token matching
  for (const token of tokens) {
    const idx = VOCAB.indexOf(token);
    if (idx >= 0) {
      vec[idx] += 1;
    }
    // Partial match (e.g. "deliveries" matches "delivery")
    for (let i = 0; i < VOCAB.length; i++) {
      if (token !== VOCAB[i] && (token.startsWith(VOCAB[i]) || VOCAB[i].startsWith(token))) {
        vec[i] += 0.5;
      }
    }
  }

  // Phrase boost — reward multi-word patterns that indicate specific intents
  for (const { pattern, boosts } of PHRASE_BOOSTS) {
    if (pattern.test(text)) {
      for (const [word, boost] of Object.entries(boosts)) {
        const idx = VOCAB.indexOf(word);
        if (idx >= 0) vec[idx] += boost;
      }
    }
  }

  // Normalize to unit vector
  const mag = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
  if (mag === 0) return vec;
  return vec.map((v: number) => v / mag);
}

// ── SEMANTIC EMBEDDING (same as local — single implementation) ────────────────
// Kept as async wrapper for API compatibility with questionPlans and GraphRAG.

let semanticEmbeddingCache = new Map<string, number[]>();
const SEMANTIC_CACHE_MAX = 500;

export async function getSemanticEmbedding(text: string): Promise<number[]> {
  const key = text.trim().toLowerCase();
  const cached = semanticEmbeddingCache.get(key);
  if (cached) return cached;

  const emb = getLocalEmbedding(text);
  semanticEmbeddingCache.set(key, emb);
  if (semanticEmbeddingCache.size > SEMANTIC_CACHE_MAX) {
    const oldestKey = semanticEmbeddingCache.keys().next().value as string | undefined;
    if (oldestKey) semanticEmbeddingCache.delete(oldestKey);
  }
  return emb;
}

/**
 * Synchronous embedding — used in hot paths.
 */
export function getLocalEmbeddingSync(text: string): number[] {
  return getLocalEmbedding(text);
}

/**
 * Initialize embeddings. No-op now (no model to load).
 * Kept for API compatibility with server.ts startup.
 */
export async function initEmbeddings(): Promise<void> {
  console.log('  [Embedding] ✓ Enhanced TF-IDF embeddings ready (no native dependencies)');
}

/**
 * Semantic model readiness check. Always false now (no transformer model).
 * TF-IDF is always used directly.
 */
export function isSemanticReady(): boolean {
  return false;
}

// ── GROQ-POWERED SEMANTIC FINGERPRINT (optional enhancement) ─────────────────
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
  // Try Groq fingerprint first (if enabled — off by default)
  const groqEmb = await getGroqFingerprint(text);
  if (groqEmb) {
    console.log('  [Embedding] Groq fingerprint generated');
    return groqEmb;
  }

  // Primary: local TF-IDF-like embedding (instant, free, no dependencies)
  const localEmb = getLocalEmbedding(text);
  const hasSignal = localEmb.some(v => v > 0);
  if (hasSignal) {
    return localEmb;
  }

  return null;
}
