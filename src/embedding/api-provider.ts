/**
 * API Embedding Provider
 *
 * Remote embedding via any OpenAI-compatible /v1/embeddings endpoint.
 * Works with OpenAI, DashScope/Qwen, Ollama-compatible gateways, and similar providers.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { EmbeddingProvider } from './provider.js';
import {
  getApiEmbeddingConfig,
  getEmbeddingApiKey,
  getEmbeddingBaseUrl,
  getEmbeddingModel,
  getEmbeddingDimensions,
} from '../config.js';

const CACHE_DIR = process.env.MEMORIX_DATA_DIR || join(homedir(), '.memorix', 'data');
const CACHE_FILE = join(CACHE_DIR, '.embedding-api-cache.json');
const FAILURE_FILE = join(CACHE_DIR, '.embedding-api-failures.json');
const MAX_FAILURES = 3;

const cache = new Map<string, number[]>();
const failures = new Map<string, number>();
let diskCacheDirty = false;
let diskSaveTimer: ReturnType<typeof setTimeout> | null = null;

const DASHSCOPE_MAX_BATCH_SIZE = 10;

function normalizeText(text: string, config: ReturnType<typeof getApiEmbeddingConfig>): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, config.maxInputChars);
}

function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function loadDiskCache(config: ReturnType<typeof getApiEmbeddingConfig>): Promise<void> {
  if (!config.diskCache) return;
  try {
    const raw = await readFile(CACHE_FILE, 'utf-8');
    const entries: [string, number[]][] = JSON.parse(raw);
    for (const [k, v] of entries) cache.set(k, v);
    console.error(`[memorix] Loaded ${entries.length} cached API embeddings from disk`);
  } catch {
    // No cache file or corrupt cache; start fresh.
  }
  try {
    const raw = await readFile(FAILURE_FILE, 'utf-8');
    const entries: [string, number][] = JSON.parse(raw);
    for (const [k, v] of entries) failures.set(k, v);
  } catch {
    // No failure file or corrupt file; start fresh.
  }
}

async function saveDiskCacheNow(): Promise<void> {
  if (!diskCacheDirty) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(Array.from(cache.entries())));
    await writeFile(FAILURE_FILE, JSON.stringify(Array.from(failures.entries())));
    diskCacheDirty = false;
  } catch {
    // Cache persistence is best-effort only.
  }
}

function scheduleDiskSave(config: ReturnType<typeof getApiEmbeddingConfig>): void {
  if (diskSaveTimer) clearTimeout(diskSaveTimer);
  diskSaveTimer = setTimeout(() => {
    saveDiskCacheNow().catch(() => {});
    diskSaveTimer = null;
  }, config.diskSaveDebounce);
}

function cacheSet(hash: string, value: number[], config: ReturnType<typeof getApiEmbeddingConfig>): void {
  if (cache.size >= config.cacheSize) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(hash, value);
  failures.delete(hash);
  diskCacheDirty = true;
}

function markFailure(hash: string): void {
  failures.set(hash, (failures.get(hash) ?? 0) + 1);
  diskCacheDirty = true;
}

function shouldSkipFailed(hash: string): boolean {
  return (failures.get(hash) ?? 0) >= MAX_FAILURES;
}

function clearFailure(hash: string): void {
  if (failures.delete(hash)) {
    diskCacheDirty = true;
  }
}

function markChunkFailed(texts: string[]): void {
  for (const text of texts) {
    markFailure(textHash(text));
  }
}

function clearChunkFailures(texts: string[]): void {
  for (const text of texts) {
    clearFailure(textHash(text));
  }
  diskCacheDirty = true;
}

interface EmbeddingAPIResponse {
  object: string;
  data: Array<{
    object: string;
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

interface APIEmbeddingConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  requestedDimensions: number | null;
}

function isLocalEmbeddingEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(baseUrl);
}

function getPreferredBatchSize(apiConfig: APIEmbeddingConfig, yamlConfig: ReturnType<typeof getApiEmbeddingConfig>): number {
  if (/dashscope\.aliyuncs\.com/i.test(apiConfig.baseUrl)) {
    return DASHSCOPE_MAX_BATCH_SIZE;
  }
  return yamlConfig.batchSize;
}

function parseBatchLimit(error: unknown): number | null {
  if (!(error instanceof Error)) return null;

  const explicit = error.message.match(/should not be larger than\s+(\d+)/i);
  if (explicit) return parseInt(explicit[1], 10);

  if (/batch size/i.test(error.message)) {
    const fallback = error.message.match(/(\d+)/);
    if (fallback) return parseInt(fallback[1], 10);
  }

  return null;
}

export class APIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;

  private config: APIEmbeddingConfig;
  private yamlConfig: ReturnType<typeof getApiEmbeddingConfig>;
  private totalTokensUsed = 0;
  private totalApiCalls = 0;

  private constructor(config: APIEmbeddingConfig, yamlConfig: ReturnType<typeof getApiEmbeddingConfig>, detectedDimensions: number) {
    this.config = config;
    this.yamlConfig = yamlConfig;
    this.dimensions = detectedDimensions;
    this.name = `api-${config.model.replace(/\//g, '-')}`;
  }

  static async create(): Promise<APIEmbeddingProvider> {
    const config = APIEmbeddingProvider.resolveConfig();
    const yamlConfig = getApiEmbeddingConfig();

    await loadDiskCache(yamlConfig);

    const dimensions = await APIEmbeddingProvider.probeAPI(config, yamlConfig);
    console.error(`[memorix] API embedding: ${config.model} @ ${config.baseUrl} (${dimensions}d)`);

    return new APIEmbeddingProvider(config, yamlConfig, dimensions);
  }

  private static resolveConfig(): APIEmbeddingConfig {
    const apiKey = getEmbeddingApiKey();
    let baseUrl = getEmbeddingBaseUrl();
    const model = getEmbeddingModel();
    const requestedDimensions = getEmbeddingDimensions();

    if (!apiKey && !isLocalEmbeddingEndpoint(baseUrl)) {
      throw new Error(
        'No API key for embedding. Set MEMORIX_EMBEDDING_API_KEY, MEMORIX_LLM_API_KEY, or OPENAI_API_KEY, or run `memorix configure`.',
      );
    }

    baseUrl = baseUrl.replace(/\/+$/, '');

    return { apiKey, baseUrl, model, requestedDimensions };
  }

  private static async probeAPI(config: APIEmbeddingConfig, yamlConfig: ReturnType<typeof getApiEmbeddingConfig>): Promise<number> {
    const body: Record<string, unknown> = {
      model: config.model,
      input: 'dimension probe',
    };
    if (config.requestedDimensions) {
      body.dimensions = config.requestedDimensions;
    }

    const response = await fetchWithRetry(
      `${config.baseUrl}/embeddings`,
      config.apiKey,
      body,
      yamlConfig,
    );

    if (response.data.length === 0 || !response.data[0].embedding) {
      throw new Error('API probe returned no embeddings; check model name and API key');
    }

    return response.data[0].embedding.length;
  }

  async embed(text: string): Promise<number[]> {
    const normalized = normalizeText(text, this.yamlConfig);
    const hash = textHash(normalized);
    const cached = cache.get(hash);
    if (cached) return cached;
    if (shouldSkipFailed(hash)) {
      throw new Error(`Embedding skipped after ${MAX_FAILURES} failures`);
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      input: normalized,
    };
    if (this.config.requestedDimensions) {
      body.dimensions = this.config.requestedDimensions;
    }

    let response: EmbeddingAPIResponse;
    try {
      response = await fetchWithRetry(
        `${this.config.baseUrl}/embeddings`,
        this.config.apiKey,
        body,
        this.yamlConfig,
      );
    } catch (error) {
      markFailure(hash);
      scheduleDiskSave(this.yamlConfig);
      throw error;
    }

    const embedding = response.data[0].embedding;
    if (embedding.length !== this.dimensions) {
      markFailure(hash);
      scheduleDiskSave(this.yamlConfig);
      throw new Error(`Expected ${this.dimensions}d, got ${embedding.length}d; dimension mismatch`);
    }

    this.trackUsage(response);
    cacheSet(hash, embedding, this.yamlConfig);
    scheduleDiskSave(this.yamlConfig);
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const normalizedTexts = texts.map(t => normalizeText(t, this.yamlConfig));
    const results: number[][] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    for (let i = 0; i < normalizedTexts.length; i++) {
      const hash = textHash(normalizedTexts[i]);
      const cached = cache.get(hash);
      if (cached) {
        results[i] = cached;
      } else if (shouldSkipFailed(hash)) {
        continue;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(normalizedTexts[i]);
      }
    }

    if (uncachedTexts.length === 0) return results;

    const cacheHitRate = ((texts.length - uncachedTexts.length) / texts.length * 100).toFixed(1);
    console.error(
      `[memorix] API embedding ${uncachedTexts.length}/${texts.length} texts (cache hit: ${cacheHitRate}%)`,
    );

    const processChunk = async (chunkTexts: string[], chunkIndices: number[]): Promise<void> => {
      if (chunkTexts.length === 0) return;

      const body: Record<string, unknown> = {
        model: this.config.model,
        input: chunkTexts,
      };
      if (this.config.requestedDimensions) {
        body.dimensions = this.config.requestedDimensions;
      }

      try {
        const response = await fetchWithRetry(
          `${this.config.baseUrl}/embeddings`,
          this.config.apiKey,
          body,
          this.yamlConfig,
        );

        this.trackUsage(response);
        clearChunkFailures(chunkTexts);

        for (const item of response.data) {
          const originalIdx = chunkIndices[item.index];
          results[originalIdx] = item.embedding;
          cacheSet(textHash(normalizedTexts[originalIdx]), item.embedding, this.yamlConfig);
        }
      } catch (error) {
        const providerLimit = parseBatchLimit(error);
        const fallbackSize = providerLimit ?? Math.ceil(chunkTexts.length / 2);

        if (chunkTexts.length > 1 && fallbackSize < chunkTexts.length) {
          console.error(
            `[memorix] Embedding batch too large for provider, retrying in chunks of ${fallbackSize}`,
          );
          for (let start = 0; start < chunkTexts.length; start += fallbackSize) {
            await processChunk(
              chunkTexts.slice(start, start + fallbackSize),
              chunkIndices.slice(start, start + fallbackSize),
            );
          }
          return;
        }

        markChunkFailed(chunkTexts);
        scheduleDiskSave(this.yamlConfig);
      }
    };

    const preferredBatchSize = getPreferredBatchSize(this.config, this.yamlConfig);
    const chunks: { texts: string[]; indices: number[] }[] = [];
    for (let batchStart = 0; batchStart < uncachedTexts.length; batchStart += preferredBatchSize) {
      chunks.push({
        texts: uncachedTexts.slice(batchStart, batchStart + preferredBatchSize),
        indices: uncachedIndices.slice(batchStart, batchStart + preferredBatchSize),
      });
    }

    for (let ci = 0; ci < chunks.length; ci += this.yamlConfig.maxConcurrency) {
      const concurrentChunks = chunks.slice(ci, ci + this.yamlConfig.maxConcurrency);
      await Promise.all(concurrentChunks.map((chunk) => processChunk(chunk.texts, chunk.indices)));
    }

    scheduleDiskSave(this.yamlConfig);
    return results;
  }

  getStats(): { totalTokens: number; totalApiCalls: number; cacheSize: number } {
    return {
      totalTokens: this.totalTokensUsed,
      totalApiCalls: this.totalApiCalls,
      cacheSize: cache.size,
    };
  }

  private trackUsage(response: EmbeddingAPIResponse): void {
    this.totalApiCalls++;
    if (response.usage) {
      this.totalTokensUsed += response.usage.total_tokens;
    }
  }
}

async function fetchWithRetry(
  url: string,
  apiKey: string | undefined,
  body: Record<string, unknown>,
  config: ReturnType<typeof getApiEmbeddingConfig>,
  attempt = 0,
): Promise<EmbeddingAPIResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Embedding API timeout after ${config.timeout}ms: ${url}`);
    }
    throw err;
  }
  clearTimeout(timeout);

  if (response.ok) {
    return response.json() as Promise<EmbeddingAPIResponse>;
  }

  if ((response.status === 429 || response.status >= 500) && attempt < config.maxRetries) {
    const delay = config.baseDelay * Math.pow(2, attempt);
    const retryAfter = response.headers.get('retry-after');
    const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;
    console.error(`[memorix] Embedding API ${response.status}, retry ${attempt + 1}/${config.maxRetries} in ${waitMs}ms`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    return fetchWithRetry(url, apiKey, body, config, attempt + 1);
  }

  const errorText = await response.text().catch(() => 'unknown error');
  throw new Error(`Embedding API error (${response.status}): ${errorText}`);
}
