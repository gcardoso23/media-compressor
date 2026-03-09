// Runs `task` over `items` with at most `limit` in flight.
export async function pool<T>(items: T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      await task(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Runs at most `limit` tasks at once; the rest wait their turn.
export function limiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
