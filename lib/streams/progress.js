import { formatBytes, formatDuration } from "../../deps.js";

export class Progress extends TransformStream {
  completed = 0;
  done = false;
  estimated = NaN;
  eta = NaN;
  percent = 0;
  rate = 0;
  time = 0;
  total = 0;

  /**
   * Creates a new Progress.
   * @param {number} total
   * @param {(progress: Progress) => void} [onProgress]
   */
  constructor(total, onProgress) {
    const startAt = Date.now();

    super({
      transform: (chunk, controller) => {
        this.completed += chunk.byteLength;

        const now = Date.now();
        this.time = (now - startAt) / 1000;
        this.rate = this.completed / this.time;

        this.estimated = total / this.rate;
        this.percent = Math.round(this.completed / total * 100);
        this.eta = this.estimated - this.time;

        onProgress?.(this);

        controller.enqueue(chunk);
      },
      flush: (_controller) => {
        this.done = true;
        onProgress?.(this);
      },
    });

    this.total = total;
  }

  get completedh() {
    return formatBytes(this.completed, { binary: true });
  }

  get etah() {
    return formatDuration(this.eta * 1000, { ignoreZero: true });
  }

  get rateh() {
    return formatBytes(this.rate, { binary: true });
  }

  get timeh() {
    return formatDuration(this.time * 1000, { ignoreZero: true });
  }

  get totalh() {
    return formatBytes(this.total, { binary: true });
  }
}
