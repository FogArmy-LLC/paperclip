import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExistingComment, upsertComment } from '../run-quality-gates.mjs';

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1',
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});


test('Actions migration creates once then updates, preserving legacy comments without /user', async () => {
  const comments = [{ id: 1, user: { login: 'commitperclip[bot]' }, body: 'old — commitperclip' }];
  const writes = [];
  const api = async (path, token, options) => {
    assert.notEqual(path, '/user');
    if (!options) return comments;
    writes.push(options.method);
    if (options.method === 'POST') comments.push({ id: 2, user: { login: 'github-actions[bot]' }, body: JSON.parse(options.body).body });
    else { assert.ok(path.endsWith('/2')); comments[1].body = JSON.parse(options.body).body; }
  };
  for (const body of ['first — commitperclip', 'second — commitperclip']) {
    const found = await findExistingComment(api, 'token', 'owner/repo', 1, 'github-actions[bot]');
    await upsertComment('token', 'owner/repo', 1, body, found, api);
  }
  assert.deepEqual(writes, ['POST', 'PATCH']);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].body, 'old — commitperclip');
  assert.equal(comments[1].body, 'second — commitperclip');
});

test('Actions lookup skips full legacy page and finds signed own comment on next page', async () => {
  const own = { id: 200, user: { login: 'github-actions[bot]' }, body: 'result — commitperclip' };
  const paths = [];
  const found = await findExistingComment(async path => {
    paths.push(path);
    return path.endsWith('page=1') ? Array.from({length:100}, () => ({ user: {login:'commitperclip[bot]'}, body:'old — commitperclip' })) : [own];
  }, 'token', 'owner/repo', 1, 'github-actions[bot]');
  assert.equal(found, own);
  assert.equal(paths.length, 2);
});

test('Unknown posting identity fails before any API call', async () => {
  await assert.rejects(findExistingComment(() => { throw new Error('API must not run'); }, 'token', 'owner/repo', 1, null), /Explicit recognized/);
});
