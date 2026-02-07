import { describe, expect, it } from 'vitest';
import { writeZipBlob, readZipBlob, writeJson } from '../../src/core/backup/archive';
import { convert } from '../../src/core/service';

describe('convert smoke', () => {
  it('converts a minimal cherry backup to rikka with sidecar', async () => {
    const srcEntries = new Map<string, Uint8Array>();
    writeJson(srcEntries, 'data.json', {
      version: 5,
      localStorage: {},
      indexedDB: {
        topics: [
          {
            id: 'topic-1',
            name: 'Topic',
            assistantId: 'assistant-1',
            messages: [
              {
                id: 'message-1',
                role: 'user',
                createdAt: '2024-01-01T00:00:00.000Z',
                blocks: ['block-1'],
              },
            ],
          },
        ],
        message_blocks: [
          {
            id: 'block-1',
            messageId: 'message-1',
            type: 'main_text',
            content: 'hello',
          },
        ],
        files: [],
      },
    });
    srcEntries.set('Data/Files/.keep', new Uint8Array());

    const inputBlob = await writeZipBlob(srcEntries);
    const inputFile = new File([inputBlob], 'src.zip', { type: 'application/zip' });

    const result = await convert({
      inputFile,
      from: 'auto',
      to: 'rikka',
      redactSecrets: false,
    });

    expect(result.manifest.targetFormat).toBe('rikka');
    const outputEntries = await readZipBlob(result.outputBlob);
    expect(outputEntries.has('settings.json')).toBe(true);
    expect(outputEntries.has('rikka_hub.db')).toBe(true);
    expect(outputEntries.has('cherrikka/manifest.json')).toBe(true);
    expect(outputEntries.has('cherrikka/raw/source.zip')).toBe(true);
  });
});
