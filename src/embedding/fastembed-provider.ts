/**
 * FastEmbed Provider
 *
 * Local ONNX-based embedding using fastembed (Qdrant).
 * Model: BAAI/bge-small-en-v1.5 (384 dimensions, ~30MB)
 *
 * This is an optional dependency — if fastembed is not installed,
 * the provider module gracefully falls back to fulltext-only search.
 *
 * Persistent disk cache: embeddings are saved to ~/.memorix/data/.embedding-cache.json
 * so server restarts don't need to regenerate them (saves minutes of CPU on 500+ obs).
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { EmbeddingProvider } from './provider.js';
import { getFastEmbedConfig } from '../config.js';

const CACHE_DIR = process.env.MEMORIX_DATA_DIR || join(homedir(), '.memorix', 'data');
const CACHE_FILE = join(CACHE_DIR, '.embedding-cache.json');

// In-memory cache keyed by text hash → embedding
let cache: Map<string, number[]> | undefined;
let diskCacheDirty = false;

function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function loadDiskCache(): Promise<void> {
  try {
    const raw = await readFile(CACHE_FILE, 'utf-8');
    const entries: [string, number[]][] = JSON.parse(raw);
    for (const [k, v] of entries) cache.set(k, v);
    console.error(`[memorix] Loaded ${entries.length} cached embeddings from disk`);
  } catch {
    // No cache file or corrupt — start fresh
  }
}

async function saveDiskCache(): Promise<void> {
  if (!diskCacheDirty) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const entries = Array.from(cache.entries());
    await writeFile(CACHE_FILE, JSON.stringify(entries));
    diskCacheDirty = false;
  } catch {
    // Ignore write errors — cache is an optimization, not critical
  }
}

export class FastEmbedProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;

  private model: { embed: (docs: string[], batchSize?: number) => AsyncGenerator<number[][]>; queryEmbed: (query: string) => Promise<number[]> };
  private config: ReturnType<typeof getFastEmbedConfig>;

  private constructor(model: FastEmbedProvider['model'], config: ReturnType<typeof getFastEmbedConfig>, modelName: string) {
    this.model = model;
    this.config = config;
    this.dimensions = config.dimensions;
    this.name = `fastembed-${modelName}`;
  }

  /**
   * Initialize the FastEmbed provider.
   * Downloads model on first use (~30MB), cached locally after.
   * Loads persistent embedding cache from disk.
   */
  static async create(): Promise<FastEmbedProvider> {
    const config = getFastEmbedConfig();

    // Dynamic import — throws if fastembed is not installed
    const { EmbeddingModel, FlagEmbedding } = await import('fastembed');

    // Map model name from config to EmbeddingModel enum or use as-is for custom models
    let modelConfig;
    if (config.model === 'BGESmallENV15') {
      modelConfig = EmbeddingModel.BGESmallENV15;
    } else {
      // Custom model string
      modelConfig = config.model;
    }

    const model = await FlagEmbedding.init({
      model: modelConfig,
    });

    // Initialize cache once (module-level singleton)
    if (!cache) {
      cache = new Map();
    }

    // Load disk cache before returning — subsequent embedBatch calls will hit cache
    await loadDiskCache();

    // Extract model name for display
    const modelName = config.model.replace(/^BAAI\//, '').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
    return new FastEmbedProvider(model, config, modelName);
  }

  async embed(text: string): Promise<number[]> {
    const hash = textHash(text);
    const cached = cache.get(hash);
    if (cached) return cached;

    const raw = await this.model.queryEmbed(text);
    // Ensure plain number[] (fastembed may return Float32Array)
    const result = Array.from(raw) as number[];
    if (result.length !== this.dimensions) {
      throw new Error(`Expected ${this.dimensions}d embedding, got ${result.length}d`);
    }
    this.cacheSet(hash, result);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    // Check cache for each text (by hash)
    for (let i = 0; i < texts.length; i++) {
      const hash = textHash(texts[i]);
      const cached = cache.get(hash);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    // Batch embed uncached texts
    if (uncachedTexts.length > 0) {
      console.error(`[memorix] Embedding ${uncachedTexts.length}/${texts.length} uncached texts (${texts.length - uncachedTexts.length} from cache)`);
      let batchIdx = 0;
      for await (const batch of this.model.embed(uncachedTexts, this.config.batchSize)) {
        for (const vec of batch) {
          const originalIdx = uncachedIndices[batchIdx];
          const plain = Array.from(vec) as number[];
          results[originalIdx] = plain;
          this.cacheSet(textHash(uncachedTexts[batchIdx]), plain);
          batchIdx++;
        }
      }
      // Persist cache to disk after batch operations
      await saveDiskCache();
    }

    return results;
  }

  private cacheSet(hash: string, value: number[]): void {
    // Evict oldest entries if cache is full
    if (cache.size >= this.config.cacheSize) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(hash, value);
    diskCacheDirty = true;
  }
}
