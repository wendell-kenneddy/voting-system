import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import type { Ranking } from '../../src/domain/types';

export interface ReceivedFrame { id?: string; event?: string; data?: Ranking; comment?: string; at: number }

export class SseClient {
  readonly frames: ReceivedFrame[] = [];
  ended = false;
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly listeners = new Set<() => void>();
  private response?: IncomingMessage;
  private request?: ClientRequest;
  headers: IncomingMessage['headers'] = {};

  async connect(url: string): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { this.close(); reject(new Error('SSE headers timeout')); }, 2000);
      this.request = get(url, res => {
        clearTimeout(timeout);
        this.response = res;
        this.headers = res.headers;
        if (res.statusCode !== 200) { this.close(); reject(new Error(`SSE status ${res.statusCode}`)); return; }
        res.on('data', (chunk: Buffer) => this.ingest(this.decoder.write(chunk)));
        res.on('end', () => { this.ingest(this.decoder.end()); this.finish(); });
        res.on('close', () => this.finish());
        res.on('error', () => this.finish());
        resolve();
      });
      this.request.on('error', error => { clearTimeout(timeout); reject(error); this.finish(); });
    });
    return this;
  }

  ingest(text: string): void {
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf('\n\n')) >= 0) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const frame: ReceivedFrame = { at: performance.now() };
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) frame.comment = line.slice(1).trim();
        else if (line.startsWith('id: ')) frame.id = line.slice(4);
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6)) as Ranking;
      }
      this.frames.push(frame);
      this.notify();
    }
  }

  waitFor(predicate: (frames: ReceivedFrame[]) => boolean, timeoutMs = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); this.listeners.delete(check); };
      const check = () => {
        if (predicate(this.frames)) { cleanup(); resolve(); }
        else if (this.ended) { cleanup(); reject(new Error('SSE ended before expected event')); }
      };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('SSE event timeout')); }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  waitForEnd(timeoutMs = 2000): Promise<void> {
    return this.waitFor(() => this.ended, timeoutMs);
  }
  private notify(): void { for (const listener of [...this.listeners]) listener(); }
  private finish(): void { this.ended = true; this.notify(); }
  close(): void { this.response?.destroy(); this.request?.destroy(); this.finish(); }
}
