// Serialize disk writes; a failed write must prevent a false success report.
export class DiskSink {
  constructor(writable) {
    this.writable = writable;
    this.pending = Promise.resolve();
    this.bytes = 0;
    this.error = null;
  }
  append(blob) {
    this.pending = this.pending.then(async () => {
      if (this.error) return;
      try {
        await this.writable.write(blob);
        this.bytes += blob.size;
      } catch (error) { this.error = error; }
    });
    return this.pending;
  }
  async close() {
    await this.pending;
    if (this.error) {
      await this.writable.abort().catch(() => {});
      throw this.error;
    }
    await this.writable.close();
  }
}

export function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(v => String(v).padStart(2, '0')).join(':');
}
