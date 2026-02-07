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

  it('falls back assistant chatModelId when source assistant model is missing', () => {
    const [normalized] = normalizeFromCherryConfig({
      'cherry.persistSlices': {
        assistants: {
          assistants: [{ id: 'a1', name: 'A1', prompt: 'hello' }],
        },
        settings: {},
        llm: {
          defaultModel: { id: 'gpt-4o-mini' },
          providers: [
            {
              id: 'p1',
              type: 'openai',
              models: [{ id: 'gpt-4o-mini', modelId: 'gpt-4o-mini', name: 'gpt-4o-mini' }],
            },
          ],
        },
      },
    });

    const ir: BackupIR = {
      sourceApp: 'cherry-studio',
      sourceFormat: 'cherry',
      createdAt: new Date().toISOString(),
      assistants: [],
      conversations: [],
      files: [],
      config: {},
      settings: normalized,
      opaque: {},
      secrets: {},
      warnings: [],
    };

    const [settings] = buildRikkaSettingsFromIR(ir, {});
    const assistants = settings.assistants as Array<Record<string, unknown>>;
    expect(assistants).toHaveLength(1);
    expect(assistants[0].chatModelId).toBeTruthy();
    expect(assistants[0].chatModelId).toBe(settings.chatModelId);
  });

  it('drops invalid assistant mcpServers objects that are not uuid arrays', () => {
    const [normalized] = normalizeFromCherryConfig({
      'cherry.persistSlices': {
        assistants: {
          assistants: [
            {
              id: 'a1',
              name: 'A1',
              prompt: 'hello',
              model: { id: 'gpt-4o-mini' },
              mcpServers: [{ id: 'not-uuid' }],
            },
          ],
        },
        settings: {},
        llm: {
          defaultModel: { id: 'gpt-4o-mini' },
          providers: [
            {
              id: 'p1',
              type: 'openai',
              models: [{ id: 'gpt-4o-mini', modelId: 'gpt-4o-mini', name: 'gpt-4o-mini' }],
            },
          ],
        },
      },
    });

    const ir: BackupIR = {
      sourceApp: 'cherry-studio',
      sourceFormat: 'cherry',
      createdAt: new Date().toISOString(),
      assistants: [],
      conversations: [],
      files: [],
      config: {},
      settings: normalized,
      opaque: {},
      secrets: {},
      warnings: [],
    };

    const [settings, warnings] = buildRikkaSettingsFromIR(ir, {});
    const assistants = settings.assistants as Array<Record<string, unknown>>;
    expect(assistants).toHaveLength(1);
    expect(assistants[0].mcpServers).toBeUndefined();
    expect(warnings).toContain('dropped non-uuid assistant field: mcpServers');
  });

  it('renames duplicated assistant names to avoid conflicts', () => {
    const [normalized] = normalizeFromCherryConfig({
      'cherry.persistSlices': {
        assistants: {
          assistants: [
            { id: 'a1', name: '默认助手', prompt: 'p', model: { id: 'm1' } },
            { id: 'a2', name: '默认助手', prompt: 'p2', model: { id: 'm1' } },
          ],
        },
        settings: {},
        llm: {
          defaultModel: { id: 'm1' },
          providers: [
            {
              id: 'p1',
              type: 'openai',
              models: [{ id: 'm1', modelId: 'm1', name: 'm1' }],
            },
          ],
        },
      },
    });

    const ir: BackupIR = {
      sourceApp: 'cherry-studio',
      sourceFormat: 'cherry',
      createdAt: new Date().toISOString(),
      assistants: [],
      conversations: [],
      files: [],
      config: {},
      settings: normalized,
      opaque: {},
      secrets: {},
      warnings: [],
    };

    const [settings, warnings] = buildRikkaSettingsFromIR(ir, {});
    const assistants = settings.assistants as Array<Record<string, unknown>>;
    expect(assistants).toHaveLength(2);
    expect(assistants[0].name).toBe('默认助手');
    expect(assistants[1].name).toBe('默认助手 (2)');
    expect(warnings).toContain('assistant name conflict renamed: 默认助手 -> 默认助手 (2)');
  });

  it('normalizes unsupported model type to CHAT when building rikka settings', () => {
    const [normalized] = normalizeFromCherryConfig({
      'cherry.persistSlices': {
        assistants: {
          assistants: [{ id: 'a1', name: 'A1', prompt: 'p', model: { id: 'm1' } }],
        },
        settings: {},
        llm: {
          defaultModel: { id: 'm1' },
          providers: [
            {
              id: 'p1',
              type: 'openai',
              models: [{ id: 'm1', type: 'invalid-type' }],
            },
          ],
        },
      },
    });

    const ir: BackupIR = {
      sourceApp: 'cherry-studio',
      sourceFormat: 'cherry',
      createdAt: new Date().toISOString(),
      assistants: [],
      conversations: [],
      files: [],
      config: {},
      settings: normalized,
      opaque: {},
      secrets: {},
      warnings: [],
    };

    const [settings, warnings] = buildRikkaSettingsFromIR(ir, {});
    const providers = settings.providers as Array<Record<string, unknown>>;
    const models = providers[0].models as Array<Record<string, unknown>>;
    expect(models[0].type).toBe('CHAT');
    expect(warnings).toContain('normalized unsupported model type to CHAT: invalid-type');
  });

  it('coerces assistant numeric and boolean fields from string inputs', () => {
    const [normalized] = normalizeFromCherryConfig({
      'cherry.persistSlices': {
        assistants: {
          assistants: [
            {
              id: 'a1',
              name: 'A1',
              prompt: 'p',
              model: { id: 'm1' },
              settings: {
                temperature: '0.7',
                topP: '0.8',
                contextCount: '16',
                streamOutput: 'true',
                maxTokens: '1024',
              },
            },
          ],
        },
        settings: {},
        llm: {
          defaultModel: { id: 'm1' },
          providers: [{ id: 'p1', type: 'openai', models: [{ id: 'm1' }] }],
        },
      },
    });

    const ir: BackupIR = {
      sourceApp: 'cherry-studio',
      sourceFormat: 'cherry',
      createdAt: new Date().toISOString(),
      assistants: [],
      conversations: [],
      files: [],
      config: {},
      settings: normalized,
      opaque: {},
      secrets: {},
      warnings: [],
    };

    const [settings] = buildRikkaSettingsFromIR(ir, {});
    const assistants = settings.assistants as Array<Record<string, unknown>>;
    expect(assistants[0].temperature).toBe(0.7);
    expect(assistants[0].topP).toBe(0.8);
    expect(assistants[0].contextMessageSize).toBe(16);
    expect(assistants[0].streamOutput).toBe(true);
    expect(assistants[0].maxTokens).toBe(1024);
  });
});
