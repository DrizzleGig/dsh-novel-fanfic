// 头像来源适配器：Bangumi / AniList / Kitsu 官方角色图，以及 Bing / 百度网页搜图。
//
// 约束（docs/方案-fanfic-0.4.x-2026-11-26.md §4）：
//   - 只用固定 API/搜索端点；不抓任意 URL；不导出 Cookie；不依赖外部插件/CLI。
//   - 用户点击才查；网页搜图一次最多 12 条；不翻页批量。
//   - 本模块只返回候选元数据（URL/标题/来源），不下载图片；下载/缩略图代理在 Host 侧另做。
//   - 测试注入 fetchImpl，不访问网络。

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 2 * 1024 * 1024;
const UA = 'dsh-novel-fanfic/0.4 (local fanfic studio; +https://github.com/DrizzleGig/dsh-novel-fanfic)';

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}

function asText(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function requestText(url, init, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前宿主没有 fetch，无法联网取头像来源');
  const controller = new AbortController();
  const timeoutMs = clampInt(options.timeoutMs, 1000, 60_000, DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        ...(init?.headers || {}),
      },
    });
    if (!res || res.ok === false) {
      const status = res?.status ? ` HTTP ${res.status}` : '';
      throw new Error(`来源请求失败${status}`);
    }
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) throw new Error('来源响应过大');
    return text;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('来源请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(url, init, options = {}) {
  const text = await requestText(url, init, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('来源返回的不是 JSON');
  }
}

function postJson(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// ── 解析：Bangumi ────────────────────────────────────────────────────────────

export function parseBangumiSubjects(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.map((row) => ({
    source: 'bangumi',
    sourceId: String(row.id ?? ''),
    title: asText(row.name_cn || row.name, 180),
    originalTitle: asText(row.name, 180),
    type: row.type === 2 ? 'anime' : row.type === 1 ? 'book' : row.type === 4 ? 'game' : 'other',
    year: Number(String(row.date || row.air_date || '').slice(0, 4)) || null,
    coverUrl: asText(row.images?.medium || row.images?.large || row.images?.common, 1000),
    pageUrl: row.id ? `https://bgm.tv/subject/${row.id}` : '',
    score: Number(row.rating?.score) || null,
  })).filter((row) => row.sourceId && row.title);
}

export function parseBangumiCharacters(json) {
  const rows = Array.isArray(json) ? json : [];
  return rows.map((row) => ({
    source: 'bangumi',
    sourceId: String(row.id ?? ''),
    name: asText(row.name, 120),
    nativeName: '',
    aliases: [],
    role: asText(row.relation, 60) || '角色',
    imageUrl: asText(row.images?.large || row.images?.medium || row.images?.grid, 1000),
    thumbUrl: asText(row.images?.medium || row.images?.grid || row.images?.small, 1000),
    pageUrl: row.id ? `https://bgm.tv/character/${row.id}` : '',
    nsfw: row.nsfw === true,
  })).filter((row) => row.sourceId && row.name);
}

// ── 解析：AniList ────────────────────────────────────────────────────────────

export function parseAniListMedia(json) {
  const rows = Array.isArray(json?.data?.Page?.media) ? json.data.Page.media : [];
  return rows.map((row) => ({
    source: 'anilist',
    sourceId: String(row.id ?? ''),
    title: asText(row.title?.native || row.title?.romaji || row.title?.english, 180),
    originalTitle: asText(row.title?.romaji || row.title?.english, 180),
    type: String(row.type || '').toLowerCase() === 'manga' ? 'manga' : 'anime',
    year: Number(row.startDate?.year) || null,
    coverUrl: asText(row.coverImage?.large || row.coverImage?.medium, 1000),
    pageUrl: row.id ? `https://anilist.co/anime/${row.id}` : '',
    score: Number(row.averageScore) || null,
    nsfw: row.isAdult === true,
  })).filter((row) => row.sourceId && row.title && !row.nsfw);
}

export function parseAniListCharacters(json) {
  const rows = Array.isArray(json?.data?.Media?.characters?.nodes)
    ? json.data.Media.characters.nodes
    : Array.isArray(json?.data?.Page?.characters)
      ? json.data.Page.characters
      : [];
  return rows.map((row) => ({
    source: 'anilist',
    sourceId: String(row.id ?? ''),
    name: asText(row.name?.native || row.name?.full, 120),
    nativeName: asText(row.name?.native, 120),
    aliases: [row.name?.full].filter(Boolean).map((v) => asText(v, 120)),
    role: '角色',
    imageUrl: asText(row.image?.large || row.image?.medium, 1000),
    thumbUrl: asText(row.image?.medium || row.image?.large, 1000),
    pageUrl: row.siteUrl || (row.id ? `https://anilist.co/character/${row.id}` : ''),
    nsfw: row.isAdult === true,
  })).filter((row) => row.sourceId && row.name);
}

// ── 解析：Kitsu ──────────────────────────────────────────────────────────────

export function parseKitsuCharacters(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.map((row) => {
    const a = row.attributes || {};
    const names = a.names || {};
    return {
      source: 'kitsu',
      sourceId: String(row.id ?? ''),
      name: asText(a.canonicalName || a.name || names.en || names.ja_jp, 120),
      nativeName: asText(names.ja_jp, 120),
      aliases: [names.en, names.ja_jp, a.name].filter(Boolean).map((v) => asText(v, 120)),
      role: '角色',
      imageUrl: asText(a.image?.large || a.image?.original, 1000),
      thumbUrl: asText(a.image?.small || a.image?.tiny || a.image?.large, 1000),
      pageUrl: row.id ? `https://kitsu.io/character/${row.id}` : '',
      nsfw: false,
    };
  }).filter((row) => row.sourceId && row.name);
}

// ── 解析：Bing / 百度网页搜图 ────────────────────────────────────────────────

export function parseBingImages(html, limit = 12) {
  const text = String(html ?? '');
  const images = [];
  const murls = [...text.matchAll(/murl(?:&quot;|")\s*:\s*(?:&quot;|")([^"&]+)/g)].map((m) => decodeEntities(m[1]));
  const turls = [...text.matchAll(/turl(?:&quot;|")\s*:\s*(?:&quot;|")([^"&]+)/g)].map((m) => decodeEntities(m[1]));
  for (let i = 0; i < murls.length && images.length < limit; i++) {
    const imageUrl = murls[i];
    if (!/^https?:\/\//i.test(imageUrl)) continue;
    images.push({
      source: 'bing',
      imageUrl,
      thumbUrl: turls[i] || imageUrl,
      title: '',
      pageUrl: '',
    });
  }
  return dedupeImages(images).slice(0, limit);
}

export function parseBaiduImages(json, limit = 12) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const images = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const imageUrl = row.middleURL || row.hoverURL || row.thumbURL || row.objURL;
    const thumbUrl = row.thumbURL || row.middleURL || imageUrl;
    if (!/^https?:\/\//i.test(String(imageUrl || ''))) continue;
    images.push({
      source: 'baidu',
      imageUrl: String(imageUrl),
      thumbUrl: String(thumbUrl),
      title: asText(decodeEntities(row.fromPageTitleEnc || row.fromPageTitle || ''), 120),
      pageUrl: row.fromURL ? String(row.fromURL) : '',
    });
  }
  return dedupeImages(images).slice(0, limit);
}

function dedupeImages(images) {
  const seen = new Set();
  const out = [];
  for (const image of images) {
    const key = image.imageUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(image);
  }
  return out;
}

// ── 搜索：作品 / 角色 / 网页图 ───────────────────────────────────────────────

export async function bangumiSearchWorks(query, options = {}) {
  const json = await requestJson(
    'https://api.bgm.tv/v0/search/subjects',
    postJson({ keyword: String(query), filter: { type: [1, 2, 4] } }),
    options,
  );
  return parseBangumiSubjects(json);
}

export async function bangumiCharacters(subjectId, options = {}) {
  const json = await requestJson(
    `https://api.bgm.tv/v0/subjects/${encodeURIComponent(String(subjectId))}/characters`,
    { method: 'GET' },
    options,
  );
  return parseBangumiCharacters(json);
}

export async function anilistSearchWorks(query, options = {}) {
  const body = {
    query: 'query($s:String){Page(page:1,perPage:6){media(search:$s){id title{romaji native english} type startDate{year} coverImage{large medium} averageScore isAdult}}}',
    variables: { s: String(query) },
  };
  const json = await requestJson('https://graphql.anilist.co', postJson(body), options);
  return parseAniListMedia(json);
}

export async function anilistCharacters(mediaId, options = {}) {
  const body = {
    query: 'query($id:Int){Media(id:$id){characters(page:1,perPage:25,sort:[ROLE,RELEVANCE]){nodes{id name{full native} image{large medium} siteUrl isAdult}}}}',
    variables: { id: Number(mediaId) },
  };
  const json = await requestJson('https://graphql.anilist.co', postJson(body), options);
  return parseAniListCharacters(json);
}

export async function kitsuSearchWorks(query, options = {}) {
  const json = await requestJson(
    `https://kitsu.io/api/edge/anime?filter%5Btext%5D=${encodeURIComponent(String(query))}&page%5Blimit%5D=6`,
    { method: 'GET' },
    options,
  );
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.map((row) => {
    const a = row.attributes || {};
    return {
      source: 'kitsu',
      sourceId: String(row.id ?? ''),
      title: asText(a.canonicalTitle || a.titles?.en || a.titles?.en_jp || a.slug, 180),
      originalTitle: asText(a.titles?.en_jp || a.titles?.ja_jp, 180),
      type: 'anime',
      year: Number(String(a.startDate || '').slice(0, 4)) || null,
      coverUrl: asText(a.coverImage?.large || a.coverImage?.original, 1000),
      pageUrl: row.id ? `https://kitsu.io/anime/${row.id}` : '',
      score: Number(a.averageRating) || null,
    };
  }).filter((row) => row.sourceId && row.title);
}

export async function kitsuCharacters(animeId, options = {}) {
  const json = await requestJson(
    `https://kitsu.io/api/edge/anime/${encodeURIComponent(String(animeId))}/characters?page%5Blimit%5D=25`,
    { method: 'GET' },
    options,
  );
  return parseKitsuCharacters(json);
}

export async function searchWorks(query, options = {}) {
  const q = asText(query, 200);
  if (!q) return { ok: false, works: [], errors: [{ source: 'input', message: 'query 必填' }] };
  const jobs = [
    ['bangumi', bangumiSearchWorks(q, options)],
    ['anilist', anilistSearchWorks(q, options)],
    ['kitsu', kitsuSearchWorks(q, options)],
  ];
  const settled = await Promise.allSettled(jobs.map(([, job]) => job));
  const works = [];
  const errors = [];
  settled.forEach((result, index) => {
    const source = jobs[index][0];
    if (result.status === 'fulfilled') works.push(...result.value);
    else errors.push({ source, message: String(result.reason?.message || result.reason) });
  });
  return { ok: works.length > 0, works, errors };
}

export async function listCharacters(source, sourceId, options = {}) {
  if (source === 'bangumi') return bangumiCharacters(sourceId, options);
  if (source === 'anilist') return anilistCharacters(sourceId, options);
  if (source === 'kitsu') return kitsuCharacters(sourceId, options);
  throw new Error(`不支持的来源：${source}`);
}

export async function searchWebImages(query, options = {}) {
  const q = asText(query, 200);
  if (!q) return { ok: false, engine: options.engine || 'bing', images: [], error: 'query 必填' };
  const engine = options.engine === 'bing' ? 'bing' : 'baidu';
  const limit = clampInt(options.limit, 1, 24, 12);
  try {
    if (engine === 'baidu') {
      const url = 'https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&is=&fp=result'
        + `&word=${encodeURIComponent(q)}&queryWord=${encodeURIComponent(q)}&cl=2&lm=-1&ie=utf-8&oe=utf-8`
        + `&st=-1&z=&ic=&hd=&latest=&copyright=&s=&se=&tab=&width=&height=&face=&istype=&qc=&nc=1&expermode=&nojc=&isAsync=&pn=0&rn=${limit}&gsm=1e`;
      const json = await requestJson(url, { method: 'GET' }, options);
      const images = parseBaiduImages(json, limit);
      return { ok: images.length > 0, engine, images, error: images.length ? '' : '没有解析到结果' };
    }
    const url = `https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=1&count=${limit}&mmasync=1`;
    const html = await requestText(url, { method: 'GET' }, options);
    const images = parseBingImages(html, limit);
    return { ok: images.length > 0, engine, images, error: images.length ? '' : '没有解析到结果' };
  } catch (error) {
    return { ok: false, engine, images: [], error: String(error?.message || error) };
  }
}

// ── 名称匹配（纯函数）────────────────────────────────────────────────────────

export function normalizeName(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

export function scoreName(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.82;
  const min = Math.min(a.length, b.length);
  if (min < 2) return 0;
  const distance = levenshtein(a, b);
  const allowed = min <= 3 ? 1 : 2;
  if (distance <= allowed) return 0.65;
  return 0;
}

function confidenceOf(score) {
  if (score >= 0.9) return 'high';
  if (score >= 0.75) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

function canonForms(character) {
  return [character.name, ...(Array.isArray(character.aliases) ? character.aliases : [])].filter(Boolean);
}

function sourceForms(character) {
  return [character.name, character.nativeName, ...(Array.isArray(character.aliases) ? character.aliases : [])].filter(Boolean);
}

/** 把 canon 人物与来源角色做候选匹配；不自动确认，只返回排序候选。 */
export function matchCharacters(canonCharacters, sourceCharacters) {
  const sources = Array.isArray(sourceCharacters) ? sourceCharacters : [];
  return (Array.isArray(canonCharacters) ? canonCharacters : []).map((character) => {
    const candidates = [];
    for (const source of sources) {
      let best = 0;
      for (const left of canonForms(character)) {
        for (const right of sourceForms(source)) best = Math.max(best, scoreName(left, right));
      }
      if (best > 0) {
        candidates.push({
          ...source,
          score: Number(best.toFixed(3)),
          confidence: confidenceOf(best),
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
    return {
      characterId: character.id,
      name: character.name,
      candidates: candidates.slice(0, 5),
    };
  });
}
