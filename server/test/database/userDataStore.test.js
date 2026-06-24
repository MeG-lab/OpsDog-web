import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyMigrations } from '../../src/database/migrations.js';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';
import { createUserDataStore } from '../../src/userDataStore.js';

const withStore = (work) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-user-data-'));
  const database = openSqliteAdapter({ databasePath: path.join(root, 'opsdog.db') });
  try {
    applyMigrations(database, { now: () => '2026-06-15T00:00:00.000Z' });
    database.run(`
      INSERT INTO users
        (id, username, salt, password_hash, iterations, digest, enabled, created_at, updated_at)
      VALUES
        ('user-a', 'alice', 'salt-a', 'hash-a', 120000, 'sha256', 1, 't', 't'),
        ('user-b', 'bob', 'salt-b', 'hash-b', 120000, 'sha256', 1, 't', 't')
    `);
    return work({ database, store: createUserDataStore(database) });
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
};

const conversation = (id, title, messageText) => ({
  id,
  title,
  kind: 'normal',
  modelId: 'model-a',
  createdAt: 1000,
  updatedAt: 2000,
  messages: [{
    id: `${id}-message`,
    role: 'assistant',
    content: messageText,
    timestamp: 1500,
    toolCalls: [{ id: 'tool-1', name: 'diagnose', arguments: { target: 'host' }, status: 'completed' }],
    isStreaming: true,
  }],
});

test('user data store keeps config isolated by user id', () => {
  withStore(({ store }) => {
    store.saveConfig('user-a', {
      llmConfigs: [{ id: 'model-a', provider: 'custom', name: 'A', apiKey: 'key-a', modelName: 'a', maxTokens: 1024, temperature: 0.4 }],
      activeModelId: 'model-a',
      activeWorkspace: 'chat',
    });
    store.saveConfig('user-b', {
      llmConfigs: [{ id: 'model-b', provider: 'custom', name: 'B', apiKey: 'key-b', modelName: 'b', maxTokens: 2048, temperature: 0.2 }],
      activeModelId: 'model-b',
      activeWorkspace: 'settings',
    });

    assert.equal(store.loadConfig('user-a').activeModelId, 'model-a');
    assert.equal(store.loadConfig('user-b').activeModelId, 'model-b');
    assert.equal(store.loadConfig('missing-user').llmConfigs.length, 0);
  });
});

test('user data store persists conversations and strips streaming state', () => {
  withStore(({ store }) => {
    store.saveConversations('user-a', [conversation('conv-a', 'Alice', 'hello alice')]);
    store.saveConversations('user-b', [conversation('conv-b', 'Bob', 'hello bob')]);

    const alice = store.loadConversations('user-a');
    const bob = store.loadConversations('user-b');

    assert.equal(alice.length, 1);
    assert.equal(alice[0].id, 'conv-a');
    assert.equal(alice[0].messages[0].content, 'hello alice');
    assert.equal(alice[0].messages[0].isStreaming, undefined);
    assert.deepEqual(alice[0].messages[0].toolCalls[0].arguments, { target: 'host' });
    assert.equal(bob.length, 1);
    assert.equal(bob[0].id, 'conv-b');
  });
});

test('user data store updates messages without exposing another user conversation', () => {
  withStore(({ store }) => {
    store.saveConversations('user-a', [conversation('shared-id', 'Alice', 'alice original')]);
    store.saveConversations('user-b', [conversation('bob-id', 'Bob', 'bob original')]);

    store.appendConversationMessage('user-a', 'shared-id', {
      id: 'new-message',
      role: 'user',
      content: 'new text',
      timestamp: 3000,
    });
    store.updateConversationMessage('user-a', 'shared-id', 'new-message', { content: 'updated text' });
    store.replaceConversationMessages('user-b', 'bob-id', [{
      id: 'bob-replaced',
      role: 'assistant',
      content: 'replaced',
      timestamp: 4000,
    }]);

    assert.equal(store.loadConversationMessages('user-a', 'shared-id').at(-1).content, 'updated text');
    assert.equal(store.loadConversationMessages('user-b', 'bob-id')[0].id, 'bob-replaced');

    store.deleteConversation('user-a', 'shared-id');
    assert.equal(store.loadConversations('user-a').length, 0);
    assert.equal(store.loadConversations('user-b').length, 1);
  });
});

test('user data store includes the global system announcement conversation for each user', () => {
  withStore(({ store }) => {
    store.saveSystemConversation({
      id: 'system-announcements',
      title: '系统通告',
      kind: 'system',
      systemChannel: 'announcements',
      lastReadAt: 0,
      modelId: 'system',
      createdAt: 100,
      updatedAt: 200,
      messages: [{
        id: 'system-message',
        role: 'system',
        content: 'system notice',
        timestamp: 200,
      }],
    });

    assert.equal(store.loadConversations('user-a')[0].id, 'system-announcements');
    assert.equal(store.loadConversations('user-b')[0].messages[0].content, 'system notice');

    store.appendConversationMessage('user-a', 'system-announcements', {
      id: 'system-message-2',
      role: 'system',
      content: 'new system notice',
      timestamp: 300,
    });
    assert.equal(store.loadConversationMessages('user-b', 'system-announcements').at(-1).content, 'new system notice');
  });
});
