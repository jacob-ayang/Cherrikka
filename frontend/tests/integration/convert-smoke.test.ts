import { describe, expect, it } from 'vitest';
import { writeZipBlob, readZipBlob, writeJson } from '../../src/core/backup/archive';
import { convert } from '../../src/core/service';
import { openDatabase } from '../../src/vendor/sql';

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
    expect(outputEntries.has('rikka_hub-wal')).toBe(true);
    expect(outputEntries.has('rikka_hub-shm')).toBe(true);
    expect(outputEntries.has('cherrikka/manifest.json')).toBe(true);
    expect(outputEntries.has('cherrikka/raw/source.zip')).toBe(true);

    const dbBytes = outputEntries.get('rikka_hub.db');
    expect(dbBytes).toBeTruthy();
    const db = await openDatabase(dbBytes!);
    try {
      const stmt = db.prepare('SELECT title FROM ConversationEntity LIMIT 1');
      try {
        expect(stmt.step()).toBe(true);
        const row = stmt.getAsObject() as Record<string, unknown>;
        expect(String(row.title)).toBe('hello');
      } finally {
        stmt.free();
      }
    } finally {
      db.close();
    }
  });

  it('keeps conversation-to-assistant mapping when topic.assistantId is missing', async () => {
    const persist = {
      assistants: {
        defaultAssistant: { id: 'default', name: 'Default' },
        assistants: [
          {
            id: 'default',
            name: 'Default',
            topics: [
              { id: 'topic-1', assistantId: 'default' },
              { id: 'topic-2', assistantId: 'default' },
            ],
          },
          {
            id: 'assistant-special',
            name: 'Special',
            // Simulate stale topic.assistantId; owner assistant should win.
            topics: [{ id: 'topic-3', assistantId: 'default' }],
          },
        ],
      },
      settings: {},
      llm: {},
    } as const;
    const persistRaw = JSON.stringify({
      assistants: JSON.stringify(persist.assistants),
      settings: JSON.stringify(persist.settings),
      llm: JSON.stringify(persist.llm),
    });

    const srcEntries = new Map<string, Uint8Array>();
    writeJson(srcEntries, 'data.json', {
      version: 5,
      localStorage: {
        'persist:cherry-studio': persistRaw,
      },
      indexedDB: {
        topics: [
          {
            id: 'topic-1',
            messages: [{ id: 'message-1', role: 'user', assistantId: 'default', blocks: ['block-1'] }],
          },
          {
            id: 'topic-2',
            messages: [{ id: 'message-2', role: 'user', assistantId: 'default', blocks: ['block-2'] }],
          },
          {
            id: 'topic-3',
            messages: [{ id: 'message-3', role: 'user', assistantId: 'assistant-special', blocks: ['block-3'] }],
          },
        ],
        message_blocks: [
          { id: 'block-1', messageId: 'message-1', type: 'main_text', content: 't1' },
          { id: 'block-2', messageId: 'message-2', type: 'main_text', content: 't2' },
          { id: 'block-3', messageId: 'message-3', type: 'main_text', content: 't3' },
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

    const outputEntries = await readZipBlob(result.outputBlob);
    const dbBytes = outputEntries.get('rikka_hub.db');
    expect(dbBytes).toBeTruthy();
    const db = await openDatabase(dbBytes!);
    try {
      const stmt = db.prepare('SELECT assistant_id AS assistantId, COUNT(*) AS cnt FROM ConversationEntity GROUP BY assistant_id');
      const counts: number[] = [];
      try {
        while (stmt.step()) {
          const row = stmt.getAsObject() as Record<string, unknown>;
          counts.push(Number(row.cnt));
        }
      } finally {
        stmt.free();
      }
      counts.sort((a, b) => a - b);
      expect(counts).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });
});
