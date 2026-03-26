import { Router } from 'express';
import type { Request, Response } from 'express';
import { getLogs } from '../services/logger.js';

const router = Router();

router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const logs = await getLogs();

    if (logs.length === 0) {
      res.json({
        cacheHitRate: 0,
        tierDistribution: { 1: 0, 2: 0, 3: 0 },
        fallbackRate: 0,
        avgLatencyMs: 0,
        topFunctions: [],
        failedQueryCount: 0,
        totalRequests: 0,
      });
      return;
    }

    const total = logs.length;
    const cacheHits = logs.filter((l) => l.cacheHit).length;
    const fallbacks = logs.filter((l) => l.usedFallback).length;
    const totalLatency = logs.reduce((sum, l) => sum + l.latencyMs, 0);

    // Tier distribution
    const tierCounts = { 1: 0, 2: 0, 3: 0 };
    for (const l of logs) {
      if (l.tierUsed === 1) tierCounts[1]++;
      else if (l.tierUsed === 2) tierCounts[2]++;
      else if (l.tierUsed === 3) tierCounts[3]++;
    }

    // Top functions
    const funcCounts = new Map<string, number>();
    for (const l of logs) {
      if (l.functionCalled) {
        funcCounts.set(l.functionCalled, (funcCounts.get(l.functionCalled) ?? 0) + 1);
      }
    }
    const topFunctions = Array.from(funcCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    // Failed queries (confidence = 'low' or empty answer)
    const failedQueryCount = logs.filter((l) => l.confidence === 'low' || l.recordsReturned === 0).length;

    res.json({
      cacheHitRate: total > 0 ? Math.round((cacheHits / total) * 100) : 0,
      tierDistribution: {
        1: total > 0 ? Math.round((tierCounts[1] / total) * 100) : 0,
        2: total > 0 ? Math.round((tierCounts[2] / total) * 100) : 0,
        3: total > 0 ? Math.round((tierCounts[3] / total) * 100) : 0,
      },
      fallbackRate: total > 0 ? Math.round((fallbacks / total) * 100) : 0,
      avgLatencyMs: total > 0 ? Math.round(totalLatency / total) : 0,
      topFunctions,
      failedQueryCount,
      totalRequests: total,
    });
  } catch (err: unknown) {
    console.error('[Admin] Stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

export default router;
