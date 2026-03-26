// ── EMBEDDING SERVICE ─────────────────────────────────────────────────────────
// Uses Groq LLM to generate semantic fingerprints for caching
// Approach: Extract key concepts → generate stable hash → compare

import Groq from 'groq-sdk';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

let groqClient: Groq | null = null;

function getGroq(): Groq {
  if (!groqClient) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY ?? '' });
  return groqClient;
}

// ── LIGHTWEIGHT EMBEDDING: TF-IDF-like keyword vectors ────────────────────────
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

// ── GROQ-POWERED SEMANTIC FINGERPRINT (fallback for complex queries) ──────────
// Default: keep free-tier friendly (local embeddings only) unless explicitly enabled.
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
      if (idx >= 0) vec[idx] = 2.0; // Strong weight for LLM-extracted concepts
      // Partial match
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
  // Try Groq fingerprint first (more semantic)
  const groqEmb = await getGroqFingerprint(text);
  if (groqEmb) {
    console.log('  [Embedding] Groq fingerprint generated');
    return groqEmb;
  }

  // Fallback: local TF-IDF-like embedding (instant, free)
  const localEmb = getLocalEmbedding(text);
  const hasSignal = localEmb.some(v => v > 0);
  if (hasSignal) {
    console.log('  [Embedding] Local embedding generated');
    return localEmb;
  }

  return null;
}
