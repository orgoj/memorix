/**
 * Verify FIX-1: Project-level memorix.yml reaches runtime config getters.
 *
 * Before fix: loadYamlConfig() without args ignored project-level config.
 * After fix: initProjectRoot() sets a global default, so all getters work.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadYamlConfig, initProjectRoot, resetYamlConfigCache } from '../../src/config/yaml-loader.js';

describe('Project-level memorix.yml resolution', () => {
  const testDir = join(tmpdir(), 'memorix-test-yml-' + Date.now());
  const ymlPath = join(testDir, 'memorix.yml');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    resetYamlConfigCache();
  });

  afterEach(() => {
    resetYamlConfigCache();
    try { unlinkSync(ymlPath); } catch { /* ignore */ }
  });

  it('loadYamlConfig() without args should NOT find project config before initProjectRoot', () => {
    writeFileSync(ymlPath, 'git:\n  autoHook: true\n  maxDiffSize: 999\n', 'utf-8');
    const cfg = loadYamlConfig();
    // Without initProjectRoot, no project root is known
    expect(cfg.git?.maxDiffSize).not.toBe(999);
  });

  it('loadYamlConfig() without args SHOULD find project config after initProjectRoot', () => {
    writeFileSync(ymlPath, 'git:\n  autoHook: true\n  maxDiffSize: 999\nllm:\n  provider: test-provider\n', 'utf-8');
    initProjectRoot(testDir);
    const cfg = loadYamlConfig();
    expect(cfg.git?.autoHook).toBe(true);
    expect(cfg.git?.maxDiffSize).toBe(999);
    expect(cfg.llm?.provider).toBe('test-provider');
  });

  it('should load nested embedding API settings from memorix.yml', () => {
    writeFileSync(
      ymlPath,
      [
        'embedding:',
        '  provider: api',
        '  model: test-embed-model',
        '  dimensions: 1024',
        '  api:',
        '    baseUrl: http://localhost:11434/v1',
        '    batchSize: 32',
        '    maxConcurrency: 2',
        '    timeout: 120000',
      ].join('\n') + '\n',
      'utf-8',
    );

    initProjectRoot(testDir);
    const cfg = loadYamlConfig();
    expect(cfg.embedding?.provider).toBe('api');
    expect(cfg.embedding?.model).toBe('test-embed-model');
    expect(cfg.embedding?.dimensions).toBe(1024);
    expect(cfg.embedding?.api?.baseUrl).toBe('http://localhost:11434/v1');
    expect(cfg.embedding?.api?.batchSize).toBe(32);
    expect(cfg.embedding?.api?.maxConcurrency).toBe(2);
    expect(cfg.embedding?.api?.timeout).toBe(120000);
  });

  it('explicit projectRoot arg should override globalProjectRoot', () => {
    // Set globalProjectRoot to testDir
    writeFileSync(ymlPath, 'llm:\n  provider: from-global\n', 'utf-8');
    initProjectRoot(testDir);

    // Create a different dir with different config
    const otherDir = join(tmpdir(), 'memorix-test-yml-other-' + Date.now());
    mkdirSync(otherDir, { recursive: true });
    const otherYml = join(otherDir, 'memorix.yml');
    writeFileSync(otherYml, 'llm:\n  provider: from-explicit\n', 'utf-8');

    // Explicit arg should win
    resetYamlConfigCache();
    const cfg = loadYamlConfig(otherDir);
    expect(cfg.llm?.provider).toBe('from-explicit');

    // Cleanup
    try { unlinkSync(otherYml); } catch { /* ignore */ }
  });

  it('initProjectRoot should invalidate cache', () => {
    writeFileSync(ymlPath, 'llm:\n  provider: first\n', 'utf-8');
    initProjectRoot(testDir);
    const cfg1 = loadYamlConfig();
    expect(cfg1.llm?.provider).toBe('first');

    // Update file and re-init
    writeFileSync(ymlPath, 'llm:\n  provider: second\n', 'utf-8');
    initProjectRoot(testDir); // Should invalidate cache
    const cfg2 = loadYamlConfig();
    expect(cfg2.llm?.provider).toBe('second');
  });
});
