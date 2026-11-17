const fs = require('node:fs/promises');

class FileSession {
  constructor(handle, partial, destination) {
    this.handle = handle;
    this.partial = partial;
    this.destination = destination;
    this.bytes = 0;
    this.pending = Promise.resolve();
    this.failure = null;
    this.closed = false;
    this.lastSync = Date.now();
  }
  static async open(destination) {
    const partial = `${destination}.partial`;
    const handle = await fs.open(partial, 'wx');
    return new FileSession(handle, partial, destination);
  }
  write(data) {
    if (this.closed) return Promise.reject(new Error('Файл уже закрыт'));
    const operation = this.pending.then(async () => {
      if (this.failure) throw this.failure;
      try {
        const buffer = Buffer.from(data);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await this.handle.write(buffer, offset);
          if (!bytesWritten) throw new Error('Диск перестал принимать данные');
          offset += bytesWritten;
        }
        this.bytes += buffer.length;
        if (Date.now() - this.lastSync > 10000) {
          await this.handle.sync();
          this.lastSync = Date.now();
        }
        return this.bytes;
      } catch (error) { this.failure = error; throw error; }
    });
    // Keep the queue handled even if a renderer disappears during IPC.
    this.pending = operation.catch(() => {});
    return operation;
  }
  async finish(finalize) {
    this.closed = true;
    await this.pending;
    try {
      if (this.failure) throw this.failure;
      await this.handle.sync();
    } finally { await this.handle.close(); }
    if (this.bytes === 0) {
      await fs.unlink(this.partial);
      throw new Error('Видеоданные не получены; пустой файл удалён');
    }
    if (finalize) await finalize(this.partial);
    this.bytes = (await fs.stat(this.partial)).size;
    await fs.rename(this.partial, this.destination);
    return { path:this.destination, bytes:this.bytes };
  }
  async abort() {
    this.closed = true;
    await this.pending;
    await this.handle.close();
    if (!this.bytes) await fs.unlink(this.partial).catch(() => {});
    return {path:this.partial, bytes:this.bytes};
  }
}
module.exports = {FileSession};
