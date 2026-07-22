import { useCallback, useEffect, useState } from "react";

/**
 * State synced to `localStorage` under `key`, falling back to `initial` when the
 * key is absent or storage is unavailable (private mode can throw on access).
 */
export function usePersistedState<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored != null ? (JSON.parse(stored) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // localStorage may be unavailable (private mode / quota); persist is best-effort.
    }
  }, [key, state]);

  const set = useCallback((value: T | ((prev: T) => T)) => {
    setState((prev) => (typeof value === "function" ? (value as (p: T) => T)(prev) : value));
  }, []);

  return [state, set];
}