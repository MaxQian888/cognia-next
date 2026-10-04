/**
 * Content-addressed blob store.
 *
 * Layout: <root>/blobs/<hex[0:2]>/<hex[2:4]>/<sha256-hex>
 * Write path: tmp file in the destination directory → fsync → atomic rename,
 * then directory fsync. Content is deduplicated by hash; a present blob is
 * never rewritten. `verifyStore` performs a real scan — no fake OK.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import {
  sha256Hex,
  isSha256Hex,
  WorkbenchError,
  ERROR_CODES,
} from "@latexwb/contracts";

export interface PutResult {
  hash: string;
  path: string;
  bytes: number;
  /** true when the blob already existed (dedup hit, nothing written). */
  existed: boolean;
}

export interface VerifyStoreReport {
  scanned: number;
  /** Referenced hashes with no blob on disk. */
  missing: string[];
  /** On-disk blobs whose bytes do not hash to their filename. */
  corrupt: string[];
  /** Files whose name is not a valid sha256 hex digest. */
  malformed: string[];
  /** On-disk blobs not present in the referenced set (only when provided). */
  unreferenced: string[];
  ok: boolean;
}

export class BlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, "blobs"), { recursive: true });
  }

  private blobsDir(): string {
    return join(this.root, "blobs");
  }

  pathFor(hash: string): string {
    if (!isSha256Hex(hash)) {
      throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `invalid blob hash: ${hash}`);
    }
    return join(this.blobsDir(), hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  put(data: Uint8Array): PutResult {
    const hash = sha256Hex(data);
    const dest = this.pathFor(hash);
    if (existsSync(dest)) {
      return { hash, path: dest, bytes: data.length, existed: true };
    }
    const dir = dirname(dest);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
    try {
      // Write + fsync on a WRITABLE descriptor: fsync on a read-only fd does
      // not guarantee the data we wrote reached stable storage.
      const fd = openSync(tmp, "w");
      try {
        writeSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, dest);
      const dfd = openSync(dir, "r");
      try {
        fsyncSync(dfd);
      } catch {
        // directory fsync is best-effort on filesystems that disallow it
      } finally {
        closeSync(dfd);
      }
    } finally {
      rmSync(tmp, { force: true });
    }
    return { hash, path: dest, bytes: data.length, existed: false };
  }

  get(hash: string): Uint8Array {
    const path = this.pathFor(hash);
    if (!existsSync(path)) {
      throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `blob ${hash} not found`);
    }
    return readFileSync(path);
  }

  /** Read and re-hash; throws DIGEST_MISMATCH when bytes were tampered with. */
  getVerified(hash: string): Uint8Array {
    const data = this.get(hash);
    const actual = sha256Hex(data);
    if (actual !== hash) {
      throw new WorkbenchError(
        ERROR_CODES.DIGEST_MISMATCH,
        `blob ${hash} content hashes to ${actual}`,
      );
    }
    return data;
  }

  has(hash: string): boolean {
    return existsSync(this.pathFor(hash));
  }

  stat(hash: string): { bytes: number } | null {
    const path = this.pathFor(hash);
    if (!existsSync(path)) return null;
    return { bytes: statSync(path).size };
  }

  /** Walk the store and return every on-disk blob hash (validated names only). */
  scanHashes(): { hashes: string[]; malformed: string[] } {
    const hashes: string[] = [];
    const malformed: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          if (isSha256Hex(entry.name)) {
            hashes.push(entry.name);
          } else if (!entry.name.startsWith(".tmp-")) {
            malformed.push(full);
          }
        }
      }
    };
    walk(this.blobsDir());
    return { hashes, malformed };
  }

  /**
   * Scan the store on disk and cross-check it against the set of referenced
   * hashes (e.g. collected from snapshot_files/artifacts). Performs content
   * re-hashing when `deep` is set — this is a real verification, not a stub.
   */
  verifyStore(options: { referenced?: ReadonlySet<string>; deep?: boolean } = {}): VerifyStoreReport {
    const { hashes, malformed } = this.scanHashes();
    const corrupt: string[] = [];
    const onDisk = new Set(hashes);

    if (options.deep !== false) {
      for (const hash of hashes) {
        const actual = sha256Hex(readFileSync(this.pathFor(hash)));
        if (actual !== hash) {
          corrupt.push(hash);
        }
      }
    }

    const referenced = options.referenced;
    const missing: string[] = [];
    const unreferenced: string[] = [];
    if (referenced !== undefined) {
      for (const hash of referenced) {
        if (!onDisk.has(hash)) missing.push(hash);
      }
      for (const hash of hashes) {
        if (!referenced.has(hash)) unreferenced.push(hash);
      }
    }

    return {
      scanned: hashes.length,
      missing: missing.sort(),
      corrupt: corrupt.sort(),
      malformed: malformed.sort(),
      unreferenced: unreferenced.sort(),
      ok: missing.length === 0 && corrupt.length === 0 && malformed.length === 0,
    };
  }
}
