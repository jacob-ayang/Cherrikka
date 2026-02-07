import { describe, expect, it } from 'vitest';
import { readZipBlob, writeJson, writeZipBlob } from '../../src/engine/backup/archive';
import { parseRikkaArchive, validateRikkaArchive } from '../../src/engine/rikka/index';
import { openDatabase } from '../../src/vendor/sql';

describe('rikka managed_files compatibility', () => {
  it('validates backups without managed_files table by checking upload payloads', async () => {
    const dbBytes = await buildDbWithoutManagedFiles();

    const entries = new Map<string, Uint8Array>();
    writeJson(entries, 'settings.json', {
      assistants: [{ id: 'assistant-1', name: 'Assistant One' }],
    });
    entries.set('rikka_hub.db', dbBytes);
    entries.set('upload/demo.txt', new TextEncoder().encode('demo file'));

    const archiveBlob = await writeZipBlob(entries);
    const archiveEntries = await readZipBlob(archiveBlob);

    const result = await validateRikkaArchive(archiveEntries);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain('managed_files table missing; skipping managed file index');
  });

  it('parses backups without managed_files table and keeps upload files as orphan', async () => {
    const dbBytes = await buildDbWithoutManagedFiles();

    const entries = new Map<string, Uint8Array>();
    writeJson(entries, 'settings.json', {
      assistants: [{ id: 'assistant-1', name: 'Assistant One' }],
    });
    entries.set('rikka_hub.db', dbBytes);
    entries.set('upload/demo.txt', new TextEncoder().encode('demo file'));

    const ir = await parseRikkaArchive(entries);
    expect(ir.warnings).toContain('managed_files table missing; skipping managed file index');
    expect(ir.files.some((file) => file.orphan && file.relativeSrc === 'upload/demo.txt')).toBe(true);
  });
});

async function buildDbWithoutManagedFiles(): Promise<Uint8Array> {
  const db = await openDatabase();
  try {
    db.run(
      "CREATE TABLE ConversationEntity (`id` TEXT NOT NULL, `assistant_id` TEXT NOT NULL DEFAULT '0950e2dc-9bd5-4801-afa3-aa887aa36b4e', `title` TEXT NOT NULL, `nodes` TEXT NOT NULL, `create_at` INTEGER NOT NULL, `update_at` INTEGER NOT NULL, `truncate_index` INTEGER NOT NULL DEFAULT -1, `suggestions` TEXT NOT NULL DEFAULT '[]', `is_pinned` INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(`id`))",
    );
    db.run(
      'CREATE TABLE message_node (`id` TEXT NOT NULL, `conversation_id` TEXT NOT NULL, `node_index` INTEGER NOT NULL, `messages` TEXT NOT NULL, `select_index` INTEGER NOT NULL, PRIMARY KEY(`id`))',
    );

    const now = Date.now();
    db.run(
      "INSERT INTO ConversationEntity (id, assistant_id, title, nodes, create_at, update_at, truncate_index, suggestions, is_pinned) VALUES (?, ?, ?, '[]', ?, ?, -1, '[]', 0)",
      ['conversation-1', 'assistant-1', 'demo', now, now],
    );

    const messages = [
      {
        id: 'message-1',
        role: 'assistant',
        parts: [
          {
            type: 'me.rerere.ai.ui.UIMessagePart.Document',
            url: 'file:///data/user/0/me.rerere.rikkahub/files/upload/demo.txt',
          },
        ],
      },
    ];
    db.run(
      'INSERT INTO message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, 0, ?, 0)',
      ['node-1', 'conversation-1', JSON.stringify(messages)],
    );

    return db.export();
  } finally {
    db.close();
  }
}
