import React, { useState, useEffect } from 'react';
import type { AdminStats } from '../types/index';

const API_URL = import.meta.env.VITE_API_URL ?? '';

export default function AdminPanel() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchStats() {
      try {
        const res = await fetch(`${API_URL}/api/admin/stats`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as AdminStats;
        if (!cancelled) setStats(data);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed');
      }
    }

    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (error) {
    return <div className="admin-panel"><h1>Admin Dashboard</h1><p className="admin-error">Error: {error}</p></div>;
  }

  if (!stats) {
    return <div className="admin-panel"><h1>Admin Dashboard</h1><p>Loading...</p></div>;
  }

  return (
    <div className="admin-panel" id="admin-panel">
      <h1>Admin Dashboard</h1>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{stats.totalRequests}</div>
          <div className="stat-label">Total Requests</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.cacheHitRate}%</div>
          <div className="stat-label">Cache Hit Rate</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.avgLatencyMs}ms</div>
          <div className="stat-label">Avg Latency</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.fallbackRate}%</div>
          <div className="stat-label">Fallback Rate</div>
        </div>
      </div>

      <div className="stats-section">
        <h2>LLM Tier Distribution</h2>
        <table className="stats-table">
          <thead><tr><th>Tier</th><th>Provider</th><th>Usage</th></tr></thead>
          <tbody>
            <tr><td>1</td><td>Groq LLaMA 3</td><td>{stats.tierDistribution[1]}%</td></tr>
            <tr><td>2</td><td>DeepSeek Chat</td><td>{stats.tierDistribution[2]}%</td></tr>
            <tr><td>3</td><td>DeepSeek Reasoner</td><td>{stats.tierDistribution[3]}%</td></tr>
          </tbody>
        </table>
      </div>

      <div className="stats-section">
        <h2>Top Functions</h2>
        <table className="stats-table">
          <thead><tr><th>Function</th><th>Calls</th></tr></thead>
          <tbody>
            {stats.topFunctions.map((f) => (
              <tr key={f.name}><td>{f.name}</td><td>{f.count}</td></tr>
            ))}
            {stats.topFunctions.length === 0 && (
              <tr><td colSpan={2}>No function calls yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="stats-section">
        <h2>Errors</h2>
        <p className="stat-inline">Failed queries: <strong>{stats.failedQueryCount}</strong></p>
      </div>
    </div>
  );
}
