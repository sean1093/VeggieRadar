import { useEffect, useState } from 'react';

/**
 * Whether the browser currently believes it has a connection.
 *
 * Used for wording only, never to skip a request: `navigator.onLine === true`
 * merely means *some* network interface is up, so a fetch is still the only
 * proof that the backend is reachable. The `false` side is the reliable one —
 * that is the case worth telling the user about.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    // One handler for both events: the flag is read from the browser rather
    // than inferred from which event fired.
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  return online;
}
