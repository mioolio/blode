type RequestToken = { channel: string; sequence: number; generation: number };

/** Reject responses from an earlier target, action or component lifetime. */
export class DebuggerRequests {
  private generation = 0;
  private sequences = new Map<string, number>();
  invalidate() {
    this.generation++;
  }
  begin(channel: string): RequestToken {
    const sequence = (this.sequences.get(channel) ?? 0) + 1;
    this.sequences.set(channel, sequence);
    return { channel, sequence, generation: this.generation };
  }
  current(token: RequestToken) {
    return token.generation === this.generation && token.sequence === this.sequences.get(token.channel);
  }
  async read<T>(channel: string, load: () => Promise<T>) {
    const token = this.begin(channel);
    try {
      const value = await load();
      return this.current(token) ? { token, value } : null;
    } catch (error) {
      if (this.current(token)) throw error;
      return null;
    }
  }
}
