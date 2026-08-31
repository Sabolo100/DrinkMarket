/**
 * Nyers bizonyitekok tarolasa (spec 29.3).
 *
 * CSAK hibas, vitatott vagy review eseteknel mentunk teljes snapshotot.
 * A tarolo privat, a megorzes korlatozott (alapertelmezes 30-90 nap).
 * Secret, cookie es auth header SOHA nem kerulhet artefaktba (spec 38/12).
 */
import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@radovin/observability';
import type { WorkerConfig } from '../config.js';

const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/(set-cookie|cookie)\s*:\s*[^\n\r]+/gi, '$1: [redacted]'],
  [/(authorization|x-api-key|x-auth-token)\s*:\s*[^\n\r]+/gi, '$1: [redacted]'],
  [/("(?:password|token|apiKey|api_key|secret)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2'],
  [/<input[^>]*type=["']password["'][^>]*>/gi, '<input type="password" value="[redacted]">'],
];

function sanitize(content: string): string {
  let out = content;
  for (const [re, replacement] of SENSITIVE_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export async function saveArtifact(
  config: WorkerConfig,
  runId: string,
  name: string,
  content: string | Buffer,
  contentType: string,
): Promise<string> {
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  const key = `${runId}/${Date.now()}-${safeName}`;

  if (config.evidenceDriver !== 'fs') {
    logger.warn('artifact.driver_unsupported', {
      driver: config.evidenceDriver,
      hint: 'Az S3 driver kesobb kerul be; jelenleg fs tarolas hasznalatos.',
    });
  }

  const dir = path.join(config.evidencePath, runId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(config.evidencePath, key);
  const payload = typeof content === 'string' ? sanitize(content) : content;
  await writeFile(filePath, payload);
  logger.debug('artifact.saved', { key, contentType, bytes: payload.length });
  return key;
}

/** Retencios takaritas: a megadott napnal regebbi artefaktok torlese. */
export async function cleanupArtifacts(config: WorkerConfig): Promise<number> {
  const cutoff = Date.now() - config.evidenceRetentionDays * 86_400_000;
  let removed = 0;
  try {
    const runDirs = await readdir(config.evidencePath).catch(() => [] as string[]);
    for (const runDir of runDirs) {
      const dirPath = path.join(config.evidencePath, runDir);
      const files = await readdir(dirPath).catch(() => [] as string[]);
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const info = await stat(filePath).catch(() => null);
        if (info && info.mtimeMs < cutoff) {
          await unlink(filePath).catch(() => undefined);
          removed++;
        }
      }
    }
  } catch (err) {
    logger.warn('artifact.cleanup_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return removed;
}
