export class LineSplitter {
  private buffer = '';
  push(chunk: string, onLine: (line: string) => void) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      onLine(line);
    }
  }
  flush(onLine: (line: string) => void) {
    if (this.buffer.length > 0) {
      onLine(this.buffer);
      this.buffer = '';
    }
  }
}
