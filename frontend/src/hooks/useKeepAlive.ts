import { useEffect, useRef } from 'react';

const API_URL = import.meta.env.VITE_API_URL ?? '';
const PING_INTERVAL = 4 * 60 * 1000; // 4 minutes (Render spins down after 15 min idle)

/**
 * Keeps the Render free-tier backend alive by pinging /health every 4 minutes
 * while the user has the tab open. Pauses when tab is hidden to save resources.
 */
export function useKeepAlive() {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const ping = async () => {
      try {
        await fetch(`${API_URL}/health`, { method: 'GET' });
      } catch {
        // Silent — backend might be cold, that's fine
      }
    };

    const start = () => {
      if (!intervalRef.current) {
        intervalRef.current = setInterval(ping, PING_INTERVAL);
      }
    };

    const stop = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    // Pause when tab is hidden, resume when visible
    const handleVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };

    // Start immediately
    start();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);
}
