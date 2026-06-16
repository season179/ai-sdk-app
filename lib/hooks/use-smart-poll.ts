"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Poll cadence while something is running or about to fire. */
export const POLL_FAST_MS = 10_000;
/** Poll cadence while nothing is active — a quiet heartbeat that still
 * picks up tasks created elsewhere (agent, API, another tab) within a minute. */
export const POLL_IDLE_MS = 60_000;
/** Floor for any computed delay, so a stray getDelayMs result can't busy-loop. */
const MIN_DELAY_MS = 1_000;

type SmartPollState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};

type UseSmartPollOptions<T> = {
  /** Fetch and parse the payload; throw on failure. */
  fetcher: () => Promise<T>;
  /** Choose the delay until the next poll from the latest data. */
  getDelayMs: (data: T | null) => number;
  /** Master gate — when false the loop is torn down entirely (e.g. a closed dropdown). */
  enabled?: boolean;
  /** Fallback message when a thrown error isn't an Error instance. */
  errorMessage?: string;
};

/**
 * Visibility-aware, adaptive poller. Pauses completely while the tab is hidden
 * and refreshes immediately when it regains focus; recomputes the next delay
 * from the latest data on every cycle (via setTimeout, not setInterval), so the
 * cadence can speed up when work is live and slow down when idle.
 */
export function useSmartPoll<T>({
  fetcher,
  getDelayMs,
  enabled = true,
  errorMessage = "Request failed.",
}: UseSmartPollOptions<T>) {
  // Start loading when the loop is active on mount, so the first paint already
  // reflects an in-flight fetch (skeleton / disabled refresh button).
  const [state, setState] = useState<SmartPollState<T>>(() => ({
    data: null,
    loading: enabled,
    error: null,
  }));

  // Keep the latest callbacks/data in refs so the polling effect doesn't
  // resubscribe on every render, while still invoking the current versions.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const getDelayRef = useRef(getDelayMs);
  getDelayRef.current = getDelayMs;
  const errorMessageRef = useRef(errorMessage);
  errorMessageRef.current = errorMessage;
  const dataRef = useRef<T | null>(null);
  // Monotonic token: only the most recent request may apply its result, so a
  // slower/out-of-order response (or one that resolves after teardown) can't
  // clobber fresher state or feed a stale snapshot to getDelayMs.
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setState((current) => ({ ...current, loading: true }));

    try {
      const data = await fetcherRef.current();

      if (requestId !== requestIdRef.current) {
        return;
      }

      dataRef.current = data;
      setState({ data, loading: false, error: null });
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : errorMessageRef.current,
      }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const stop = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = undefined;
    };

    const schedule = () => {
      stop();
      const requested = getDelayRef.current(dataRef.current);
      const delay = Number.isFinite(requested) ? Math.max(MIN_DELAY_MS, requested) : POLL_IDLE_MS;
      timer = setTimeout(() => void tick(), delay);
    };

    const tick = async () => {
      // A hidden tab pauses the loop; the visibility handler resumes it.
      if (cancelled || document.hidden) {
        return;
      }

      await refresh();

      // Re-check after the await: the tab may have hidden — or the effect torn
      // down — mid-fetch, in which case we must not arm another timer.
      if (!cancelled && !document.hidden) {
        schedule();
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void tick();
      }
    };

    void tick();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      // Supersede any in-flight refresh so its result is dropped after teardown.
      requestIdRef.current += 1;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, refresh]);

  return { ...state, refresh };
}
