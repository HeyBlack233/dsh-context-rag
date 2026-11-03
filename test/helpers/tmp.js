/**
 * Shared temporary-directory helpers for `dsh-context-rag` tests.
 *
 * @module tmp
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create a fresh temporary directory under the OS temp dir.
 *
 * @param {string} [prefix] - Name prefix for the directory; defaults to
 *   `dsh-rag-`.
 * @returns {Promise<string>} Absolute path of the new directory.
 */
export async function makeTempDir(prefix = "dsh-rag-") {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Recursively remove a temporary directory.
 *
 * Missing, empty, and non-string paths are tolerated so cleanup can be
 * called unconditionally after a test.
 *
 * @param {string} dir - Absolute path of the directory to remove.
 * @returns {Promise<void>}
 */
export async function cleanupTempDir(dir) {
  if (typeof dir === "string" && dir.length > 0) {
    await rm(dir, { recursive: true, force: true });
  }
}
