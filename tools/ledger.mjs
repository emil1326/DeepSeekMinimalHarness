/**
 * One token budget, shared by every worker, enforced before a run starts.
 *
 * The reason this is a file and not a counter is the arithmetic: four workers
 * each holding a local "50M" is a 200M sweep. A cap that lives in four places
 * is not a cap.
 *
 * The lock is `open` with the exclusive flag, which fails if the file exists.
 * That is atomic on both platforms and needs no dependency, which matters more
 * here than elegance: this file is the thing standing between a red-team sweep
 * and a bill nobody agreed to.
 *
 * Reservation happens **before** the run, not after. Charging at the end means
 * four workers can pass the same check simultaneously and all four overspend —
 * which is precisely the failure this exists to prevent. A worker takes a lease,
 * runs, then settles with what it actually used, returning the difference.
 */

import fs from 'node:fs';
import path from 'node:path';

const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Ledger {
  constructor(file, cap) {
    this.file = file;
    this.lockFile = `${file}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      this.#write({ cap, reserved: 0, spent: 0 });
    }
  }

  #read() {
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  #write(state) {
    // Written to a neighbour and renamed, so a crash mid-write cannot leave a
    // half-parsed budget behind. The rename is atomic.
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(temp, this.file);
  }

  /** Take the lock, or wait for whoever has it. */
  async #lock() {
    for (let waited = 0; waited < LOCK_STALE_MS; waited += LOCK_RETRY_MS) {
      try {
        fs.closeSync(fs.openSync(this.lockFile, 'wx'));
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // A worker killed mid-lease must not wedge the sweep for ever.
        try {
          const age = Date.now() - fs.statSync(this.lockFile).mtimeMs;
          if (age > LOCK_STALE_MS) fs.rmSync(this.lockFile, { force: true });
        } catch {
          /* the holder released it between the open and the stat */
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    throw new Error(`could not take ${this.lockFile} within ${LOCK_STALE_MS} ms`);
  }

  #unlock() {
    fs.rmSync(this.lockFile, { force: true });
  }

  /**
   * Reserve up to `amount` tokens, or refuse.
   *
   * Returns a lease to hand back to `settle`, or `null` when the budget is gone
   * — which is a normal answer, not an error. A sweep that runs out of budget
   * stops cleanly and says so.
   */
  async reserve(amount, label) {
    await this.#lock();
    try {
      const state = this.#read();
      const committed = state.reserved + state.spent;
      if (committed + amount > state.cap) {
        const left = Math.max(0, state.cap - committed);
        return { granted: false, left, cap: state.cap };
      }
      state.reserved += amount;
      this.#write(state);
      return { granted: true, lease: { id: `${label}-${Date.now()}`, amount } };
    } finally {
      this.#unlock();
    }
  }

  /**
   * Hand back what the run actually used.
   *
   * Under-spending is the normal case: the lease is a ceiling, and a run that
   * ends early should not be charged for the whole thing. Over-spending is
   * recorded as it is rather than clamped — a run that went past its lease is a
   * finding about the lease, and hiding it would be the same fail-open shape
   * the catalogue keeps warning about.
   */
  async settle(lease, used) {
    await this.#lock();
    try {
      const state = this.#read();
      state.reserved = Math.max(0, state.reserved - lease.amount);
      state.spent += Math.max(0, used);
      this.#write(state);
      return { spent: state.spent, cap: state.cap, overran: used > lease.amount };
    } finally {
      this.#unlock();
    }
  }

  /** A run that never started, or died before spending: nothing to charge. */
  async release(lease) {
    await this.#lock();
    try {
      const state = this.#read();
      state.reserved = Math.max(0, state.reserved - lease.amount);
      this.#write(state);
    } finally {
      this.#unlock();
    }
  }

  async status() {
    await this.#lock();
    try {
      const state = this.#read();
      return {
        cap: state.cap,
        spent: state.spent,
        reserved: state.reserved,
        left: state.cap - state.spent - state.reserved,
      };
    } finally {
      this.#unlock();
    }
  }
}
