import type { Counter } from '@prometheus-io/client';

// The current value of one counter series, 0 when it has never been touched.
export async function counterValue<T extends string>(counter: Counter<T>, labels: Partial<Record<T, string>> = {}): Promise<number> {
  const { values } = await counter.get();
  const match = values.find((entry) =>
    Object.entries(labels).every(([name, value]) => (entry.labels as Record<string, unknown>)[name] === value),
  );
  return match?.value ?? 0;
}
