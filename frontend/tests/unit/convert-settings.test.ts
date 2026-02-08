import { describe, expect, it } from 'vitest';

import { readZipBlob } from '../../src/engine/backup/zip';
import { convert } from '../../src/engine/service';

async function makeCherryZip(providerType: string): Promise<File> {
  const persist = {
    assistants: JSON.stringify({
      assistants: [
        {
          id: 'assistant-1',
          name: 'Imported Assistant',
          prompt: 'hello',
          settings: {
            contextCount: 32,
            streamOutput: true,
            temperature: 0.7,
          },
        },
      ],
    }),
    llm: JSON.stringify({
      providers: [
        {
          id: 'provider-1',
          name: 'Provider',
          type: providerType,
          baseUrl: 'https://example.com',
          models: [
            {
              id: 'model-1',
              modelId: 'model-1',
              name: 'model-1',
              displayName: 'model-1',
            },
          ],
        },
      ],
      defaultModel: {
        id: 'model-1',
        modelId: 'model-1',
      },
      quickModel: {
        id: 'model-1',
        modelId: 'model-1',
      },
      translateModel: {
        id: 'model-1',
        modelId: 'model-1',
      },
      topicNamingModel: {
        id: 'model-1',
        modelId: 'model-1',
      },
    }),
    settings: JSON.stringify({}),
    backup: JSON.stringify({}),
  };
  const data = {
    version: 5,
    time: Date.now(),
    localStorage: {
      'persist:cherry-studio': JSON.stringify(persist),
    },
    indexedDB: {
      topics: [],
      message_blocks: [],
      files: [],
    },
  };

  const { writeZipBlob } = await import('../../src/engine/backup/zip');
  const encoder = new TextEncoder();
  const entries = new Map<string, Uint8Array>([
    ['data.json', encoder.encode(JSON.stringify(data))],
    ['Data/Files/.keep', new Uint8Array()],
  ]);
  const blob = await writeZipBlob(entries);
  return new File([blob], 'fixture-cherry.zip', { type: 'application/zip' });
}

describe('convert settings parity basics', () => {
  it('keeps assistant maxTokens empty and normalizes openai baseUrl to /v1', async () => {
    const input = await makeCherryZip('openai');
    const result = await convert({
      inputFile: input,
      from: 'auto',
      to: 'rikka',
      redactSecrets: false,
    });
    const entries = await readZipBlob(result.outputBlob);
    const settingsRaw = entries.get('settings.json');
    expect(settingsRaw).toBeTruthy();
    const settings = JSON.parse(new TextDecoder().decode(settingsRaw));
    expect(settings.providers[0].baseUrl).toBe('https://example.com/v1');
    expect(settings.assistants[0].maxTokens).toBeUndefined();
  });

  it('maps cherry anthropic provider type to rikka claude', async () => {
    const input = await makeCherryZip('anthropic');
    const result = await convert({
      inputFile: input,
      from: 'auto',
      to: 'rikka',
      redactSecrets: false,
    });
    const entries = await readZipBlob(result.outputBlob);
    const settingsRaw = entries.get('settings.json');
    expect(settingsRaw).toBeTruthy();
    const settings = JSON.parse(new TextDecoder().decode(settingsRaw));
    expect(settings.providers[0].type).toBe('claude');
  });

  it('supports multi-source convert and emits multi-source sidecar', async () => {
    const cherryInput = await makeCherryZip('openai');
    const rikkaSeed = await convert({
      inputFile: cherryInput,
      from: 'auto',
      to: 'rikka',
      redactSecrets: false,
    });
    const rikkaInput = new File([rikkaSeed.outputBlob], 'fixture-rikka.zip', { type: 'application/zip' });

    const merged = await convert({
      inputFiles: [cherryInput, rikkaInput],
      from: 'auto',
      to: 'rikka',
      redactSecrets: false,
      configPrecedence: 'latest',
    });
    const entries = await readZipBlob(merged.outputBlob);
    expect(entries.has('cherrikka/raw/source-1.zip')).toBe(true);
    expect(entries.has('cherrikka/raw/source-2.zip')).toBe(true);

    const manifestRaw = entries.get('cherrikka/manifest.json');
    expect(manifestRaw).toBeTruthy();
    const manifest = JSON.parse(new TextDecoder().decode(manifestRaw));
    expect(Array.isArray(manifest.sources)).toBe(true);
    expect(manifest.sources.length).toBe(2);
  });
});
