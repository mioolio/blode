/** Bound filesystem fan-out across all concurrent navigation requests. */
export class NavigationIo {
  private active = 0;
  private queue: (() => void)[] = [];
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= 8) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.active++;
    try {
      return await operation();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export async function boundedNavigationMap<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        result[index] = await run(items[index]);
      }
    }),
  );
  return result;
}
