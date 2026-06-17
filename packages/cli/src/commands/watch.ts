import path from "node:path";
import chokidar from "chokidar";
import pc from "picocolors";
import { type BuildOptions, type FileResult, buildOne, discover } from "./build.js";

export interface RebuildSummary {
  results: FileResult[];
  initial: boolean;
}

export interface WatchHooks {
  onRebuild?: (summary: RebuildSummary) => void;
  onReady?: () => void;
}

export interface WatchController {
  close: () => Promise<void>;
}

const DEBOUNCE_MS = 80;
const ACTIO_SUFFIX = ".actio.yml";
const IGNORE_SEGMENTS = new Set(["node_modules", "dist", ".git"]);

const toPosix = (p: string): string => p.split(path.sep).join("/");

const isIgnoredPath = (p: string): boolean =>
  toPosix(p)
    .split("/")
    .some((segment) => IGNORE_SEGMENTS.has(segment));

const now = (): string => new Date().toLocaleTimeString();

const printSummary = (results: FileResult[], initial: boolean): void => {
  if (results.length === 0) return;
  const wrote = results.filter((r) => r.wrote).length;
  const errored = results.filter((r) => r.errored).length;
  const parts: string[] = [];
  if (wrote) parts.push(`${wrote} written`);
  if (errored) parts.push(pc.red(`${errored} failed`));
  parts.push(`${results.length} total`);
  const label = initial ? "build" : "rebuild";
  process.stderr.write(
    `${pc.dim(`[${now()}]`)} ${pc.bold("Actio")} ${label}: ${parts.join(", ")}\n`,
  );
};

/**
 * Start watch mode: full build once, then rebuild changed files on save.
 * Unlike `build`/`check`, watch never resolves with a nonzero intent on
 * transpile errors — it reports and keeps watching until `close()`.
 */
export const runWatch = async (
  patterns: string[],
  opts: BuildOptions,
  hooks: WatchHooks = {},
): Promise<WatchController> => {
  const cwd = opts.cwd ?? process.cwd();
  const buildOpts: BuildOptions = { ...opts, check: false, stdout: false };

  const rebuild = async (files: string[], initial: boolean): Promise<void> => {
    if (!initial && files.length > 0) {
      const noun = files.length === 1 ? "file" : "files";
      process.stderr.write(
        `\n${pc.dim(`[${now()}]`)} ${pc.cyan("change detected")} ${pc.dim(`(${files.length} ${noun})`)}\n`,
      );
    }

    const results: FileResult[] = [];
    for (const file of files) {
      try {
        results.push(await buildOne(file, cwd, buildOpts));
      } catch (err) {
        process.stderr.write(`${pc.red("error")}: ${file}: ${(err as Error).message}\n`);
        results.push({ file, wrote: false, drift: false, errored: true });
      }
    }

    printSummary(results, initial);
    hooks.onRebuild?.({ results, initial });
  };

  const initialFiles = await discover(patterns, cwd);
  if (initialFiles.length === 0) {
    process.stderr.write(
      `${pc.yellow("warning")}: no .actio.yml files found${
        patterns.length ? ` for: ${patterns.join(", ")}` : ""
      }; watching for new files\n`,
    );
  }
  await rebuild(initialFiles, true);

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let flushing = false;

  const flush = async (): Promise<void> => {
    if (flushing) {
      schedule();
      return;
    }
    flushing = true;
    // Snapshot and drain synchronously so files saved during the await below
    // stay queued for the next flush instead of being cleared out from under us.
    const captured = [...pending];
    for (const f of captured) pending.delete(f);
    const discovered = new Set(await discover(patterns, cwd));
    const files = captured.filter((f) => discovered.has(f));
    if (files.length > 0) await rebuild(files.sort(), false);
    flushing = false;
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  };

  const onUpsert = (raw: string): void => {
    const rel = toPosix(raw);
    if (!rel.endsWith(ACTIO_SUFFIX) || isIgnoredPath(rel)) return;
    pending.add(rel);
    schedule();
  };

  const onUnlink = (raw: string): void => {
    const rel = toPosix(raw);
    if (!rel.endsWith(ACTIO_SUFFIX) || isIgnoredPath(rel)) return;
    process.stderr.write(
      `${pc.yellow("removed")}: ${rel} ${pc.dim("(generated workflow left in place)")}\n`,
    );
  };

  const watcher = chokidar.watch(".", {
    cwd,
    ignoreInitial: true,
    ignored: (p) => isIgnoredPath(p),
  });
  watcher.on("add", onUpsert);
  watcher.on("change", onUpsert);
  watcher.on("unlink", onUnlink);
  watcher.on("ready", () => hooks.onReady?.());

  process.stderr.write(`${pc.dim("Watching for changes… (press Ctrl+C to stop)")}\n`);

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
};
