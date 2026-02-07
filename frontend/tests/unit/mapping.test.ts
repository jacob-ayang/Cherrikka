import { describe, expect, it } from 'vitest';
import type { BackupIR } from '../../src/core/ir/types';
import {
  buildRikkaSettingsFromIR,
  normalizeFromCherryConfig,
  normalizeFromRikkaConfig,
} from '../../src/core/mapping/settings';

describe('settings mapping', () => {
  it('normalizes cherry providers to canonical types', () => {
    const [normalized] = normalizeFromCherryConfig({
      'cherry.persistSlices': {
        assistants: {
          assistants: [],
        },
        settings: {},
        llm: {
          providers: [
            { id: 'p1', type: 'openai', name: 'OpenAI' },
            { id: 'p2', type: 'anthropic', name: 'Claude' },
          ],
        },
      },
    });

    const providers = normalized['core.providers'] as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(2);
    expect(providers[0].mappedType).toBe('openai');
    expect(providers[1].mappedType).toBe('claude');
  });

  it('normalizes rikka provider and assistants', () => {
    const [normalized] = normalizeFromRikkaConfig({
      'rikka.settings': {
        providers: [{ id: 'p', type: 'google', name: 'Gemini' }],
        assistants: [{ id: 'a', name: 'A1', systemPrompt: 'x', chatModelId: 'm1' }],
      },
    });

    const providers = normalized['core.providers'] as Array<Record<string, unknown>>;
    const assistants = normalized['core.assistants'] as Array<Record<string, unknown>>;
    expect(providers[0].mappedType).toBe('google');
    expect(assistants[0].name).toBe('A1');
  });

  it('builds rikka settings with mapped provider types', () => {
    const ir: BackupIR = {
      sourceApp: 'cherry-studio',
      sourceFormat: 'cherry',
      createdAt: new Date().toISOString(),
      assistants: [],
      conversations: [],
      files: [],
      config: {},
      settings: {
        'core.providers': [
          {
            id: 'p1',
            name: 'Provider1',
            mappedType: 'openai',
            raw: { apiKey: 'k', models: [] },
          },
        ],
        'core.assistants': [],
        'core.models': { chatModelId: 'm1' },
        'core.selection': {},
        'sync.webdav': {},
        'sync.s3': {},
        'sync.local': {},
        'ui.profile': {},
        search: {},
        mcp: {},
        tts: {},
      },
      opaque: {},
      secrets: {},
      warnings: [],
    };

    const [settings] = buildRikkaSettingsFromIR(ir, {});
    const providers = settings.providers as Array<Record<string, unknown>>;
    expect(providers[0].type).toBe('openai');
    expect(settings.assistantId).toBeTruthy();
  });
});
