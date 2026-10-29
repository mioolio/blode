/** Share expensive immutable reads until their underlying inputs change. */
export class SnapshotCache<T> {
  private entry?: { key: string; value: Promise<T> };
  invalidate(): void {
    this.entry = undefined;
  }
  async get(key: string, load: () => Promise<T>): Promise<T> {
    if (this.entry?.key !== key) {
      const entry = { key, value: Promise.resolve().then(load) };
      this.entry = entry;
      entry.value.catch(() => {
        if (this.entry === entry) this.entry = undefined;
      });
    }
    return structuredClone(await this.entry!.value);
  }
}
