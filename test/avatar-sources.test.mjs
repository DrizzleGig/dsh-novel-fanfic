import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anilistCharacters,
  bangumiCharacters,
  kitsuCharacters,
  listCharacters,
  matchCharacters,
  parseAniListCharacters,
  parseAniListMedia,
  parseBangumiCharacters,
  parseBangumiSubjects,
  parseBaiduImages,
  parseBingImages,
  parseKitsuCharacters,
  scoreName,
  searchWebImages,
  searchWorks,
} from '../lib/avatar-sources.mjs';

const BANGUMI_SUBJECTS = {
  data: [
    { id: 199425, name: '斗罗大陆', name_cn: '斗罗大陆', type: 2, date: '2018-01-20', images: { medium: 'https://lain.bgm.tv/cover.jpg' }, rating: { score: 6.2 } },
    { id: 1, name: 'Book', name_cn: '书', type: 1, date: '2000', images: {} },
  ],
};

const BANGUMI_CHARACTERS = [
  { id: 61115, name: '唐三', relation: '主角', images: { large: 'https://lain.bgm.tv/tangsan.jpg', medium: 'https://lain.bgm.tv/tangsan-m.jpg' } },
  { id: 61116, name: '小舞', relation: '主角', images: { large: 'https://lain.bgm.tv/xiaowu.jpg' } },
];

const ANILIST_MEDIA = {
  data: {
    Page: {
      media: [
        { id: 101920, title: { native: '斗罗大陆', romaji: 'Douluo Dalu' }, type: 'ANIME', startDate: { year: 2018 }, coverImage: { large: 'https://s4.anilist.co/cover.jpg' }, averageScore: 62 },
        { id: 2, title: { native: '成人' }, type: 'ANIME', isAdult: true },
      ],
    },
  },
};

const ANILIST_CHARACTERS = {
  data: {
    Media: {
      characters: {
        nodes: [
          { id: 142002, name: { full: 'San Tang', native: '唐三' }, image: { large: 'https://s4.anilist.co/tangsan.png', medium: 'https://s4.anilist.co/tangsan-m.png' }, siteUrl: 'https://anilist.co/character/142002' },
          { id: 142008, name: { full: 'Xiaowu', native: '小舞' }, image: { large: 'https://s4.anilist.co/xiaowu.jpg' } },
        ],
      },
    },
  },
};

const KITSU_CHARACTERS = {
  data: [
    { id: '95003', attributes: { canonicalName: 'Tang San', names: { en: 'Tang San', ja_jp: '唐三' }, image: { large: 'https://media.kitsu.app/tangsan.jpeg', small: 'https://media.kitsu.app/tangsan-s.jpeg' } } },
  ],
};

const BING_HTML = 'x murl&quot;:&quot;https://img.example/a.jpg&quot; turl&quot;:&quot;https://tse.example/a.jpg&quot; '
  + 'murl&quot;:&quot;https://img.example/b.jpg&quot; turl&quot;:&quot;https://tse.example/b.jpg&quot; '
  + 'murl&quot;:&quot;https://img.example/a.jpg&quot;';

const BAIDU_JSON = {
  data: [
    { thumbURL: 'https://img0.baidu.com/a-thumb.jpg', middleURL: 'https://img0.baidu.com/a.jpg', fromPageTitleEnc: '唐三', fromURL: 'https://example.com/a' },
    { thumbURL: 'https://img1.baidu.com/b-thumb.jpg', middleURL: 'https://img1.baidu.com/b.jpg' },
    {},
  ],
};

function fakeFetch(routes) {
  return async (url) => {
    for (const [needle, body] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        return { ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
      }
    }
    return { ok: false, status: 404, text: async () => '' };
  };
}

test('解析 Bangumi 作品/角色', () => {
  const works = parseBangumiSubjects(BANGUMI_SUBJECTS);
  assert.equal(works.length, 2);
  assert.deepEqual(works[0], {
    source: 'bangumi', sourceId: '199425', title: '斗罗大陆', originalTitle: '斗罗大陆',
    type: 'anime', year: 2018, coverUrl: 'https://lain.bgm.tv/cover.jpg',
    pageUrl: 'https://bgm.tv/subject/199425', score: 6.2,
  });
  const chars = parseBangumiCharacters(BANGUMI_CHARACTERS);
  assert.equal(chars.length, 2);
  assert.equal(chars[0].name, '唐三');
  assert.equal(chars[0].imageUrl, 'https://lain.bgm.tv/tangsan.jpg');
  assert.equal(chars[0].pageUrl, 'https://bgm.tv/character/61115');
});

test('解析 AniList 作品/角色，过滤成人作品', () => {
  const works = parseAniListMedia(ANILIST_MEDIA);
  assert.equal(works.length, 1);
  assert.equal(works[0].sourceId, '101920');
  assert.equal(works[0].title, '斗罗大陆');
  assert.equal(works[0].year, 2018);
  const chars = parseAniListCharacters(ANILIST_CHARACTERS);
  assert.equal(chars.length, 2);
  assert.equal(chars[0].name, '唐三');
  assert.equal(chars[0].nativeName, '唐三');
  assert.equal(chars[0].imageUrl, 'https://s4.anilist.co/tangsan.png');
});

test('解析 Kitsu 角色（中文名优先）', () => {
  const chars = parseKitsuCharacters(KITSU_CHARACTERS);
  assert.equal(chars.length, 1);
  assert.equal(chars[0].name, 'Tang San');
  assert.equal(chars[0].nativeName, '唐三');
  assert.equal(chars[0].imageUrl, 'https://media.kitsu.app/tangsan.jpeg');
});

test('解析 Bing/百度网页图并去重', () => {
  const bing = parseBingImages(BING_HTML, 12);
  assert.equal(bing.length, 2);
  assert.equal(bing[0].imageUrl, 'https://img.example/a.jpg');
  assert.equal(bing[0].thumbUrl, 'https://tse.example/a.jpg');
  assert.equal(bing[1].imageUrl, 'https://img.example/b.jpg');

  const baidu = parseBaiduImages(BAIDU_JSON, 12);
  assert.equal(baidu.length, 2);
  assert.equal(baidu[0].imageUrl, 'https://img0.baidu.com/a.jpg');
  assert.equal(baidu[0].thumbUrl, 'https://img0.baidu.com/a-thumb.jpg');
  assert.equal(baidu[0].title, '唐三');
});

test('searchWorks 聚合三源；单个来源失败不阻塞', async () => {
  const fetchImpl = fakeFetch({
    'api.bgm.tv/v0/search/subjects': BANGUMI_SUBJECTS,
    'graphql.anilist.co': ANILIST_MEDIA,
    'kitsu.io/api/edge/anime': { data: [] },
  });
  const result = await searchWorks('斗罗大陆', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.works.length, 3);

  const partial = await searchWorks('斗罗大陆', {
    fetchImpl: fakeFetch({ 'api.bgm.tv/v0/search/subjects': BANGUMI_SUBJECTS }),
  });
  assert.equal(partial.ok, true);
  assert.equal(partial.works.length, 2);
  assert.equal(partial.errors.length, 2);
});

test('listCharacters 按来源分派', async () => {
  const fetchImpl = fakeFetch({
    'api.bgm.tv/v0/subjects/199425/characters': BANGUMI_CHARACTERS,
    'graphql.anilist.co': ANILIST_CHARACTERS,
    'kitsu.io/api/edge/anime/101920/characters': KITSU_CHARACTERS,
  });
  assert.equal((await bangumiCharacters('199425', { fetchImpl })).length, 2);
  assert.equal((await anilistCharacters('101920', { fetchImpl })).length, 2);
  assert.equal((await kitsuCharacters('101920', { fetchImpl })).length, 1);
  assert.equal((await listCharacters('bangumi', '199425', { fetchImpl }))[0].name, '唐三');
  await assert.rejects(listCharacters('nope', '1', { fetchImpl }), /不支持的来源/);
});

test('searchWebImages 分别解析 Bing/百度，空结果不假装成功', async () => {
  const bing = await searchWebImages('斗罗大陆 唐三 动画 形象', {
    engine: 'bing',
    fetchImpl: fakeFetch({ 'bing.com/images/async': BING_HTML }),
  });
  assert.equal(bing.ok, true);
  assert.equal(bing.images.length, 2);

  const baidu = await searchWebImages('斗罗大陆 唐三 动画 形象', {
    engine: 'baidu',
    fetchImpl: fakeFetch({ 'image.baidu.com/search/acjson': BAIDU_JSON }),
  });
  assert.equal(baidu.ok, true);
  assert.equal(baidu.images.length, 2);

  const empty = await searchWebImages('x', { engine: 'bing', fetchImpl: fakeFetch({}) });
  assert.equal(empty.ok, false);
  assert.equal(empty.images.length, 0);
});

test('名称匹配：精确/别名/包含/编辑距离；不硬配无关角色', () => {
  assert.equal(scoreName('唐三', '唐 三'), 1);
  assert.ok(scoreName('唐三', '小三') > 0.6);
  assert.ok(scoreName('唐三', '唐三四') > 0.6);
  assert.equal(scoreName('唐三', '小舞'), 0);

  const matched = matchCharacters(
    [
      { id: 'c1', name: '唐三', aliases: ['小三'] },
      { id: 'c2', name: '小舞' },
      { id: 'c3', name: '戴沐白' },
    ],
    [
      { source: 'bangumi', sourceId: '61115', name: '唐三', aliases: [] },
      { source: 'bangumi', sourceId: '61116', name: '小舞', aliases: [] },
      { source: 'bangumi', sourceId: '61117', name: '唐昊', aliases: [] },
    ],
  );
  assert.equal(matched[0].candidates[0].sourceId, '61115');
  assert.equal(matched[0].candidates[0].confidence, 'high');
  assert.equal(matched[1].candidates[0].sourceId, '61116');
  assert.equal(matched[2].candidates.length, 0);
});
