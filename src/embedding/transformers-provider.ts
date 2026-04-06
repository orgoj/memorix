/**
 * Transformers.js Provider
 *
 * Pure JavaScript embedding using @huggingface/transformers (HuggingFace).
 * Model: Xenova/all-MiniLM-L6-v2 (384 dimensions, ~22MB quantized)
 *
 * Key advantages over fastembed:
 *   - No native ONNX binding required (pure JS / WASM)
 *   - Works out-of-the-box on Windows, macOS, Linux
 *   - Supports quantized models (q8, q4) for smaller footprint
 *
 * This is an optional dependency — if @huggingface/transformers is not
 * installed, the provider module gracefully falls back to the next option.
 *
 * Inspired by Mem0's multi-provider embedding architecture.
 */

import type { EmbeddingProvider } from './provider.js';
import { getTransformersConfig } from '../config.js';

// In-memory LRU cache
let cache: Map<string, number[]> | undefined;

export class TransformersProvider implements EmbeddingProvider {
    readonly name: string;
    readonly dimensions: number;

    private extractor: any; // Pipeline instance
    private config: ReturnType<typeof getTransformersConfig>;

    private constructor(extractor: any, config: ReturnType<typeof getTransformersConfig>, modelName: string) {
        this.extractor = extractor;
        this.config = config;
        this.dimensions = config.dimensions;
        this.name = `transformers-${modelName}`;
    }

    /**
     * Initialize the Transformers.js provider.
     * Downloads model on first use (~22MB quantized), cached locally after.
     */
    static async create(): Promise<TransformersProvider> {
        const config = getTransformersConfig();

        // Dynamic import — throws if @huggingface/transformers is not installed
        const { pipeline } = await import('@huggingface/transformers');
        const extractor = await pipeline(
            'feature-extraction',
            config.model,
            { dtype: config.dtype }, // Quantized for small footprint
        );

        // Initialize cache once (module-level singleton)
        if (!cache) {
            cache = new Map();
        }

        // Extract model name for display
        const modelName = config.model.replace('Xenova/', '').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
        return new TransformersProvider(extractor, config, modelName);
    }

    async embed(text: string): Promise<number[]> {
        // Check cache first
        const cached = cache.get(text);
        if (cached) return cached;

        const output = await this.extractor(text, {
            pooling: 'mean',
            normalize: true,
        });

        // output.tolist() returns [[...384 floats]]
        const result: number[] = Array.from(output.tolist()[0]);
        if (result.length !== this.dimensions) {
            throw new Error(`Expected ${this.dimensions}d embedding, got ${result.length}d`);
        }

        this.cacheSet(text, result);
        return result;
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        const results: number[][] = new Array(texts.length);
        const uncachedIndices: number[] = [];
        const uncachedTexts: string[] = [];

        // Check cache for each text
        for (let i = 0; i < texts.length; i++) {
            const cached = cache.get(texts[i]);
            if (cached) {
                results[i] = cached;
            } else {
                uncachedIndices.push(i);
                uncachedTexts.push(texts[i]);
            }
        }

        // Batch embed uncached texts
        if (uncachedTexts.length > 0) {
            const output = await this.extractor(uncachedTexts, {
                pooling: 'mean',
                normalize: true,
            });
            const allVecs: number[][] = output.tolist();

            for (let i = 0; i < allVecs.length; i++) {
                const vec = Array.from(allVecs[i]) as number[];
                const originalIdx = uncachedIndices[i];
                results[originalIdx] = vec;
                this.cacheSet(uncachedTexts[i], vec);
            }
        }

        return results;
    }

    private cacheSet(key: string, value: number[]): void {
        if (cache.size >= this.config.cacheSize) {
            const firstKey = cache.keys().next().value;
            if (firstKey !== undefined) cache.delete(firstKey);
        }
        cache.set(key, value);
    }
}
