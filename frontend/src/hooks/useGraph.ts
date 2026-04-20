import { useState, useEffect, useCallback, useRef } from 'react';
import type { GraphData, GraphNodeDetails } from '../types/index';

const API_URL = import.meta.env.VITE_API_URL ?? '';

export type LoadingStage = 
  | 'waking'      // Pinging the backend to wake it up
  | 'connecting'  // Backend responded, fetching graph
  | 'rendering'   // Got graph data, building visualization
  | 'ready'       // Done
  | 'error';

export function useGraph() {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<LoadingStage>('waking');
  const [pingAttempt, setPingAttempt] = useState(0);

  const fetchWithRetry = useCallback(async () => {
    // Stage 1: Ping health endpoint to wake backend (lightweight, fast response once awake)
    setStage('waking');
    let backendAwake = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 20; // ~60s max wait (3s per attempt)

    while (!backendAwake && attempts < MAX_ATTEMPTS) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${API_URL}/health`, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          backendAwake = true;
        }
      } catch {
        // Backend still cold, retry
      }
      if (!backendAwake) {
        attempts++;
        setPingAttempt(attempts);
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (!backendAwake) {
      setError('Backend is taking too long to start. Please refresh in a minute.');
      setStage('error');
      setLoading(false);
      return;
    }

    // Stage 2: Fetch graph data
    setStage('connecting');
    try {
      const res = await fetch(`${API_URL}/api/graph`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as GraphData;
      
      // Stage 3: Brief rendering phase
      setStage('rendering');
      // Small delay to let the graph component mount smoothly
      await new Promise(r => setTimeout(r, 300));
      
      setGraphData(data);
      setStage('ready');
      setLoading(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load graph');
      setStage('error');
      setLoading(false);
    }
  }, []);

  const hasStarted = useRef(false);

  useEffect(() => {
    // Guard against React.StrictMode double-mount (dev mode fires effects twice)
    if (hasStarted.current) return;
    hasStarted.current = true;

    fetchWithRetry();
  }, [fetchWithRetry]);

  return { graphData, loading, error, stage, pingAttempt };
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
