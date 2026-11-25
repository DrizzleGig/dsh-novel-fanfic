import test from 'node:test';
import assert from 'node:assert/strict';
import { safeHongguoClient } from '../lib/hongguo.mjs';

test('红果安全客户端只暴露元数据/弹幕，不暴露 resolvePlayback', async () => {
  const calls = [];
  const fake = {
    search(query, options) { calls.push(['search', query, options]); return Promise.resolve({ items: [] }); },
    getSeries(id) { calls.push(['getSeries', id]); return Promise.resolve({ id }); },
    listEpisodes(id, options) { calls.push(['listEpisodes', id, options]); return Promise.resolve({ items: [] }); },
    listDanmaku(seriesId, episodeId, options) { calls.push(['listDanmaku', seriesId, episodeId, options]); return Promise.resolve({ items: [] }); },
    resolvePlayback() { throw new Error('must not be exposed'); },
  };
  const client = safeHongguoClient(fake);
  assert.deepEqual(Object.keys(client).sort(), ['getSeries', 'listDanmaku', 'listEpisodes', 'search']);
  assert.equal(client.resolvePlayback, undefined);
  await client.search('斗罗大陆', { pageSize: 3 });
  await client.listEpisodes('s1', { pageSize: 3 });
  assert.deepEqual(calls, [
    ['search', '斗罗大陆', { pageSize: 3 }],
    ['listEpisodes', 's1', { pageSize: 3 }],
  ]);
});

test('红果安全客户端拒绝缺方法的客户端', () => {
  assert.throws(() => safeHongguoClient({ search() {} }), /缺少 getSeries/);
  assert.throws(() => safeHongguoClient(null), /不可用/);
});
