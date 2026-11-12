#!/usr/bin/env node
/**
 * compat-matrix.mjs — assert the plugin's declared DSH range against DSH's own
 * compatibility evaluator across a probe list of published releases.
 *
 * The evaluator is read from a DSH installation (`DSH_INSTALL_DIR`) so the
 * check uses the same code path as installation and profile startup: an own
 * `engines.dsh` range decides alone, DSH peers are the fallback, and ranges are
 * matched with semver's includePrerelease option.
 *
 * Usage:
 *   node scripts/compat-matrix.mjs                     # DSH_INSTALL_DIR required
 *   node scripts/compat-matrix.mjs --app-boot <path>   # explicit evaluator file
 *   node scripts/compat-matrix.mjs --supported a,b --rejected c,d
 *
 * Exits non-zero when any probe disagrees with the declared range or when the
 * evaluator cannot be located. The probe lists are published DSH releases and
 * do not need to change unless the range itself changes.
 *
 * @module compat-matrix
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

/** Releases the range must admit: floor, intermediate prereleases, and head. */
const DEFAULT_SUPPORTED = [
  "0.2.1-rc.2",
  "0.2.1-rc.3",
  "0.2.1-rc.4",
  "0.2.1-rc.5",
  "0.2.2-alpha.2",
  "0.2.2-alpha.3",
  "0.2.2-rc.1",
  "0.2.2-rc.2",
];

/** Releases the range must reject: below the floor and the next minor line. */
const DEFAULT_REJECTED = [
  "0.2.0-rc.2",
  "0.2.1-alpha.5",
  "0.2.1-rc.1",
  "0.3.0-alpha.1",
  "0.3.0-rc.1",
  "0.3.0",
];

/**
 * Read `--name value` and `--name=value` options.
 *
 * @param {string[]} argv - Process arguments after the script name.
 * @returns {Record<string, string|undefined>} Parsed options.
 */
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) options[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      options[key] = argv[i + 1];
      i += 1;
    } else options[key] = "true";
  }
  return options;
}

/**
 * Resolve the evaluator file inside a DSH installation.
 *
 * @param {string|undefined} explicit - `--app-boot` value, if any.
 * @returns {string} Absolute path of the evaluator module.
 */
function evaluatorPath(explicit) {
  if (explicit) return path.resolve(explicit);
  const install = process.env.DSH_INSTALL_DIR;
  if (install) {
    return path.join(install, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
  }
  throw new Error(
    "Cannot locate the DSH compatibility evaluator: set DSH_INSTALL_DIR to the " +
      "running DSH installation or pass --app-boot <path>.",
  );
}

/**
 * Split a comma list into trimmed, non-empty values.
 *
 * @param {string|undefined} value - Comma-separated option value.
 * @param {readonly string[]} fallback - Defaults when the option is absent.
 * @returns {string[]} Probe versions.
 */
function listOf(value, fallback) {
  if (!value) return [...fallback];
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) throw new Error("An empty version list is not useful");
  return items;
}

const options = parseArgs(process.argv.slice(2));
if (options.help === "true") {
  process.stdout.write(
    "Assert the plugin's DSH range with DSH's own evaluator.\n\n" +
      "  node scripts/compat-matrix.mjs [--app-boot <path>] " +
      "[--supported v1,v2,...] [--rejected v1,v2,...]\n\n" +
      "DSH_INSTALL_DIR supplies the evaluator when --app-boot is omitted.\n",
  );
  process.exit(0);
}

const evaluator = await import(pathToFileURL(evaluatorPath(options.appBoot)).href);
const { evaluatePluginCompatibility } = evaluator;
if (typeof evaluatePluginCompatibility !== "function") {
  throw new Error("The evaluator module does not export evaluatePluginCompatibility");
}

const supported = listOf(options.supported, DEFAULT_SUPPORTED);
const rejected = listOf(options.rejected, DEFAULT_REJECTED);
const rule = manifest.engines?.dsh
  ? `engines.dsh ${manifest.engines.dsh}`
  : `dsh peers ${JSON.stringify(
      Object.fromEntries(
        Object.entries(manifest.peerDependencies ?? {}).filter(
          ([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"),
        ),
      ),
    )}`;

process.stdout.write(`plugin: ${manifest.name}@${manifest.version}\n`);
process.stdout.write(`rule:   ${rule}\n`);
process.stdout.write(`runtime used to evaluate: the probe list below\n\n`);

let failures = 0;
const check = (versions, expected) => {
  for (const version of versions) {
    let issue;
    try {
      issue = evaluatePluginCompatibility(manifest, {}, version);
    } catch (error) {
      failures += 1;
      process.stdout.write(`  ${version.padEnd(14)} ERROR ${String(error?.message ?? error)}\n`);
      continue;
    }
    const accepted = issue === undefined;
    const ok = accepted === expected;
    if (!ok) failures += 1;
    const verdict = accepted ? "accepted" : "rejected";
    const detail = issue ? ` (${JSON.stringify(issue.requirements)})` : "";
    process.stdout.write(
      `  ${version.padEnd(14)} ${verdict.padEnd(9)} ${ok ? "ok" : "MISMATCH"}${detail}\n`,
    );
  }
};

process.stdout.write("must be accepted:\n");
check(supported, true);
process.stdout.write("\nmust be rejected:\n");
check(rejected, false);

if (failures > 0) {
  process.stdout.write(`\n${failures} probe(s) disagree with the declared range.\n`);
  process.exit(1);
}
process.stdout.write("\nAll probes agree with the declared range.\n");
