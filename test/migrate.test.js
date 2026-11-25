const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('homepage media migration preserves assets and published state on rerun', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viaara-migration-test-'));
  process.env.DB_CLIENT = 'sqlite';
  process.env.SQLITE_PATH = path.join(dir, 'test.sqlite');
  const db = require('../db/db');
  const migrate = require('../db/migrate');
  t.after(async () => {
    await db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await migrate();
  const state = await db('homepage_media_state').where({ id: 1 }).first();
  assert.equal(state.video_asset_id, null);
  assert.equal(state.poster_asset_id, null);

  const asset = {
    id: 'hero-1',
    type: 'hero',
    slot: 1,
    filename: 'hero.mp4',
    url: '/uploads/homepage/hero/hero.mp4',
    mime_type: 'video/mp4',
    file_size: 42
  };
  await db('homepage_media_assets').insert(asset);
  await assert.rejects(db('homepage_media_assets').insert({ ...asset, id: 'hero-2' }), /unique/i);
  await db('homepage_media_state').where({ id: 1 }).update({ video_asset_id: asset.id });

  await migrate();
  assert.equal((await db('homepage_media_assets').select('*')).length, 1);
  assert.equal((await db('homepage_media_state').where({ id: 1 }).first()).video_asset_id, asset.id);
  assert.equal((await db('homepage_media_state').select('*')).length, 1);
});
