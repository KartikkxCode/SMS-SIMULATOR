import { setTimeout as sleep } from "node:timers/promises";

export type Clock = { now(): number; sleep(ms: number): Promise<unknown> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => sleep(ms) };

const SLOW_DOWN_MS = 60_000;
const MIN_FACTOR = 1 / 16;

/** Spaces requests evenly at `ratePerSec`, and halves the speed for a minute each time WhatsApp pushes back. */
export class RateLimiter {
  private nextAt = 0;
  private factor = 1;
  private slowUntil = 0;

  constructor(
    private readonly ratePerSec: number,
    private readonly clock: Clock = realClock,
  ) {}

  /** Requests per second right now. */
  currentRate(): number {
    if (this.clock.now() >= this.slowUntil) this.factor = 1;
    return this.ratePerSec * this.factor;
  }

  slowDown(): void {
    this.currentRate();
    this.factor = Math.max(this.factor / 2, MIN_FACTOR);
    this.slowUntil = this.clock.now() + SLOW_DOWN_MS;
  }

  /** Waits for the next free slot. */
  async take(): Promise<void> {
    const now = this.clock.now();
    const slot = Math.max(now, this.nextAt);
    this.nextAt = slot + 1000 / this.currentRate();
    if (slot > now) await this.clock.sleep(slot - now);
  }
}
