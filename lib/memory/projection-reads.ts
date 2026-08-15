export type ProjectionReadTask<T> = (context: {
  signal: AbortSignal;
  deadlineAt: number;
}) => Promise<T>;

/**
 * Starts every optional read immediately and applies one absolute budget.
 * Values that finish in time are retained; rejected/unfinished reads use their
 * clean fallback. Aborting the shared signal prevents queued recall SQL from
 * starting after the route has moved on to streaming.
 */
export async function runProjectionReads<T extends Record<string, unknown>>(
  tasks: { [K in keyof T]: ProjectionReadTask<T[K]> },
  fallbacks: T,
  options: {
    deadlineMs?: number;
    deadlineAt?: number;
    now?: () => number;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const deadlineAt = options.deadlineAt ?? now() + (options.deadlineMs ?? 2_000);
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const values = { ...fallbacks };
  const pending = (Object.keys(tasks) as Array<keyof T>).map(async (key) => {
    try {
      values[key] = await tasks[key]({ signal, deadlineAt });
    } catch (error) {
      if (!signal.aborted) {
        console.error(`Projection read '${String(key)}' failed`, error);
      }
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadlineAt - now()));
  });
  await Promise.race([Promise.allSettled(pending).then(() => undefined), timeout]);
  controller.abort();
  if (timer) clearTimeout(timer);
  return values;
}
