import { stderrLogger, type Logger } from './internal/util.js';

export const DEFAULT_BUFFER_SIZE = 1000;
const DROP_LOG_INTERVAL_MS = 10_000;

/**
 * Fixed-size ring buffer. When full, push() drops the oldest item and logs to stderr.
 *
 * Thread-safety: Node.js runs JavaScript on a single thread and every method here is
 * synchronous, so push()/drain() can never interleave. No locking is needed.
 */
export class RingBuffer<T> {
  readonly capacity: number;
  private readonly items: (T | undefined)[];
  private head = 0; // index of the oldest item
  private count = 0;
  private droppedTotal = 0;
  private droppedSinceLog = 0;
  private lastDropLogAt = 0;

  constructor(
    capacity: number = DEFAULT_BUFFER_SIZE,
    private readonly logger: Logger = stderrLogger,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Total items dropped because the buffer was full. */
  get dropped(): number {
    return this.droppedTotal;
  }

  /** Adds an item. Returns the dropped (oldest) item when the buffer was full. */
  push(item: T): T | undefined {
    if (this.count < this.capacity) {
      this.items[(this.head + this.count) % this.capacity] = item;
      this.count++;
      return undefined;
    }
    const dropped = this.items[this.head];
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    this.droppedTotal++;
    this.logDrop();
    return dropped;
  }

  /** Returns all items, oldest first, and clears the buffer. */
  drain(): T[] {
    const out: T[] = new Array<T>(this.count);
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.capacity;
      out[i] = this.items[idx] as T;
      this.items[idx] = undefined;
    }
    this.head = 0;
    this.count = 0;
    return out;
  }

  // Logs the first drop immediately, then at most once per interval with a count,
  // so a sustained overflow cannot flood stderr.
  private logDrop(): void {
    this.droppedSinceLog++;
    const now = Date.now();
    if (this.lastDropLogAt === 0 || now - this.lastDropLogAt >= DROP_LOG_INTERVAL_MS) {
      this.logger(
        `event buffer full (capacity ${this.capacity}); dropped ${this.droppedSinceLog} oldest span(s) (total dropped: ${this.droppedTotal})`,
      );
      this.lastDropLogAt = now;
      this.droppedSinceLog = 0;
    }
  }
}
