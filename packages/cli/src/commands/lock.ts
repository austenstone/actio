import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ActionLockEntry {
  action: string;
  sourceRef: string;
  digest: string;
  integrity: string;
  resolvedAt: string;
}

export interface ImportLockEntry {
  source: string;
  immutableRef: string;
  integrity: string;
  resolvedAt: string;
}

/** Build-time pin cache entry, keyed by canonical ref (`owner/repo@ref` / `docker://img:tag`). */
export interface PinCacheEntry {
  ref: string;
  digest: string;
  resolvedAt: string;
}

export interface ActioLock {
  version: 1;
  actions: Record<string, ActionLockEntry>;
  imports: Record<string, ImportLockEntry>;
  pins?: Record<string, PinCacheEntry>;
}

export interface LockState {
  path: string;
  data: LockFileData;
}

export type LockFileData = ActioLock & Record<string, unknown>;

const defaultLock = (): LockFileData => ({ version: 1, actions: {}, imports: {} });

export const serializeLock = (lock: LockState): string => `${JSON.stringify(lock.data, null, 2)}\n`;

export const readLock = async (cwd: string, lockPath?: string): Promise<LockState> => {
  const fullPath = path.resolve(cwd, lockPath ?? "actio.lock");
  if (!existsSync(fullPath)) {
    return { path: fullPath, data: defaultLock() };
  }
  const text = await readFile(fullPath, "utf8");
  const parsed = JSON.parse(text) as Partial<ActioLock> & Record<string, unknown>;
  return {
    path: fullPath,
    data: {
      ...parsed,
      version: 1,
      actions: parsed.actions ?? {},
      imports: parsed.imports ?? {},
    },
  };
};

export const writeLock = async (lock: LockState): Promise<void> => {
  await mkdir(path.dirname(lock.path), { recursive: true });
  await writeFile(lock.path, serializeLock(lock), "utf8");
};
