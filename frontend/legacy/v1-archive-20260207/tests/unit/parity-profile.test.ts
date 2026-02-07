import { describe, expect, it } from 'vitest';
import { parseParityPath, parseParityProfile, stripJsonByPaths } from '../../src/engine/parity/profile';

describe('parity profile helpers', () => {
  it('parses wildcard paths', () => {
    const tokens = parseParityPath('indexedDB.topics[].messages[].blocks[]');
    expect(tokens).toEqual([
      { kind: 'key', key: 'indexedDB' },
      { kind: 'key', key: 'topics' },
      { kind: 'array' },
      { kind: 'key', key: 'messages' },
      { kind: 'array' },
      { kind: 'key', key: 'blocks' },
      { kind: 'array' },
    ]);
  });

  it('strips configured random fields from nested json', () => {
    const input = {
      time: 12345,
      indexedDB: {
        message_blocks: [
          { id: 'a', createdAt: 'x', toolId: 't', content: 'hello' },
          { id: 'b', createdAt: 'y', toolId: 'u', content: 'world' },
        ],
        topics: [
          {
            messages: [
              { createdAt: 'm1', blocks: ['b1', 'b2'] },
              { createdAt: 'm2', blocks: ['b3'] },
            ],
          },
        ],
      },
    };

    const stripped = stripJsonByPaths(input, [
      'time',
      'indexedDB.message_blocks[].id',
      'indexedDB.message_blocks[].createdAt',
      'indexedDB.message_blocks[].toolId',
      'indexedDB.topics[].messages[].createdAt',
      'indexedDB.topics[].messages[].blocks[]',
    ]);

    expect(stripped).toEqual({
      indexedDB: {
        message_blocks: [
          { content: 'hello' },
          { content: 'world' },
        ],
        topics: [
          {
            messages: [
              { blocks: [] },
              { blocks: [] },
            ],
          },
        ],
      },
    });
  });

  it('parses profile object and drops malformed entries', () => {
    const profile = parseParityProfile({
      json: {
        'data.json': ['time', 'indexedDB.message_blocks[].id'],
        bad: 'x',
      },
      sqlite: {
        'rikka_hub.db': {
          ignoreColumns: {
            ConversationEntity: ['create_at', 'update_at'],
          },
          stripMessageFields: ['id'],
        },
      },
    });

    expect(profile).toEqual({
      json: {
        'data.json': ['time', 'indexedDB.message_blocks[].id'],
      },
      sqlite: {
        'rikka_hub.db': {
          ignoreColumns: {
            ConversationEntity: ['create_at', 'update_at'],
          },
          stripMessageFields: ['id'],
        },
      },
    });
  });
});
