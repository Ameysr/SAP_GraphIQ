import { Router } from 'express';
import type { Request, Response } from 'express';
import { runQuery } from '../db.js';
import { getRedis } from '../redis.js';
import type { GraphNode, GraphEdge, GraphData } from '../types/index.js';

const router = Router();

const GRAPH_CACHE_TTL = 600; // 10 minutes

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Try cache first, but skip if Redis is down
    try {
      const redis = getRedis();
      const cached = await redis.get('graph_data');
      if (cached) {
        res.json(JSON.parse(cached) as GraphData);
        return;
      }
    } catch {
      // Redis unavailable — skip cache
    }

    // Run smaller, focused queries to avoid Aura free tier timeout
    // Instead of one massive MATCH (n)-[r]->(m), we query per relationship type
    const queries = [
      `MATCH (c:Customer)-[r:PLACED]->(so:SalesOrder) RETURN c AS n, r, so AS m LIMIT 100`,
      `MATCH (so:SalesOrder)-[r:HAS_ITEM]->(soi:SalesOrderItem) RETURN so AS n, r, soi AS m LIMIT 100`,
      `MATCH (soi:SalesOrderItem)-[r:FULFILLED_BY]->(di:DeliveryItem) RETURN soi AS n, r, di AS m LIMIT 100`,
      `MATCH (di:DeliveryItem)-[r:PART_OF]->(dh:DeliveryHeader) RETURN di AS n, r, dh AS m LIMIT 100`,
      `MATCH (dh:DeliveryHeader)-[r:BILLED_IN]->(bi:BillingItem) RETURN dh AS n, r, bi AS m LIMIT 50`,
      `MATCH (bi:BillingItem)-[r:PART_OF]->(bh:BillingHeader) RETURN bi AS n, r, bh AS m LIMIT 50`,
      `MATCH (bh:BillingHeader)-[r:PAID_BY]->(pay:Payment) RETURN bh AS n, r, pay AS m LIMIT 50`,
      `MATCH (soi:SalesOrderItem)-[r:REFERENCES]->(p:Product) RETURN soi AS n, r, p AS m LIMIT 50`,
      `MATCH (di:DeliveryItem)-[r:AT_PLANT]->(pl:Plant) RETURN di AS n, r, pl AS m LIMIT 30`,
    ];

    const allRecords: Record<string, unknown>[] = [];
    for (const q of queries) {
      try {
        const recs = await runQuery(q, {});
        allRecords.push(...recs);
      } catch (err) {
        console.warn(`[Graph] Partial query failed (skipping):`, (err as Error).message?.substring(0, 80));
      }
    }

    const nodesMap = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    for (const record of allRecords) {
      const n = record.n as Record<string, unknown> | null;
      const m = record.m as Record<string, unknown> | null;
      const r = record.r as Record<string, unknown> | null;

      if (n && typeof n === 'object') {
        const nLabels = (n.labels as string[] | undefined) ?? ['Unknown'];
        const nId = (n.id as string | undefined) ?? '';
        if (nId && !nodesMap.has(nId)) {
          const props = { ...n };
          delete props.labels;
          nodesMap.set(nId, {
            id: nId,
            label: nId,
            type: nLabels[0] ?? 'Unknown',
            properties: props,
          });
        }
      }

      if (m && typeof m === 'object') {
        const mLabels = (m.labels as string[] | undefined) ?? ['Unknown'];
        const mId = (m.id as string | undefined) ?? '';
        if (mId && !nodesMap.has(mId)) {
          const props = { ...m };
          delete props.labels;
          nodesMap.set(mId, {
            id: mId,
            label: mId,
            type: mLabels[0] ?? 'Unknown',
            properties: props,
          });
        }
      }

      if (n && m && r) {
        const nId = (n.id as string | undefined) ?? '';
        const mId = (m.id as string | undefined) ?? '';
        const rType = (r.type as string | undefined) ?? 'UNKNOWN';
        if (nId && mId) {
          edges.push({ source: nId, target: mId, type: rType });
        }
      }
    }

    const data: GraphData = {
      nodes: Array.from(nodesMap.values()),
      edges,
    };

    // Try to cache, but don't fail if Redis is down
    try {
      const redis = getRedis();
      await redis.set('graph_data', JSON.stringify(data), 'EX', GRAPH_CACHE_TTL);
    } catch {
      // Redis unavailable — skip cache
    }

    res.json(data);
  } catch (err: unknown) {
    console.error('[Graph] Error:', err);
    res.status(500).json({ error: 'Failed to load graph data' });
  }
});

router.get('/node/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const cypher = `
      MATCH (n {id: $id})
      OPTIONAL MATCH (n)-[r]-(m)
      RETURN n, collect({rel: r, neighbor: m}) AS connections
    `;

    const records = await runQuery(cypher, { id });

    if (records.length === 0) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }

    const raw = records[0] as {
      n: any;
      connections: Array<{ rel: any; neighbor: any }>;
    };

    function formatNode(rawNode: any): GraphNode {
      const labels = (rawNode?.labels as string[] | undefined) ?? ['Unknown'];
      const nodeId = (rawNode?.id as string | undefined) ?? '';
      const props = { ...(rawNode ?? {}) };
      delete (props as any).labels;
      // GraphNode expects: { id, label, type, properties }
      return {
        id: nodeId,
        label: nodeId,
        type: labels[0] ?? 'Unknown',
        properties: props,
      };
    }

    const node = formatNode(raw.n);
    const connections = (raw.connections ?? [])
      .filter((c) => c?.rel && c?.neighbor)
      .map((c) => ({
        relType: (c.rel?.type as string | undefined) ?? 'UNKNOWN',
        neighbor: formatNode(c.neighbor),
      }));

    res.json({ node, connections, connectionsCount: connections.length });
  } catch (err: unknown) {
    console.error('[Graph] Node lookup error:', err);
    res.status(500).json({ error: 'Failed to load node data' });
  }
});

export default router;
