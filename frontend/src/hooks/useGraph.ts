import { useState, useEffect } from 'react';
import type { GraphData, GraphNodeDetails } from '../types/index';

const API_URL = import.meta.env.VITE_API_URL ?? '';

export function useGraph() {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchGraph() {
      try {
        const res = await fetch(`${API_URL}/api/graph`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as GraphData;
        if (!cancelled) {
          setGraphData(data);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load graph');
          setLoading(false);
        }
      }
    }

    fetchGraph();
    return () => { cancelled = true; };
  }, []);

  return { graphData, loading, error };
}

export async function fetchNodeDetails(id: string): Promise<GraphNodeDetails | null> {
  try {
    const res = await fetch(`${API_URL}/api/graph/node/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return (await res.json()) as GraphNodeDetails;
  } catch {
    return null;
  }
}
