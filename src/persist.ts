import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { restoreStore, snapshotStore, type MemoryStore, type Snapshot } from "./store.js";

/**
 * Debounced JSON snapshot of the whole store. Identities, grants and queued mail
 * survive a restart; acked payloads are already gone from the store, so they are
 * gone from disk too. The file holds token hashes and webhook secrets: mode 600.
 */
export class FilePersistence {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private store: MemoryStore,
    private path: string,
    private delayMs = 200,
  ) {}

  load(): boolean {
    if (!existsSync(this.path)) return false;
    const snap = JSON.parse(readFileSync(this.path, "utf8")) as Snapshot;
    restoreStore(this.store, snap);
    return true;
  }

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.delayMs);
    this.timer.unref();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshotStore(this.store)), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
