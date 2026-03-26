// ── PRODUCTION METRICS SERVICE ─────────────────────────────────────────────────
// Tracks: latency percentiles, cache stats, LLM usage, errors, blocked queries

export interface QueryMetric {
  timestamp: number;
  intent: string;
  latencyMs: number;
  cacheHit: boolean;
  tierUsed: number;
  provider: string;
  path: string;           // 'function' | 'template'
  functionName: string;
  recordCount: number;
  error: boolean;
  blocked: boolean;
  estimatedCost: number;  // USD
}

// In-memory ring buffer — last 1000 queries
const BUFFER_SIZE = 1000;
const metrics: QueryMetric[] = [];
let totalQueries = 0;

// ── LLM COST TABLE (USD per 1M tokens, approximate) ──
const COST_PER_QUERY: Record<string, number> = {
  groq: 0.0002,           // llama-3.3-70b on Groq: ~$0.59/1M input, est ~200 tokens/query
  deepseek: 0.0003,       // deepseek-chat: ~$0.27/1M input
  'deepseek-reasoner': 0.001, // deepseek-reasoner: $2/1M
};

export function recordQuery(m: Omit<QueryMetric, 'timestamp'>): void {
  const entry: QueryMetric = { ...m, timestamp: Date.now() };
  if (metrics.length >= BUFFER_SIZE) {
    metrics.shift();
  }
  metrics.push(entry);
  totalQueries++;
}

export function estimateCost(provider: string, tierUsed: number): number {
  if (tierUsed === 3) return COST_PER_QUERY['deepseek-reasoner'] ?? 0.001;
  return COST_PER_QUERY[provider] ?? 0.0003;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function getMetrics() {
  const now = Date.now();
  const last5min = metrics.filter(m => now - m.timestamp < 5 * 60 * 1000);
  const last1hr = metrics.filter(m => now - m.timestamp < 60 * 60 * 1000);

  // Per-intent latency percentiles
  const intents = ['LOOKUP', 'TRAVERSE', 'AGGREGATE', 'DETECT', 'COMPARE'];
  const latencyByIntent: Record<string, { p50: number; p95: number; p99: number; count: number }> = {};
  for (const intent of intents) {
    const latencies = last1hr.filter(m => m.intent === intent).map(m => m.latencyMs);
    latencyByIntent[intent] = {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      count: latencies.length,
    };
  }

  // Cache stats
  const cacheHits = last1hr.filter(m => m.cacheHit).length;
  const cacheMisses = last1hr.filter(m => !m.cacheHit).length;
  const cacheHitRate = cacheHits + cacheMisses > 0 ? (cacheHits / (cacheHits + cacheMisses) * 100).toFixed(1) + '%' : '0%';

  // LLM tier usage
  const tierCounts = { tier1: 0, tier2: 0, tier3: 0 };
  const providerCounts: Record<string, number> = {};
  for (const m of last1hr) {
    if (m.tierUsed === 1) tierCounts.tier1++;
    else if (m.tierUsed === 2) tierCounts.tier2++;
    else if (m.tierUsed === 3) tierCounts.tier3++;
    providerCounts[m.provider] = (providerCounts[m.provider] || 0) + 1;
  }

  // Error & blocked
  const errors = last1hr.filter(m => m.error).length;
  const blocked = last1hr.filter(m => m.blocked).length;
  const errorRate = last1hr.length > 0 ? (errors / last1hr.length * 100).toFixed(1) + '%' : '0%';

  // Cost
  const totalCost = last1hr.reduce((sum, m) => sum + m.estimatedCost, 0);
  const sessionCost = metrics.reduce((sum, m) => sum + m.estimatedCost, 0);

  // Function usage
  const functionUsage: Record<string, number> = {};
  for (const m of last1hr) {
    if (m.functionName) {
      functionUsage[m.functionName] = (functionUsage[m.functionName] || 0) + 1;
    }
  }

  // Path distribution
  const pathCounts: Record<string, number> = {};
  for (const m of last1hr) {
    pathCounts[m.path] = (pathCounts[m.path] || 0) + 1;
  }

  return {
    overview: {
      totalQueries,
      queriesLast5min: last5min.length,
      queriesLastHour: last1hr.length,
      uptimeSeconds: Math.floor(process.uptime()),
    },
    latency: latencyByIntent,
    cache: { hits: cacheHits, misses: cacheMisses, hitRate: cacheHitRate },
    llm: { tierCounts, providerCounts },
    errors: { total: errors, blocked, errorRate },
    cost: {
      lastHourUSD: Number(totalCost.toFixed(4)),
      sessionTotalUSD: Number(sessionCost.toFixed(4)),
      estimatedMonthlyAt10kPerDay: Number((totalCost / Math.max(last1hr.length, 1) * 10000 * 30).toFixed(2)),
    },
    functionUsage,
    pathDistribution: pathCounts,
  };
}
