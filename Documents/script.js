/* ============ Supabase 初始化 ============ */
const SUPABASE_URL = "https://talcftwpcnemvztfldmc.supabase.co";
const SUPABASE_KEY = "sb_publishable_m3aoIMWt1KMrio8GmqAtaQ_nB8kO2_n";
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ============ 采集层（多代理故障转移 + RSS 直连通道） ============ */
// 链路优先级：同源 Worker（随站点一起部署，最稳）→ 公共 CORS 代理逐个降级。
// 实测（2026-10）：allorigins 已不可用、corsproxy.io 需 key、codetabs 超时，
// cors.eu.org / cors.lol 可用但限流，故必须带超时与自动降级。
const PROXIES = [
  { name: "同源Worker", build: u => `/proxy?url=${encodeURIComponent(u)}`, own: true },
  { name: "allorigins", build: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: "codetabs",   build: u => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}` },
  { name: "cors.eu.org",build: u => `https://cors.eu.org/${u}` },
  { name: "cors.lol",   build: u => `https://api.cors.lol/?url=${encodeURIComponent(u)}` },
  { name: "whateverorigin", build: u => `https://www.whateverorigin.org/get?url=${encodeURIComponent(u)}` },
];
const PROXY_DOWN = new Set();          // 本轮运行内判定不可用的代理，跳过
const PROXY_FAILS = new Map();         // 各代理失败次数（同源 Worker 超时给 2 次机会）
let LAST_PROXY = "";                    // 最近一次成功的代理名（写进任务日志）
let LAST_CHANNEL = "";                  // 最近一次信息源通道（直连 / 代理名）

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function fetchWithTimeout(url, ms = 12000, opts = {}){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, cache: "no-store", signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function isProxyDead(msg){
  return /超时|网络失败|未生效|HTTP 429|HTTP 401|HTTP 403/.test(msg);
}

/* 部分中文站是 GBK/GB2312（如奥数网），meta charset 是 ASCII 字符，
   在 UTF-8 解码结果里就能看到——发现后按声明的编码重解一次 */
function decodeHtmlBuf(buf){
  const utf8 = new TextDecoder("utf-8").decode(buf);
  const m = utf8.match(/charset=["']?(gbk|gb2312|gb18030)/i);
  if (m) {
    try { return new TextDecoder(m[1].toLowerCase()).decode(buf); } catch (e) {}
  }
  return utf8;
}

async function tryProxy(p, target){
  let res;
  try {
    res = await fetchWithTimeout(p.build(target), p.own ? 20000 : 12000);
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "超时" : "网络失败");
  }
  if (p.own) {
    // 同源代理必须带标记头；没有说明 /proxy 没被 Worker 处理（例如 SPA 把它回退成 index.html）
    if (res.headers.get("x-teen-proxy") !== "1") throw new Error("未生效");
    // Worker 抓上游失败会回 502（仍带标记头），必须当失败走降级，否则拿到错误文本解析出 0 条
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } else if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return decodeHtmlBuf(await res.arrayBuffer());
}

function strikeProxy(p, msg){
  const fails = (PROXY_FAILS.get(p.name) || 0) + 1;
  PROXY_FAILS.set(p.name, fails);
  // 同源 Worker 是首选通道：只有确定性失败（未部署/连不上）才踢掉，超时给 2 次机会；
  // 公共代理不稳，一次失败本轮就跳过。
  const definitive = /未生效|网络失败/.test(msg);
  const limit = definitive ? 1 : (p.own ? 2 : 1);
  if (isProxyDead(msg) && fails >= limit) PROXY_DOWN.add(p.name);
}

async function fetchViaProxy(url){
  const errs = [];
  // file:// 打开时 /proxy 会被解析成磁盘路径（file:///D:/proxy…），必然被 CORS 拦下刷屏，直接跳过
  const sameOriginOk = /^https?:$/.test(location.protocol);
  for (const p of PROXIES) {
    if (PROXY_DOWN.has(p.name)) continue;
    if (p.own && !sameOriginOk) continue;
    try {
      const text = await tryProxy(p, url);
      LAST_PROXY = p.name;
      return text;
    } catch (e) {
      errs.push(`${p.name}:${e.message}`);
      strikeProxy(p, e.message);
    }
  }
  throw new Error(`代理全部失败（${errs.join("；") || "本轮可用代理已全部标记为不可用"}）`);
}

/* RSS → JSON 通道：rss2json 自带 CORS 可直连（无需代理）；feed2json 无 CORS 走代理链兜底 */
async function fetchFeedJson(feedUrl){
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`, 8000);
      if (res.ok) {
        const data = await res.json();
        if (data.status === "ok" && Array.isArray(data.items)) {
          LAST_CHANNEL = "rss2json直连";
          return { items: data.items, raw: data };
        }
      }
    } catch (e) { /* 尝试下一个通道 */ }
    await sleep(1500);
  }
  const text = await fetchViaProxy(`https://feed2json.org/convert?url=${encodeURIComponent(feedUrl)}`);
  const data = JSON.parse(text);
  if (data.items) {
    LAST_CHANNEL = `feed2json经${LAST_PROXY}`;
    return { items: data.items, raw: data };
  }
  throw new Error("feed2json 无结果");
}

function feedItemToRaw(it){
  const link = typeof (it.link || it.url) === "string" ? (it.link || it.url) : "";
  const title = String(it.title ?? it.rawTitle ?? "").trim();
  const desc = String(it.description ?? it.summary ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { title, link, desc };
}

/* 大陆不可达域名黑名单：存进 source_url 的链接最终由用户点开，
   指向这些域名的结果直接丢弃（必应会混入境外站点） */
const MAINLAND_BLOCKED_HOST = /(^|\.)(youtube\.com|youtu\.be|google\.com|googleapis\.com|gstatic\.com|goo\.gl|twitter\.com|x\.com|facebook\.com|instagram\.com|wikipedia\.org|nytimes\.com|bbc\.co\.uk|bbc\.com|cnn\.com|bloomberg\.com|reuters\.com|reddit\.com|medium\.com|github\.com|githubusercontent\.com|stackoverflow\.com|quora\.com|amazon\.com|linkedin\.com|tiktok\.com|telegram\.org|whatsapp\.com)$/i;
function isMainlandReachable(u){
  try { return !MAINLAND_BLOCKED_HOST.test(new URL(u).hostname); }
  catch (e) { return false; }
}

/* 标题预过滤（本地规则，先于 AI 清洗执行）：
   搜索引擎会混入与「青少年赛事」无关的泛教育内容——高考报名/查分/志愿、
   教师资格、培训机构广告、留学中介、家长课堂等。这些条目连 AI 都不值得调，
   直接拦下，省 API 也省人工复核成本。
   命中即丢显得武断的（如「竞赛」命中黑词），交给 AI 清洗做最终裁决，这里只拦确定的。 */
const TITLE_BLOCK_PATTERNS = [
  /高考|中考|考研|成人高考|专升本|四六级|雅思|托福|gre|留学|移民|签证/i,
  /教师(资格|招聘|编制)|公务员|事业编|司法考试|注册会计|执业(医师|药师)/,
  /(报名|确认|截止).{0,8}(照片|证件照|摄像|资格审核)|散装照片/i,
  /查分|查成绩|成绩(查询|公布|出炉)|分数线|志愿填报|征集志愿|录取通知/i,
  /(培训|辅导|补习|网课|课程|机构).{0,6}(招生|报名|优惠|简章)|限时.{0,4}(优惠|报名)|免费领(取)?资料/i,
  /(招聘|求职|兼职|实习)(信息|公告)?|工资|薪资待遇/i,
  /(房产|楼盘|装修|招聘|二手|黄页|games?|电影|电视剧|小说)(网|群)?(首页|专题)?\.?(com|cn)?$/i,
];
/* 明确的赛事白名单词：命中且未命中黑名单的，是小概率误伤的兜底放行 */
const TITLE_EVENT_HINTS = /竞赛|大赛|比赛|杯赛|赛事|奥赛|挑战赛|邀请赛|锦标赛|选拔赛|测评|Uoi|Ncan| recruiting| dollar| program|是全国赛|白名单/i;

function isJunkEventTitle(it){
  const text = `${it.rawTitle || ""} ${it.summary || ""}`.slice(0, 120);
  if (!text.trim()) return false;   // 空标题交给后续环节处理
  if (TITLE_BLOCK_PATTERNS.some(r => r.test(text))) {
    // 东方不败式误伤兜底：明显是赛事词就用不着这里拦，直接丢
    const strong = /高考|考研|四六级|雅思|托福|留学|公务员|查分|分数线|志愿填报|广告|招聘/.test(text);
    return strong || !TITLE_EVENT_HINTS.test(text);
  }
  return false;
}

/* 必应结果可能包 ck/a 跳转（u=a1<base64url>），解出真实目标站，避免存下 bing.com 跳板链接 */
function unwrapBingLink(href){
  if (!/bing\.com\/ck\/a/.test(href)) return href;
  try {
    const u = new URL(href).searchParams.get("u") || "";
    if (!u.startsWith("a1")) return href;
    let b64 = u.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const target = new TextDecoder().decode(bytes);
    return /^https?:\/\//.test(target) ? target : href;
  } catch (e) { return href; }
}

/* ============ 大模型清洗（OpenAI 兼容 /chat/completions 接口） ============
   采集到的原始标题格式五花八门（公众号文章标题、带【报名】前缀、带网站后缀），
   交给大模型规范化成赛事名称、生成简介、判定报名状态与信息类型（启事/资讯）。
   API 配置直接写死在代码里（DeepSeek），改 key 改下面一行即可。 */
const LLM_DEFAULT_CFG = { base: "https://api.deepseek.com", key: "sk-5ba8c4409e0d42349282cf468362bfb2", model: "deepseek-chat" };
function loadLLMCfg(){ return { ...LLM_DEFAULT_CFG }; }
async function llmChat(cfg, system, user){
  const url = /\/chat\/completions$/.test(cfg.base) ? cfg.base : `${cfg.base}/chat/completions`;
  const res = await fetchWithTimeout(url, 90000, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [ { role: "system", content: system }, { role: "user", content: user } ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = (j && j.error && j.error.message) || ""; } catch (e) {}
    throw new Error(`接口 HTTP ${res.status}${detail ? `（${String(detail).slice(0, 100)}）` : ""}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) throw new Error("返回空内容");
  return String(text);
}

/* 大模型返回的枚举/自由文本要做校验：
   枚举字段对不上就丢弃（宁可不填，也不要塞进筛选器里一堆脏值），
   自由文本按长度和字符集卡一道。 */
function pickEnum(v, allowed){
  const s = String(v ?? "").trim();
  return allowed.includes(s) ? s : "";
}
function pickPlace(v){
  const s = String(v ?? "").trim();
  return /^[\u4e00-\u9fa5]{2,6}$/.test(s) ? s : "";
}
function pickText(v, maxLen){
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  if (!s || s.length > (maxLen || 30)) return "";
  if (/^(null|undefined|无|未知|不详|不确定)$/i.test(s)) return "";
  return s;
}
/* 每条条目从模型结果里抽取 tl 字段，采集和其它批量任务共用 */
function applyAiFields(it, hit){
  if (typeof hit.summary === "string" && hit.summary.trim()) it.summary = hit.summary.trim();
  if (typeof hit.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(hit.deadline)) it.deadline = hit.deadline;
  if (hit.reg === "OPEN" || hit.reg === "UPCOMING" || hit.reg === "CLOSED") it.regStatus = hit.reg;
  if (hit.kind === "NOTICE" || hit.kind === "NEWS") it.kind = hit.kind;
  const cat = pickEnum(hit.category, CATEGORIES);
  if (cat) it.category = cat;
  const region = pickEnum(hit.region, REGIONS) || pickPlace(hit.region);
  if (region) it.region = region;
  const grade = pickEnum(hit.grade, GRADES);
  if (grade) it.gradeScope = grade;
  const fmt = pickText(hit.format, 20); if (fmt) it.format = fmt;
  const fee = pickText(hit.fee, 20); if (fee) it.fee = fee;
  const prize = pickText(hit.prize, 60); if (prize) it.prize = prize;
  const org = pickText(hit.organizer, 40); if (org) it.organizer = org;
}

async function polishItems(items, cfg){
  const system = "你是青少年赛事信息清洗助手。只输出 JSON 数组，不要 markdown 代码块标记，不要任何解释。";
  let kept = 0, dropped = 0, firstErr = "";
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    const input = batch.map((it, j) => ({ id: j, rawTitle: it.rawTitle, summary: (it.summary || "").slice(0, 200) }));
    const today = new Date().toISOString().slice(0, 10);
    const user = `下面是抓取到的网页条目（今天是 ${today}）。逐条判断：
1. 若与青少年赛事/竞赛/报名/测评/夏令营等活动相关：
   - title：规范化赛事名称，格式「年份 + 赛事正式名称」，去掉【报名】前缀、"-微信公众号"、"点击进入"、来源网站后缀等噪音；
   - summary：60-100 字赛事简介（面向对象、内容、时间地点、费用），只写原文有的信息，禁止编造；
   - deadline：报名截止日期，格式 YYYY-MM-DD，原文能明确推出才填，否则 null，禁止编造；
   - reg：结合截止日期和今天判断报名状态——仍在报名窗口内 "OPEN"、尚未开始 "UPCOMING"、已截止或过期 "CLOSED"；无法判断填 null；
   - kind：判断信息类型——"NOTICE"：报名启事/通知（告诉读者可以去报名：含报名时间、条件、入口、章程发布）；"NEWS"：资讯报道（新闻、获奖名单、政策解读、赛事回顾、盘点等，看完不能直接报名）；
   - category：赛事分类，只能从这个列表里选一个：${CATEGORIES.join(" / ")}；不确定填 null；
   - region：面向地区，优先从「${REGIONS.join(" / ")}」里选，其他省份直接写省名（如"湖北"）；全国性填"全国"；不确定填 null；
   - grade：面向学段，只能从「${GRADES.join(" / ")}」里选一个；不确定填 null；
   - format：参赛形式，如「线上」「线下」「线上初赛+线下决赛」，不超过 10 字；不确定填 null；
   - fee：报名费用，照抄原文写法，如「免费」「200 元」「免费（决赛阶段收费）」；不超过 10 字；不确定填 null；
   - prize：奖项设置，照抄原文写法，不超过 30 字；不确定填 null；
   - organizer：主办方全称，不超过 20 字；不确定填 null。
2. 若明显不是赛事（广告、无关文章）：所有字段均为 null。
原则：宁可保留也不要误删——只要与赛事相关就保留，是否可报名靠 kind 区分；除 title 和 summary 外，任何推不出来的信息一律填 null，禁止编造。
输入：${JSON.stringify(input)}
只输出数组，元素格式 {"id":0,"title":"...","summary":"...","deadline":null,"reg":null,"kind":"NOTICE","category":null,"region":null,"grade":null,"format":null,"fee":null,"prize":null,"organizer":null}，id 与输入对应：`;
    try {
      const text = await llmChat(cfg, system, user);
      const m = text.match(/\[[\s\S]*\]/);
      const arr = JSON.parse(m ? m[0] : text);
      batch.forEach((it, j) => {
        const hit = (Array.isArray(arr) ? arr : []).find(x => x && x.id === j);
        if (hit && typeof hit.title === "string" && hit.title.trim()) {
          it.rawTitle = hit.title.trim();
          applyAiFields(it, hit);
          kept++;
        } else {
          it._drop = true;
          dropped++;
        }
      });
    } catch (e) {
      // 这一批清洗失败：保持原样入库，不影响整轮采集
      if (!firstErr) firstErr = e.message;
    }
    if (i + 10 < items.length) await sleep(600);
  }
  if (kept === 0 && dropped === 0 && firstErr) throw new Error(firstErr);
  const keptItems = items.filter(x => !x._drop);
  keptItems.forEach(x => { delete x._drop; });
  return { items: keptItems, kept, dropped, err: firstErr };
}

async function crawlSogouWechat(keyword){
  const url = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(keyword)}`;
  const html = await fetchViaProxy(url);
  if (html.includes("验证码") || html.includes("antispider") || html.includes("请输入验证码")) {
    throw new Error("搜狗触发验证码，请稍后重试或降低频率");
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items = [];
  doc.querySelectorAll(".news-list li").forEach(li => {
    const a = li.querySelector("h3 a");
    if (!a) return;
    const title = a.textContent.trim();
    const href = a.getAttribute("href") || "";
    const summary = li.querySelector(".txt-info")?.textContent.trim() || "";
    const gzhName = li.querySelector(".account")?.textContent.trim() || "";
    if (!title) return;
    items.push({
      rawTitle: title,
      summary,
      // 搜狗改版或反爬变体下 .account 可能取不到，别把「公众号：」这种半截标签写进库
      sourceName: gzhName ? `公众号：${gzhName}` : "微信公众号",
      sourceUrl: href.startsWith("http") ? href : `https://weixin.sogou.com${href}`,
    });
  });
  return items.slice(0, 10);
}

/* 搜狗通用网页搜索：国内站点、链接为搜狗 /link?url= 站内跳转（国内可达）或直达站 */
async function crawlSogouWebSearch(keyword){
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(keyword)}`;
  const html = await fetchViaProxy(url);
  if (html.includes("antispider") || html.includes("请输入验证码")) {
    throw new Error("搜狗网页触发验证码，请稍后重试");
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items = [];
  doc.querySelectorAll(".vrwrap").forEach(card => {
    const a = card.querySelector("h3.vr-title a");
    if (!a) return;
    const title = a.textContent.trim();
    const href = a.getAttribute("href") || "";
    const summary = card.querySelector(".space-txt, .str_info")?.textContent.trim() || "";
    if (!title || !href) return;
    items.push({
      rawTitle: title,
      summary,
      sourceName: "搜狗网页搜索",
      sourceUrl: href.startsWith("http") ? href : `https://www.sogou.com${href}`,
    });
  });
  if (items.length === 0) throw new Error("搜狗网页返回 0 条（可能触发拦截或页面结构变化）");
  return items.slice(0, 10);
}

async function crawlBaiduSearch(keyword){
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(keyword)}&rn=20`;
  const html = await fetchViaProxy(url);
  if (html.includes("百度安全验证") || html.includes("wappass.baidu.com")) {
    throw new Error("百度触发安全验证，请稍后重试");
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items = [];
  doc.querySelectorAll(".result, .c-container").forEach(el => {
    const a = el.querySelector("h3 a");
    if (!a) return;
    const title = a.textContent.trim();
    const link = a.getAttribute("href") || "";
    const summary = el.querySelector(".c-abstract, .content-right_8Zs40")?.textContent.trim() || "";
    if (title && link.startsWith("http")) {
      items.push({ rawTitle: title, summary, sourceName: "百度搜索", sourceUrl: link });
    }
  });
  return items.slice(0, 10);
}

async function crawlBingSearch(keyword){
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(keyword)}&count=20`;
  const html = await fetchViaProxy(url);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items = [];
  doc.querySelectorAll(".b_algo").forEach(el => {
    const a = el.querySelector("h2 a");
    if (!a) return;
    const title = a.textContent.trim();
    const link = unwrapBingLink(a.getAttribute("href") || "");
    const summary = el.querySelector(".b_caption p, p")?.textContent.trim() || "";
    if (title && link.startsWith("http")) {
      items.push({ rawTitle: title, summary, sourceName: "必应搜索", sourceUrl: link });
    }
  });
  if (items.length === 0) throw new Error("必应返回 0 条（可能触发拦截或页面结构变化）");
  return items.slice(0, 10);
}

/* 360 搜索：SSR 页面，.res-list 卡片 → h3 a */
async function crawl360Search(keyword){
  const url = `https://www.so.com/s?q=${encodeURIComponent(keyword)}`;
  const html = await fetchViaProxy(url);
  if (/请输入验证码|antispider|安全验证|验证中心/.test(html)) {
    throw new Error("360 搜索触发验证码，请稍后重试");
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items = [];
  doc.querySelectorAll(".res-list, .pattern-safety").forEach(card => {
    const a = card.querySelector("h3 a");
    if (!a) return;
    const title = a.textContent.trim();
    const href = a.getAttribute("href") || "";
    const summary = card.querySelector(".res-desc, .res-intro, .res-summary, p")?.textContent.trim() || "";
    if (!title || !href) return;
    items.push({
      rawTitle: title,
      summary,
      sourceName: "360搜索",
      sourceUrl: href.startsWith("http") ? href : `https://www.so.com${href}`,
    });
  });
  if (items.length === 0) throw new Error("360 搜索返回 0 条（可能触发拦截或页面结构变化）");
  return items.slice(0, 10);
}

async function crawlRss(feedUrl){
  try {
    const { items, raw } = await fetchFeedJson(feedUrl);
    return items.slice(0, 10).map(it => {
      const f = feedItemToRaw(it);
      return {
        rawTitle: f.title,
        summary: f.desc.slice(0, 120),
        sourceName: raw?.feed?.title || raw?.metadata?.title || "RSS",
        sourceUrl: f.link,
      };
    }).filter(x => x.rawTitle);
  } catch (err) {
    console.warn("RSS 采集失败:", feedUrl, err.message);
    return [];
  }
}

async function crawlOfficialSite(listUrl, siteName){
  const html = await fetchViaProxy(listUrl);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = new URL(listUrl).origin;
  const items = [];
  doc.querySelectorAll("a").forEach(a => {
    const title = a.textContent.trim();
    const href = a.getAttribute("href") || "";
    if (title.length > 8 && /通知|公告|报名|竞赛|大赛|比赛|选拔|测评/.test(title)) {
      items.push({
        rawTitle: title,
        summary: "",
        sourceName: siteName || new URL(listUrl).hostname,
        sourceUrl: href.startsWith("http") ? href : `${base}${href.startsWith("/") ? "" : "/"}${href}`,
      });
    }
  });
  if (items.length === 0) throw new Error(`${siteName || new URL(listUrl).hostname} 返回 0 条匹配（可能限流或页面结构变化）`);
  return items.slice(0, 15);
}

/* ============ 常量 ============ */
const CATEGORIES = ["编程与信息学","数学","物理","化学","生物","科创与发明","机器人与人工智能","艺术与设计","英语与人文","体育","综合素养"];
const REGIONS = ["全国","北京","上海","广东","浙江","江苏","山东","四川"];
const GRADES = ["小学","初中","高中","小学-初中","初中-高中","全学段"];
const STATUS = { UPCOMING:"即将开始", OPEN:"报名中", CLOSED:"报名截止", ONGOING:"进行中", ENDED:"已结束" };
const REVIEW = { PENDING:"待审核", APPROVED:"已通过", REJECTED:"已拒绝" };
const SOURCE_TYPES = {
  RSS:"RSS 订阅", HTML:"网页抓取", OFFICIAL:"官网公开页",
  CSV:"CSV 导入", JSON:"JSON 导入", MANUAL:"后台手动录入",
  SUBMISSION:"用户投稿",
  SOGOU_WECHAT:"搜狗微信搜索", SOGOU_WEB:"搜狗网页搜索", BAIDU_SEARCH:"百度搜索",
  BING_SEARCH:"必应搜索", SO360_WEB:"360搜索",
};

/* AI 清洗额外产出的赛事属性。以前只产出 标题/简介/截止/报名状态/启事分类，
   分类、地区、学段这些一直是空的，导致赛事库筛选和首页热门分类都筛不出东西。 */
const AI_EXTRA_COLS = ["category","region","grade_scope","format","fee","prize","organizer"];
const RAW_DOC_AI_COLS = ["deadline","reg_status","kind", ...AI_EXTRA_COLS];

/* ============ 数据（空数组，从 Supabase 加载） ============ */
let EVENTS = [];
let SOURCES = [];
let RAW_DOCS = [];
let NEWS_DOCS = [];       // 前台「赛事资讯」频道：raw_docs 里 kind=NEWS 的条目
let CRAWL_JOBS = [];
let PROMOTIONS = [];
let SUBMISSIONS = [];

let ADMIN_LOGGED = false;
let ADMIN_USER = "";
let LOGIN_ERROR = "";
let CRAWL_RUNNING = false;
let AI_PROGRESS = "";     // AI 批量任务的进度（如 "3/8"），显示在按钮文字里
let APP_LOADING = true;
let RAW_FILTER = "ALL";   // 原始数据页筛选：ALL / NOTICE / NEWS / NONE

/* ============ 用户体系 / 收藏订阅 / 举报 / 入驻申请 ============ */
let CURRENT_USER = null;      // { id, username, displayName }，未登录为 null
let SESSION_TOKEN = "";
let FAVORITES = [];           // [{ id, eventId, createdAt }]
let SUBSCRIPTIONS = [];
let REPORTS = [];
let ORG_APPLICATIONS = [];
const VIEWED = new Set();     // 本次会话内已计过浏览量的赛事 id，避免来回切换重复 +1

const SESSION_KEY = "teen_session";
const ADMIN_SESSION_KEY = "teen_admin_login";
const READ_NOTICES_KEY = "teen_read_notices";
const SESSION_DAYS = 30;

const REPORT_REASONS = ["信息已过时 / 已截止", "信息有误（时间、费用、组别等）", "疑似虚假或诈骗", "报名链接失效", "内容重复", "其他"];
const PROMO_SLOTS = [["HOME_BANNER","首页横幅"], ["HOME_RECOMMEND","首页推荐"], ["LIST_TOP","列表置顶"]];
const ORG_KINDS = [["JOIN","入驻"], ["CLAIM","认领赛事"]];

/* ============ 数据映射 ============ */
function mapEvent(e) {
  return {
    id: e.id,
    title: e.title,
    summary: e.summary || "",
    description: e.description || "",
    category: e.category || "",
    region: e.region || "",
    gradeScope: e.grade_scope || "",
    format: e.format || "",
    fee: e.fee || "",
    prize: e.prize || "",
    organizer: e.organizer || "",
    organizationVerified: !!e.organization_verified,
    sourceName: e.source_name || "",
    sourceUrl: e.source_url || "",
    credibilityScore: e.credibility_score ?? 60,
    status: e.status || "OPEN",
    isPromoted: !!e.is_promoted,
    isPinned: !!e.is_pinned,
    isSample: !!e.is_sample,
    registrationEnd: e.registration_end || "",
    eventStart: e.event_start || "",
    viewCount: e.view_count ?? 0,
    favoriteCount: e.favorite_count ?? 0,
    reviewStatus: e.review_status || "PENDING",
    aiBrief: e.ai_brief || "",
    officialUrl: e.official_url || "",
    createdAt: (e.created_at || "").slice(0, 10),
  };
}

function mapSource(s) {
  return {
    id: s.id, name: s.name, url: s.url, type: s.type,
    enabled: !!s.enabled, credibilityScore: s.credibility_score ?? 60,
    lastCrawledAt: s.last_crawled_at ? s.last_crawled_at.slice(0, 16).replace("T", " ") : "—",
  };
}

function mapRawDoc(r) {
  return {
    id: r.id, sourceName: r.source_name || "", sourceUrl: r.source_url || "",
    rawTitle: r.raw_title || "", summary: r.summary || "", status: r.status || "NEW",
    kind: r.kind || "",
    deadline: r.deadline || "", regStatus: r.reg_status || "",
    category: r.category || "", region: r.region || "", gradeScope: r.grade_scope || "",
    format: r.format || "", fee: r.fee || "", prize: r.prize || "", organizer: r.organizer || "",
    fetchedAt: r.fetched_at ? r.fetched_at.slice(0, 16).replace("T", " ") : "",
  };
}

function mapCrawlJob(j) {
  return {
    id: j.id, sourceName: j.source_name || "", trigger: j.trigger || "MANUAL",
    status: j.status || "SUCCESS", totalFound: j.total_found ?? 0, newCount: j.new_count ?? 0,
    log: j.log || "",
    startedAt: j.started_at ? j.started_at.slice(0, 16).replace("T", " ") : "",
    finishedAt: j.finished_at ? j.finished_at.slice(0, 16).replace("T", " ") : "",
  };
}

function mapPromotion(p) {
  return {
    id: p.id, slot: p.slot || "HOME_RECOMMEND", title: p.title || "",
    eventId: p.event_id, weight: p.weight ?? 0, active: !!p.active,
  };
}
/* promotions 和 events 是并行加载的，标题在渲染时再查，避免拿到空 */
function promoEventTitle(p){
  const e = EVENTS.find(x => x.id === p.eventId);
  return e ? e.title : "";
}

function mapSubmission(s) {
  return {
    id: s.id, title: s.title, url: s.url, contact: s.contact, status: s.status,
    description: s.description || "",
    userId: s.user_id || "",
    createdAt: s.created_at ? s.created_at.slice(0, 16).replace("T", " ") : "",
  };
}

/* ============ 数据加载 ============ */
async function loadEvents() {
  const { data, error } = await db.from("events").select("*").order("registration_end", { ascending: true, nullsFirst: false });
  if (error) { console.error("加载赛事失败:", error); throw error; }
  EVENTS = (data || []).map(mapEvent);
}
async function loadSources() {
  const { data, error } = await db.from("sources").select("*").order("created_at");
  if (error) { console.error(error); return; }
  SOURCES = (data || []).map(mapSource);
}
async function loadRawDocs() {
  const { data, error } = await db.from("raw_docs").select("*").order("fetched_at", { ascending: false }).limit(200);
  if (error) { console.error(error); return; }
  RAW_DOCS = (data || []).map(mapRawDoc);
}
/* 前台资讯频道：只取 AI 判定为 NEWS 的条目（新闻报道/获奖名单/政策解读等，看完不能报名的那类） */
async function loadNews() {
  const { data, error } = await db.from("raw_docs").select("*")
    .eq("kind", "NEWS").neq("status", "DISCARDED")
    .order("fetched_at", { ascending: false }).limit(60);
  if (error) { console.error("加载资讯失败:", error.message); return; }
  NEWS_DOCS = (data || []).map(mapRawDoc);
}
async function loadCrawlJobs() {
  const { data, error } = await db.from("crawl_jobs").select("*").order("started_at", { ascending: false }).limit(50);
  if (error) { console.error(error); return; }
  CRAWL_JOBS = (data || []).map(mapCrawlJob);
}
async function loadPromotions() {
  const { data, error } = await db.from("promotions").select("*");
  if (error) { console.error(error); return; }
  PROMOTIONS = (data || []).map(mapPromotion);
}
async function loadSubmissions() {
  const { data, error } = await db.from("submissions").select("*").order("created_at", { ascending: false });
  if (error) { console.error(error); return; }
  SUBMISSIONS = (data || []).map(mapSubmission);
}
async function loadReports() {
  const { data, error } = await db.from("reports").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) { console.error("加载举报失败:", error.message); return; }
  REPORTS = (data || []).map(r => ({
    id: r.id, eventId: r.event_id, eventTitle: r.event_title || "",
    reason: r.reason || "", detail: r.detail || "", status: r.status || "PENDING",
    handlerNote: r.handler_note || "",
    createdAt: (r.created_at || "").slice(0, 16).replace("T", " "),
  }));
}
async function loadOrgApplications() {
  const { data, error } = await db.from("org_applications").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) { console.error("加载入驻申请失败:", error.message); return; }
  ORG_APPLICATIONS = (data || []).map(a => ({
    id: a.id, kind: a.kind || "JOIN", orgName: a.org_name || "", website: a.website || "",
    contactName: a.contact_name || "", contact: a.contact || "", message: a.message || "",
    claimEventId: a.claim_event_id || "", claimEventTitle: a.claim_event_title || "",
    userId: a.user_id || "",
    status: a.status || "PENDING", handlerNote: a.handler_note || "",
    createdAt: (a.created_at || "").slice(0, 16).replace("T", " "),
  }));
}

async function loadAll() {
  await Promise.all([loadEvents(), loadSources(), loadRawDocs(), loadNews(), loadCrawlJobs(), loadPromotions(), loadSubmissions()]);
  // 已登录用户也要加载申请记录：「我的申请」要展示自己提交的入驻 / 认领审核进度
  if (ADMIN_LOGGED || CURRENT_USER) await Promise.all([loadReports(), loadOrgApplications()]);
}

/* ============ 工具 ============ */
function daysUntil(d){ if(!d) return null; const t=new Date(); t.setHours(0,0,0,0); const x=new Date(d); x.setHours(0,0,0,0); return Math.round((x-t)/86400000); }
function credibilityLevel(s){ return s>=85?{label:"高可信",cls:"bg-emerald-50 text-emerald-700"}: s>=60?{label:"中等可信",cls:"bg-sky-50 text-sky-700"}:{label:"待核实",cls:"bg-amber-50 text-amber-700"}; }
function esc(s){ return String(s??"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
/* 官网链接的短显示：去掉协议与末尾斜杠，超长截断 */
function shortUrl(u){ try { const x = new URL(u); const s = (x.hostname + x.pathname).replace(/\/+$/, ""); return s.length > 42 ? s.slice(0, 42) + "…" : s; } catch (e) { return u; } }
/* 来源标签归一化。采集侧只拿到「公众号：」这种半截名字时，直接展示会像是页面坏了 */
function sourceLabel(name){
  const s = String(name ?? "").trim().replace(/[\s：:]+$/, "").trim();
  if (!s) return "公开渠道";
  if (/^公众号$/.test(s)) return "微信公众号";
  return s;
}
/* 白名单赛事：只认名单库来源。核验页要断言「这是白名单赛事」，
   不能把「可信度分数高」当成白名单依据，那会对家长做出错误承诺 */
function isWhitelistEvent(e){
  return !!e && String(e.sourceName||"").includes("白名单");
}
/* 当前 hash 上的查询串（hash 路由里 ? 后面的部分） */
function hashQuery(){
  const h = location.hash.replace(/^#/,"");
  return new URLSearchParams(h.includes("?") ? h.split("?")[1] : "");
}
/* 字符二元组相似度。中文赛事名写法多变（「全国中学生物理奥林匹克竞赛」vs「物理奥赛」），
   直接 includes 匹配不到，用 Dice 系数能容忍这种改写 */
function bigrams(s){
  const t = String(s||"").toLowerCase().replace(/[\s\-—_·・（）()【】\[\]，,。.、:：;；!！?？"'“”‘’]/g, "");
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i+2));
  return out;
}
function diceSim(a, b){
  const A = bigrams(a), B = bigrams(b);
  if (!A.length || !B.length) return a === b ? 1 : 0;
  const pool = new Map();
  A.forEach(g => pool.set(g, (pool.get(g)||0) + 1));
  let hit = 0;
  B.forEach(g => { const n = pool.get(g)||0; if (n > 0) { hit++; pool.set(g, n-1); } });
  return (2 * hit) / (A.length + B.length);
}
/* 泛词查询。家长只输「大赛」也会命中一堆标题，却会被读成「这些就是你要找的比赛」，
   比查不到更误导，所以单独拦掉 */
const GENERIC_QUERIES = ["大赛","比赛","竞赛","赛事","杯赛","活动","挑战赛","邀请赛","锦标赛","全国","中学生","小学生","青少年","少年"];
/* 在已收录的白名单赛事里找最接近的几条。返回空数组只代表「没匹配到」，
   不代表该赛事不正规——名单库仍在扩充中，页面文案必须说清这一点 */
function whitelistMatches(q){
  const query = String(q||"").trim();
  if (query.length < 2 || GENERIC_QUERIES.includes(query)) return [];
  const pool = EVENTS.filter(e => e.reviewStatus === "APPROVED" && isWhitelistEvent(e));
  const qChars = [...new Set(query.split(""))];
  return pool.map(e => {
    const exact = e.title === query;
    const contains = e.title.includes(query) || query.includes(e.title);
    // 短查询按单字覆盖率兜底：「物理奥赛」这种口语说法二元组对不上「物理奥林匹克竞赛」
    const covered = qChars.filter(c => e.title.includes(c)).length / qChars.length;
    const shortBoost = query.length <= 6 && covered >= 0.7 ? 0.55 : 0;
    return { e, score: exact ? 1 : Math.max(diceSim(query, e.title), contains ? 0.62 : 0, shortBoost) };
  }).filter(x => x.score >= 0.45)
    .sort((a,b) => b.score - a.score)
    .slice(0, 3);
}
function nav(hash){ location.hash = hash; }
function now(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }
function todayStr(){ return new Date().toISOString().slice(0,10); }

/* ============ 本地存储 / 密码学 ============ */
function lsGet(key, fallback){
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
  catch (e) { return fallback; }
}
function lsSet(key, val){
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { console.warn("localStorage 写入失败", e); }
}
function lsDel(key){ try { localStorage.removeItem(key); } catch (e) {} }

function bytesToHex(buf){ return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join(""); }
function hexToBytes(hex){
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i*2, 2), 16);
  return out;
}
function randomHex(bytes){
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/* 密码只在浏览器里算出 PBKDF2 加盐哈希再上传，明文不落库。
   需要 https 或 http://127.0.0.1（file:// 下部分浏览器没有 crypto.subtle）。 */
async function pbkdf2(password, saltHex){
  if (!(window.crypto && crypto.subtle)) throw new Error("当前环境不支持加密接口，请用 https 或 http://127.0.0.1 打开");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: 100000, hash: "SHA-256" }, key, 256);
  return bytesToHex(bits);
}

/* 迁移脚本没跑时 SQL 函数不存在，统一吞掉错误，由调用方走降级 */
async function rpcSafe(fn, args){
  try { const { error } = await db.rpc(fn, args); return !error; }
  catch (e) { return false; }
}

/* ============ 注册 / 登录 / 会话 ============ */
function mapUserRow(r){ return r ? { id:r.id, username:r.username, displayName:r.display_name || r.username } : null; }

function requireLogin(action){
  if (CURRENT_USER) return true;
  toast(`请先登录后再${action}`);
  nav("/me");
  return false;
}

/* 登录态存服务端 app_sessions，localStorage 只放 token。
   所以清掉浏览器数据后重新登录即可，收藏/订阅/投稿都还在库里。 */
async function restoreSession(){
  const saved = lsGet(SESSION_KEY, null);
  if (!saved || !saved.token) return;
  if (saved.expiresAt && new Date(saved.expiresAt).getTime() < Date.now()) { lsDel(SESSION_KEY); return; }
  try {
    const { data: sess, error } = await db.from("app_sessions")
      .select("token,user_id,expires_at").eq("token", saved.token).maybeSingle();
    if (error || !sess) { lsDel(SESSION_KEY); return; }
    if (new Date(sess.expires_at).getTime() < Date.now()) {
      await db.from("app_sessions").delete().eq("token", saved.token);
      lsDel(SESSION_KEY);
      return;
    }
    const { data: user, error: ue } = await db.from("app_users")
      .select("id,username,display_name").eq("id", sess.user_id).maybeSingle();
    if (ue || !user) { lsDel(SESSION_KEY); return; }
    CURRENT_USER = mapUserRow(user);
    SESSION_TOKEN = saved.token;
    lsSet(SESSION_KEY, { token: saved.token, userId: user.id, username: user.username, expiresAt: sess.expires_at });
  } catch (e) {
    console.warn("恢复登录态失败（app_users / app_sessions 表可能还没建）:", e.message);
  }
}

async function startSession(user){
  const token = randomHex(24);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  const { error } = await db.from("app_sessions").insert({ token, user_id: user.id, expires_at: expiresAt });
  if (error) throw new Error("会话创建失败：" + dbErrMsg(error));
  CURRENT_USER = mapUserRow(user);
  SESSION_TOKEN = token;
  lsSet(SESSION_KEY, { token, userId: user.id, username: user.username, expiresAt });
}

async function registerUser(username, password, displayName){
  if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,20}$/.test(username)) throw new Error("用户名限 2—20 位中文、字母、数字或下划线");
  if (String(password).length < 6) throw new Error("密码至少 6 位");
  const { data: exist, error: qe } = await db.from("app_users").select("id").eq("username", username).maybeSingle();
  if (qe) throw new Error(dbErrMsg(qe));
  if (exist) throw new Error("该用户名已被注册");
  const salt = randomHex(16);
  const hash = await pbkdf2(password, salt);
  const { data: user, error } = await db.from("app_users")
    .insert({ username, display_name: (displayName || "").trim() || username, pwd_salt: salt, pwd_hash: hash })
    .select("id,username,display_name").single();
  if (error) throw new Error(dbErrMsg(error));
  await startSession(user);
}

async function loginUser(username, password){
  const { data: user, error } = await db.from("app_users").select("*").eq("username", username).maybeSingle();
  if (error) throw new Error(dbErrMsg(error));
  if (!user) throw new Error("用户名或密码错误");
  const hash = await pbkdf2(password, user.pwd_salt);
  if (hash !== user.pwd_hash) throw new Error("用户名或密码错误");
  // 顺手清掉这个账号已经过期的会话，别让表一直长
  try { await db.from("app_sessions").delete().eq("user_id", user.id).lt("expires_at", new Date().toISOString()); } catch (e) {}
  await startSession(user);
}

async function logoutUser(){
  if (SESSION_TOKEN) { try { await db.from("app_sessions").delete().eq("token", SESSION_TOKEN); } catch (e) {} }
  CURRENT_USER = null; SESSION_TOKEN = ""; FAVORITES = []; SUBSCRIPTIONS = [];
  lsDel(SESSION_KEY);
  toast("已退出登录");
  nav("/");
}

/* ============ 收藏 / 订阅 ============ */
async function loadUserData(){
  if (!CURRENT_USER) { FAVORITES = []; SUBSCRIPTIONS = []; return; }
  try {
    const [f, s] = await Promise.all([
      db.from("favorites").select("id,event_id,created_at").eq("user_id", CURRENT_USER.id).order("created_at", { ascending:false }),
      db.from("subscriptions").select("id,event_id,created_at").eq("user_id", CURRENT_USER.id).order("created_at", { ascending:false }),
    ]);
    if (!f.error) FAVORITES = (f.data || []).map(r => ({ id:r.id, eventId:r.event_id, createdAt:(r.created_at||"").slice(0,10) }));
    if (!s.error) SUBSCRIPTIONS = (s.data || []).map(r => ({ id:r.id, eventId:r.event_id, createdAt:(r.created_at||"").slice(0,10) }));
    if (f.error) console.warn("加载收藏失败:", f.error.message);
    if (s.error) console.warn("加载订阅失败:", s.error.message);
  } catch (e) { console.warn("加载收藏/订阅失败:", e.message); }
}

function isFavorited(id){ return FAVORITES.some(f => f.eventId === id); }
function isSubscribed(id){ return SUBSCRIPTIONS.some(s => s.eventId === id); }

async function bumpFavCount(eventId, delta){
  const e = EVENTS.find(x => x.id === eventId);
  if (await rpcSafe("bump_event_favorite", { eid: eventId, delta: delta })) return;
  // 没有 bump_event_favorite 函数时退回读改写（并发下会丢计数，够用）
  if (!e) return;
  try { await db.from("events").update({ favorite_count: Math.max(0, (e.favoriteCount||0) + delta) }).eq("id", eventId); } catch (err) {}
}

async function toggleFavorite(eventId){
  if (!requireLogin("收藏")) return;
  const e = EVENTS.find(x => x.id === eventId);
  const fav = FAVORITES.find(f => f.eventId === eventId);
  if (fav) {
    const { error } = await db.from("favorites").delete().eq("id", fav.id);
    if (error) { toast("取消收藏失败：" + dbErrMsg(error)); return; }
    FAVORITES = FAVORITES.filter(f => f.id !== fav.id);
    await bumpFavCount(eventId, -1);
    if (e) e.favoriteCount = Math.max(0, (e.favoriteCount||0) - 1);
    toast("已取消收藏");
  } else {
    const { error } = await db.from("favorites").insert({ user_id: CURRENT_USER.id, event_id: eventId });
    if (error) { toast("收藏失败：" + dbErrMsg(error)); return; }
    await loadUserData();
    await bumpFavCount(eventId, 1);
    if (e) e.favoriteCount = (e.favoriteCount||0) + 1;
    toast("已收藏，可在个人中心查看");
  }
  render();
}

async function toggleSubscription(eventId){
  if (!requireLogin("订阅提醒")) return;
  const sub = SUBSCRIPTIONS.find(s => s.eventId === eventId);
  if (sub) {
    const { error } = await db.from("subscriptions").delete().eq("id", sub.id);
    if (error) { toast("取消订阅失败：" + dbErrMsg(error)); return; }
    SUBSCRIPTIONS = SUBSCRIPTIONS.filter(s => s.id !== sub.id);
    toast("已取消订阅");
  } else {
    const { error } = await db.from("subscriptions").insert({ user_id: CURRENT_USER.id, event_id: eventId });
    if (error) { toast("订阅失败：" + dbErrMsg(error)); return; }
    await loadUserData();
    toast("已订阅，报名开始与临近截止会在个人中心提醒");
  }
  render();
}

/* ============ 站内通知 ============
   项目没有服务端定时任务，就算建一张 notifications 表也没有东西去写它。
   订阅关系和赛事日期都在库里，前端按当前时间现算，提醒永远是最新的；
   已读状态用 localStorage 记，属于"浏览器偏好"而不是业务数据。 */
function userNotices(){
  if (!CURRENT_USER) return [];
  const read = lsGet(READ_NOTICES_KEY, []);
  const out = [];
  SUBSCRIPTIONS.forEach(s => {
    const e = EVENTS.find(x => x.id === s.eventId);
    if (!e || e.reviewStatus !== "APPROVED") return;
    const d = daysUntil(e.registrationEnd);
    if (d !== null && d >= 0 && d <= 7) {
      out.push({ key:`${e.id}:closing`, eventId: e.id, level: d<=3?"urgent":"warn",
        title: d===0 ? "今天截止报名" : `还有 ${d} 天截止报名`,
        desc: `${e.title} · 报名截止 ${e.registrationEnd}` });
    } else if (e.status === "OPEN" && d !== null && d > 7) {
      out.push({ key:`${e.id}:open`, eventId: e.id, level:"info",
        title:"正在报名中", desc:`${e.title} · 报名截止 ${e.registrationEnd}` });
    } else if (e.status === "UPCOMING") {
      out.push({ key:`${e.id}:upcoming`, eventId: e.id, level:"info",
        title:"报名尚未开始", desc:`${e.title} · 开始报名后会在这里提醒你` });
    }
  });
  out.forEach(n => { n.read = read.includes(n.key); });
  return out.sort((a,b) => (a.read?1:0) - (b.read?1:0));
}
function unreadNoticeCount(){ return userNotices().filter(n => !n.read).length; }
function markNoticeRead(key){
  const read = lsGet(READ_NOTICES_KEY, []);
  if (!read.includes(key)) { read.push(key); lsSet(READ_NOTICES_KEY, read); }
  render();
}
function markAllNoticesRead(){
  lsSet(READ_NOTICES_KEY, userNotices().map(n => n.key));
  render();
}

/* ============ 浏览量 ============ */
async function bumpView(e){
  if (!e || VIEWED.has(e.id)) return;
  VIEWED.add(e.id);
  const next = (e.viewCount || 0) + 1;
  if (!(await rpcSafe("inc_event_view", { eid: e.id }))) {
    try { await db.from("events").update({ view_count: next }).eq("id", e.id); } catch (err) {}
  }
  e.viewCount = next;
  const el = document.getElementById("view-count");
  if (el) el.textContent = next;
}

/* ============ 举报 / 主办方申请 ============ */
async function submitReport(eventId, reason, detail){
  const e = EVENTS.find(x => x.id === eventId);
  if (!reason) { toast("请选择举报原因"); return; }
  const { error } = await db.from("reports").insert({
    event_id: eventId,
    event_title: e ? e.title : "",
    user_id: CURRENT_USER ? CURRENT_USER.id : null,
    reason, detail: detail || "",
    status: "PENDING",
  });
  if (error) { toast("提交失败：" + dbErrMsg(error)); return; }
  closeModal();
  toast("举报已提交，我们会尽快核实");
}

async function submitOrgApplication(payload){
  const { error } = await db.from("org_applications").insert({
    kind: payload.kind || "JOIN",
    org_name: payload.orgName,
    website: payload.website || "",
    contact_name: payload.contactName || "",
    contact: payload.contact || "",
    message: payload.message || "",
    claim_event_id: payload.claimEventId || null,
    claim_event_title: payload.claimEventTitle || "",
    user_id: CURRENT_USER ? CURRENT_USER.id : null,
    status: "PENDING",
  });
  if (error) throw new Error(dbErrMsg(error));
}

/* ============ 图表按需加载（只在数据报告页用到） ============ */
let CHART_JS_PROMISE = null;
function ensureChartJs(){
  if (window.Chart) return Promise.resolve();
  if (!CHART_JS_PROMISE) {
    CHART_JS_PROMISE = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
      s.onload = () => resolve();
      s.onerror = () => { CHART_JS_PROMISE = null; reject(new Error("Chart.js 加载失败（CDN 不可达）")); };
      document.head.appendChild(s);
    });
  }
  return CHART_JS_PROMISE;
}

/* 二维码库同理，只在生成分享图时按需加载；拿不到就退化成纯文字网址 */
let QR_JS_PROMISE = null;
function ensureQrLib(){
  if (window.qrcode) return Promise.resolve(true);
  if (!QR_JS_PROMISE) {
    QR_JS_PROMISE = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
      s.onload = () => resolve(!!window.qrcode);
      s.onerror = () => { QR_JS_PROMISE = null; resolve(false); };
      document.head.appendChild(s);
    });
  }
  return QR_JS_PROMISE;
}

/* ============ 导出 CSV ============ */
function csvCell(v){ const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; }
function downloadText(filename, text){
  const blob = new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* 剪贴板：https 下走异步接口，否则退回 execCommand */
function copyText(text, okMsg){
  const done = () => toast(okMsg || "已复制");
  const fallback = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove(); done();
    } catch (e) { toast("复制失败，请手动选中复制"); }
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

/* ============ 通用组件 ============ */
function Badge(text, cls){ return `<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}">${esc(text)}</span>`; }
function BadgeCategory(c){ return Badge(c, "bg-slate-100 text-slate-700"); }
function BadgeStatus(s){ const m={OPEN:"bg-emerald-100 text-emerald-700",UPCOMING:"bg-sky-100 text-sky-700",CLOSED:"bg-slate-200 text-slate-600",ONGOING:"bg-indigo-100 text-indigo-700",ENDED:"bg-slate-200 text-slate-500"}; return Badge(STATUS[s]||s, m[s]||"bg-slate-100 text-slate-700"); }
function BadgeReview(s){ const m={PENDING:"bg-amber-100 text-amber-700",APPROVED:"bg-emerald-100 text-emerald-700",REJECTED:"bg-rose-100 text-rose-700"}; return Badge(REVIEW[s]||s, m[s]||"bg-slate-100 text-slate-700"); }
function BadgeSample(){ return Badge("示例数据", "border border-dashed border-slate-300 bg-slate-50 text-slate-500"); }
function BadgeVerified(){ return Badge("✓ 认证主办方", "bg-sky-600 text-white"); }
function BadgeCred(s){ const l=credibilityLevel(s); return Badge("可信度 "+s+" · "+l.label, l.cls); }
function BadgePromoted(){ return Badge("★ 推广", "bg-amber-100 text-amber-700"); }
function BadgePinned(){ return Badge("置顶", "border border-slate-300 text-slate-600"); }

/* ============ 弹窗与表单（后台增删改、举报、认领都用这一套） ============ */
let MODAL = null;   // { title, body, saveLabel, onSave, wide }

function openModal(cfg){ MODAL = cfg; paintModal(); }
function closeModal(){
  MODAL = null;
  const root = document.getElementById("modal-root");
  if (root) root.innerHTML = "";
}
function paintModal(){
  const root = document.getElementById("modal-root");
  if (!root) return;
  if (!MODAL) { root.innerHTML = ""; return; }
  root.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 py-10" onclick="if(event.target===this)closeModal()">
      <div class="w-full ${MODAL.wide?"max-w-3xl":"max-w-lg"} rounded-lg bg-white shadow-xl">
        <div class="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <p class="text-base font-semibold">${esc(MODAL.title)}</p>
          <button onclick="closeModal()" class="rounded px-2 py-1 text-sm text-slate-400 hover:bg-slate-100">✕</button>
        </div>
        <div id="modal-body" class="max-h-[70vh] overflow-y-auto p-5 space-y-4">${MODAL.body||""}</div>
        <div class="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button onclick="closeModal()" class="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">取消</button>
          ${MODAL.onSave?`<button id="modal-save" onclick="runModalSave()" class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">${esc(MODAL.saveLabel||"保存")}</button>`:""}
        </div>
      </div>
    </div>`;
}
async function runModalSave(){
  if (!MODAL || !MODAL.onSave) return;
  const btn = document.getElementById("modal-save");
  if (btn) { btn.disabled = true; btn.textContent = "处理中…"; }
  try { await MODAL.onSave(); }
  catch (e) { toast("操作失败：" + dbErrMsg(e)); }
  finally { if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = (MODAL && MODAL.saveLabel) || "保存"; } }
}

function fInput(name, label, val, opts){
  const o = opts || {};
  return `<div class="space-y-1 ${o.full?"sm:col-span-2":""}">
    <label class="text-sm font-medium">${esc(label)}${o.required?' <span class="text-rose-600">*</span>':""}</label>
    <input data-f="${name}" type="${o.type||"text"}" value="${esc(val??"")}" placeholder="${esc(o.placeholder||"")}"
      class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
  </div>`;
}
function fArea(name, label, val, rows){
  return `<div class="space-y-1 sm:col-span-2">
    <label class="text-sm font-medium">${esc(label)}</label>
    <textarea data-f="${name}" rows="${rows||3}" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">${esc(val??"")}</textarea>
  </div>`;
}
function fSelect(name, label, val, options){
  return `<div class="space-y-1">
    <label class="text-sm font-medium">${esc(label)}</label>
    <select data-f="${name}" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
      ${options.map(([v,l])=>`<option value="${esc(v)}" ${String(v)===String(val??"")?"selected":""}>${esc(l)}</option>`).join("")}
    </select>
  </div>`;
}
function fCheck(name, label, checked){
  return `<label class="flex items-center gap-2 pb-2 text-sm">
    <input data-f="${name}" type="checkbox" ${checked?"checked":""} class="h-4 w-4 rounded border-slate-300">
    <span>${esc(label)}</span>
  </label>`;
}
function readModalForm(){
  const out = {};
  document.querySelectorAll("#modal-body [data-f]").forEach(el => {
    out[el.getAttribute("data-f")] = el.type === "checkbox" ? el.checked : el.value;
  });
  return out;
}
function isUuid(v){ return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v||"")); }

/* ============ 卡片 ============ */
function EventCard(e){
  const d = daysUntil(e.registrationEnd);
  const urgent = d!==null && d>=0 && d<=7;
  return `
  <div class="group flex h-full flex-col rounded-lg border border-slate-200 bg-white shadow-sm transition hover:shadow-md">
    <div class="space-y-3 p-5 pb-3">
      <div class="flex flex-wrap items-center gap-2">
        ${BadgeCategory(e.category || "未分类")} ${BadgeStatus(e.status)}
        ${e.isPromoted||e._listTop?BadgePromoted():""} ${e.isPinned?BadgePinned():""}
      </div>
      <a href="#/events/${e.id}" class="line-clamp-2 block text-base font-semibold leading-snug text-slate-900 hover:text-blue-600">${esc(e.title)}</a>
    </div>
    <div class="flex-1 space-y-3 px-5 pb-3">
      <p class="line-clamp-2 text-sm text-slate-500">${esc(e.summary)}</p>
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>📍 ${esc([e.region, e.format].filter(Boolean).join(" · ") || "地区待定")}</span>
        <span>🗓 ${e.registrationEnd?`截止 ${esc(e.registrationEnd)}`:isWhitelistEvent(e)?"报名时间待官方公布":"截止时间待定"} ${urgent?`<span class="ml-1 font-medium text-amber-600">剩 ${d} 天</span>`:""}</span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        ${BadgeCred(e.credibilityScore)}
        ${e.organizationVerified?BadgeVerified():""}
        ${e.isSample?BadgeSample():""}
      </div>
    </div>
    <div class="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
      <span class="truncate">来源：${esc(sourceLabel(e.sourceName))}</span>
      <span class="shrink-0">${esc(e.fee)}</span>
    </div>
  </div>`;
}

/* ============ 前台 ============ */
let MOBILE_NAV_OPEN = false;
function toggleMobileNav(){ MOBILE_NAV_OPEN = !MOBILE_NAV_OPEN; render(); }

function MobileNav(items){
  if (!MOBILE_NAV_OPEN) return "";
  return `
  <div class="border-b border-slate-200 bg-white lg:hidden">
    <nav class="mx-auto flex max-w-7xl flex-col px-4 py-2">
      ${items.map(([h,l])=>{
        const active = h==="/" ? location.hash.replace(/^#/,"")==="/" : location.hash.replace(/^#/,"").startsWith(h);
        return `<a href="#${h}" onclick="toggleMobileNav()" class="rounded-md px-3 py-2.5 text-sm font-medium ${active?"bg-slate-100 text-slate-900":"text-slate-600 hover:bg-slate-100"}">${l}</a>`;
      }).join("")}
    </nav>
  </div>`;
}

function SiteHeader(){
  const hash = location.hash.replace(/^#/,"") || "/";
  const items = [["/","首页"],["/check","白名单核验"],["/events","赛事库"],["/calendar","赛事日历"],["/news","赛事资讯"],["/report","数据报告"],["/submit","信息收集"],["/org","主办方入驻"],["/about","关于"]];
  const navs = items.map(([h,l])=>{
    const active = h==="/" ? hash==="/" : hash.startsWith(h);
    return `<a href="#${h}" class="whitespace-nowrap rounded-md px-2.5 py-2 text-sm font-medium transition ${active?"bg-slate-100 text-slate-900":"text-slate-500 hover:bg-slate-100 hover:text-slate-900"}">${l}</a>`;
  }).join("");
  const unread = CURRENT_USER ? unreadNoticeCount() : 0;
  const meLabel = CURRENT_USER ? `${esc(CURRENT_USER.displayName)}` : "登录 / 注册";
  return `
  <header class="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
    <div class="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4">
      <a href="#/" class="flex items-center gap-2">
        <img src="logo.svg" alt="" class="h-8 w-8">
        <span class="hidden text-sm font-semibold sm:inline">青少年赛事聚合</span>
      </a>
      <nav class="hidden items-center gap-1 lg:flex">${navs}</nav>
      <div class="ml-auto flex items-center gap-2">
        <input placeholder="搜索赛事…" class="hidden w-44 rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500 md:block lg:hidden xl:block"
          onkeydown="if(event.key==='Enter'){location.hash='/events?k='+encodeURIComponent(this.value)}">
        <a href="#/me" class="relative hidden max-w-[9rem] truncate rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 sm:inline-block">${meLabel}${unread?`<span class="ml-1 rounded-full bg-rose-600 px-1.5 py-0.5 text-xs text-white">${unread}</span>`:""}</a>
        <!-- 后台入口不放在公开导航里，仍可通过 #/admin/login 直达 -->
        <a href="#/events" class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">找赛事</a>
        <button onclick="toggleMobileNav()" aria-label="菜单" class="rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
        </button>
      </div>
    </div>
    ${MobileNav([...items, ["/me", CURRENT_USER ? `个人中心（${esc(CURRENT_USER.displayName)}）` : "登录 / 注册"]])}
  </header>`;
}
function SiteFooter(){
  return `
  <footer class="mt-16 border-t border-slate-200 bg-slate-50">
    <div class="mx-auto grid max-w-7xl gap-8 px-4 py-10 md:grid-cols-4">
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <img src="logo.svg" alt="" class="h-7 w-7">
          <p class="text-sm font-semibold">青少年赛事信息聚合平台</p>
        </div>
        <p class="text-xs text-slate-500">赛事信息来自公开渠道聚合，请以主办方官方公告为准。</p>
      </div>
      <div class="space-y-2">
        <p class="text-sm font-semibold">用户</p>
        <ul class="space-y-1 text-xs text-slate-500">
          <li><a href="#/events">赛事库</a></li><li><a href="#/calendar">赛事日历</a></li>
          <li><a href="#/news">赛事资讯</a></li><li><a href="#/report">数据报告</a></li><li><a href="#/submit">赛事投稿</a></li>
          <li><a href="#/me">个人中心</a></li>
        </ul>
      </div>
      <div class="space-y-2">
        <p class="text-sm font-semibold">合作</p>
        <ul class="space-y-1 text-xs text-slate-500">
          <li><a href="#/org">主办方入驻 / 认领</a></li><li><a href="#/report">数据报告</a></li>
        </ul>
      </div>
      <div class="space-y-2">
        <p class="text-sm font-semibold">说明</p>
        <ul class="space-y-1 text-xs text-slate-500">
          <li><a href="#/about">关于我们</a></li><li><a href="#/about">免责声明</a></li><li><a href="#/about">来源说明</a></li>
          <li><a href="#/faq" class="text-blue-600 hover:underline">常见问题 Q&A</a></li>
        </ul>
      </div>
    </div>
    <div class="border-t border-slate-200">
      <div class="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-slate-500 sm:flex-row">
        <span>© 2026 青少年赛事信息聚合平台</span>
        <span>各条赛事的信息来源以详情页标注为准</span>
      </div>
    </div>
  </footer>`;
}

/* 首页推荐位：优先读 promotions 表（active，按 weight 降序），
   同时兼容老的 events.is_promoted 标记，两边合并去重。 */
function promotedEvents(limit){
  const promos = PROMOTIONS
    .filter(p => p.active && p.slot === "HOME_RECOMMEND")
    .sort((a,b) => (b.weight||0) - (a.weight||0));
  const byPromo = promos.map(p => EVENTS.find(e => e.id === p.eventId && e.reviewStatus === "APPROVED")).filter(Boolean);
  const byFlag = EVENTS.filter(e => e.reviewStatus === "APPROVED" && e.isPromoted);
  const merged = [...byPromo, ...byFlag].filter((e,i,a) => a.findIndex(x => x.id === e.id) === i);
  return merged.slice(0, limit || 4);
}
function activeBanner(){
  return PROMOTIONS.filter(p => p.active && p.slot === "HOME_BANNER")
    .sort((a,b) => (b.weight||0) - (a.weight||0))[0] || null;
}
function listTopIds(){
  return PROMOTIONS.filter(p => p.active && p.slot === "LIST_TOP").map(p => p.eventId);
}

function PageHome(){
  const approved = EVENTS.filter(e=>e.reviewStatus==="APPROVED");
  const whitelistCount = approved.filter(isWhitelistEvent).length;
  const promoted = promotedEvents(4);
  const banner = activeBanner();
  const bannerEvent = banner ? EVENTS.find(e => e.id === banner.eventId && e.reviewStatus === "APPROVED") : null;
  const closing = [...approved].filter(e=>{const d=daysUntil(e.registrationEnd);return d!==null&&d>=0&&d<=15;})
    .sort((a,b)=>(daysUntil(a.registrationEnd)??0)-(daysUntil(b.registrationEnd)??0));

  const catCount = {};
  approved.forEach(e=>catCount[e.category||"未分类"]=(catCount[e.category||"未分类"]||0)+1);
  const hot = Object.entries(catCount).sort((a,b)=>b[1]-a[1]).slice(0,5);

  return `
  <div class="mx-auto max-w-7xl space-y-14 px-4 py-10">
    <section class="rounded-2xl border border-slate-200 bg-gradient-to-br from-blue-50 via-white to-slate-50 p-8 md:p-12">
      <span class="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">● 已收录 ${approved.length} 条赛事 · 白名单 ${whitelistCount} 项</span>
      <h1 class="mt-4 max-w-3xl text-3xl font-bold leading-tight md:text-4xl">一站式发现青少年赛事，来源可追溯、信息可核实</h1>
      <p class="mt-4 max-w-2xl text-sm text-slate-500 md:text-base">聚合编程、科创、数学、艺术等方向的赛事与活动信息，提供报名截止提醒、订阅通知、主办方认证与数据报告服务。</p>
      <div class="mt-6 flex flex-wrap gap-3">
        <a href="#/events" class="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700">浏览全部赛事</a>
        <a href="#/submit" class="rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">提交赛事线索</a>
        ${CURRENT_USER?"":`<a href="#/me" class="rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">登录 / 注册</a>`}
      </div>
      ${approved.length===0?`<p class="mt-4 text-xs text-amber-600">赛事数据正在录入中，稍后刷新即可看到最新内容。</p>`:""}
    </section>

    ${(() => {
      if (!CURRENT_USER) return "";
      const pending = userNotices().filter(n => !n.read);
      if (pending.length === 0) return "";
      return `
    <section class="rounded-xl border border-amber-200 bg-amber-50 px-6 py-5">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="min-w-0">
          <p class="text-base font-semibold text-amber-900">🔔 你有 ${pending.length} 条订阅提醒</p>
          <ul class="mt-2 space-y-1">
            ${pending.slice(0,2).map(n=>`<li><a href="#/events/${n.eventId}" class="block truncate text-sm text-amber-800 hover:underline">${esc(n.title)} · ${esc(n.desc)}</a></li>`).join("")}
          </ul>
        </div>
        <button onclick="gotoNotices()" class="shrink-0 rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700">查看全部提醒 →</button>
      </div>
    </section>`;
    })()}

    ${whitelistCount>0?`
    <section class="rounded-xl border border-blue-200 bg-blue-50/60 px-6 py-6">
      <h2 class="text-lg font-semibold text-slate-900">🛡 白名单核验</h2>
      <p class="mt-1 text-sm text-slate-600">拿不准一场比赛是否正规？输入赛事名称，查它是否在教育部及各省教育厅公布的中小学生竞赛白名单里。已收录 ${whitelistCount} 项。</p>
      <form onsubmit="event.preventDefault(); nav('/check?q='+encodeURIComponent(this.q.value.trim()))" class="mt-4 flex flex-wrap gap-2">
        <input name="q" autocomplete="off" placeholder="输入赛事名称，例如：全国青少年人工智能大赛"
          class="min-w-0 flex-1 rounded-md border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-blue-500">
        <button class="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700">核验</button>
      </form>
    </section>`:""}

    ${bannerEvent?`
    <section>
      <a href="#/events/${bannerEvent.id}" class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-6 py-4 transition hover:bg-amber-100">
        <div class="min-w-0">
          <span class="rounded bg-amber-200 px-2 py-0.5 text-xs font-medium text-amber-800">推荐</span>
          <span class="ml-2 text-base font-semibold text-amber-900">${esc(banner.title || bannerEvent.title)}</span>
          <p class="mt-1 truncate text-sm text-amber-700">${esc(bannerEvent.summary)}</p>
        </div>
        <span class="shrink-0 text-sm text-amber-700">查看详情 →</span>
      </a>
    </section>`:""}

    ${promoted.length>0?`
    <section class="space-y-4">
      <div class="flex items-end justify-between">
        <div>
          <h2 class="text-xl font-semibold">推荐赛事</h2>
          <p class="text-sm text-slate-500">首页推广位 · 由后台「推广位管理」配置</p>
        </div>
        <a href="#/events" class="text-sm text-blue-600 hover:underline">查看全部 →</a>
      </div>
      <div class="grid gap-4 md:grid-cols-2">${promoted.map(EventCard).join("")}</div>
    </section>`:""}

    ${closing.length>0?`
    <section class="space-y-4">
      <div>
        <h2 class="text-xl font-semibold">⏰ 即将截止</h2>
        <p class="text-sm text-slate-500">按报名截止时间排序，15 天内截止</p>
      </div>
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">${closing.slice(0,3).map(EventCard).join("")}</div>
    </section>`:""}

    ${NEWS_DOCS.length>0?`
    <section class="space-y-4">
      <div class="flex items-end justify-between">
        <div>
          <h2 class="text-xl font-semibold">📰 赛事资讯</h2>
          <p class="text-sm text-slate-500">最新收录的赛事报道、获奖名单与政策解读</p>
        </div>
        <a href="#/news" class="text-sm text-blue-600 hover:underline">更多资讯 →</a>
      </div>
      <div class="grid gap-4 md:grid-cols-3">${NEWS_DOCS.slice(0,3).map(NewsCard).join("")}</div>
    </section>`:""}

    ${hot.length>0?`
    <section class="space-y-4">
      <h2 class="text-xl font-semibold">🔥 热门分类</h2>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        ${hot.map(([name,count])=>`
          <a href="#/events?cat=${encodeURIComponent(name)}" class="block rounded-lg border border-slate-200 bg-white p-4 transition hover:shadow-md">
            <p class="text-sm font-medium">${esc(name)}</p>
            <p class="mt-1 text-xs text-slate-500">${count} 个赛事</p>
          </a>`).join("")}
      </div>
    </section>`:""}

    <section class="grid gap-4 md:grid-cols-3">
      <div class="rounded-lg border border-slate-200 bg-white p-5">
        <p class="flex items-center gap-2 text-base font-semibold">🛡 主办方认证</p>
        <p class="mt-2 text-sm text-slate-500">通过认证的主办方将在赛事卡片与详情页展示认证标识。</p>
        <a href="#/org" class="mt-3 inline-block text-sm text-blue-600 hover:underline">申请认证 →</a>
      </div>
      <div class="rounded-lg border border-slate-200 bg-white p-5">
        <p class="text-base font-semibold">🔔 订阅提醒</p>
        <p class="mt-2 text-sm text-slate-500">订阅关注赛事后，报名开始 / 即将截止将收到提醒。</p>
        <a href="#/me" class="mt-3 inline-block text-sm text-blue-600 hover:underline">${CURRENT_USER?"管理订阅 →":"登录后使用 →"}</a>
      </div>
      <div class="rounded-lg border border-slate-200 bg-white p-5">
        <p class="text-base font-semibold">📊 数据报告</p>
        <p class="mt-2 text-sm text-slate-500">基于平台聚合数据，提供分类、地区与报名趋势报告。</p>
        <a href="#/report" class="mt-3 inline-block text-sm text-blue-600 hover:underline">查看报告 →</a>
      </div>
    </section>
  </div>`;
}

let listFilters = { keyword:"", category:"", region:"", grade:"", status:"" };

function applyFilter(key,val){
  listFilters[key] = listFilters[key]===val ? "" : val;
  render();
}
function resetFilter(){ listFilters={keyword:"",category:"",region:"",grade:"",status:""}; render(); }

/* 筛选选项 = 预置枚举 + 库里真实出现过的值。
   采集来的赛事分类/地区往往是枚举外的写法，不补上这些选项就筛不出东西。 */
function filterOptions(fixed, key, cap){
  const cnt = {};
  EVENTS.filter(e=>e.reviewStatus==="APPROVED").forEach(e=>{ const v = e[key]; if (v) cnt[v] = (cnt[v]||0) + 1; });
  const extra = Object.keys(cnt).filter(v => !fixed.includes(v))
    .sort((a,b)=>cnt[b]-cnt[a]).slice(0, cap || 8);
  return [...fixed, ...extra];
}

function filteredEvents(){
  const tops = listTopIds();
  let list = EVENTS.filter(e=>e.reviewStatus==="APPROVED");
  const k = (listFilters.keyword || "").trim();
  if (k) list = list.filter(e=>e.title.includes(k) || (e.organizer||"").includes(k));
  if (listFilters.category) list = list.filter(e=>e.category===listFilters.category);
  if (listFilters.region) list = list.filter(e=>e.region===listFilters.region);
  if (listFilters.grade) list = list.filter(e=>e.gradeScope===listFilters.grade);
  if (listFilters.status) list = list.filter(e=>e.status===listFilters.status);
  list.forEach(e => { e._listTop = tops.includes(e.id); });
  return list.sort((a,b)=>{
    const ta = a._listTop ? 0 : 1, tb = b._listTop ? 0 : 1;
    if (ta !== tb) return ta - tb;   // 列表置顶推广位排最前
    return (daysUntil(a.registrationEnd)??999) - (daysUntil(b.registrationEnd)??999);
  });
}

function eventsResultsHTML(list){
  return `
    <div class="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
      <span class="text-slate-500">共 <strong class="text-slate-900">${list.length}</strong> 条结果</span>
      <span class="text-slate-500">排序：置顶优先，其余按报名截止最近</span>
    </div>
    ${list.length===0
      ? `<div class="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">没有符合条件的赛事</div>`
      : `<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">${list.map(EventCard).join("")}</div>`}`;
}

/* 只重绘结果区，不整体 render：整体 render 会把输入框一起重建，光标和焦点就没了 */
function applyKeyword(v){
  listFilters.keyword = v;
  const box = document.getElementById("events-results");
  if (!box) { render(); return; }
  box.innerHTML = eventsResultsHTML(filteredEvents());
}

function PageEvents(){
  const hash = location.hash.replace(/^#/,"");
  const qs = hash.includes("?") ? hash.split("?")[1] : "";
  const q = new URLSearchParams(qs);
  if (q.get("cat")) listFilters.category = q.get("cat");
  if (q.get("k")) listFilters.keyword = q.get("k");
  // 查询串只消费一次就抹掉：留在 hash 里的话每次 render 都会重新套上筛选，用户点取消也取消不掉
  if (qs) history.replaceState(null, "", "#/events");

  const list = filteredEvents();
  const categories = filterOptions(CATEGORIES, "category", 8);
  const regions = filterOptions(REGIONS, "region", 12);
  const grades = filterOptions(GRADES, "gradeScope", 4);

  // 值放在 data-v 里而不是拼进 onclick：分类/地区现在来自数据库，可能带引号
  const chip = (active,label,value,onclick)=>`<button data-v="${esc(value)}" onclick="${onclick}" class="rounded-full border px-3 py-1 text-xs font-medium transition ${active?"border-blue-600 bg-blue-50 text-blue-700":"border-slate-200 bg-white text-slate-600 hover:border-slate-300"}">${esc(label)}</button>`;

  return `
  <div class="mx-auto max-w-7xl px-4 py-8 space-y-6">
    <div>
      <h1 class="text-2xl font-bold">赛事库</h1>
      <p class="text-sm text-slate-500">共 ${EVENTS.filter(e=>e.reviewStatus==="APPROVED").length} 条已发布赛事</p>
    </div>

    <div class="grid gap-6 lg:grid-cols-[260px_1fr]">
      <aside class="space-y-4">
        <div class="rounded-lg border border-slate-200 bg-white p-4 space-y-4">
          <p class="text-sm font-semibold">⚙ 筛选条件</p>
          <div class="space-y-2">
            <p class="text-xs font-medium text-slate-500">关键词</p>
            <input id="evt-kw" value="${esc(listFilters.keyword)}" oninput="applyKeyword(this.value)" placeholder="赛事名称 / 主办方"
              class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
          </div>
          <div class="space-y-2">
            <p class="text-xs font-medium text-slate-500">分类</p>
            <div class="flex flex-wrap gap-1.5">
              ${categories.map(c=>chip(listFilters.category===c,c,c,`applyFilter('category',this.dataset.v)`)).join("")}
            </div>
          </div>
          <div class="space-y-2">
            <p class="text-xs font-medium text-slate-500">地区</p>
            <div class="flex flex-wrap gap-1.5">
              ${regions.map(r=>chip(listFilters.region===r,r,r,`applyFilter('region',this.dataset.v)`)).join("")}
            </div>
          </div>
          <div class="space-y-2">
            <p class="text-xs font-medium text-slate-500">学段</p>
            <div class="flex flex-wrap gap-1.5">
              ${grades.map(g=>chip(listFilters.grade===g,g,g,`applyFilter('grade',this.dataset.v)`)).join("")}
            </div>
          </div>
          <div class="space-y-2">
            <p class="text-xs font-medium text-slate-500">报名状态</p>
            <div class="flex flex-wrap gap-1.5">
              ${["OPEN","UPCOMING","CLOSED"].map(s=>chip(listFilters.status===s,STATUS[s],s,`applyFilter('status',this.dataset.v)`)).join("")}
            </div>
          </div>
          <button onclick="resetFilter()" class="w-full rounded-md border border-slate-300 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">重置筛选</button>
        </div>
      </aside>

      <section id="events-results" class="space-y-4">${eventsResultsHTML(list)}</section>
    </div>
  </div>`;
}

/* ============ 白名单核验 ============
   家长在群里被推荐一个比赛，第一反应是「这比赛正规吗」。
   本地名单库只有百余条，所以「没查到」绝不能写成「不正规」——
   这个功能的信任价值全在措辞是否老实。 */
function PageWhitelistCheck(rawQ){
  const q = String(rawQ||"").trim();
  const total = EVENTS.filter(e => e.reviewStatus === "APPROVED" && isWhitelistEvent(e)).length;
  const matches = whitelistMatches(q);

  const form = `
    <form onsubmit="event.preventDefault(); nav('/check?q='+encodeURIComponent(this.q.value.trim()))" class="flex flex-wrap gap-2">
      <input name="q" value="${esc(q)}" placeholder="输入赛事名称，例如：全国青少年人工智能大赛" autocomplete="off"
        class="min-w-0 flex-1 rounded-md border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-blue-500">
      <button class="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700">核验</button>
    </form>`;

  const matchCard = (e, score) => `
    <a href="#/events/${e.id}" class="block rounded-lg border border-slate-200 bg-white p-5 transition hover:shadow-md">
      <div class="flex flex-wrap items-center gap-2">
        <span class="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">✓ 白名单赛事</span>
        ${BadgeCategory(e.category||"未分类")} ${BadgeStatus(e.status)}
      </div>
      <p class="mt-2 text-base font-semibold leading-snug">${esc(e.title)}</p>
      <dl class="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div><dt class="text-xs text-slate-500">主办单位</dt><dd>${e.organizer?esc(e.organizer):`<span class="text-slate-400">原文未提供</span>`}</dd></div>
        <div><dt class="text-xs text-slate-500">面向学段</dt><dd>${e.gradeScope?esc(e.gradeScope):`<span class="text-slate-400">原文未提供</span>`}</dd></div>
      </dl>
      <p class="mt-3 text-xs text-slate-400">${score>=1?"名称完全一致":"名称最接近"} · 查看赛事详情 →</p>
    </a>`;

  let result;
  if (!q){
    result = `
    <div class="rounded-lg border border-slate-200 bg-white p-6 text-sm leading-relaxed text-slate-600">
      <p class="font-medium text-slate-900">怎么用</p>
      <p class="mt-2">输入赛事名称即可核验。不用写全名，输入关键词也能匹配，例如「信息学」「机器人」「作文」。</p>
      <p class="mt-2">当前已收录 <strong class="text-slate-900">${total}</strong> 项教育部及各省教育厅公布的中小学生竞赛白名单赛事。</p>
      <p class="mt-4 rounded-md bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">本页只做「是否在已收录名单中」的名称比对，不构成对任何赛事正规性的判断。最终请以教育部及各省教育厅官方公布的名单为准。</p>
    </div>`;
  } else if (GENERIC_QUERIES.includes(q)){
    result = `
    <div class="rounded-lg border border-slate-200 bg-white px-5 py-4 text-sm leading-relaxed text-slate-600">
      <p class="font-semibold text-slate-900">「${esc(q)}」太宽泛了</p>
      <p class="mt-2">这个词会匹配到很多赛事，说明不了具体是哪一场。请补上赛事名称里的关键词再试，例如「青少年人工智能」「信息学」「机器人」「作文」。</p>
    </div>`;
  } else if (matches.length > 0){
    result = `
    <div class="space-y-4">
      <div class="rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-4">
        <p class="text-base font-semibold text-emerald-900">✓ 在已收录的白名单库中找到 ${matches.length} 项</p>
        <p class="mt-1 text-sm leading-relaxed text-emerald-800">「${esc(q)}」与下列白名单赛事名称匹配。白名单赛事经教育行政部门审核备案，是面向中小学生的正规竞赛活动。</p>
      </div>
      <div class="grid gap-4 md:grid-cols-2">${matches.map(m => matchCard(m.e, m.score)).join("")}</div>
      <p class="text-xs text-slate-400">匹配依据是赛事名称相似度，可能存在偏差；报名时间与参赛条件请以主办方官方通知为准。</p>
    </div>`;
  } else {
    result = `
    <div class="rounded-lg border border-amber-200 bg-amber-50 px-5 py-4">
      <p class="text-base font-semibold text-amber-900">未在已收录的白名单库中找到「${esc(q)}」</p>
      <p class="mt-2 text-sm leading-relaxed text-amber-800">这<strong>不等于</strong>该赛事不正规。常见原因有三种：</p>
      <ul class="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-amber-800">
        <li>名称写法不同——试试只输入关键词，例如「物理」「机器人」「作文」</li>
        <li>属于省级或地方名单，本站尚未收录（当前已收录 ${total} 项，仍在持续扩充）</li>
        <li>该赛事确实不在白名单范围内</li>
      </ul>
      <p class="mt-3 text-sm leading-relaxed text-amber-800">判断正规性请以教育部及各省教育厅官方公布的名单为准。如果你确认它是白名单赛事，欢迎<a href="#/submit" class="underline">提交线索</a>帮我们补全。</p>
    </div>`;
  }

  return `
  <div class="mx-auto max-w-3xl space-y-6 px-4 py-8">
    <div>
      <h1 class="text-2xl font-bold">白名单核验</h1>
      <p class="mt-1 text-sm text-slate-500">查一场赛事是否在教育部及各省教育厅公布的中小学生竞赛白名单中。</p>
    </div>
    ${form}
    ${result}
  </div>`;
}

function PageEventDetail(id){
  const e = EVENTS.find(x=>x.id===id);
  if (!e) return `<div class="mx-auto max-w-3xl px-4 py-20 text-center"><p class="text-2xl font-bold">404</p><p class="mt-2 text-slate-500">赛事不存在</p><a href="#/events" class="mt-6 inline-block text-blue-600">← 返回赛事库</a></div>`;

  const d = daysUntil(e.registrationEnd);
  /* 空字段不显示破折号：原文没写的平台不编造，但要让家长看出是「来源未提供」而不是页面没做完 */
  const fld = (label,val,verified)=>{
    const has = val !== undefined && val !== null && String(val).trim() !== "";
    return `
    <div class="space-y-1">
      <dt class="text-xs text-slate-500">${label}</dt>
      <dd class="flex flex-wrap items-center gap-2 text-sm font-medium">
        ${has
          ? `${esc(val)}${verified?'<span class="text-sky-600">🛡</span>':""}`
          : `<span class="font-normal text-slate-400">原文未提供</span>${e.sourceUrl?`<a href="${esc(e.sourceUrl)}" target="_blank" rel="noopener" class="text-xs font-normal text-blue-600 hover:underline">看原通知 ↗</a>`:""}`}
      </dd>
    </div>`;
  };

  return `
  <div class="mx-auto grid max-w-7xl gap-8 px-4 py-8 lg:grid-cols-[1fr_320px]">
    <article class="space-y-6">
      <div class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          ${BadgeCategory(e.category)} ${BadgeStatus(e.status)}
          ${e.isPromoted?BadgePromoted():""} ${e.isSample?BadgeSample():""}
        </div>
        <h1 class="text-2xl font-bold leading-snug">${esc(e.title)}</h1>
        <div class="flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-500">
          <span>📍 ${esc(e.region)} · ${esc(e.format)}</span>
          <span>👥 ${esc(e.gradeScope)}</span>
          <span>🗓 报名截止 ${esc(e.registrationEnd)} ${d!==null&&d>=0&&d<=7?`<span class="font-medium text-amber-600">（剩 ${d} 天）</span>`:""}</span>
        </div>
      </div>

      <div class="rounded-lg border border-slate-200 bg-white p-6">
        <h2 class="mb-3 text-base font-semibold">赛事简介</h2>
        <p class="text-sm leading-relaxed text-slate-500">${esc(e.summary)}</p>
        ${e.description?`<p class="mt-3 text-sm leading-relaxed text-slate-500">${esc(e.description)}</p>`:""}
      </div>

      <div class="rounded-lg border border-violet-200 bg-white p-6">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-base font-semibold">🤖 AI 赛事简析</h2>
          <button onclick="generateAiBrief('${e.id}')" ${AI_BRIEF_BUSY?"disabled":""}
            class="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50">
            ${AI_BRIEF_BUSY===e.id?"生成中…（约 10 秒）":(e.aiBrief||AI_BRIEF_FALLBACK[e.id])?"重新生成":"生成简析报告"}
          </button>
        </div>
        ${(() => {
          const brief = AI_BRIEF_BUSY===e.id ? "" : (e.aiBrief || AI_BRIEF_FALLBACK[e.id] || "");
          return brief
            ? `<div class="whitespace-pre-wrap text-sm leading-relaxed text-slate-500">${esc(brief)}</div>
               <p class="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-400">由大模型基于本站已收录信息自动生成，仅供参考，请以主办方官方章程为准。</p>`
            : `<p class="text-sm leading-relaxed text-slate-500">还没有简析报告。点击右上角按钮，AI 会基于本站已收录的信息（简介、分类、面向学段、费用、奖项、来源等）生成一份参赛参考简析，帮助快速判断这项赛事是否值得参加。</p>`;
        })()}
      </div>

      <div class="rounded-lg border border-slate-200 bg-white p-6">
        <h2 class="mb-4 text-base font-semibold">关键信息</h2>
        <dl class="grid gap-4 sm:grid-cols-2">
          ${fld("主办方", e.organizer, e.organizationVerified)}
          ${fld("参赛形式", e.format)}
          ${fld("报名截止", e.registrationEnd)}
          ${fld("比赛开始", e.eventStart)}
          ${fld("费用", e.fee)}
          ${fld("奖项", e.prize)}
        </dl>
      </div>

      <div class="rounded-lg border border-slate-200 bg-white p-6 space-y-3 text-sm">
        <h2 class="text-base font-semibold">来源与可信度</h2>
        <div class="flex items-center justify-between"><span class="text-slate-500">来源名称</span><span>${esc(sourceLabel(e.sourceName))}</span></div>
        <div class="flex items-center justify-between"><span class="text-slate-500">可信度评分</span><span>${BadgeCred(e.credibilityScore)}</span></div>
        <div class="flex items-center justify-between"><span class="text-slate-500">录入时间</span><span>${esc(e.createdAt)}</span></div>
        ${e.officialUrl?`<div class="flex items-center justify-between gap-3"><span class="text-slate-500">官方网站</span><a href="${esc(e.officialUrl)}" target="_blank" rel="noopener" class="truncate text-blue-600 hover:underline">${esc(shortUrl(e.officialUrl))} ↗</a></div>`:""}
        ${e.sourceUrl?`<div class="border-t border-slate-100 pt-3"><a href="${esc(e.sourceUrl)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline">查看来源页面 ↗</a></div>`:""}
      </div>
    </article>

    <aside class="space-y-4 lg:sticky lg:top-24 lg:self-start">
      <div class="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
        ${(e.officialUrl||e.sourceUrl)?`<a href="${esc(e.officialUrl||e.sourceUrl)}" target="_blank" rel="noopener" class="block w-full rounded-md bg-blue-600 py-2.5 text-center text-sm font-medium text-white hover:bg-blue-700">${e.officialUrl?"前往官网 ↗":"查看来源 ↗"}</a>`:""}
        ${!e.officialUrl?`<p class="text-center text-xs text-slate-400">官网待补全，后台「赛事管理」可一键 AI 查找</p>`:""}
        <div class="grid grid-cols-2 gap-2">
          <button onclick="toggleFavorite('${e.id}')" class="rounded-md border py-2 text-xs transition ${isFavorited(e.id)?"border-rose-300 bg-rose-50 text-rose-700":"border-slate-300 hover:bg-slate-50"}">${isFavorited(e.id)?"♥ 已收藏":"♡ 收藏"}</button>
          <button onclick="toggleSubscription('${e.id}')" class="rounded-md border py-2 text-xs transition ${isSubscribed(e.id)?"border-sky-300 bg-sky-50 text-sky-700":"border-slate-300 hover:bg-slate-50"}">${isSubscribed(e.id)?"🔔 已订阅":"🔔 订阅"}</button>
          <button onclick="shareEventCard('${e.id}')" class="rounded-md border border-slate-300 py-2 text-xs hover:bg-slate-50">📤 分享卡片</button>
          <button onclick="openReportModal('${e.id}')" class="rounded-md border border-slate-300 py-2 text-xs hover:bg-slate-50">⚑ 举报</button>
        </div>
        ${CURRENT_USER?"":`<p class="text-center text-xs text-slate-400">登录后可收藏、订阅截止提醒</p>`}
      </div>

      <div class="rounded-lg border border-slate-200 bg-white p-5 space-y-2 text-sm">
        <h2 class="text-base font-semibold">主办方</h2>
        <p class="font-medium">${e.organizer?esc(e.organizer):`<span class="font-normal text-slate-400">主办方待补充</span>`}</p>
        ${e.organizationVerified?BadgeVerified():`<span class="text-xs text-slate-500">尚未认证</span>`}
        <p class="pt-2 text-xs"><a href="#/org?event=${e.id}" class="text-blue-600 hover:underline">这是我们主办的赛事，去认领 / 认证 →</a></p>
      </div>

      ${(e.viewCount>0||e.favoriteCount>0)?`
      <div class="rounded-lg border border-slate-200 bg-white p-5 space-y-2 text-sm">
        <h2 class="text-base font-semibold">数据概览</h2>
        <div class="flex justify-between"><span class="text-slate-500">浏览量</span><span id="view-count">${e.viewCount}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">收藏量</span><span id="fav-count">${e.favoriteCount}</span></div>
      </div>`:""}
    </aside>
  </div>`;
}

/* 举报弹窗 */
function openReportModal(eventId){
  const e = EVENTS.find(x => x.id === eventId);
  openModal({
    title: "举报这条赛事信息",
    saveLabel: "提交举报",
    body: `
      <p class="text-sm text-slate-500">${esc(e?e.title:"")}</p>
      ${fSelect("reason","举报原因", REPORT_REASONS[0], REPORT_REASONS.map(r=>[r,r]))}
      ${fArea("detail","补充说明（选填）","",3)}
      <p class="text-xs text-slate-400">提交后会进入后台「举报处理」队列，我们会尽快核实。</p>`,
    onSave: async () => {
      const v = readModalForm();
      await submitReport(eventId, v.reason, v.detail);
    },
  });
}

/* ============ 分享卡片图 ============
   家长真正会往班级群里发的是图片，不是链接。用 canvas 现画一张可直接转发的卡片。
   微信内置浏览器里 <a download> 常常无效，所以主路径是「长按保存」，下载按钮只作补充。 */
const CARD_FONT = '"PingFang SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

/* 分享图是同步画出来的，logo 得提前载入。载不到（或在 file:// 下被跨源污染）就退回
   原来的「赛」字块，宁可少一个品牌标记，也不能让整张卡片画不出来。 */
let LOGO_IMG = null, LOGO_LOADING = null;
function ensureLogoImg(){
  if (!LOGO_LOADING) LOGO_LOADING = new Promise(resolve => {
    const img = new Image();
    img.onload = () => { LOGO_IMG = img; resolve(img); };
    img.onerror = () => resolve(null);
    img.src = "logo.svg";
  });
  return LOGO_LOADING;
}

function cardRoundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}
/* 逐字折行：中文没有词边界，按宽度切最稳 */
function cardWrapText(ctx, text, maxWidth){
  const lines = [];
  let line = "";
  for (const ch of String(text||"")){
    if (ch === "\n"){ lines.push(line); line = ""; continue; }
    const test = line + ch;
    if (line && ctx.measureText(test).width > maxWidth){ lines.push(line); line = ch; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}
function cardPill(ctx, x, y, text, bg, fg, fontSize){
  ctx.font = `600 ${fontSize}px ${CARD_FONT}`;
  const w = ctx.measureText(text).width + 30;
  const h = fontSize + 20;
  ctx.fillStyle = bg; cardRoundRect(ctx, x, y, w, h, h/2); ctx.fill();
  ctx.fillStyle = fg; ctx.textBaseline = "middle";
  ctx.fillText(text, x + 15, y + h/2 + 1);
  ctx.textBaseline = "alphabetic";
  return w;
}
function cardQr(ctx, text, x, y, size){
  if (!window.qrcode) return false;
  let qr;
  try { qr = window.qrcode(0, "M"); qr.addData(text); qr.make(); } catch (e) { return false; }
  const n = qr.getModuleCount(), cell = size / n;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(x, y, size, size);
  ctx.fillStyle = "#0f172a";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++){
    if (qr.isDark(r, c)) ctx.fillRect(x + c*cell, y + r*cell, Math.ceil(cell), Math.ceil(cell));
  }
  return true;
}
function shareUrlFor(e){
  return `${location.origin}${location.pathname}#/events/${e.id}`;
}

function drawShareCard(e, withQr){
  const W = 750, H = 1000, S = 2;   // 2 倍超采样，手机上不糊
  const canvas = document.createElement("canvas");
  canvas.width = W*S; canvas.height = H*S;
  const ctx = canvas.getContext("2d");
  ctx.scale(S, S);

  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#2563eb"; ctx.fillRect(0, 0, W, 132);
  let logoDrawn = false;
  if (LOGO_IMG){
    try { ctx.drawImage(LOGO_IMG, 48, 40, 52, 52); logoDrawn = true; }
    catch (err) { LOGO_IMG = null; }   // 跨源污染画布，后面 toBlob 会直接抛错
  }
  if (!logoDrawn){
    ctx.fillStyle = "rgba(255,255,255,.18)"; cardRoundRect(ctx, 48, 40, 52, 52, 14); ctx.fill();
    ctx.fillStyle = "#ffffff"; ctx.textAlign = "center";
    ctx.font = `700 28px ${CARD_FONT}`; ctx.fillText("赛", 74, 78);
  }
  ctx.textAlign = "left";
  ctx.font = `700 26px ${CARD_FONT}`; ctx.fillText("青少年赛事信息聚合平台", 118, 68);
  ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.font = `400 16px ${CARD_FONT}`;
  ctx.fillText("赛事信息聚合 · 来源可追溯", 118, 96);

  let y = 184, bx = 48;
  bx += cardPill(ctx, bx, y, e.category || "未分类", "#f1f5f9", "#334155", 18) + 10;
  bx += cardPill(ctx, bx, y, STATUS[e.status] || e.status || "待确认", "#eff6ff", "#1d4ed8", 18) + 10;
  if (isWhitelistEvent(e)) cardPill(ctx, bx, y, "✓ 教育部白名单", "#ecfdf5", "#047857", 18);
  y += 58;

  ctx.fillStyle = "#0f172a"; ctx.font = `700 34px ${CARD_FONT}`;
  cardWrapText(ctx, e.title, W - 96).slice(0, 4).forEach(l => { ctx.fillText(l, 48, y + 34); y += 48; });
  y += 22;

  ctx.fillStyle = "#e2e8f0"; ctx.fillRect(48, y, W-96, 1); y += 30;
  [["主办单位", e.organizer], ["面向学段", e.gradeScope],
   ["地区 · 形式", [e.region, e.format].filter(Boolean).join(" · ")],
   ["报名截止", e.registrationEnd], ["费用", e.fee]].forEach(([label, val]) => {
    ctx.font = `400 18px ${CARD_FONT}`; ctx.fillStyle = "#64748b";
    ctx.fillText(label, 48, y);
    const has = val !== undefined && val !== null && String(val).trim() !== "";
    ctx.font = `600 22px ${CARD_FONT}`; ctx.fillStyle = has ? "#0f172a" : "#94a3b8";
    const lines = cardWrapText(ctx, has ? String(val) : "原文未提供", W - 96 - 150).slice(0, 2);
    lines.forEach((l, i) => ctx.fillText(l, 198, y + i*28));
    y += Math.max(28, lines.length*28) + 18;
  });

  const footTop = 792;
  ctx.fillStyle = "#e2e8f0"; ctx.fillRect(48, footTop - 34, W-96, 1);
  if (withQr){
    ctx.fillStyle = "#f8fafc"; cardRoundRect(ctx, 48, footTop, 172, 172, 12); ctx.fill();
    cardQr(ctx, shareUrlFor(e), 56, footTop + 8, 156);
  }
  const tx = withQr ? 244 : 48;
  ctx.fillStyle = "#0f172a"; ctx.font = `600 22px ${CARD_FONT}`;
  ctx.fillText(withQr ? "扫码查看赛事详情" : "查看赛事详情", tx, footTop + 40);
  ctx.fillStyle = "#64748b"; ctx.font = `400 16px ${CARD_FONT}`;
  cardWrapText(ctx, shareUrlFor(e), W - tx - 48).slice(0, 2)
    .forEach((l, i) => ctx.fillText(l, tx, footTop + 78 + i*24));
  ctx.fillStyle = "#94a3b8"; ctx.font = `400 15px ${CARD_FONT}`;
  ctx.fillText("信息来自公开渠道，请以主办方官方公告为准", tx, footTop + 152);

  return canvas;
}

async function shareEventCard(eventId){
  const e = EVENTS.find(x => x.id === eventId);
  if (!e) return;
  toast("正在生成分享图…", 1400);
  const withQr = await ensureQrLib();
  await ensureLogoImg();
  const canvas = drawShareCard(e, withQr);
  const url = shareUrlFor(e);
  canvas.toBlob((blob) => {
    if (!blob){ toast("分享图生成失败，请重试"); return; }
    const objUrl = URL.createObjectURL(blob);
    openModal({
      title: "分享这张赛事卡片",
      saveLabel: "复制链接",
      body: `
        <img src="${objUrl}" alt="${esc(e.title)}" class="w-full rounded-lg border border-slate-200">
        <p class="text-center text-sm text-slate-500">手机上<strong>长按图片保存</strong>，就能转发到班级群、家长群</p>
        <a href="${objUrl}" download="赛事-${esc(e.title)}.png" class="block rounded-md border border-slate-300 px-4 py-2 text-center text-sm hover:bg-slate-50">下载图片</a>`,
      onSave: async () => { copyText(url, "赛事链接已复制"); },
    });
  }, "image/png");
}

/* ============ 赛事日历（月视图） ============
   对标 saishizhi.com/calendar 的交互：整月网格一眼看到截止/开赛分布，
   点某天看当天动态。蓝点 = 报名截止，紫点 = 开赛。 */
let CAL_MONTH = "";       // 当前查看的月份 "YYYY-MM"，空 = 本月
let CAL_SELECTED = "";    // 选中查看的某一天 "YYYY-MM-DD"，空 = 自动（今天或本月第一个有标注的日子）

function calYmd(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function calShiftMonth(delta){
  const t = new Date();
  const cur = CAL_MONTH || calYmd(t).slice(0,7);
  let [y,m] = cur.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  CAL_MONTH = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  CAL_SELECTED = "";
  render();
}
function calGoToday(){ CAL_MONTH = ""; CAL_SELECTED = ""; render(); }
function calPick(ymd){ CAL_SELECTED = CAL_SELECTED===ymd ? "" : ymd; render(); }

function PageCalendar(){
  const approved = EVENTS.filter(e=>e.reviewStatus==="APPROVED");
  const todayYmd = calYmd(new Date());
  const cur = CAL_MONTH || todayYmd.slice(0,7);
  const [y,m] = cur.split("-").map(Number);
  const first = new Date(y, m-1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const lead = (first.getDay()+6)%7;   // 周一开头

  // 本月有日期标注的赛事：报名截止（蓝）/ 开赛（紫）
  const byDate = {};
  approved.forEach(e=>{
    if ((e.registrationEnd||"").slice(0,7)===cur) (byDate[e.registrationEnd]=byDate[e.registrationEnd]||[]).push({e, type:"END"});
    if ((e.eventStart||"").slice(0,7)===cur) (byDate[e.eventStart]=byDate[e.eventStart]||[]).push({e, type:"START"});
  });
  const monthCount = Object.values(byDate).reduce((s,a)=>s+a.length,0);
  const sel = CAL_SELECTED || (todayYmd.startsWith(cur) ? todayYmd : (Object.keys(byDate).sort()[0] || ""));
  const selected = byDate[sel] || [];

  let cells = "";
  for (let i=0;i<lead;i++) cells += `<div class="min-h-[68px] rounded-md bg-slate-50/60"></div>`;
  for (let day=1; day<=daysInMonth; day++){
    const ymd = `${cur}-${String(day).padStart(2,"0")}`;
    const evs = byDate[ymd]||[];
    const isToday = ymd===todayYmd, isSel = ymd===sel;
    cells += `
    <button onclick="calPick('${ymd}')" class="min-h-[68px] rounded-md border p-1.5 text-left align-top transition ${isSel?"border-blue-500 bg-blue-50":isToday?"border-emerald-400 bg-emerald-50/60":"border-slate-200 bg-white hover:bg-slate-50"}">
      <span class="text-xs font-medium ${isToday?"text-emerald-600":isSel?"text-blue-700":"text-slate-700"}">${day}${isToday?`<span class="ml-0.5 text-[10px]">今天</span>`:""}</span>
      <div class="mt-1 flex flex-wrap items-center gap-0.5">
        ${evs.slice(0,4).map(x=>`<span class="h-1.5 w-1.5 rounded-full ${x.type==="END"?"bg-blue-500":"bg-violet-500"}" title="${esc(x.e.title)}"></span>`).join("")}
        ${evs.length>4?`<span class="text-[10px] text-slate-400">+${evs.length-4}</span>`:""}
      </div>
    </button>`;
  }

  return `
  <div class="mx-auto max-w-4xl px-4 py-8 space-y-6">
    <div>
      <h1 class="text-2xl font-bold">赛事日历</h1>
      <p class="text-sm text-slate-500">按月查看报名截止与开赛时间，点击日期查看当天动态</p>
    </div>
    <div class="rounded-lg border border-slate-200 bg-white p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">${y} 年 ${m} 月</h2>
          <p class="mt-0.5 text-xs text-slate-500">本月 ${monthCount} 项日期标注 · <span class="ml-1 inline-block h-2 w-2 rounded-full bg-blue-500"></span> 报名截止 · <span class="ml-1 inline-block h-2 w-2 rounded-full bg-violet-500"></span> 开赛</p>
        </div>
        <div class="flex gap-1">
          <button onclick="calShiftMonth(-1)" class="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">← 上月</button>
          <button onclick="calGoToday()" class="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">今天</button>
          <button onclick="calShiftMonth(1)" class="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">下月 →</button>
        </div>
      </div>
      <div class="mt-4 grid grid-cols-7 gap-1 text-center text-xs font-medium text-slate-400">
        ${["一","二","三","四","五","六","日"].map(w=>`<div class="py-1">${w}</div>`).join("")}
      </div>
      <div class="grid grid-cols-7 gap-1">${cells}</div>
      ${approved.length===0?`<p class="mt-3 text-center text-xs text-amber-600">赛事库还没有已通过审核的赛事，先到后台审核或采集</p>`:""}
    </div>
    ${sel?`
    <div class="rounded-lg border border-slate-200 bg-white">
      <div class="border-b border-slate-100 px-5 py-3"><h2 class="text-sm font-semibold">${sel} 的赛事动态</h2></div>
      ${selected.length===0
        ? `<p class="px-5 py-6 text-sm text-slate-500">这一天没有标注的赛事日期</p>`
        : `<div class="divide-y divide-slate-100">${selected.map(({e,type})=>`
            <a href="#/events/${e.id}" class="flex flex-wrap items-center justify-between gap-2 px-5 py-3 hover:bg-slate-50">
              <div class="min-w-0">
                <p class="text-sm font-medium">${esc(e.title)}</p>
                <p class="mt-0.5 text-xs text-slate-500">${esc(e.region)} · ${esc(e.category)} · 来源：${esc(sourceLabel(e.sourceName))}</p>
              </div>
              <div class="flex shrink-0 items-center gap-2">${type==="END"?Badge("报名截止","bg-blue-100 text-blue-700"):Badge("开赛","bg-violet-100 text-violet-700")}${BadgeStatus(e.status)}</div>
            </a>`).join("")}</div>`}
    </div>`:""}
  </div>`;
}

/* ============ 个人中心 ============ */
let ME_TAB = "fav";         // fav / sub / my / apps / notice
let AUTH_MODE = "login";    // login / register
let AUTH_ERROR = "";

/* ============ 赛事资讯频道（raw_docs 里 kind=NEWS 的条目：新闻报道/获奖名单/政策解读，看完不能报名的那类） ============ */
function NewsCard(n){
  return `
  <article class="flex h-full flex-col rounded-lg border border-slate-200 border-l-4 border-l-violet-400 bg-white p-5 transition hover:shadow-md">
    <div class="flex flex-wrap items-center gap-2 text-xs text-slate-400">
      <span class="rounded bg-violet-100 px-1.5 py-0.5 font-medium text-violet-700">资讯</span>
      ${n.category?BadgeCategory(n.category):""}
      ${n.region?`<span>${esc(n.region)}</span>`:""}
    </div>
    <h2 class="mt-2 text-base font-semibold leading-snug">
      ${n.sourceUrl
        ? `<a href="${esc(n.sourceUrl)}" target="_blank" rel="noopener" class="hover:text-violet-700">${esc(n.rawTitle)}</a>`
        : esc(n.rawTitle)}
    </h2>
    ${n.summary?`<p class="mt-2 line-clamp-3 text-sm leading-relaxed text-slate-500">${esc(n.summary)}</p>`:""}
    <div class="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3 text-xs text-slate-400">
      <span>来源：${esc(sourceLabel(n.sourceName))} · ${esc(n.fetchedAt)}</span>
      ${n.sourceUrl?`<a href="${esc(n.sourceUrl)}" target="_blank" rel="noopener" class="text-blue-600 hover:underline">阅读原文 ↗</a>`:""}
    </div>
  </article>`;
}
function PageNews(){
  const items = NEWS_DOCS;
  return `
  <div class="mx-auto max-w-4xl px-4 py-8 space-y-6">
    <div>
      <h1 class="text-2xl font-bold">赛事资讯</h1>
      <p class="text-sm text-slate-500">围绕赛事的新闻报道、获奖名单、政策解读与回顾盘点，由采集链路自动收录、AI 自动分类，共 ${items.length} 条。</p>
    </div>
    ${items.length===0
      ? `<div class="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">还没有资讯。先在后台运行一次采集，再点「🤖 AI 分类原始数据」，NEWS 条目会自动出现在这里。</div>`
      : `<div class="grid gap-4 md:grid-cols-2">${items.map(NewsCard).join("")}</div>`}
  </div>`;
}

/* 「我的申请」：当前登录用户提交的入驻 / 认领申请（提交时已关联 user_id） */
function myOrgApplications(){
  if (!CURRENT_USER) return [];
  return ORG_APPLICATIONS.filter(a => a.userId === CURRENT_USER.id);
}

async function saveDisplayName(){
  const v = (document.getElementById("me-display-name").value || "").trim();
  if (!v) { toast("昵称不能为空"); return; }
  if (v.length > 20) { toast("昵称最长 20 个字"); return; }
  const { error } = await db.from("app_users").update({ display_name: v }).eq("id", CURRENT_USER.id);
  if (error) { toast("保存失败：" + dbErrMsg(error)); return; }
  CURRENT_USER.displayName = v;
  const saved = lsGet(SESSION_KEY, null);
  if (saved) lsSet(SESSION_KEY, { ...saved, username: CURRENT_USER.username });
  toast("昵称已更新");
  render();
}
let AUTH_BUSY = false;
let MY_SUBMISSIONS = null;  // null = 还没查过

function setMeTab(t){ ME_TAB = t; render(); }
/* 从站内提醒条跳通知 tab：hash 若已经是 /me，改 hash 不会再触发 hashchange，得手动 render */
function gotoNotices(){
  ME_TAB = "notice";
  if (location.hash.replace(/^#/,"") === "/me") render(); else nav("/me");
}
function setAuthMode(m){ AUTH_MODE = m; AUTH_ERROR = ""; render(); }

async function doUserAuth(){
  const u = document.getElementById("auth-username").value.trim();
  const p = document.getElementById("auth-password").value;
  const dEl = document.getElementById("auth-display");
  const d = dEl ? dEl.value.trim() : "";
  AUTH_ERROR = ""; AUTH_BUSY = true; render();
  const mode = AUTH_MODE;
  try {
    if (mode === "register") await registerUser(u, p, d);
    else await loginUser(u, p);
    await Promise.all([loadUserData(), loadMySubmissions()]);
    ME_TAB = "fav";
    toast(mode === "register" ? "注册成功，已自动登录" : `欢迎回来，${CURRENT_USER.displayName}`);
  } catch (e) {
    AUTH_ERROR = dbErrMsg(e);
  } finally {
    AUTH_BUSY = false;
    render();
  }
}

async function loadMySubmissions(){
  if (!CURRENT_USER) { MY_SUBMISSIONS = []; return; }
  const { data, error } = await db.from("submissions").select("*")
    .eq("user_id", CURRENT_USER.id).order("created_at", { ascending:false });
  if (error) { MY_SUBMISSIONS = []; console.warn("加载我的投稿失败:", error.message); return; }
  MY_SUBMISSIONS = (data || []).map(mapSubmission);
}

/* 2026-10 之前的投稿没有 user_id，按当时填写的联系方式补查 */
async function searchSubmissionsByContact(){
  const el = document.getElementById("legacy-contact");
  const v = el ? el.value.trim() : "";
  if (!v) { toast("请输入当时填写的联系方式"); return; }
  const { data, error } = await db.from("submissions").select("*").eq("contact", v).order("created_at", { ascending:false });
  if (error) { toast("查询失败：" + dbErrMsg(error)); return; }
  const rows = (data || []).map(mapSubmission);
  const have = new Set((MY_SUBMISSIONS || []).map(s => s.id));
  MY_SUBMISSIONS = [...(MY_SUBMISSIONS || []), ...rows.filter(r => !have.has(r.id))];
  toast(rows.length ? `找到 ${rows.length} 条历史投稿` : "没有找到该联系方式下的投稿");
  render();
}

function meEventRow(e, rightBtn){
  if (!e) {
    return `<div class="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
      <div class="min-w-0">
        <p class="text-sm text-slate-400">该赛事已下架或未通过审核</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">${rightBtn||""}</div>
    </div>`;
  }
  const d = daysUntil(e.registrationEnd);
  return `<div class="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
    <div class="min-w-0">
      <a href="#/events/${e.id}" class="text-sm font-medium hover:text-blue-600">${esc(e.title)}</a>
      <p class="mt-0.5 text-xs text-slate-500">${esc(e.category||"未分类")} · ${esc(e.region||"地区待定")} · ${e.registrationEnd?`截止 ${esc(e.registrationEnd)}${d!==null&&d>=0?`（剩 ${d} 天）`:""}`:"截止时间待定"}</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      ${BadgeStatus(e.status)}
      ${rightBtn||""}
    </div>
  </div>`;
}

function PageMeAuth(){
  const isReg = AUTH_MODE === "register";
  return `
  <div class="mx-auto max-w-md px-4 py-12">
    <div class="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
      <div class="text-center space-y-1">
        <h1 class="text-xl font-bold">${isReg?"注册账号":"登录"}</h1>
        <p class="text-sm text-slate-500">登录后可以收藏赛事、订阅截止提醒、查看投稿进度</p>
      </div>
      <div class="flex rounded-md border border-slate-200 p-1 text-sm">
        <button onclick="setAuthMode('login')" class="flex-1 rounded py-1.5 font-medium ${!isReg?"bg-blue-600 text-white":"text-slate-600 hover:bg-slate-50"}">登录</button>
        <button onclick="setAuthMode('register')" class="flex-1 rounded py-1.5 font-medium ${isReg?"bg-blue-600 text-white":"text-slate-600 hover:bg-slate-50"}">注册</button>
      </div>
      <div class="space-y-3">
        <div class="space-y-1">
          <label class="text-sm font-medium">用户名</label>
          <input id="auth-username" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
            placeholder="2—20 位中文、字母、数字或下划线">
        </div>
        ${isReg?`<div class="space-y-1">
          <label class="text-sm font-medium">昵称（选填）</label>
          <input id="auth-display" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="显示在页面右上角">
        </div>`:""}
        <div class="space-y-1">
          <label class="text-sm font-medium">密码</label>
          <input id="auth-password" type="password" onkeydown="if(event.key==='Enter')doUserAuth()"
            class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
            placeholder="${isReg?"至少 6 位":"请输入密码"}">
        </div>
        ${AUTH_ERROR?`<p class="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">${esc(AUTH_ERROR)}</p>`:""}
        <button onclick="doUserAuth()" ${AUTH_BUSY?"disabled":""} class="w-full rounded-md bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">${AUTH_BUSY?"处理中…":(isReg?"注册并登录":"登录")}</button>
        <p class="text-center text-xs text-slate-400">密码在浏览器里加盐哈希后才上传，明文不会离开本机</p>
      </div>
    </div>
  </div>`;
}

function PageMe(){
  if (!CURRENT_USER) return PageMeAuth();

  const tabs = [["fav",`我的收藏 ${FAVORITES.length}`],["sub",`我的订阅 ${SUBSCRIPTIONS.length}`],["my",`我的投稿 ${MY_SUBMISSIONS?MY_SUBMISSIONS.length:""}`],["apps",`我的申请 ${myOrgApplications().length||""}`],["notice",`通知 ${unreadNoticeCount()||""}`]];
  const tabBar = `<div class="flex flex-wrap gap-1 border-b border-slate-200">
    ${tabs.map(([k,l])=>`<button onclick="setMeTab('${k}')" class="rounded-t-md px-4 py-2 text-sm font-medium transition ${ME_TAB===k?"border-b-2 border-blue-600 text-blue-700":"text-slate-500 hover:text-slate-900"}">${l}</button>`).join("")}
  </div>`;

  let body = "";
  if (ME_TAB === "fav") {
    body = FAVORITES.length === 0
      ? `<p class="px-5 py-10 text-center text-sm text-slate-500">还没有收藏赛事，去<a href="#/events" class="text-blue-600">赛事库</a>看看</p>`
      : FAVORITES.map(f => meEventRow(EVENTS.find(e=>e.id===f.eventId),
          `<button onclick="toggleFavorite('${f.eventId}')" class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">取消收藏</button>`)).join("");
  } else if (ME_TAB === "sub") {
    body = SUBSCRIPTIONS.length === 0
      ? `<p class="px-5 py-10 text-center text-sm text-slate-500">还没有订阅赛事。订阅后，报名开始与临近截止会在这里提醒你。</p>`
      : SUBSCRIPTIONS.map(s => meEventRow(EVENTS.find(e=>e.id===s.eventId),
          `<button onclick="toggleSubscription('${s.eventId}')" class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">取消订阅</button>`)).join("");
  } else if (ME_TAB === "my") {
    const list = MY_SUBMISSIONS || [];
    body = `${list.length===0
        ? `<p class="px-5 py-8 text-center text-sm text-slate-500">还没有投稿记录</p>`
        : `<div class="divide-y divide-slate-100">${list.map(s=>`
            <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div class="min-w-0">
                <p class="text-sm font-medium">${esc(s.title)}</p>
                <p class="mt-0.5 text-xs text-slate-500">${esc(s.createdAt)}${s.contact?` · 联系：${esc(s.contact)}`:""}</p>
                ${s.url?`<a href="${esc(s.url)}" target="_blank" rel="noopener" class="text-xs text-blue-600 hover:underline">${esc(s.url)} ↗</a>`:""}
              </div>
              <div class="flex shrink-0 items-center gap-2">
                ${BadgeReview(s.status)}
                ${s.status==="APPROVED"?`<a href="#/events" class="text-xs text-blue-600 hover:underline">查看赛事库 →</a>`:""}
              </div>
            </div>`).join("")}</div>`}
      <div class="border-t border-slate-100 bg-slate-50 px-5 py-3">
        <p class="text-xs text-slate-500">查询更早的投稿（未登录时提交的没有关联账号，按当时填写的联系方式查）</p>
        <div class="mt-2 flex gap-2">
          <input id="legacy-contact" class="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500" placeholder="邮箱 / 微信 / 手机">
          <button onclick="searchSubmissionsByContact()" class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100">查询</button>
        </div>
      </div>`;
  } else if (ME_TAB === "apps") {
    const list = myOrgApplications();
    body = list.length === 0
      ? `<p class="px-5 py-10 text-center text-sm text-slate-500">还没有提交过入驻 / 认领申请，去<a href="#/org" class="text-blue-600">主办方入驻</a>页面提交</p>`
      : list.map(a=>`
          <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div class="min-w-0">
              <p class="text-sm font-medium">${esc(a.orgName)}
                <span class="ml-1 rounded px-1.5 py-0.5 text-xs ${a.kind==="CLAIM"?"bg-amber-100 text-amber-700":"bg-sky-100 text-sky-700"}">${a.kind==="CLAIM"?"赛事认领":"机构入驻"}</span>
              </p>
              <p class="mt-0.5 text-xs text-slate-500">${esc(a.createdAt)}${a.claimEventTitle?` · 认领「${esc(a.claimEventTitle)}」`:""}</p>
              ${a.handlerNote?`<p class="mt-1 rounded bg-slate-50 px-2 py-1 text-xs text-slate-500">审核备注：${esc(a.handlerNote)}</p>`:""}
            </div>
            <div class="shrink-0">${a.status==="APPROVED"?Badge("已通过","bg-emerald-100 text-emerald-700"):a.status==="REJECTED"?Badge("已驳回","bg-rose-100 text-rose-700"):Badge("审核中","bg-amber-100 text-amber-700")}</div>
          </div>`).join("");
  } else {
    const notices = userNotices();
    body = notices.length === 0
      ? `<p class="px-5 py-10 text-center text-sm text-slate-500">暂无提醒。订阅赛事后，报名开始与临近截止会在这里出现。</p>`
      : notices.map(n=>`
          <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-3 ${n.read?"opacity-60":""}">
            <a href="#/events/${n.eventId}" class="min-w-0 flex-1">
              <p class="text-sm font-medium ${n.level==="urgent"?"text-rose-700":n.level==="warn"?"text-amber-700":"text-slate-900"}">${n.title}</p>
              <p class="mt-0.5 truncate text-xs text-slate-500">${esc(n.desc)}</p>
            </a>
            ${n.read?`<span class="shrink-0 text-xs text-slate-400">已读</span>`
                    :`<button onclick="markNoticeRead('${n.key}')" class="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">标为已读</button>`}
          </div>`).join("");
  }

  return `
  <div class="mx-auto max-w-4xl px-4 py-8 space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">个人中心</h1>
        <p class="text-sm text-slate-500">${esc(CURRENT_USER.displayName)} · 登录于 ${SESSION_DAYS} 天内有效，收藏与订阅保存在云端</p>
      </div>
      <button onclick="logoutUser()" class="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">退出登录</button>
    </div>
    ${ME_TAB!=="notice" && unreadNoticeCount()>0?`
    <button onclick="setMeTab('notice')" class="flex w-full items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-left transition hover:bg-amber-100">
      <span class="text-sm font-medium text-amber-900">🔔 你有 ${unreadNoticeCount()} 条未读提醒，含即将截止的订阅赛事</span>
      <span class="shrink-0 text-sm text-amber-700">去看 →</span>
    </button>`:""}
    <div class="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div class="rounded-lg border border-slate-200 bg-white">
        ${tabBar}
      ${ME_TAB==="notice" && unreadNoticeCount()>0
        ? `<div class="flex justify-end border-b border-slate-100 px-5 py-2"><button onclick="markAllNoticesRead()" class="text-xs text-blue-600 hover:underline">全部标为已读</button></div>`
        : ""}
      <div class="divide-y divide-slate-100">${body}</div>
    </div>
    <aside class="space-y-4">
      <div class="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
        <p class="text-base font-semibold">账号设置</p>
        <div class="space-y-1 text-sm">
          <p class="text-slate-500">用户名</p>
          <p class="font-medium">${esc(CURRENT_USER.username)}</p>
        </div>
        <div class="space-y-1">
          <label class="text-sm font-medium">昵称</label>
          <input id="me-display-name" value="${esc(CURRENT_USER.displayName)}" maxlength="20"
            class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
          <p class="text-xs text-slate-400">显示在页面右上角与个人中心</p>
        </div>
        <button onclick="saveDisplayName()" class="w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700">保存昵称</button>
      </div>
    </aside>
  </div>`;
}

function PageSubmit(){
  return `
  <div class="mx-auto max-w-3xl px-4 py-8 space-y-6">
    <div>
      <h1 class="text-2xl font-bold">提交赛事线索</h1>
      <p class="text-sm text-slate-500">提交后进入后台「用户投稿审核」队列，数据会写入云端数据库。</p>
    </div>
    ${CURRENT_USER
      ? `<p class="rounded-md bg-emerald-50 px-4 py-3 text-xs text-emerald-700">已登录 ${esc(CURRENT_USER.displayName)}，本次投稿会记到你的账号下，可在<a href="#/me" class="underline">个人中心 → 我的投稿</a>查看审核进度。</p>`
      : `<p class="rounded-md bg-amber-50 px-4 py-3 text-xs text-amber-800">未登录也可以投稿，但无法在个人中心跟踪进度。<a href="#/me" class="underline">登录 / 注册</a>后再投稿可以随时查看审核结果。</p>`}
    <div class="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
      <div class="space-y-2">
        <label class="text-sm font-medium">赛事名称 *</label>
        <input id="sub-title" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder="例如：2026 年 XX 市青少年环保创意大赛">
      </div>
      <div class="space-y-2">
        <label class="text-sm font-medium">官方链接</label>
        <input id="sub-url" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder="https://...">
      </div>
      <div class="space-y-2">
        <label class="text-sm font-medium">你的联系方式</label>
        <input id="sub-contact" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder="邮箱 / 微信 / 手机">
      </div>
      <div class="space-y-2">
        <label class="text-sm font-medium">补充说明</label>
        <textarea id="sub-desc" rows="4" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder="赛事简介、组别、奖项、费用等"></textarea>
      </div>
      <button onclick="submitForm()" class="w-full rounded-md bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700">提交</button>
    </div>
  </div>`;
}

/* 表还没补齐列时逐级降级重试，别让一次投稿因为少一列就失败 */
async function insertSubmission(row){
  let r = await db.from("submissions").insert(row);
  if (r.error && /user_id/i.test(r.error.message)) { delete row.user_id; r = await db.from("submissions").insert(row); }
  if (r.error && /description/i.test(r.error.message)) { delete row.description; r = await db.from("submissions").insert(row); }
  return r;
}

async function submitForm(){
  const title = document.getElementById("sub-title").value.trim();
  const url = document.getElementById("sub-url").value.trim();
  const contact = document.getElementById("sub-contact").value.trim();
  const desc = document.getElementById("sub-desc").value.trim();
  if (!title) { toast("请填写赛事名称"); return; }
  const row = { title, url, contact, description: desc, status: "PENDING" };
  if (CURRENT_USER) row.user_id = CURRENT_USER.id;
  const { error } = await insertSubmission(row);
  if (error) { toast("提交失败：" + dbErrMsg(error)); return; }
  await Promise.all([loadSubmissions(), CURRENT_USER ? loadMySubmissions() : Promise.resolve()]);
  document.getElementById("sub-title").value = "";
  document.getElementById("sub-url").value = "";
  document.getElementById("sub-contact").value = "";
  document.getElementById("sub-desc").value = "";
  toast(CURRENT_USER ? "投稿已提交，可在「个人中心 → 我的投稿」查看进度" : "投稿已提交，等待审核");
}

function PageAbout(){
  return `
  <div class="mx-auto max-w-3xl px-4 py-8 space-y-6">
    <h1 class="text-2xl font-bold">关于本站</h1>
    <div class="rounded-lg border border-slate-200 bg-white p-6 space-y-3 text-sm leading-relaxed text-slate-500">
      <h2 class="text-base font-semibold text-slate-900">平台定位</h2>
      <p>青少年赛事信息聚合平台，用于聚合公开渠道发布的青少年赛事、竞赛与活动信息，帮助家长与学生更高效地检索、筛选与跟踪赛事。</p>
      <p>平台持续从公开渠道采集并更新赛事信息，每条赛事均标注来源与可信度，可跳转原始出处核对。</p>
    </div>
    <div class="rounded-lg border border-slate-200 bg-white p-6 space-y-3 text-sm text-slate-500">
      <h2 class="text-base font-semibold text-slate-900">数据来源说明</h2>
      <ul class="list-disc space-y-1 pl-5">
        ${Object.entries(SOURCE_TYPES).map(([k,v])=>`<li><code class="rounded bg-slate-100 px-1">${k}</code> — ${v}</li>`).join("")}
      </ul>
      <p>每条赛事均记录来源名称、来源链接与录入时间，可在赛事详情页查看并跳转原始出处。</p>
    </div>
    <div class="rounded-lg border border-slate-200 bg-white p-6 space-y-3 text-sm leading-relaxed text-slate-500">
      <h2 class="text-base font-semibold text-slate-900">免责声明</h2>
      <p>1. 本站为信息聚合平台，非赛事主办方，不参与赛事组织、报名与评审。</p>
      <p>2. 赛事信息均来源于公开渠道，平台尽力核实但不保证信息的完整性、准确性与时效性，请以主办方官方发布为准。</p>
      <p>3. 对于因使用本站信息产生的任何直接或间接损失，本站不承担责任。</p>
      <p>4. 若权利人认为本站内容侵犯其合法权益，可通过举报入口提出，我们将及时处理。</p>
    </div>
  </div>`;
}

/* ============ 常见问题 Q&A（内容与站内实际功能一一对应） ============ */
function qaItem(q, a){
  return `
  <details class="group rounded-lg border border-slate-200 bg-white open:shadow-sm">
    <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-medium text-slate-900">
      <span>${q}</span>
      <span class="shrink-0 text-slate-400 transition group-open:rotate-45">＋</span>
    </summary>
    <div class="border-t border-slate-100 px-5 py-4 text-sm leading-relaxed text-slate-500">${a}</div>
  </details>`;
}
function qaGroup(title, items){
  return `
  <div class="space-y-3">
    <h2 class="text-base font-semibold text-slate-900">${title}</h2>
    ${items.join("")}
  </div>`;
}
function PageFaq(){
  return `
  <div class="mx-auto max-w-3xl px-4 py-8 space-y-8">
    <div>
      <h1 class="text-2xl font-bold">常见问题 Q&A</h1>
      <p class="text-sm text-slate-500">关于本站的数据来源、使用方法与常见疑问。还有其他问题可通过页面底部联系方式反馈。</p>
    </div>
    ${qaGroup("关于平台", [
      qaItem("这是一个什么平台？",
        `青少年赛事信息聚合平台：把公开渠道发布的青少年赛事、竞赛与活动信息聚合到一处，帮助家长与学生更高效地<strong>检索、筛选与跟踪</strong>赛事。赛事信息均来自公开渠道，每条都标注来源与可信度，可跳转原始出处核对。`),
      qaItem("赛事信息是从哪里来的？",
        `三个途径：<br>1. <strong>自动采集</strong>——后台定期从搜狗网页/搜狗微信、必应中国、360搜索、百度、NOI 官网、奥数网、网易教育以及 RSS 订阅源等公开渠道抓取，再用 AI 清洗规范化标题、生成简介、判定报名状态与信息类型；<br>2. <strong>用户提交</strong>——通过顶部导航「信息收集」提交赛事线索；<br>3. <strong>主办方入驻 / 认领</strong>——主办方提交资料、审核通过后自行维护。<br>每条赛事均记录来源名称、来源链接与录入时间，可在赛事详情页查看并跳转原始出处。`),
      qaItem("信息准确吗？能直接按站内信息报名吗？",
        `本站是聚合平台，<strong>不是赛事主办方</strong>，不参与赛事组织、报名与评审。报名截止日期、费用等字段由 AI 结合原文辅助判断，仅供参考，<strong>请一律以主办方官方公告为准</strong>。对信息有疑问时，优先点击详情页的「来源链接」核对原文。`),
    ])}
    ${qaGroup("怎么使用", [
      qaItem("赛事卡片上的「报名启事」「资讯」标签是什么意思？",
        `<span class="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">报名启事</span>：告诉读者可以去报名的内容（含报名时间、条件、入口、章程发布），看完能直接行动；<br><span class="rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700">资讯</span>：新闻报道、获奖名单、政策解读、赛事回顾等，看完不能直接报名，会在顶部导航的「<a href="#/news" class="text-blue-600 underline">赛事资讯</a>」频道集中展示。<br>赛事库顶部可按类型筛选。`),
      qaItem("「报名中 / 未开始 / 已截止」是怎么判定的？",
        `平台结合报名截止日期与当天日期自动判定，并由 AI 复核。受原文信息所限，个别赛事的截止日期可能缺失或滞后，报名前请务必到官方渠道确认。`),
      qaItem("怎么快速找到适合我的赛事？",
        `四种方式：<br>1. 顶部搜索框按关键词搜索；<br>2. 在「赛事库」按<strong>分类 / 地区 / 学段</strong>筛选；<br>3. 在「赛事日历」按时间浏览；<br>4. 在「数据报告」查看各类赛事的统计分布。`),
      qaItem("注册登录有什么用？",
        `登录后可以<strong>收藏赛事</strong>、<strong>订阅截止提醒</strong>、在「个人中心 → 我的投稿」<strong>跟踪投稿审核进度</strong>、查看入驻 / 认领申请的审核状态以及站内通知。未登录也可以浏览赛事库和提交线索，只是无法跟踪进度。`),
      qaItem("截止提醒是怎么实现的？",
        `在赛事详情页点击「订阅提醒」后，个人中心的「通知」会根据你订阅的赛事与报名截止日期自动计算提醒（临近截止、即将开始等），已读状态保存在本机，无需留下邮箱或手机号。`),
    ])}
    ${qaGroup("参与共建", [
      qaItem("我知道一个赛事但站里没有，怎么办？",
        `点击顶部导航的「<a href="#/submit" class="text-blue-600 underline">信息收集</a>」，填写赛事名称、官方链接与补充说明提交。提交后进入审核队列，通过审核即会在赛事库展示。登录后再提交，可以在个人中心随时查看审核进度。`),
      qaItem("我是主办方，如何入驻或认领赛事？",
        `在「<a href="#/org" class="text-blue-600 underline">主办方入驻 / 认领</a>」页面选择：<br>· <strong>机构入驻</strong>——填写机构名称、官网与联系方式，审核通过后可在本站发布和维护赛事；<br>· <strong>赛事认领</strong>——若站内已有你主办的赛事，选中该赛事并提交证明材料，审核通过后建立关联。<br>审核进度可在「个人中心 → 我的申请」查看。`),
      qaItem("看到错误信息或侵权内容怎么办？",
        `在赛事详情页使用举报入口提交原因与说明，运营人员会在后台审核处理；涉及侵权会被及时下架。`),
      qaItem("为什么有的赛事信息不完整？",
        `自动采集依赖原始页面公开的信息，原文没写的字段（如费用、奖项）平台不会编造，会留空处理。欢迎通过「信息收集」补充线索，或等待主办方认领后完善。`),
    ])}
  </div>`;
}

let ORG_KIND = "JOIN";        // JOIN 入驻 / CLAIM 认领
let ORG_CLAIM_EVENT = "";
let ORG_DONE = false;

function setOrgKind(k){ ORG_KIND = k; ORG_DONE = false; render(); }

async function submitOrgForm(){
  const orgName = document.getElementById("org-name").value.trim();
  const website = document.getElementById("org-site").value.trim();
  const contactName = document.getElementById("org-contact-name").value.trim();
  const contact = document.getElementById("org-contact").value.trim();
  const message = document.getElementById("org-message").value.trim();
  let claimEventId = "";
  if (ORG_KIND === "CLAIM") {
    const sel = document.getElementById("org-claim-event");
    claimEventId = sel ? sel.value : "";
    if (!claimEventId) { toast("请选择要认领的赛事"); return; }
  }
  if (!orgName) { toast("请填写机构名称"); return; }
  const claimed = claimEventId ? EVENTS.find(e => e.id === claimEventId) : null;
  try {
    await submitOrgApplication({
      kind: ORG_KIND, orgName, website, contactName, contact, message,
      claimEventId: claimEventId || null,
      claimEventTitle: claimed ? claimed.title : "",
    });
  } catch (e) { toast("提交失败：" + dbErrMsg(e)); return; }
  ORG_DONE = true;
  render();
}

function PageOrg(){
  const hash = location.hash.replace(/^#/,"");
  const qs = hash.includes("?") ? hash.split("?")[1] : "";
  const q = new URLSearchParams(qs);
  if (q.get("event") && isUuid(q.get("event"))) { ORG_KIND = "CLAIM"; ORG_CLAIM_EVENT = q.get("event"); ORG_DONE = false; }
  if (q.get("kind")) { ORG_KIND = q.get("kind").toUpperCase() === "CLAIM" ? "CLAIM" : "JOIN"; ORG_DONE = false; }
  if (qs) history.replaceState(null, "", "#/org");

  const feature = (icon,title,desc,color)=>`
    <div class="rounded-lg border border-slate-200 bg-white p-5">
      <p class="flex items-center gap-2 text-base font-semibold"><span class="${color}">${icon}</span>${title}</p>
      <p class="mt-2 text-sm text-slate-500">${desc}</p>
    </div>`;

  const claimable = EVENTS.filter(e => e.reviewStatus === "APPROVED")
    .sort((a,b) => (daysUntil(a.registrationEnd)??999) - (daysUntil(b.registrationEnd)??999))
    .slice(0, 300);
  // 从详情页「去认领」带过来的赛事如果不在已发布列表里（比如还在待审核），也要能选中，
  // 否则下拉框预选落空，提交时才报"请选择要认领的赛事"
  const claimTarget = ORG_CLAIM_EVENT ? EVENTS.find(e => e.id === ORG_CLAIM_EVENT) : null;
  if (claimTarget && !claimable.some(e => e.id === claimTarget.id)) claimable.unshift(claimTarget);

  const form = ORG_DONE ? `
    <div class="rounded-lg border border-emerald-200 bg-emerald-50 p-6 space-y-2 text-sm text-emerald-800">
      <p class="text-base font-semibold">✔ 申请已提交</p>
      <p>申请已进入后台审核队列，审核结果会在<a href="#/me" class="underline">个人中心</a>里体现（登录状态下提交的申请会关联到你的账号）。</p>
      <button onclick="ORG_DONE=false;render()" class="mt-2 rounded-md border border-emerald-300 bg-white px-4 py-2 text-sm hover:bg-emerald-100">再提交一份</button>
    </div>` : `
    <div class="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
      <div class="flex rounded-md border border-slate-200 p-1 text-sm">
        ${ORG_KINDS.map(([k,l])=>`<button onclick="setOrgKind('${k}')" class="flex-1 rounded py-1.5 font-medium ${ORG_KIND===k?"bg-blue-600 text-white":"text-slate-600 hover:bg-slate-50"}">${l==="CLAIM"?"赛事认领":"机构入驻"}</button>`).join("")}
      </div>
      ${ORG_KIND==="CLAIM"?`
      <div class="space-y-2">
        <label class="text-sm font-medium">要认领的赛事 *</label>
        <select id="org-claim-event" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
          <option value="">请选择赛事…</option>
          ${claimable.map(e=>`<option value="${e.id}" ${e.id===ORG_CLAIM_EVENT?"selected":""}>${esc(e.title)}${e.sourceName?`（来源：${esc(e.sourceName)}）`:""}</option>`).join("")}
        </select>
        <p class="text-xs text-slate-400">认领通过后，该赛事会显示「✓ 认证主办方」标识。</p>
      </div>`:""}
      <div class="grid gap-4 md:grid-cols-2">
        <div class="space-y-2">
          <label class="text-sm font-medium">机构名称 *</label>
          <input id="org-name" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder="全称，须与赛事主办方一致">
        </div>
        <div class="space-y-2">
          <label class="text-sm font-medium">官网</label>
          <input id="org-site" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder="https://...">
        </div>
        <div class="space-y-2">
          <label class="text-sm font-medium">联系人</label>
          <input id="org-contact-name" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder="姓名">
        </div>
        <div class="space-y-2">
          <label class="text-sm font-medium">联系方式</label>
          <input id="org-contact" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder="邮箱 / 电话">
        </div>
      </div>
      <div class="space-y-2">
        <label class="text-sm font-medium">补充说明</label>
        <textarea id="org-message" rows="3" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder="主营业务、过往赛事、希望获得的曝光位等"></textarea>
      </div>
      <button onclick="submitOrgForm()" class="w-full rounded-md bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700">提交申请</button>
    </div>`;

  return `
  <div class="mx-auto max-w-4xl px-4 py-8 space-y-8">
    <div>
      <span class="inline-block rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">申请提交后进入后台审核队列</span>
      <h1 class="mt-3 text-2xl font-bold">主办方入驻 / 赛事认领</h1>
      <p class="text-sm text-slate-500">认证主办方可获得认证标识、推广位与数据报告服务。</p>
    </div>
    <div class="grid gap-4 md:grid-cols-3">
      ${feature("🛡","认证标识","赛事卡片与详情页展示「已认证主办方」，提升信任度。","text-sky-600")}
      ${feature("📣","推广位","首页 Banner、首页推荐、列表置顶等曝光位。","text-amber-600")}
      ${feature("📈","数据报告","分类分布、地区分布、热度趋势等数据服务。","text-emerald-600")}
    </div>
    ${form}
  </div>`;
}

/* ============ 后台 ============ */
const ADMIN_NAV = [
  ["/admin","仪表盘","📊"],
  ["/admin/events","赛事管理","🏆"],
  ["/admin/sources","来源管理","🗄"],
  ["/admin/crawl","采集任务","📡"],
  ["/admin/raw","原始数据","📄"],
  ["/admin/promotions","推广位管理","📣"],
  ["/admin/analytics","分析看板","📈"],
  ["/admin/submissions","投稿审核","📥"],
  ["/admin/reports","举报处理","⚑"],
  ["/admin/orgs","入驻审核","🏢"],
  ["/admin/health","数据库体检","🩺"],
];

/* 窄屏抽屉状态：桌面（≥md）侧栏常驻，窄屏靠汉堡按钮滑出，点击遮罩/导航项/×关闭 */
let ADMIN_NAV_OPEN = false;
function setAdminNav(open){
  ADMIN_NAV_OPEN = open;
  const drawer = document.getElementById("admin-drawer");
  const backdrop = document.getElementById("admin-backdrop");
  if (drawer) {
    drawer.classList.toggle("translate-x-0", open);
    drawer.classList.toggle("-translate-x-full", !open);
  }
  if (backdrop) backdrop.classList.toggle("hidden", !open);
}
function toggleAdminNav(){ setAdminNav(!ADMIN_NAV_OPEN); }
function closeAdminNav(){ setAdminNav(false); }

function AdminSidebar(hash){
  // close=true 的用于抽屉内：点击导航项跳转后顺带收起抽屉
  const mkItems = (close) => ADMIN_NAV.map(([h,l,ic])=>{
    const active = h==="/admin" ? hash==="/admin" : hash.startsWith(h);
    return `<a href="#${h}"${close?` onclick="closeAdminNav()"`:""} class="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition ${active?"bg-white text-slate-900 shadow-sm":"text-slate-500 hover:bg-white/70 hover:text-slate-900"}"><span>${ic}</span>${l}</a>`;
  }).join("");
  // 桌面端常驻侧栏（不变）
  const desktop = `
  <aside class="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-slate-100 md:flex">
    <div class="flex h-16 items-center gap-2 border-b border-slate-200 px-5">
      <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-sm font-bold text-white">后</span>
      <span class="text-sm font-semibold">赛事平台后台</span>
    </div>
    <nav class="flex-1 space-y-1 overflow-y-auto p-3">${mkItems(false)}</nav>
    <div class="border-t border-slate-200 p-3">
      <a href="#/" class="block rounded-md px-3 py-2 text-xs text-slate-500 hover:bg-white/70">← 返回前台</a>
    </div>
  </aside>`;
  // 窄屏（<md）抽屉：常驻 DOM，仅在打开时滑入；汉堡按钮在 AdminTopbar
  const drawer = `
  <div class="md:hidden">
    <div id="admin-backdrop" ${ADMIN_NAV_OPEN?"":"hidden"} onclick="closeAdminNav()" class="fixed inset-0 z-40 bg-slate-900/40"></div>
    <aside id="admin-drawer" class="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform duration-200 ${ADMIN_NAV_OPEN?"translate-x-0":"-translate-x-full"}">
      <div class="flex h-16 items-center gap-2 border-b border-slate-200 px-5">
        <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-sm font-bold text-white">后</span>
        <span class="text-sm font-semibold">赛事平台后台</span>
        <button onclick="closeAdminNav()" aria-label="关闭菜单" class="ml-auto rounded-md p-2 text-slate-500 hover:bg-slate-100">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>
        </button>
      </div>
      <nav class="flex-1 space-y-1 overflow-y-auto p-3">${mkItems(true)}</nav>
      <div class="border-t border-slate-200 p-3">
        <a href="#/" onclick="closeAdminNav()" class="block rounded-md px-3 py-2 text-xs text-slate-500 hover:bg-slate-100">← 返回前台</a>
      </div>
    </aside>
  </div>`;
  return desktop + drawer;
}

function AdminTopbar(){
  return `
  <header class="flex h-16 items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 sm:px-5">
    <div class="flex min-w-0 items-center gap-2">
      <button onclick="toggleAdminNav()" aria-label="打开菜单" class="shrink-0 rounded-md p-2 text-slate-600 hover:bg-slate-100 md:hidden">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
      </button>
      <img src="logo.svg" alt="" class="h-7 w-7 shrink-0">
      <div class="truncate text-sm text-slate-500">青少年赛事聚合平台 · 运营后台（Supabase）</div>
    </div>
    <div class="flex shrink-0 items-center gap-3">
      <span class="hidden text-sm sm:inline">已登录：<strong>${esc(ADMIN_USER)}</strong></span>
      <button onclick="adminLogout()" class="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">退出</button>
    </div>
  </header>`;
}

function statCard(label,value,hint,color){
  return `
  <div class="rounded-lg border border-slate-200 bg-white p-5">
    <p class="text-xs text-slate-500">${label}</p>
    <p class="mt-1 text-2xl font-semibold ${color||""}">${value}</p>
    ${hint?`<p class="mt-1 text-xs text-slate-400">${hint}</p>`:""}
  </div>`;
}

function AdminPageDashboard(){
  const total = EVENTS.length;
  const pending = EVENTS.filter(e=>e.reviewStatus==="PENDING").length;
  const closing = EVENTS.filter(e=>e.status==="OPEN").length;
  const sources = SOURCES.filter(s=>s.enabled).length;
  const rawNew = RAW_DOCS.filter(r=>r.status==="NEW").length;

  const pendingList = EVENTS.filter(e=>e.reviewStatus==="PENDING").slice(0,5);

  return `
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold">仪表盘</h1>
      <p class="text-sm text-slate-500">数据来自 Supabase 云数据库 · 实时同步</p>
    </div>
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      ${statCard("赛事总数",total)}
      ${statCard("待审核",pending,"",  "text-amber-600")}
      ${statCard("报名中",closing,"",  "text-emerald-600")}
      ${statCard("启用来源",sources,"",  "text-emerald-600")}
      ${statCard("原始待处理",rawNew,"来自采集",  "text-sky-600")}
    </div>
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="rounded-lg border border-slate-200 bg-white">
        <div class="border-b border-slate-100 px-5 py-3"><p class="text-base font-semibold">待审核队列</p></div>
        <div class="divide-y divide-slate-100">
          ${pendingList.length===0?`<p class="px-5 py-6 text-sm text-slate-500">暂无待审核</p>`:
            pendingList.map(e=>`
            <div class="flex items-center justify-between px-5 py-3">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">${esc(e.title)}</p>
                <p class="mt-0.5 text-xs text-slate-500">${esc(e.sourceName)} · ${esc(e.createdAt)}</p>
              </div>
              <a href="#/admin/events" class="shrink-0 text-xs text-blue-600 hover:underline">去审核 →</a>
            </div>`).join("")}
        </div>
      </div>
      <div class="rounded-lg border border-slate-200 bg-white">
        <div class="border-b border-slate-100 px-5 py-3"><p class="text-base font-semibold">最近采集任务</p></div>
        <div class="divide-y divide-slate-100">
          ${CRAWL_JOBS.length===0?`<p class="px-5 py-6 text-sm text-slate-500">还没有采集记录</p>`:
            CRAWL_JOBS.slice(0,4).map(j=>`
            <div class="flex items-center justify-between px-5 py-3">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">${esc(j.sourceName)}</p>
                <p class="mt-0.5 text-xs text-slate-500">${esc(j.startedAt)} · 写入 ${j.newCount} 条</p>
              </div>
              ${Badge(j.status==="SUCCESS"?"成功":"失败", j.status==="SUCCESS"?"bg-emerald-100 text-emerald-700":"bg-rose-100 text-rose-700")}
            </div>`).join("")}
        </div>
      </div>
    </div>
  </div>`;
}

function AdminPageEvents(){
  const rows = EVENTS.map(e=>`
    <tr class="border-t border-slate-100 hover:bg-slate-50">
      <td class="px-4 py-3">
        <p class="text-sm font-medium">${esc(e.title)}</p>
        <p class="mt-0.5 text-xs text-slate-500">${esc(e.organizer||"主办方待补")} · 来源：${esc(e.sourceName||"—")}</p>
      </td>
      <td class="px-4 py-3">${BadgeCategory(e.category||"未分类")}</td>
      <td class="px-4 py-3 text-sm">${esc(e.region||"—")}</td>
      <td class="px-4 py-3 text-sm">${esc(e.registrationEnd||"—")}</td>
      <td class="px-4 py-3">${BadgeReview(e.reviewStatus)}</td>
      <td class="px-4 py-3">
        <div class="flex flex-wrap gap-1">
          ${e.isPinned?Badge("置顶","bg-slate-200 text-slate-700"):""}
          ${e.isPromoted?BadgePromoted():""}
        </div>
      </td>
      <td class="px-4 py-3">
        <div class="flex flex-wrap gap-1">
          ${e.reviewStatus!=="APPROVED"?`
            <button onclick="reviewEvent('${e.id}','APPROVED')" class="rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700">通过</button>
          `:""}
          ${e.reviewStatus!=="REJECTED"?`
            <button onclick="reviewEvent('${e.id}','REJECTED')" class="rounded bg-rose-600 px-2 py-1 text-xs text-white hover:bg-rose-700">拒绝</button>
          `:""}
          <button onclick="togglePin('${e.id}')" class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-white">${e.isPinned?"取消置顶":"置顶"}</button>
          <button onclick="togglePromote('${e.id}')" class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-white">${e.isPromoted?"取消推广":"推广"}</button>
          <button onclick="openEventForm('${e.id}')" class="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100">编辑</button>
          <button onclick="deleteEvent('${e.id}')" class="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-700 hover:bg-rose-100">删除</button>
        </div>
      </td>
    </tr>`).join("");

  return `
  <div class="space-y-6">
    <div class="flex items-end justify-between">
      <div>
        <h1 class="text-2xl font-bold">赛事管理</h1>
        <p class="text-sm text-slate-500">共 ${EVENTS.length} 条 · 所有操作会写入 Supabase 数据库并立即反映到前台</p>
      </div>
      <button onclick="openEventForm('')" class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">+ 新增赛事</button>
      <button onclick="findOfficialSites()" ${CRAWL_RUNNING?"disabled":""} class="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">${CRAWL_RUNNING?(AI_PROGRESS?`查找中(${AI_PROGRESS})…`:"查找中…"):"🔗 AI 查找官网"}</button>
    </div>
    <div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table class="w-full">
        <thead class="bg-slate-50 text-left text-xs font-medium text-slate-500">
          <tr>
            <th class="px-4 py-3">赛事</th><th class="px-4 py-3">分类</th><th class="px-4 py-3">地区</th>
            <th class="px-4 py-3">截止</th><th class="px-4 py-3">审核</th><th class="px-4 py-3">标记</th><th class="px-4 py-3">操作</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="7" class="px-4 py-10 text-center text-sm text-slate-500">暂无赛事，点右上角「+ 新增赛事」，或先去「采集任务」运行一次</td></tr>`}</tbody>
      </table>
    </div>
  </div>`;
}

/* 下拉选项：预置枚举 + 库里出现过的值 + 当前值（防止编辑时原值丢失） */
function enumOptions(fixed, current, key, cap, emptyLabel){
  const list = filterOptions(fixed, key, cap);
  if (current && !list.includes(current)) list.unshift(current);
  return [[ "", emptyLabel || "—" ], ...list.map(v => [v, v])];
}

function openEventForm(id){
  const e = id ? EVENTS.find(x => x.id === id) : null;
  const statusOpts = ["UPCOMING","OPEN","CLOSED","ONGOING","ENDED"].map(k => [k, STATUS[k]]);
  openModal({
    title: e ? `编辑赛事：${e.title}` : "新增赛事",
    saveLabel: e ? "保存修改" : "新增",
    wide: true,
    body: `
      <div class="grid gap-4 sm:grid-cols-2">
        ${fInput("title","赛事名称", e?e.title:"", { required:true, full:true, placeholder:"2026 年 XX 青少年 XX 大赛" })}
        ${fSelect("category","分类", e?e.category:"", enumOptions(CATEGORIES, e&&e.category, "category", 12, "未分类"))}
        ${fSelect("region","地区", e?e.region:"", enumOptions(REGIONS, e&&e.region, "region", 20, "地区待定"))}
        ${fSelect("grade_scope","学段", e?e.gradeScope:"", enumOptions(GRADES, e&&e.gradeScope, "gradeScope", 6, "不限"))}
        ${fInput("format","参赛形式", e?e.format:"", { placeholder:"线上 / 线下" })}
        ${fInput("fee","费用", e?e.fee:"", { placeholder:"免费 / 200 元" })}
        ${fInput("prize","奖项", e?e.prize:"")}
        ${fInput("organizer","主办方", e?e.organizer:"")}
        ${fInput("registration_end","报名截止", e?e.registrationEnd:"", { type:"date" })}
        ${fInput("event_start","比赛开始", e?e.eventStart:"", { type:"date" })}
        ${fSelect("status","报名状态", e?e.status:"OPEN", statusOpts)}
        ${fInput("credibility_score","可信度 (0-100)", e?e.credibilityScore:60, { type:"number" })}
        ${fInput("source_name","来源名称", e?e.sourceName:"")}
        ${fInput("source_url","来源链接", e?e.sourceUrl:"", { placeholder:"https://..." })}
        ${fSelect("review_status","审核状态", e?e.reviewStatus:"APPROVED", Object.entries(REVIEW).map(([k,v])=>[k,v]))}
        ${fArea("summary","简介", e?e.summary:"", 3)}
        ${fArea("description","详情", e?e.description:"", 4)}
      </div>
      <div class="flex flex-wrap gap-4 border-t border-slate-100 pt-3">
        ${fCheck("is_pinned","置顶", e?e.isPinned:false)}
        ${fCheck("is_promoted","设为推广", e?e.isPromoted:false)}
        ${fCheck("is_sample","标记为示例数据", e?e.isSample:false)}
        ${fCheck("organization_verified","主办方已认证", e?e.organizationVerified:false)}
      </div>`,
    onSave: async () => {
      const v = readModalForm();
      if (!String(v.title || "").trim()) { toast("赛事名称不能为空"); return; }
      const row = {
        title: v.title.trim(),
        category: v.category, region: v.region, grade_scope: v.grade_scope,
        format: v.format, fee: v.fee, prize: v.prize, organizer: v.organizer,
        registration_end: v.registration_end || null,
        event_start: v.event_start || null,
        status: v.status,
        review_status: v.review_status,
        credibility_score: Number(v.credibility_score) || 60,
        source_name: v.source_name, source_url: v.source_url,
        summary: v.summary, description: v.description,
        is_pinned: !!v.is_pinned, is_promoted: !!v.is_promoted,
        is_sample: !!v.is_sample, organization_verified: !!v.organization_verified,
      };
      const r = e
        ? await writeWithFallback(r2 => db.from("events").update(r2).eq("id", e.id), row)
        : await writeWithFallback(r2 => db.from("events").insert(r2).select("id").single(), row);
      if (r.error) { toast((e?"保存":"新增") + "失败：" + dbErrMsg(r.error)); return; }
      closeModal();
      await loadEvents();
      toast(e ? "赛事已更新" : "赛事已新增");
      render();
    },
  });
}

async function deleteEvent(id){
  const e = EVENTS.find(x => x.id === id);
  if (!e) return;
  const favs = FAVORITES.filter(f => f.eventId === id).length;
  if (!confirm(`确定删除赛事「${e.title}」？\n\n此操作不可撤销，相关的收藏与订阅记录会一并删除。`)) return;
  const { error } = await db.from("events").delete().eq("id", id);
  if (error) { toast("删除失败：" + dbErrMsg(error)); return; }
  if (CURRENT_USER && favs) await loadUserData();
  await loadEvents();
  toast("已删除");
  render();
}

function AdminPageSources(){
  return `
  <div class="space-y-6">
    <div class="flex items-end justify-between">
      <div>
        <h1 class="text-2xl font-bold">来源管理</h1>
        <p class="text-sm text-slate-500">共 ${SOURCES.length} 个来源，启用 ${SOURCES.filter(s=>s.enabled).length} 个</p>
      </div>
      <button onclick="openSourceForm('')" class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">+ 新增来源</button>
    </div>
    <div class="rounded-lg border border-amber-200 bg-amber-50 p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="font-semibold text-amber-900">🏆 白名单赛事导入（约 190 项）</p>
          <p class="mt-1 text-xs leading-relaxed text-amber-800">从 baimingdan.123code.me 拉取教育部及各省教育厅公布的竞赛白名单汇总，解析后作为「已通过」赛事直入前台赛事库（主办单位、学段、分类自动映射）。重复导入按「标题+地区」去重，可随时再点更新。</p>
        </div>
        <button onclick="importBaimingdan()" ${WMD_RUNNING?"disabled":""} class="shrink-0 rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50">${WMD_RUNNING?"导入中…":"导入白名单赛事"}</button>
      </div>
    </div>
    <div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table class="w-full">
        <thead class="bg-slate-50 text-left text-xs font-medium text-slate-500">
          <tr><th class="px-4 py-3">名称</th><th class="px-4 py-3">类型</th><th class="px-4 py-3">可信度</th>
          <th class="px-4 py-3">最近采集</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">操作</th></tr>
        </thead>
        <tbody>
          ${SOURCES.length===0?`<tr><td colspan="6" class="px-4 py-10 text-center text-sm text-slate-500">暂无来源，点右上角「+ 新增来源」添加</td></tr>`:""}
          ${SOURCES.map(s=>`
            <tr class="border-t border-slate-100">
              <td class="px-4 py-3"><p class="text-sm font-medium">${esc(s.name)}</p><p class="text-xs text-slate-400">${esc(s.url)}</p></td>
              <td class="px-4 py-3">${Badge(SOURCE_TYPES[s.type]||s.type||"—","bg-slate-100 text-slate-700")}</td>
              <td class="px-4 py-3 text-sm">${s.credibilityScore}</td>
              <td class="px-4 py-3 text-xs text-slate-500">${esc(s.lastCrawledAt||"—")}</td>
              <td class="px-4 py-3">${s.enabled?Badge("启用","bg-emerald-100 text-emerald-700"):Badge("禁用","bg-slate-200 text-slate-500")}</td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-1">
                  <button onclick="toggleSource('${s.id}')" class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">${s.enabled?"禁用":"启用"}</button>
                  <button onclick="openSourceForm('${s.id}')" class="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100">编辑</button>
                  <button onclick="deleteSource('${s.id}')" class="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-700 hover:bg-rose-100">删除</button>
                </div>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </div>`;
}

function openSourceForm(id){
  const s = id ? SOURCES.find(x => x.id === id) : null;
  openModal({
    title: s ? `编辑来源：${s.name}` : "新增来源",
    saveLabel: s ? "保存修改" : "新增",
    body: `
      ${fInput("name","来源名称", s?s.name:"", { required:true, placeholder:"例如：NOI 官网" })}
      ${fInput("url","来源地址", s?s.url:"", { placeholder:"https://..." })}
      ${fSelect("type","来源类型", s?s.type:"HTML", Object.entries(SOURCE_TYPES).map(([k,v])=>[k,v]))}
      ${fInput("credibility_score","可信度 (0-100)", s?s.credibilityScore:60, { type:"number" })}
      ${fCheck("enabled","启用", s?s.enabled:true)}`,
    onSave: async () => {
      const v = readModalForm();
      if (!String(v.name || "").trim()) { toast("来源名称不能为空"); return; }
      const row = {
        name: v.name.trim(), url: v.url, type: v.type,
        credibility_score: Number(v.credibility_score) || 60,
        enabled: !!v.enabled,
      };
      const r = s
        ? await writeWithFallback(r2 => db.from("sources").update(r2).eq("id", s.id), row)
        : await writeWithFallback(r2 => db.from("sources").insert(r2).select("id").single(), row);
      if (r.error) { toast((s?"保存":"新增") + "失败：" + dbErrMsg(r.error)); return; }
      closeModal();
      await loadSources();
      toast(s ? "来源已更新" : "来源已新增");
      render();
    },
  });
}

async function deleteSource(id){
  const s = SOURCES.find(x => x.id === id);
  if (!s) return;
  if (!confirm(`确定删除来源「${s.name}」？\n\n已采集的赛事与原始数据不会受影响。`)) return;
  const { error } = await db.from("sources").delete().eq("id", id);
  if (error) { toast("删除失败：" + dbErrMsg(error)); return; }
  await loadSources();
  toast("已删除");
  render();
}

function AdminPageCrawl(){
  return `
  <div class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">采集任务</h1>
        <p class="text-sm text-slate-500">真实抓取搜狗、必应、百度、官网，结果写入 Supabase</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button onclick="runRealCrawl('sogou-web')" class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50" ${CRAWL_RUNNING?"disabled":""}>采集搜狗网页</button>
        <button onclick="runRealCrawl('bing-search')" class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50" ${CRAWL_RUNNING?"disabled":""}>采集必应</button>
        <button onclick="runRealCrawl('sogou-wechat')" class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50" ${CRAWL_RUNNING?"disabled":""}>采集公众号</button>
        <button onclick="runRealCrawl('baidu-search')" class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50" ${CRAWL_RUNNING?"disabled":""}>采集百度</button>
        <button onclick="runRealCrawl('360-search')" class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50" ${CRAWL_RUNNING?"disabled":""}>采集360</button>
        <button onclick="runRealCrawl('official-noi')" class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50" ${CRAWL_RUNNING?"disabled":""}>采集官网频道</button>
        <button onclick="runRealCrawl('crawl-rss')" class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50" ${CRAWL_RUNNING?"disabled":""}>采集 RSS 订阅</button>
        <button onclick="runRealCrawl('all')" class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" ${CRAWL_RUNNING?"disabled":""}>${CRAWL_RUNNING?"采集中…":"▶ 全部采集"}</button>
        <button onclick="wipeAndRecrawl()" class="rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50" ${CRAWL_RUNNING?"disabled":""}>🗑 清库重采</button>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <button onclick="runRegStatusCheck()" class="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50" ${CRAWL_RUNNING?"disabled":""}>${CRAWL_RUNNING?(AI_PROGRESS?`执行中(${AI_PROGRESS})…`:"执行中…"):"AI 复查报名状态"}</button>
      <span class="text-xs text-slate-400">AI 清洗与复查使用内置 DeepSeek 接口（采集时每 10 条一批清洗标题、生成简介、判定报名状态与「启事/资讯」分类）。</span>
    </div>
    <div class="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 space-y-1">
      <p class="font-medium text-sm">⚠ 采集说明</p>
      <p>· 抓取走多级链路：先试同源代理 <code class="rounded bg-white px-1">/proxy</code>（需随站点部署 <code class="rounded bg-white px-1">_worker.js</code>，最稳），失败自动切换 allorigins / codetabs / cors.eu.org / cors.lol / whateverorigin 公共代理。</p>
      <p>· 来源均为<strong>国内可直接访问</strong>的站点：搜狗网页 / 搜狗微信、必应中国、360搜索、百度，以及 NOI 官网、奥数网、网易教育三个列表页。谷歌资讯已移除（news.google.com 大陆打不开，存进去的链接用户点不了）。</p>
      <p>· <strong>RSS 订阅</strong>：抓取「来源管理」里启用的 RSS 来源（rss2json 直连，失败自动降级代理转换），更多订阅源可在来源管理自行添加。</p>
      <p>· 必应结果里指向大陆不可达站点（YouTube、X、Reddit 等）的链接会被<strong>自动过滤</strong>，含 bing.com/ck/a 跳板的会解包成原站直达链接。</p>
      <p>· 搜狗 / 百度 / 360 有反爬，触发验证码时会返回失败日志，属正常现象；每条成功日志会标注实际使用的代理。</p>
      <p>· 采集结果写入 Supabase 的 raw_docs 表，原始数据页可查看。全部采集约需 2—3 分钟（8 组关键词 × 4 个搜索引擎 + 3 个列表页）。</p>
    </div>
    <div class="space-y-3">
      ${CRAWL_JOBS.length === 0 ? `<div class="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">还没有采集记录，点击上方按钮开始</div>` : ""}
      ${CRAWL_JOBS.map(j=>`
        <div class="rounded-lg border border-slate-200 bg-white p-5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-sm font-medium">${esc(j.sourceName)}</p>
              <p class="mt-0.5 text-xs text-slate-500">${esc(j.startedAt)} → ${esc(j.finishedAt)} · 触发：${j.trigger}</p>
            </div>
            <div class="flex items-center gap-2">
              ${Badge(j.status==="SUCCESS"?"成功":"失败", j.status==="SUCCESS"?"bg-emerald-100 text-emerald-700":"bg-rose-100 text-rose-700")}
              ${Badge(`抓取 ${j.totalFound} · 写入 ${j.newCount}`,"bg-slate-100 text-slate-700")}
            </div>
          </div>
          <pre class="mt-3 overflow-x-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-600">${esc(j.log)}</pre>
        </div>`).join("")}
    </div>
  </div>`;
}

function AdminPageRaw(){
  const list = RAW_DOCS.filter(r =>
    RAW_FILTER === "ALL" ? true :
    RAW_FILTER === "NONE" ? !r.kind :
    r.kind === RAW_FILTER);
  const cnt = k => RAW_DOCS.filter(r => k === "ALL" ? true : k === "NONE" ? !r.kind : r.kind === k).length;
  const tab = (k, label, cls) =>
    `<button onclick="setRawFilter('${k}')" class="rounded-full px-3 py-1 text-xs font-medium ${RAW_FILTER===k?cls:"bg-slate-100 text-slate-500 hover:bg-slate-200"}">${label} ${cnt(k)}</button>`;
  const kindBadge = k =>
    k === "NOTICE" ? Badge("报名启事", "bg-blue-100 text-blue-700") :
    k === "NEWS" ? Badge("资讯", "bg-violet-100 text-violet-700") : "";
  return `
  <div class="space-y-6">
    <div class="flex items-end justify-between">
      <div>
        <h1 class="text-2xl font-bold">原始数据</h1>
        <p class="text-sm text-slate-500">共 ${RAW_DOCS.length} 条 · 采集得到的原始文档，人工确认为赛事后入库</p>
      </div>
      <button onclick="reloadRaw()" class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50">刷新</button>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-xs text-slate-400">AI 分类：</span>
      ${tab("ALL", "全部", "bg-slate-900 text-white")}
      ${tab("NOTICE", "报名启事", "bg-blue-600 text-white")}
      ${tab("NEWS", "资讯", "bg-violet-600 text-white")}
      ${tab("NONE", "未分类", "bg-slate-700 text-white")}
      <button onclick="runKindClassify()" ${CRAWL_RUNNING?"disabled":""} class="ml-auto rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">${CRAWL_RUNNING?(AI_PROGRESS?`执行中(${AI_PROGRESS})…`:"执行中…"):"🤖 AI 分类原始数据"}</button>
    </div>
    <div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table class="w-full">
        <thead class="bg-slate-50 text-left text-xs font-medium text-slate-500">
          <tr><th class="px-4 py-3">标题</th><th class="px-4 py-3">来源</th><th class="px-4 py-3">抓取时间</th>
          <th class="px-4 py-3">类型 / 状态</th><th class="px-4 py-3">操作</th></tr>
        </thead>
        <tbody>
          ${list.length===0?`<tr><td colspan="5" class="px-4 py-10 text-center text-sm text-slate-500">${RAW_DOCS.length===0?"还没有原始数据，去「采集任务」页启动一次采集":"该分类下没有数据"}</td></tr>`:""}
          ${list.map(r=>`
            <tr class="border-t border-slate-100">
              <td class="px-4 py-3">
                <p class="text-sm font-medium">${esc(r.rawTitle)}</p>
                <a href="${esc(r.sourceUrl)}" target="_blank" class="text-xs text-blue-600 hover:underline">查看来源 ↗</a>
              </td>
              <td class="px-4 py-3 text-sm">${esc(r.sourceName)}</td>
              <td class="px-4 py-3 text-xs text-slate-500">${esc(r.fetchedAt)}</td>
              <td class="px-4 py-3">
                <p class="mb-1">${kindBadge(r.kind)}</p>
                ${r.regStatus?`<p class="mb-1">${Badge(STATUS[r.regStatus]||r.regStatus, r.regStatus==="OPEN"?"bg-emerald-100 text-emerald-700":r.regStatus==="UPCOMING"?"bg-sky-100 text-sky-700":"bg-slate-200 text-slate-500")}${r.deadline?`<span class="ml-1 text-xs text-slate-400">截止 ${esc(r.deadline)}</span>`:""}</p>`:""}
                ${
                r.status==="NEW"?Badge("待处理","bg-amber-100 text-amber-700"):
                r.status==="CONVERTED"?Badge("已转赛事","bg-emerald-100 text-emerald-700"):
                Badge("已丢弃","bg-slate-200 text-slate-500")
              }</td>
              <td class="px-4 py-3">
                ${r.status==="NEW"?`
                  <button onclick="convertRaw('${r.id}')" class="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700">${r.kind==="NEWS"?"转为资讯":"转为赛事"}</button>
                  <button onclick="discardRaw('${r.id}')" class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">丢弃</button>
                `:`<span class="text-xs text-slate-400">—</span>`}
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </div>`;
}

function setRawFilter(k){ RAW_FILTER = k; render(); }

async function reloadRaw(){ await loadRawDocs(); toast("已刷新"); render(); }

function AdminPagePromotions(){
  const slotLabel = k => { const f = PROMO_SLOTS.find(x=>x[0]===k); return f ? f[1] : (k || "—"); };
  return `
  <div class="space-y-6">
    <div class="flex items-end justify-between">
      <div>
        <h1 class="text-2xl font-bold">推广位管理</h1>
        <p class="text-sm text-slate-500">首页横幅 / 首页推荐 / 列表置顶，前台会实时读取这里的配置</p>
      </div>
      <button onclick="openPromoForm('')" class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">+ 新增推广位</button>
    </div>
    <div class="rounded-lg border border-slate-200 bg-sky-50 p-4 text-xs text-sky-800 space-y-1">
      <p>· <strong>首页横幅</strong>：每个位置取权重最高的一条，显示在首页顶部。</p>
      <p>· <strong>首页推荐</strong>：按权重排序取前 4 条，显示在首页「推荐赛事」。</p>
      <p>· <strong>列表置顶</strong>：该赛事在赛事库排序中排到最前，并带「★ 推广」标记。</p>
      <p>· 后台「赛事管理」里的「推广」按钮是旧机制，仍然生效，两边会合并去重。</p>
    </div>
    <div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table class="w-full">
        <thead class="bg-slate-50 text-left text-xs font-medium text-slate-500">
          <tr><th class="px-4 py-3">位置</th><th class="px-4 py-3">标题</th><th class="px-4 py-3">关联赛事</th>
          <th class="px-4 py-3">权重</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">操作</th></tr>
        </thead>
        <tbody>
          ${PROMOTIONS.length===0?`<tr><td colspan="6" class="px-4 py-10 text-center text-sm text-slate-500">暂无推广位，点右上角「+ 新增推广位」创建</td></tr>`:""}
          ${PROMOTIONS.map(p=>`
            <tr class="border-t border-slate-100">
              <td class="px-4 py-3 text-sm">${esc(slotLabel(p.slot))}</td>
              <td class="px-4 py-3 text-sm">${esc(p.title||"—")}</td>
              <td class="px-4 py-3 text-sm">${promoEventTitle(p)?`<a href="#/events/${p.eventId}" class="text-blue-600 hover:underline">${esc(promoEventTitle(p))}</a>`:`<span class="text-slate-400">未关联 / 已下架</span>`}</td>
              <td class="px-4 py-3 text-sm">${p.weight}</td>
              <td class="px-4 py-3">${p.active?Badge("生效中","bg-emerald-100 text-emerald-700"):Badge("已停用","bg-slate-200 text-slate-500")}</td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-1">
                  <button onclick="togglePromo('${p.id}')" class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">${p.active?"停用":"启用"}</button>
                  <button onclick="openPromoForm('${p.id}')" class="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100">编辑</button>
                  <button onclick="deletePromo('${p.id}')" class="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-700 hover:bg-rose-100">删除</button>
                </div>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </div>`;
}

function openPromoForm(id){
  const p = id ? PROMOTIONS.find(x => x.id === id) : null;
  const eventOpts = [["", "不关联赛事"], ...EVENTS.filter(e => e.reviewStatus === "APPROVED")
    .sort((a,b) => (a.title||"").localeCompare(b.title||"", "zh")).map(e => [e.id, e.title])];
  openModal({
    title: p ? "编辑推广位" : "新增推广位",
    saveLabel: p ? "保存修改" : "新增",
    body: `
      ${fSelect("slot","位置", p?p.slot:"HOME_RECOMMEND", PROMO_SLOTS)}
      ${fInput("title","标题", p?p.title:"", { placeholder:"首页横幅上显示的文案，可留空" })}
      ${fSelect("event_id","关联赛事", p?p.eventId:"", eventOpts)}
      ${fInput("weight","权重（越大越靠前）", p?p.weight:0, { type:"number" })}
      ${fCheck("active","生效中", p?p.active:true)}`,
    onSave: async () => {
      const v = readModalForm();
      const row = {
        slot: v.slot, title: v.title,
        event_id: isUuid(v.event_id) ? v.event_id : null,
        weight: Number(v.weight) || 0,
        active: !!v.active,
      };
      const r = p
        ? await writeWithFallback(r2 => db.from("promotions").update(r2).eq("id", p.id), row)
        : await writeWithFallback(r2 => db.from("promotions").insert(r2).select("id").single(), row);
      if (r.error) { toast((p?"保存":"新增") + "失败：" + dbErrMsg(r.error)); return; }
      closeModal();
      await loadPromotions();
      toast(p ? "推广位已更新" : "推广位已新增");
      render();
    },
  });
}

async function deletePromo(id){
  const p = PROMOTIONS.find(x => x.id === id);
  if (!p) return;
  if (!confirm(`确定删除这条推广位？`)) return;
  const { error } = await db.from("promotions").delete().eq("id", id);
  if (error) { toast("删除失败：" + dbErrMsg(error)); return; }
  await loadPromotions();
  toast("已删除");
  render();
}

function AdminPageAnalytics(){
  const approved = EVENTS.filter(e=>e.reviewStatus==="APPROVED");

  const countBy = (key)=>{
    const m={}; approved.forEach(e=>{ const v=e[key]||"未分类"; m[v]=(m[v]||0)+1; }); return m;
  };
  const catDist = countBy("category");
  const regionDist = countBy("region");
  const srcDist = countBy("sourceName");

  const barChart = (title,dist,color)=>{
    const entries = Object.entries(dist).sort((a,b)=>b[1]-a[1]).slice(0,6);
    const max = Math.max(...entries.map(e=>e[1]),1);
    return `
    <div class="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
      <p class="text-base font-semibold">${title}</p>
      <div class="space-y-2">
        ${entries.length===0?`<p class="text-xs text-slate-400">暂无数据</p>`:entries.map(([k,v])=>`
          <div class="flex items-center gap-3">
            <span class="w-32 shrink-0 truncate text-xs text-slate-500">${esc(k)}</span>
            <div class="h-5 flex-1 overflow-hidden rounded bg-slate-100">
              <div class="h-full rounded ${color}" style="width:${(v/max*100).toFixed(0)}%"></div>
            </div>
            <span class="w-8 shrink-0 text-right text-xs font-medium">${v}</span>
          </div>`).join("")}
      </div>
    </div>`;
  };

  const closingSoon = [...approved].filter(e=>{const d=daysUntil(e.registrationEnd);return d!==null&&d>=0;})
    .sort((a,b)=>(daysUntil(a.registrationEnd)??0)-(daysUntil(b.registrationEnd)??0)).slice(0,5);

  const hot = [...approved].sort((a,b)=>b.viewCount-a.viewCount).slice(0,5);

  return `
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold">分析看板</h1>
      <p class="text-sm text-slate-500">基于 Supabase 实时数据统计</p>
    </div>
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      ${statCard("已发布赛事",approved.length)}
      ${statCard("原始待处理",RAW_DOCS.filter(r=>r.status==="NEW").length,"来自采集",  "text-sky-600")}
      ${statCard("总浏览量",approved.reduce((s,e)=>s+e.viewCount,0),"",  "text-rose-600")}
      ${statCard("启用来源",SOURCES.filter(s=>s.enabled).length,"",  "text-emerald-600")}
    </div>
    <div class="grid gap-4 lg:grid-cols-3">
      ${barChart("分类分布",catDist,"bg-blue-500")}
      ${barChart("地区分布",regionDist,"bg-emerald-500")}
      ${barChart("来源分布",srcDist,"bg-amber-500")}
    </div>
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="rounded-lg border border-slate-200 bg-white">
        <div class="border-b border-slate-100 px-5 py-3"><p class="text-base font-semibold">⏰ 截止临近赛事</p></div>
        <div class="divide-y divide-slate-100">
          ${closingSoon.length===0?`<p class="px-5 py-6 text-sm text-slate-500">暂无数据</p>`:closingSoon.map(e=>{
            const d = daysUntil(e.registrationEnd);
            return `<div class="flex items-center justify-between px-5 py-3">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">${esc(e.title)}</p>
                <p class="mt-0.5 text-xs text-slate-500">${esc(e.registrationEnd)}</p>
              </div>
              ${Badge(`剩 ${d} 天`, d<=7?"bg-amber-100 text-amber-700":"bg-slate-100 text-slate-600")}
            </div>`;
          }).join("")}
        </div>
      </div>
      <div class="rounded-lg border border-slate-200 bg-white">
        <div class="border-b border-slate-100 px-5 py-3"><p class="text-base font-semibold">🔥 热门赛事（按浏览）</p></div>
        <div class="divide-y divide-slate-100">
          ${hot.length===0?`<p class="px-5 py-6 text-sm text-slate-500">暂无数据</p>`:hot.map(e=>`
            <div class="flex items-center justify-between px-5 py-3">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">${esc(e.title)}</p>
                <p class="mt-0.5 text-xs text-slate-500">${esc(e.category)}</p>
              </div>
              <div class="flex shrink-0 gap-3 text-xs text-slate-500">
                <span>👁 ${e.viewCount}</span><span>♡ ${e.favoriteCount}</span>
              </div>
            </div>`).join("")}
        </div>
      </div>
    </div>
  </div>`;
}

function AdminPageSubmissions(){
  return `
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold">用户投稿审核</h1>
      <p class="text-sm text-slate-500">审核前台提交的赛事线索，采纳后生成赛事</p>
    </div>
    <div class="space-y-3">
      ${SUBMISSIONS.length===0?`<div class="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">暂无投稿</div>`:""}
      ${SUBMISSIONS.map(s=>`
        <div class="rounded-lg border border-slate-200 bg-white p-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm font-medium">${esc(s.title)}</p>
              <p class="mt-0.5 text-xs text-slate-500">${esc(s.createdAt)} · 联系：${esc(s.contact||"—")}</p>
              ${s.description?`<p class="mt-1 text-xs text-slate-500">${esc(s.description)}</p>`:""}
              ${s.url?`<a href="${esc(s.url)}" target="_blank" class="mt-1 inline-block text-xs text-blue-600 hover:underline">${esc(s.url)} ↗</a>`:""}
            </div>
            <div class="flex items-center gap-2">
              ${BadgeReview(s.status)}
              ${s.status==="PENDING"?`
                <button onclick="reviewSubmission('${s.id}','APPROVED')" class="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700">采纳</button>
                <button onclick="reviewSubmission('${s.id}','REJECTED')" class="rounded bg-rose-600 px-3 py-1.5 text-xs text-white hover:bg-rose-700">忽略</button>
              `:""}
            </div>
          </div>
        </div>`).join("")}
    </div>
  </div>`;
}

/* ============ 后台：举报处理 ============ */
function AdminPageReports(){
  const pending = REPORTS.filter(r => r.status === "PENDING");
  const handled = REPORTS.filter(r => r.status !== "PENDING");
  const card = (r, isPending) => {
    const e = EVENTS.find(x => x.id === r.eventId);
    return `
    <div class="rounded-lg border border-slate-200 bg-white p-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-medium">${esc(r.eventTitle || (e ? e.title : "（赛事已删除）"))}</p>
          <p class="mt-0.5 text-xs text-slate-500">${esc(r.createdAt)} · 原因：<span class="text-rose-700">${esc(r.reason)}</span></p>
          ${r.detail?`<p class="mt-1 text-xs text-slate-500">${esc(r.detail)}</p>`:""}
          ${e?`<a href="#/admin/events" class="mt-1 inline-block text-xs text-blue-600 hover:underline">去赛事管理处理这条赛事 →</a>`:""}
        </div>
        <div class="flex shrink-0 items-center gap-2">
          ${r.status==="RESOLVED"?Badge("已处理","bg-emerald-100 text-emerald-700"):r.status==="REJECTED"?Badge("已驳回","bg-slate-200 text-slate-500"):Badge("待处理","bg-amber-100 text-amber-700")}
          ${isPending?`
            <button onclick="handleReport('${r.id}','RESOLVED')" class="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700">已处理</button>
            <button onclick="handleReport('${r.id}','REJECTED')" class="rounded border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50">驳回</button>
          `:""}
        </div>
      </div>
      ${r.handlerNote?`<p class="mt-2 rounded bg-slate-50 px-3 py-2 text-xs text-slate-500">处理备注：${esc(r.handlerNote)}</p>`:""}
    </div>`;
  };
  return `
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold">举报处理</h1>
      <p class="text-sm text-slate-500">共 ${REPORTS.length} 条举报，待处理 ${pending.length} 条</p>
    </div>
    ${REPORTS.length===0?`<div class="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">暂无举报</div>`:""}
    ${pending.length?`<div class="space-y-3">
      <p class="text-sm font-semibold text-amber-700">待处理（${pending.length}）</p>
      ${pending.map(r=>card(r,true)).join("")}
    </div>`:""}
    ${handled.length?`<div class="space-y-3">
      <p class="text-sm font-semibold text-slate-500">已处理（${handled.length}）</p>
      ${handled.map(r=>card(r,false)).join("")}
    </div>`:""}
  </div>`;
}

function handleReport(id, status){
  openModal({
    title: status === "RESOLVED" ? "标记为已处理" : "驳回举报",
    saveLabel: "提交",
    body: `${fArea("note","处理备注（选填）","",3)}
      <p class="text-xs text-slate-400">备注只保存在后台，用于记录处理结论。</p>`,
    onSave: async () => {
      const v = readModalForm();
      const { error } = await db.from("reports").update({
        status, handler_note: v.note || "", handled_at: new Date().toISOString(),
      }).eq("id", id);
      if (error) { toast("操作失败：" + dbErrMsg(error)); return; }
      closeModal();
      await loadReports();
      toast(status === "RESOLVED" ? "已标记为处理完成" : "已驳回");
      render();
    },
  });
}

/* ============ 后台：主办方入驻 / 认领审核 ============ */
function matchingOrgEvents(name){
  const n = (name || "").trim();
  if (!n) return [];
  return EVENTS.filter(e => {
    const o = (e.organizer || "").trim();
    return o && (o === n || o.includes(n) || n.includes(o));
  });
}

function AdminPageOrgs(){
  const pending = ORG_APPLICATIONS.filter(a => a.status === "PENDING");
  const handled = ORG_APPLICATIONS.filter(a => a.status !== "PENDING");
  const card = (a, isPending) => {
    const matched = matchingOrgEvents(a.orgName);
    return `
    <div class="rounded-lg border border-slate-200 bg-white p-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-medium">${esc(a.orgName)}
            <span class="ml-1 rounded px-1.5 py-0.5 text-xs ${a.kind==="CLAIM"?"bg-amber-100 text-amber-700":"bg-sky-100 text-sky-700"}">${a.kind==="CLAIM"?"赛事认领":"机构入驻"}</span>
          </p>
          <p class="mt-0.5 text-xs text-slate-500">${esc(a.createdAt)}${a.contactName?` · 联系人：${esc(a.contactName)}`:""}${a.contact?` · ${esc(a.contact)}`:""}</p>
          ${a.website?`<a href="${esc(a.website)}" target="_blank" rel="noopener" class="text-xs text-blue-600 hover:underline">${esc(a.website)} ↗</a>`:""}
          ${a.kind==="CLAIM"&&a.claimEventTitle?`<p class="mt-1 text-xs text-slate-500">认领赛事：${esc(a.claimEventTitle)}</p>`:""}
          ${a.message?`<p class="mt-1 text-xs text-slate-500">${esc(a.message)}</p>`:""}
          ${isPending?`<p class="mt-2 text-xs text-slate-400">按机构名匹配到 ${matched.length} 条现有赛事，通过后会打上「✓ 认证主办方」</p>`:""}
        </div>
        <div class="flex shrink-0 items-center gap-2">
          ${a.status==="APPROVED"?Badge("已通过","bg-emerald-100 text-emerald-700"):a.status==="REJECTED"?Badge("已驳回","bg-slate-200 text-slate-500"):Badge("待处理","bg-amber-100 text-amber-700")}
          ${isPending?`
            <button onclick="openOrgReview('${a.id}','APPROVED')" class="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700">通过</button>
            <button onclick="openOrgReview('${a.id}','REJECTED')" class="rounded border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50">驳回</button>
          `:""}
        </div>
      </div>
      ${a.handlerNote?`<p class="mt-2 rounded bg-slate-50 px-3 py-2 text-xs text-slate-500">处理备注：${esc(a.handlerNote)}</p>`:""}
    </div>`;
  };
  return `
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold">入驻 / 认领审核</h1>
      <p class="text-sm text-slate-500">共 ${ORG_APPLICATIONS.length} 条申请，待处理 ${pending.length} 条</p>
    </div>
    <div class="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
      通过申请时会按「机构名称」和赛事的主办方字段做匹配打认证标。名称写法不一致会匹配不到，所以下面可以改成赛事里实际使用的写法。
    </div>
    ${ORG_APPLICATIONS.length===0?`<div class="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">暂无申请</div>`:""}
    ${pending.length?`<div class="space-y-3">
      <p class="text-sm font-semibold text-amber-700">待处理（${pending.length}）</p>
      ${pending.map(a=>card(a,true)).join("")}
    </div>`:""}
    ${handled.length?`<div class="space-y-3">
      <p class="text-sm font-semibold text-slate-500">已处理（${handled.length}）</p>
      ${handled.map(a=>card(a,false)).join("")}
    </div>`:""}
  </div>`;
}

function openOrgReview(id, status){
  const a = ORG_APPLICATIONS.find(x => x.id === id);
  if (!a) return;
  const approve = status === "APPROVED";
  openModal({
    title: approve ? `通过申请：${a.orgName}` : `驳回申请：${a.orgName}`,
    saveLabel: approve ? "通过并打认证标" : "确认驳回",
    body: approve
      ? `${fInput("orgName","用于匹配赛事的主办方名称", a.orgName, { placeholder:"须与赛事里的「主办方」写法一致" })}
         ${fTextPreview(a.orgName)}
         ${fArea("note","处理备注（选填）","",2)}`
      : `${fArea("note","驳回原因（选填）","",3)}`,
    onSave: async () => {
      const v = readModalForm();
      if (approve) {
        const name = (v.orgName || "").trim();
        if (!name) { toast("请填写要匹配的主办方名称"); return; }
        const targets = matchingOrgEvents(name);
        for (const e of targets) {
          await writeWithFallback(r => db.from("events")
            .update({ organization_verified: true, organization_owner: name }).eq("id", e.id), {});
        }
        const { error } = await db.from("org_applications").update({
          status, handler_note: v.note || "", handled_at: new Date().toISOString(),
        }).eq("id", id);
        if (error) { toast("赛事已打标，但申请状态更新失败：" + dbErrMsg(error)); return; }
        closeModal();
        await Promise.all([loadOrgApplications(), loadEvents()]);
        toast(`已通过，${targets.length} 条赛事打上认证标识`);
      } else {
        const { error } = await db.from("org_applications").update({
          status, handler_note: v.note || "", handled_at: new Date().toISOString(),
        }).eq("id", id);
        if (error) { toast("操作失败：" + dbErrMsg(error)); return; }
        closeModal();
        await loadOrgApplications();
        toast("已驳回");
      }
      render();
    },
  });
}

function fTextPreview(orgName){
  const targets = matchingOrgEvents(orgName);
  if (!targets.length) return `<p class="text-xs text-amber-700">当前没有匹配到赛事，通过后不会给任何赛事打标。</p>`;
  return `<div class="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
    <p class="mb-1 font-medium">将要打认证标的赛事（${targets.length} 条）：</p>
    ${targets.slice(0,8).map(e=>`<p class="truncate">· ${esc(e.title)}</p>`).join("")}
    ${targets.length>8?`<p>…等 ${targets.length} 条</p>`:""}
  </div>`;
}

/* ============ 后台：数据库体检 ============ */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
let HEALTH_RUNNING = false;
let DB_HEALTH = null;

const MIGRATION_SQL = `-- 青少年赛事信息聚合平台 · 数据库迁移（幂等，可重复执行）
-- 在 Supabase 控制台 SQL Editor 里执行

alter table events      add column if not exists description        text default '';
alter table events      add column if not exists organization_owner text default '';
-- AI 赛事简析报告（详情页「AI 赛事简析」生成后存这里）
alter table events      add column if not exists ai_brief           text default '';
-- 赛事官方网站（后台「AI 查找官网」写入；详情页「前往官网」按钮优先用它）
alter table events      add column if not exists official_url       text default '';
alter table submissions add column if not exists user_id            uuid;
alter table submissions add column if not exists description        text default '';
alter table raw_docs    add column if not exists deadline           date;
alter table raw_docs    add column if not exists reg_status         text;
alter table raw_docs    add column if not exists kind               text;
alter table raw_docs    add column if not exists category           text;
alter table raw_docs    add column if not exists region             text;
alter table raw_docs    add column if not exists grade_scope        text;
alter table raw_docs    add column if not exists format             text;
alter table raw_docs    add column if not exists fee                text;
alter table raw_docs    add column if not exists prize              text;
alter table raw_docs    add column if not exists organizer          text;

create table if not exists app_users (
  id           uuid primary key default gen_random_uuid(),
  username     text unique not null,
  display_name text default '',
  pwd_salt     text not null,
  pwd_hash     text not null,
  created_at   timestamptz default now()
);

create table if not exists app_sessions (
  token      text primary key,
  user_id    uuid not null references app_users(id) on delete cascade,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);
create index if not exists app_sessions_user_idx on app_sessions(user_id);

create table if not exists favorites (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_users(id) on delete cascade,
  event_id   uuid not null references events(id) on delete cascade,
  created_at timestamptz default now(),
  unique (user_id, event_id)
);
create index if not exists favorites_user_idx on favorites(user_id);

create table if not exists subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_users(id) on delete cascade,
  event_id   uuid not null references events(id) on delete cascade,
  created_at timestamptz default now(),
  unique (user_id, event_id)
);
create index if not exists subscriptions_user_idx on subscriptions(user_id);

create table if not exists reports (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid,
  event_title  text default '',
  user_id      uuid,
  reason       text default '',
  detail       text default '',
  status       text default 'PENDING',
  handler_note text default '',
  handled_at   timestamptz,
  created_at   timestamptz default now()
);
create index if not exists reports_status_idx on reports(status);

create table if not exists org_applications (
  id                uuid primary key default gen_random_uuid(),
  kind              text default 'JOIN',
  org_name          text not null,
  website           text default '',
  contact_name      text default '',
  contact           text default '',
  message           text default '',
  claim_event_id    uuid,
  claim_event_title text default '',
  user_id           uuid,
  status            text default 'PENDING',
  handler_note      text default '',
  handled_at        timestamptz,
  created_at        timestamptz default now()
);
create index if not exists org_applications_status_idx on org_applications(status);

create or replace function inc_event_view(eid uuid)
returns void
language sql
as $$
  update events set view_count = coalesce(view_count, 0) + 1 where id = eid;
$$;

create or replace function bump_event_favorite(eid uuid, delta integer)
returns void
language sql
as $$
  update events
     set favorite_count = greatest(coalesce(favorite_count, 0) + delta, 0)
   where id = eid;
$$;`;

const HEALTH_CHECKS = [
  ["app_users", "用户表", "注册 / 登录 / 头像昵称", () => db.from("app_users").select("id").limit(1)],
  ["app_sessions", "会话表", "登录状态保持 30 天", () => db.from("app_sessions").select("token").limit(1)],
  ["favorites", "收藏表", "详情页收藏 + 个人中心「我的收藏」", () => db.from("favorites").select("id").limit(1)],
  ["subscriptions", "订阅表", "订阅提醒 + 个人中心「通知」", () => db.from("subscriptions").select("id").limit(1)],
  ["reports", "举报表", "详情页举报 + 后台「举报处理」", () => db.from("reports").select("id").limit(1)],
  ["org_applications", "入驻申请表", "主办方入驻 / 认领 + 后台「入驻审核」", () => db.from("org_applications").select("id").limit(1)],
  ["events.description", "events.description", "赛事详情长描述", () => db.from("events").select("id,description").limit(1)],
  ["events.organization_owner", "events.organization_owner", "赛事认领后的归属机构", () => db.from("events").select("id,organization_owner").limit(1)],
  ["events.ai_brief", "events.ai_brief", "详情页「AI 赛事简析」的持久化存储（缺列时简析仅当次展示）", () => db.from("events").select("id,ai_brief").limit(1)],
  ["events.official_url", "events.official_url", "赛事官方网站（后台「AI 查找官网」写入，详情页「前往官网」按钮）", () => db.from("events").select("id,official_url").limit(1)],
  ["submissions.user_id", "submissions.user_id", "「我的投稿」按账号关联", () => db.from("submissions").select("id,user_id").limit(1)],
  ["submissions.description", "submissions.description", "投稿补充说明落库", () => db.from("submissions").select("id,description").limit(1)],
  ["raw_docs.deadline/reg_status/kind", "报名截止 / 报名状态 / 启事-资讯分类", "原始数据页筛选 + 转赛事时带状态", () => db.from("raw_docs").select("id,deadline,reg_status,kind").limit(1)],
  ["raw_docs AI 属性列", "category / region / grade_scope / format / fee / prize / organizer", "采集转赛事时带出分类、地区、学段、费用、奖项、主办方（缺了这些，赛事库筛选和分析看板会空）", () => db.from("raw_docs").select("id,category,region,grade_scope,format,fee,prize,organizer").limit(1)],
];
const HEALTH_RPCS = [
  ["inc_event_view", "浏览量原子自增函数", "数据报告与详情页浏览量真实累加"],
  ["bump_event_favorite", "收藏量原子自增函数", "收藏数同步（缺失时退回读改写）"],
];

async function runHealthCheck(){
  HEALTH_RUNNING = true; render();
  const rows = [];
  for (const [key, label, feature, probe] of HEALTH_CHECKS) {
    let ok = false, err = "";
    try { const r = await probe(); ok = !r.error; if (r.error) err = r.error.message; }
    catch (e) { err = e.message; }
    rows.push({ key, label, feature, ok, err });
  }
  for (const [fn, label, feature] of HEALTH_RPCS) {
    const ok = await rpcSafe(fn, fn === "inc_event_view" ? { eid: ZERO_UUID } : { eid: ZERO_UUID, delta: 0 });
    rows.push({ key: fn + "()", label, feature, ok, err: ok ? "" : "函数不存在，请执行迁移 SQL" });
  }
  DB_HEALTH = { rows, checkedAt: now() };
  HEALTH_RUNNING = false;
  render();
}

function copyMigrationSql(){
  const fallback = () => {
    const ta = document.getElementById("migration-sql");
    if (ta) { ta.focus(); ta.select(); try { document.execCommand("copy"); toast("迁移 SQL 已复制"); } catch (e) { toast("复制失败，请手动全选复制"); } }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(MIGRATION_SQL).then(() => toast("迁移 SQL 已复制到剪贴板"), fallback);
  } else fallback();
}

function AdminPageHealth(){
  const h = DB_HEALTH;
  const missing = h ? h.rows.filter(r => !r.ok) : [];
  return `
  <div class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">数据库体检</h1>
        <p class="text-sm text-slate-500">${h ? `上次检测：${esc(h.checkedAt)}` : "检查新功能需要的表与列是否已经建好"}</p>
      </div>
      <div class="flex gap-2">
        <button onclick="copyMigrationSql()" class="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50">📋 复制迁移 SQL</button>
        <button onclick="runHealthCheck()" ${HEALTH_RUNNING?"disabled":""} class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">${HEALTH_RUNNING?"检测中…":"重新检测"}</button>
      </div>
    </div>

    ${!h?`<div class="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
      点「重新检测」开始。<br>第一次部署新功能时，多半会有几项是 ✗，按下面的 SQL 建好表再测一次即可。
    </div>`:`
    ${missing.length===0
      ? `<div class="rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800"><p class="font-semibold">✔ 全部就绪</p><p class="mt-1">收藏、订阅、举报、入驻、站内通知、浏览计数等功能都已可用。</p></div>`
      : `<div class="rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
          <p class="font-semibold">还有 ${missing.length} 项没建好，以下功能会不可用或降级：</p>
          <ul class="mt-2 list-disc space-y-1 pl-5 text-xs">
            ${missing.map(r=>`<li><code class="rounded bg-white px-1">${esc(r.key)}</code> — ${esc(r.feature)}</li>`).join("")}
          </ul>
          <p class="mt-2 text-xs">复制下面的 SQL 到 Supabase SQL Editor 执行，然后点「重新检测」。</p>
        </div>`}
    <div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table class="w-full">
        <thead class="bg-slate-50 text-left text-xs font-medium text-slate-500">
          <tr><th class="px-4 py-3">检查项</th><th class="px-4 py-3">说明</th><th class="px-4 py-3">受影响的功能</th><th class="px-4 py-3">状态</th></tr>
        </thead>
        <tbody>
          ${h.rows.map(r=>`
            <tr class="border-t border-slate-100">
              <td class="px-4 py-3"><code class="rounded bg-slate-100 px-1 text-xs">${esc(r.key)}</code></td>
              <td class="px-4 py-3 text-sm">${esc(r.label)}</td>
              <td class="px-4 py-3 text-xs text-slate-500">${esc(r.feature)}</td>
              <td class="px-4 py-3">${r.ok?Badge("✓ 就绪","bg-emerald-100 text-emerald-700"):Badge("✗ 缺失","bg-rose-100 text-rose-700")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`}

    <div class="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
      <p class="text-base font-semibold">🤖 AI 补全存量赛事属性</p>
      <p class="text-sm text-slate-500">对「分类 / 地区 / 主办方」任一为空的赛事，用大模型按标题与简介回填 分类、地区、学段、形式、费用、奖项、主办方。赛事库的筛选、首页热门分类、分析看板都依赖这些字段——它们空着，界面就会「看起来在转但筛不出东西」。</p>
      <button onclick="runFieldBackfill()" ${CRAWL_RUNNING?"disabled":""} class="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">${CRAWL_RUNNING?"执行中…":"开始补全"}</button>
    </div>

    <div class="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
      <div class="flex items-center justify-between">
        <p class="text-base font-semibold">迁移 SQL</p>
        <span class="text-xs text-slate-400">与仓库里的 schema.sql 内容一致，可重复执行</span>
      </div>
      <textarea id="migration-sql" readonly rows="14" class="w-full rounded-md border border-slate-300 bg-slate-50 p-3 font-mono text-xs">${esc(MIGRATION_SQL)}</textarea>
      <p class="text-xs text-slate-500">用法：Supabase 控制台 → SQL Editor → 新建查询 → 粘贴 → Run。</p>
    </div>
  </div>`;
}

function AdminLoginPage(){
  return `
  <div class="flex min-h-screen items-center justify-center bg-slate-100 p-4">
    <div class="w-full max-w-sm rounded-lg border border-slate-200 bg-white shadow-sm">
      <div class="space-y-2 p-6 pb-4 text-center">
        <img src="logo.svg" alt="" class="mx-auto h-11 w-11">
        <p class="text-lg font-semibold">后台登录</p>
        <p class="text-sm text-slate-500">青少年赛事信息聚合平台 · 运营后台</p>
      </div>
      <div class="p-6 pt-0 space-y-4">
        <div class="space-y-2">
          <label class="text-sm font-medium">用户名</label>
          <input id="username" value="admin" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
        </div>
        <div class="space-y-2">
          <label class="text-sm font-medium">密码</label>
          <input id="password" type="password" value="admin123" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
            onkeydown="if(event.key==='Enter')doLogin()">
        </div>
        ${LOGIN_ERROR?`<p class="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">${esc(LOGIN_ERROR)}</p>`:""}
        <button onclick="doLogin()" class="w-full rounded-md bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700">登录</button>
        <p class="text-center text-xs text-slate-400">演示账号：admin / admin123</p>
        <p class="text-center text-xs"><a href="#/" class="text-blue-600 hover:underline">← 返回前台</a></p>
      </div>
    </div>
  </div>`;
}

function AdminContent(hash){
  if (hash === "/admin/events") return AdminPageEvents();
  if (hash === "/admin/sources") return AdminPageSources();
  if (hash === "/admin/crawl") return AdminPageCrawl();
  if (hash === "/admin/raw") return AdminPageRaw();
  if (hash === "/admin/promotions") return AdminPagePromotions();
  if (hash === "/admin/analytics") return AdminPageAnalytics();
  if (hash === "/admin/submissions") return AdminPageSubmissions();
  if (hash === "/admin/reports") return AdminPageReports();
  if (hash === "/admin/orgs") return AdminPageOrgs();
  if (hash === "/admin/health") return AdminPageHealth();
  return AdminPageDashboard();
}

/* ============ 交互行为（写数据库） ============ */
/* 表还没补齐列时逐级降级。PostgREST 报错有三种写法，都要能认出列名：
     column events.organization_owner does not exist
     column "organization_owner" of relation "events" does not exist
     Could not find the 'organization_owner' column of 'events' in the schema cache
   认不出列名就不会降级，一次写入会因为缺一列整个失败。 */
function missingColumn(err){
  const m = (err && err.message) || "";
  let r = /column\s+"?([A-Za-z_0-9.]+)"?\s+does not exist/i.exec(m);
  if (r) return String(r[1]).split(".").pop();
  r = /column\s+"([^"]+)"/i.exec(m);
  if (r) return r[1];
  r = /Could not find the '([^']+)' column/i.exec(m);
  if (r) return r[1];
  return "";
}
async function writeWithFallback(run, row){
  let r = await run(row);
  for (let i = 0; i < 8 && r.error; i++) {
    const col = missingColumn(r.error);
    if (!col || !(col in row)) break;
    delete row[col];
    r = await run(row);
  }
  return r;
}

/* 把 PostgREST 的英文报错翻译成"下一步该做什么"。
   「Could not find the table 'public.app_users' in the schema cache」这种原始信息
   对使用者毫无意义，看到它的人只会一头雾水。 */
function dbErrMsg(err){
  const m = (err && err.message) || String(err || "");
  const t = /Could not find the table 'public\.([a-z_0-9]+)'/i.exec(m);
  if (t) return `数据库还没建好：缺表 ${t[1]}。请到后台「数据库体检」页复制迁移 SQL，在 Supabase SQL Editor 执行一次`;
  const f = /Could not find the function public\.([a-z_0-9]+)/i.exec(m);
  if (f) return `数据库还缺函数 ${f[1]}()。到后台「数据库体检」页复制迁移 SQL 执行一次即可`;
  if (/does not exist/i.test(m)) {
    const c = missingColumn(err);
    if (c) return `数据库还缺列 ${c}。到后台「数据库体检」页复制迁移 SQL 执行一次即可`;
  }
  return m;
}

function toast(msg, ms){
  const el = document.createElement("div");
  el.className = "fixed left-1/2 top-6 z-50 -translate-x-1/2 rounded-md bg-slate-900 px-4 py-2 text-sm text-white shadow-lg transition max-w-md";
  el.textContent = msg;
  document.body.appendChild(el);
  // 结果类提示请传更长的展示时长（毫秒），默认 2.2 秒容易被当成"点了没反应"
  setTimeout(()=>el.remove(), ms || 2200);
}

async function reviewEvent(id, status){
  const { error } = await db.from("events").update({ review_status: status }).eq("id", id);
  if (error) { toast("操作失败：" + dbErrMsg(error)); return; }
  await loadEvents();
  toast(status === "APPROVED" ? "已通过审核" : "已拒绝");
  render();
}
async function togglePin(id){
  const e = EVENTS.find(x => x.id === id);
  if (!e) return;
  const { error } = await db.from("events").update({ is_pinned: !e.isPinned }).eq("id", id);
  if (error) { toast("操作失败：" + dbErrMsg(error)); return; }
  await loadEvents();
  toast(!e.isPinned ? "已置顶" : "已取消置顶");
  render();
}
async function togglePromote(id){
  const e = EVENTS.find(x => x.id === id);
  if (!e) return;
  const { error } = await db.from("events").update({ is_promoted: !e.isPromoted }).eq("id", id);
  if (error) { toast("操作失败：" + dbErrMsg(error)); return; }
  await loadEvents();
  toast(!e.isPromoted ? "已设为推广" : "已取消推广");
  render();
}
async function toggleSource(id){
  const s = SOURCES.find(x => x.id === id);
  if (!s) return;
  const { error } = await db.from("sources").update({ enabled: !s.enabled }).eq("id", id);
  if (error) { toast("操作失败：" + dbErrMsg(error)); return; }
  await loadSources();
  toast(!s.enabled ? "来源已启用" : "来源已禁用");
  render();
}
async function togglePromo(id){
  const p = PROMOTIONS.find(x => x.id === id);
  if (!p) return;
  const { error } = await db.from("promotions").update({ active: !p.active }).eq("id", id);
  if (error) { toast("操作失败：" + dbErrMsg(error)); return; }
  await loadPromotions();
  toast(!p.active ? "推广位已启用" : "推广位已停用");
  render();
}
async function convertRaw(id){
  const r = RAW_DOCS.find(x => x.id === id);
  if (!r) return;
  if (!r.rawTitle) { toast("标题为空，无法转换"); return; }
  if (r.kind === "NEWS" && !confirm("AI 判定这条是「资讯」（新闻/名单/回顾，通常不可直接报名），仍要转为赛事吗？\n确定＝转为赛事（待审核），取消＝不转换。")) { return; }
  const row = {
    title: r.rawTitle,
    summary: r.summary || "",
    source_name: r.sourceName,
    source_url: r.sourceUrl,
    status: r.regStatus || "OPEN",   // AI 清洗时判定的报名状态，缺省按报名中
    review_status: "PENDING",
    credibility_score: 60,
  };
  if (r.deadline) row.registration_end = r.deadline;
  // 把 AI 清洗出来的赛事属性一起带过去，否则赛事库的分类/地区/学段筛选筛不到这条
  if (r.category) row.category = r.category;
  if (r.region) row.region = r.region;
  if (r.gradeScope) row.grade_scope = r.gradeScope;
  if (r.format) row.format = r.format;
  if (r.fee) row.fee = r.fee;
  if (r.prize) row.prize = r.prize;
  if (r.organizer) row.organizer = r.organizer;
  const { error } = await writeWithFallback(r2 => db.from("events").insert(r2), row);
  if (error) { toast("转换失败：" + dbErrMsg(error)); return; }
  await db.from("raw_docs").update({ status: "CONVERTED" }).eq("id", id);
  await Promise.all([loadEvents(), loadRawDocs()]);
  const filled = AI_EXTRA_COLS.filter(c => row[c]).length;
  toast(filled ? `已转为赛事（待审核，带 ${filled} 项 AI 补全属性）` : "已转为赛事（待审核）");
  render();
}
async function discardRaw(id){
  const { error } = await db.from("raw_docs").update({ status: "DISCARDED" }).eq("id", id);
  if (error) { toast("操作失败：" + dbErrMsg(error)); return; }
  await loadRawDocs();
  toast("已丢弃");
  render();
}

/* ============ 🏆 白名单赛事导入 ============
   数据源：baimingdan.123code.me（教育部及各省教育厅中小学生竞赛白名单汇总）。
   该站没有 API，全部数据内嵌在 app.js 的 original/hebei/jiangsu 三个数组里。
   用正则解析文本提取（不 eval 第三方代码），字段映射到本站赛事结构后批量入库；
   重复导入按「标题+地区」去重，可反复点。 */
let WMD_RUNNING = false;
const WMD_REGION = { national: "全国", hebei: "河北", jiangsu: "江苏", guangdong: "广东", henan: "河南", hunan: "湖南", shandong: "山东", zhejiang: "浙江" };

function parseBaimingdanJs(text){
  const out = [];
  const item = /\{\s*id:\s*(\d+)\s*,\s*name:\s*"((?:[^"\\]|\\.)*)"\s*,\s*region:\s*"((?:[^"\\]|\\.)*)"\s*,\s*category:\s*"((?:[^"\\]|\\.)*)"\s*,\s*grades:\s*\[([^\]]*)\]\s*,\s*organizer:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  const gradeStr = /"((?:[^"\\]|\\.)*)"/g;
  const unesc = s => s.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  let m;
  while ((m = item.exec(text))) {
    gradeStr.lastIndex = 0;
    const grades = [];
    let g;
    while ((g = gradeStr.exec(m[5]))) grades.push(unesc(g[1]));
    out.push({ name: unesc(m[2]), region: unesc(m[3]), category: unesc(m[4]), grades, organizer: unesc(m[6]) });
  }
  return out;
}

/* 按名称关键词细化到本站分类枚举（白名单源只有 natural/humanities/arts 三个粗类） */
function wmdCategory(name, cat){
  if (/数学/.test(name)) return "数学";
  if (/物理/.test(name)) return "物理";
  if (/化学/.test(name)) return "化学";
  if (/生物|植物|动物/.test(name)) return "生物";
  if (/机器人|无人机|人工智能|信息素养|智能设计/.test(name)) return "机器人与人工智能";
  if (/信息学|编程|计算机|科技模型|信息/.test(name)) return "编程与信息学";
  if (cat === "arts") return "艺术与设计";
  if (cat === "humanities") return /外语|英语/.test(name) ? "英语与人文" : "综合素养";
  return "科创与发明";
}

function wmdGrade(gs){
  const s = new Set((gs || []).map(g => g === "普通高中" ? "高中" : g));
  const has = x => s.has(x);
  if (has("小学") && has("初中") && has("高中")) return "全学段";
  if (has("小学") && has("初中")) return "小学-初中";
  if (has("初中") && has("高中")) return "初中-高中";
  if (s.size === 1) return [...s][0];
  return [...s].join("/");
}

/* 标题归一化：去括号内容、去省名与「赛区/省赛/选拔赛」等字样后比较，
   用于识别「同一赛事同时出现在全国名单和省名单」的重复条目 */
function wmdNorm(t){
  return String(t || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[\s·•\-—_、,，。:+]/g, "")
    .replace(/(湖南|河北|河南|广东|浙江|山东|江苏)/g, "")
    .replace(/(综合赛区|华中赛区|华北赛区|省赛区|省赛|赛区|选拔赛|初赛|预赛|复赛|决赛|省级|活动)/g, "");
}

function wmdToEvent(w){
  const gradesText = (w.grades || []).join("、");
  return {
    title: w.name,
    summary: `教育部及各省教育厅公布的中小学生竞赛白名单赛事。主办单位：${w.organizer || "详见官方通知"}；面向学段：${gradesText || "见官方通知"}。`,
    description: "白名单赛事经教育行政部门审核备案，是面向中小学生的正规竞赛活动，常作为综合素质评价与特长发展的参考。具体报名时间、方式与赛程以主办单位官方通知为准。",
    category: wmdCategory(w.name, w.category),
    region: WMD_REGION[w.region] || "全国",
    grade_scope: wmdGrade(w.grades),
    organizer: w.organizer || "",
    format: "", fee: "", prize: "",
    source_name: "白名单赛事库",
    source_url: "https://baimingdan.123code.me/",
    credibility_score: 90,
    status: "UPCOMING",
    review_status: "APPROVED",
    is_sample: false,
  };
}

async function importBaimingdan(){
  if (WMD_RUNNING) return;
  WMD_RUNNING = true;
  render();
  try {
    toast("正在拉取白名单数据（baimingdan.123code.me）…", 5000);
    let text;
    try {
      text = await fetchViaProxy("https://baimingdan.123code.me/app.js");
    } catch (e) {
      const r = await fetchWithTimeout("https://baimingdan.123code.me/app.js", 12000);
      text = await r.text();
    }
    const items = parseBaimingdanJs(text);
    if (!items.length) { toast("没有解析到赛事数据，源站结构可能已变化", 8000); return; }
    // 省级条目里凡是与全国名单同一赛事（去地区/赛区词后同名）的，视为重复不再导入
    const natNorms = new Set(items.filter(w => w.region === "national").map(w => wmdNorm(w.name)));
    const mergedDups = [];
    const deduped = items.filter(w => {
      if (w.region === "national") return true;
      if (natNorms.has(wmdNorm(w.name))) { mergedDups.push(w); return false; }
      return true;
    });
    const have = new Set(EVENTS.map(e => `${e.title}|${e.region}`));
    const fresh = deduped.filter(w => !have.has(`${w.name}|${WMD_REGION[w.region] || "全国"}`));
    if (!fresh.length) { toast(`解析到 ${items.length} 项（其中 ${mergedDups.length} 项为省级重复已跳过），无需导入`, 6000); return; }
    toast(`解析到 ${items.length} 项，新增 ${fresh.length} 项（跳过省级重复 ${mergedDups.length} 项），写入中…`, 5000);
    // 同一赛事同时出现在两个省名单时（源数据不带赛区后缀），给省级条目补「（省名）」避免同名卡片
    const titleCount = {};
    deduped.forEach(w => { titleCount[w.name] = (titleCount[w.name] || 0) + 1; });
    const rows = fresh.map(w => {
      const row = wmdToEvent(w);
      if (titleCount[w.name] > 1 && w.region !== "national") row.title = `${w.name}（${row.region}）`;
      return row;
    });
    let ok = 0, firstErr = "";
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      const { error } = await writeWithFallback(r => db.from("events").insert(r), chunk);
      if (error) { if (!firstErr) firstErr = error.message; }
      else ok += chunk.length;
      await sleep(300);
    }
    await loadEvents();
    toast(firstErr
      ? `导入完成：成功 ${ok} 条（出错：${firstErr}）`
      : `导入完成：新增 ${ok} 条白名单赛事，已直接出现在前台赛事库`, 8000);
    render();
  } catch (e) {
    toast("导入失败：" + dbErrMsg(e), 8000);
  } finally {
    WMD_RUNNING = false;
    render();
  }
}

/* ============ 🔗 AI 查找赛事官网 ============
   大模型本身不能上网，所以是「模型给候选 + 程序实测校验」两步：
   1) 模型基于赛事名/主办方给出 1-2 个候选官网（提示词明确禁止编造报名页、百科页）；
   2) 每条候选走代理链真实抓取：能打开、内容与赛事或主办方相关才算通过；
   3) 通过后写入 events.official_url，详情页「前往官网」按钮即指向真实官网。
   只处理还没有官网的赛事，可反复点击续跑（已找到的会跳过）。 */
function extractSiteNeedles(e){
  const needles = [];
  const org = (e.organizer || "").split(/[、,，;；]/)[0].replace(/[（(][^）)]*[）)]/g, "").trim();
  if (org.length >= 3) needles.push(org);
  const base = e.title.replace(/[（(][^）)]*[）)]/g, "");
  const KW = ["数学","物理","化学","生物","信息学","编程","机器人","无人机","人工智能","天文","地理","地球科学","水科技","发明","航天","航海","航空","模型","作文","文学","诗词","阅读","书法","美育","语言","心理","安全","应急","国防","劳动","智能设计","科学","艺术","书画","模拟飞行","版图","禁毒","珠心算"];
  KW.forEach(k => { if (base.includes(k)) needles.push(k); });
  const stripped = base.replace(/(全国|中国|青少年|中小学生|中学生|小学|初中|高中|中职|大赛|竞赛|比赛|活动|挑战赛|展示|系列)/g, "");
  if (stripped.length >= 3) needles.push(stripped);
  return [...new Set(needles)].slice(0, 8);
}
function siteRelevant(html, e){
  const needles = extractSiteNeedles(e);
  if (!needles.length) return true;   // 提不出关键词时只凭可访问性
  return needles.some(n => html.includes(n));
}
async function verifyOfficialSite(url, e){
  if (!/^https:\/\//i.test(url)) return false;
  // 中转站、搜索引擎、百科不算「官网」
  if (/123code\.me|bing\.com|baidu\.com|sogou\.com|so\.com|google\.|wikipedia|baike\./i.test(url)) return false;
  try {
    const html = await fetchViaProxy(url);
    return html.length > 300 && siteRelevant(html, e);
  } catch (err) { return false; }
}
async function findOfficialSites(){
  const cfg = loadLLMCfg();
  if (!cfg.base || !cfg.key || !cfg.model) { toast("内置大模型配置缺失，请检查代码中的 LLM_DEFAULT_CFG", 6000); return; }
  if (CRAWL_RUNNING) return;
  // 先探测 official_url 列是否存在，缺列时不必白跑一轮
  const probe = await db.from("events").update({ official_url: "" }).eq("id", ZERO_UUID);
  if (probe.error && missingColumn(probe.error) === "official_url") {
    toast("events 表缺 official_url 列：去后台「数据库体检」复制迁移 SQL 并在 Supabase 执行后再试", 9000);
    return;
  }
  const targets = EVENTS.filter(e => e.reviewStatus === "APPROVED" && !e.officialUrl);
  if (!targets.length) { toast("所有已通过赛事的官网都已查过（没找到的会保持空白）", 6000); return; }
  CRAWL_RUNNING = true;
  toast(`AI 查找官网：${targets.length} 条待查。每条都要真实访问候选链接校验，预计需要几分钟，期间页面不能关；可随时再次点击续跑`, 9000);
  render();
  const system = "你是赛事信息核对助手。只输出 JSON 数组，不要 markdown 代码块标记，不要解释。";
  let found = 0, tried = 0, firstErr = "";
  const BATCH = 10;
  try {
    for (let i = 0; i < targets.length; i += BATCH) {
      AI_PROGRESS = `${Math.floor(i/BATCH)+1}/${Math.ceil(targets.length/BATCH)}`;
      render();
      const batch = targets.slice(i, i + BATCH);
      const input = batch.map((e, j) => ({ id: j, title: e.title, organizer: e.organizer || null, region: e.region || null }));
      const user = `下面是青少年赛事，请给出每项赛事的官方网站候选（按可信度排序，最多 2 个）：
- 只给主办单位官网或赛事官网（学会/协会/高校/官方组委会站点）；
- 禁止编造报名页、新闻页、百科页；不确定的项给空数组，宁可留空；
- 必须是 https:// 开头的完整 URL。
输入：${JSON.stringify(input)}
只输出数组，元素格式 {"id":0,"urls":["https://..."]}，不确定时 {"id":0,"urls":[]}，id 与输入对应：`;
      let arr = [];
      try {
        const text = await llmChat(cfg, system, user);
        const m = text.match(/\[[\s\S]*\]/);
        arr = JSON.parse(m ? m[0] : text);
      } catch (e) { if (!firstErr) firstErr = e.message; }
      for (const hit of (Array.isArray(arr) ? arr : [])) {
        const real = batch[Number(hit && hit.id)];
        if (!real) continue;
        const urls = (Array.isArray(hit.urls) ? hit.urls : (typeof hit.url === "string" ? [hit.url] : [])).slice(0, 2);
        for (const u of urls) {
          const clean = String(u || "").trim().replace(/[，。；)）]+$/, "");
          if (!clean) continue;
          tried++;
          const ok = await verifyOfficialSite(clean, real);
          if (!ok) continue;
          const { error } = await db.from("events").update({ official_url: clean }).eq("id", real.id);
          if (error) { if (!firstErr) firstErr = error.message; break; }
          real.officialUrl = clean;
          found++;
          break;   // 第一条通过校验的即采用，不再试后面的候选
        }
        await sleep(200);
      }
      if (i + BATCH < targets.length) await sleep(400);
    }
    await loadEvents();
    const rest = EVENTS.filter(e => e.reviewStatus === "APPROVED" && !e.officialUrl).length;
    toast(firstErr
      ? `官网查找结束：新增 ${found} 条（出错：${firstErr}）`
      : `官网查找结束：${targets.length} 条中新增 ${found} 条，${rest} 条暂无可靠官网（校验不通过宁可不填）`, 8000);
  } finally {
    CRAWL_RUNNING = false;
    AI_PROGRESS = "";
    render();
  }
}

async function reviewSubmission(id, status){
  const s = SUBMISSIONS.find(x => x.id === id);
  if (!s) return;
  if (status === "APPROVED") {
    // 采纳即生成赛事（review_status 直接 APPROVED，立即出现在前台赛事库）
    const { error } = await db.from("events").insert({
      title: s.title,
      summary: s.description || "",
      source_name: "用户投稿",
      source_url: s.url || "",
      status: "OPEN",
      review_status: "APPROVED",
      credibility_score: 70,
    });
    if (error) { toast("生成赛事失败：" + dbErrMsg(error)); return; }
    const { error: upErr } = await db.from("submissions").update({ status }).eq("id", id);
    if (upErr) { toast("赛事已生成，但投稿状态更新失败：" + dbErrMsg(upErr)); return; }
    await Promise.all([loadSubmissions(), loadEvents()]);
    toast("已采纳并生成赛事（前台赛事库可见）");
    render();
    return;
  }
  const { error } = await db.from("submissions").update({ status }).eq("id", id);
  if (error) { toast("操作失败：" + dbErrMsg(error)); return; }
  await loadSubmissions();
  toast("已忽略");
  render();
}
function doLogin(){
  const u = document.getElementById("username").value.trim();
  const p = document.getElementById("password").value;
  if (u === "admin" && p === "admin123") {
    ADMIN_LOGGED = true; ADMIN_USER = u; LOGIN_ERROR = "";
    try { sessionStorage.setItem(ADMIN_SESSION_KEY, "1"); } catch (e) {}
    toast("已登录后台");
    nav("/admin");
    loadAll().then(render).catch(() => {});
  } else {
    LOGIN_ERROR = "用户名或密码错误";
    render();
  }
}
function adminLogout(){
  ADMIN_LOGGED = false; ADMIN_USER = "";
  try { sessionStorage.removeItem(ADMIN_SESSION_KEY); } catch (e) {}
  toast("已退出登录");
  nav("/admin/login");
}
/* 后台登录态放 sessionStorage：刷新不再掉登录，关掉标签页才失效 */
function restoreAdminSession(){
  try {
    if (sessionStorage.getItem(ADMIN_SESSION_KEY) === "1") { ADMIN_LOGGED = true; ADMIN_USER = "admin"; }
  } catch (e) {}
}

/* ============ 真实采集（写 Supabase） ============ */
const CRAWL_KEYWORDS = [
  "2026 青少年赛事 报名",
  "白名单赛事 通知",
  "全国青少年 竞赛 报名",
  "中学生 竞赛 2026",
  "青少年 编程 比赛 报名",
  "信息学 奥赛 报名 2026",
  "青少年 科技创新 大赛 报名",
  "中小学 素质测评 报名 2026",
];

/* 可抓取的官网/频道列表页（SSR 直出 HTML），由 crawlOfficialSite 通用解析 */
const OFFICIAL_SITES = [
  { url: "https://www.noi.cn/xw/", name: "NOI 官网" },
  { url: "https://www.aoshu.com/", name: "奥数网" },
  { url: "https://edu.163.com/", name: "网易教育" },
];

/* 一键清库重采：清空 raw_docs / events / crawl_jobs 三张表后立即跑一轮全新采集。
   收藏、订阅表对 events 建有 on delete cascade，会随赛事自动级联删除；
   用户账号、投稿、举报与来源配置保留不动。高危操作，双重确认。 */
async function wipeAndRecrawl(){
  if (CRAWL_RUNNING) return;
  if (!confirm("⚠ 将清空全部已采集数据：\n· 原始数据 raw_docs\n· 赛事库 events（收藏 / 订阅随之级联删除）\n· 采集日志 crawl_jobs\n用户账号、投稿、来源配置不受影响。确定继续？")) return;
  if (!confirm("最后确认：删除不可恢复，且清空后会立刻重新采集（约 2—3 分钟）。继续吗？")) return;
  CRAWL_RUNNING = true;
  render();
  const steps = [
    ["raw_docs", () => db.from("raw_docs").delete().not("id", "is", null)],
    ["events", () => db.from("events").delete().not("id", "is", null)],
    ["crawl_jobs", () => db.from("crawl_jobs").delete().not("source_name", "is", null)],
  ];
  const results = [];
  try {
    for (const [tbl, q] of steps) {
      const { error } = await q();
      results.push(`${tbl}${error ? " 失败：" + error.message : " 已清空"}`);
    }
    RAW_DOCS = []; EVENTS = []; CRAWL_JOBS = [];
    render();
    toast(`清库完成（${results.join("，")}），开始全新采集…`);
  } catch (e) {
    toast("清库异常：" + e.message);
  } finally {
    CRAWL_RUNNING = false;
  }
  await runRealCrawl("all");
}

async function runRealCrawl(sourceId){
  const t = now();
  CRAWL_RUNNING = true;
  PROXY_DOWN.clear();   // 每轮重新探测各代理可用性
  PROXY_FAILS.clear();
  LAST_PROXY = "";
  LAST_CHANNEL = "";
  const label = { "all":"全部来源", "sogou-web":"搜狗网页", "bing-search":"必应", "sogou-wechat":"搜狗微信", "baidu-search":"百度", "360-search":"360搜索", "official-noi":"官网频道", "crawl-rss":"RSS 订阅" }[sourceId] || sourceId;
  toast(`采集中（${label}），请稍候…`);
  render();

  const logs = [];
  if (location.protocol === "file:") {
    logs.push("提示：当前以本地文件方式打开，同源代理 /proxy 不可用，只能走公共代理——建议启动本地服务或部署后再采集");
    toast("以 file:// 本地文件打开：同源代理不可用，公共代理大多限流，采集多数会失败。请运行 python _local_server.py 后访问 http://localhost:8901，或直接使用线上站点", 10000);
  }
  let allItems = [];
  let blockedCount = 0;   // 被大陆不可达黑名单拦下的结果数
  let junkCount = 0;      // 被标题预过滤拦截的非赛事条目数
  const succeededSources = new Set();   // 本次成功抓到数据的来源名，用于回写 last_crawled_at

  const collect = (items) => {
    items.forEach(it => {
      if (!it.sourceUrl) return;
      if (!isMainlandReachable(it.sourceUrl)) { blockedCount++; return; }
      if (isJunkEventTitle(it)) { junkCount++; return; }   // 高考/查分/广告类噪音，入口直接拦
      if (allItems.some(x => x.sourceUrl === it.sourceUrl)) return;
      allItems.push(it);
    });
  };

  try {
    // 搜狗网页：国内站点、链接站内跳转，放最前
    if (sourceId === "sogou-web" || sourceId === "all") {
      for (const kw of CRAWL_KEYWORDS) {
        try {
          const items = await crawlSogouWebSearch(kw);
          collect(items);
          logs.push(`搜狗网页 / ${kw}：${items.length} 条（代理：${LAST_PROXY}）`);
        } catch (e) {
          logs.push(`搜狗网页 / ${kw}：失败（${e.message}）`);
          if (/验证码/.test(e.message)) await sleep(4000);
        }
        await sleep(3000);
      }
    }
    if (sourceId === "bing-search" || sourceId === "all") {
      for (const kw of CRAWL_KEYWORDS) {
        try {
          const items = await crawlBingSearch(kw);
          collect(items);
          logs.push(`必应 / ${kw}：${items.length} 条（代理：${LAST_PROXY}）`);
        } catch (e) {
          logs.push(`必应 / ${kw}：失败（${e.message}）`);
        }
        await sleep(2000);
      }
    }
    if (sourceId === "360-search" || sourceId === "all") {
      for (const kw of CRAWL_KEYWORDS) {
        try {
          const items = await crawl360Search(kw);
          collect(items);
          logs.push(`360搜索 / ${kw}：${items.length} 条（代理：${LAST_PROXY}）`);
        } catch (e) {
          logs.push(`360搜索 / ${kw}：失败（${e.message}）`);
          if (/验证码/.test(e.message)) await sleep(4000);
        }
        await sleep(3000);
      }
    }
    if (sourceId === "sogou-wechat" || sourceId === "all") {
      for (const kw of CRAWL_KEYWORDS) {
        try {
          const items = await crawlSogouWechat(kw);
          collect(items);
          logs.push(`搜狗微信 / ${kw}：${items.length} 条（代理：${LAST_PROXY}）`);
        } catch (e) {
          logs.push(`搜狗微信 / ${kw}：失败（${e.message}）`);
        }
        await sleep(3000);
      }
    }
    if (sourceId === "baidu-search" || sourceId === "all") {
      for (const kw of CRAWL_KEYWORDS) {
        try {
          const items = await crawlBaiduSearch(kw);
          collect(items);
          logs.push(`百度 / ${kw}：${items.length} 条（代理：${LAST_PROXY}）`);
        } catch (e) {
          logs.push(`百度 / ${kw}：失败（${e.message}）`);
        }
        await sleep(2000);
      }
    }
    if (sourceId === "official-noi" || sourceId === "all") {
      for (const site of OFFICIAL_SITES) {
        try {
          const items = await crawlOfficialSite(site.url, site.name);
          collect(items);
          if (items.length) succeededSources.add(site.name);
          logs.push(`${site.name}：${items.length} 条（代理：${LAST_PROXY}）`);
        } catch (e) {
          logs.push(`${site.name}：失败（${e.message}）`);
        }
        await sleep(1500);
      }
    }
    if (sourceId === "crawl-rss" || sourceId === "all") {
      // RSS 通道：抓「来源管理」里启用的 RSS 来源（来源管理页可自行添加更多 RSS 订阅）
      const feeds = SOURCES.filter(s => s.enabled && s.type === "RSS" && s.url);
      if (feeds.length === 0) {
        logs.push("RSS 采集：来源管理中没有启用的 RSS 来源，跳过（可去「来源管理」新增，类型选 RSS 订阅）");
      } else {
        for (const feed of feeds) {
          try {
            const items = await crawlRss(feed.url);
            collect(items);
            if (items.length) succeededSources.add(feed.name);
            logs.push(`RSS / ${feed.name}：${items.length} 条（通道：${LAST_CHANNEL || LAST_PROXY}）`);
          } catch (e) {
            logs.push(`RSS / ${feed.name}：失败（${e.message}）`);
          }
          await sleep(1500);
        }
      }
    }

    // 大模型清洗：规范赛事标题 + 生成赛事简介（未配置 API 则跳过，用原始标题）
    if (allItems.length > 0) {
      const llmCfg = loadLLMCfg();
      if (llmCfg.base && llmCfg.key && llmCfg.model) {
        try {
          const r = await polishItems(allItems, llmCfg);
          allItems = r.items;
          const nNotice = allItems.filter(x => x.kind === "NOTICE").length;
          const nNews = allItems.filter(x => x.kind === "NEWS").length;
          logs.push(r.err
            ? `大模型清洗：${r.kept} 条改写、${r.dropped} 条判为非赛事丢弃（部分批次失败：${r.err}）`
            : `大模型清洗：${r.kept} 条改写、${r.dropped} 条判为非赛事丢弃（报名启事 ${nNotice} / 资讯 ${nNews} / 未分类 ${allItems.length - nNotice - nNews}，模型：${llmCfg.model}）`);
        } catch (e) {
          logs.push(`大模型清洗失败，已使用原始标题（${e.message}）`);
        }
      } else {
        logs.push("内置大模型配置缺失，标题保持原样");
      }
    }

    // 写入 Supabase raw_docs
    let newCount = 0;
    if (blockedCount > 0) logs.push(`已过滤大陆不可达链接：${blockedCount} 条`);
    if (junkCount > 0) logs.push(`标题预过滤拦截非赛事内容（高考/查分/广告等）：${junkCount} 条`);
    if (allItems.length > 0) {
      const withReg = allItems.some(it => it.deadline || it.regStatus || it.kind || AI_EXTRA_COLS.some(c => it[c]));
      const mkRows = (withColumns) => allItems.map(it => {
        const row = {
          source_name: it.sourceName,
          source_url: it.sourceUrl,
          raw_title: it.rawTitle,
          summary: it.summary || "",
          status: "NEW",
        };
        if (withColumns && withReg) {
          if (it.deadline || it.regStatus) { row.deadline = it.deadline || null; row.reg_status = it.regStatus || null; }
          if (it.kind) row.kind = it.kind;
          AI_EXTRA_COLS.forEach(c => { if (it[c]) row[c] = it[c]; });
        }
        return row;
      });
      // 网络抖动导致 Failed to fetch 时自动重试一次，避免整轮白抓
      const doUpsert = async (withColumns) => {
        let r = await db.from("raw_docs").upsert(mkRows(withColumns), { onConflict: "source_url", count: "exact" });
        if (r.error && /fetch|network/i.test(r.error.message || "")) {
          await sleep(2500);
          r = await db.from("raw_docs").upsert(mkRows(withColumns), { onConflict: "source_url", count: "exact" });
        }
        return r;
      };
      let { error, count } = await doUpsert(withReg);
      const missCol = missingColumn(error);
      if (error && RAW_DOC_AI_COLS.includes(missCol)) {
        // raw_docs 还没加扩展列：去掉这些列重写，采集不被卡住
        logs.push(`raw_docs 缺 ${RAW_DOC_AI_COLS.join("/")} 列，报名状态、分类与赛事属性未随行存储（SQL：alter table raw_docs add column deadline date, add column reg_status text, add column kind text, add column category text, add column region text, add column grade_scope text, add column format text, add column fee text, add column prize text, add column organizer text;）`);
        ({ error, count } = await doUpsert(false));
      }
      if (error) {
        logs.push(`写入数据库失败：${error.message}`);
      } else {
        newCount = count ?? allItems.length;
      }
    }

    // 写入 crawl_jobs
    await db.from("crawl_jobs").insert({
      source_name: label,
      trigger: "MANUAL",
      status: logs.some(l => l.includes("失败")) && newCount === 0 ? "FAILED" : "SUCCESS",
      total_found: allItems.length,
      new_count: newCount,
      log: logs.join("\n") || "无结果",
      finished_at: new Date().toISOString(),
    });

    await Promise.all([loadRawDocs(), loadCrawlJobs()]);

    // 联动「来源管理」：把本次成功抓到数据的来源的最近采集时间回写库里
    if (succeededSources.size) {
      const stamp = new Date().toISOString();
      const localShow = stamp.slice(0, 16).replace("T", " ");
      for (const s of SOURCES) {
        if (!succeededSources.has(s.name)) continue;
        try {
          const { error } = await db.from("sources").update({ last_crawled_at: stamp }).eq("id", s.id);
          if (!error) s.lastCrawledAt = localShow;
        } catch (e) { /* 列不存在等情况下静默跳过，不影响采集结果 */ }
      }
    }

    const proxyFailCount = logs.filter(l => l.includes("代理全部失败")).length;
    if (newCount === 0 && proxyFailCount > 0) {
      toast(location.protocol === "file:"
        ? `采集未写入任何数据：${proxyFailCount} 个渠道的代理全部失败。file:// 本地文件无法使用同源代理——请运行 python _local_server.py 后访问 http://localhost:8901，或直接使用线上站点`
        : `采集未写入任何数据：${proxyFailCount} 个渠道的代理全部失败（公共代理限流或网络波动）。稍后重试、切换网络，或部署 _worker.js 走同源代理（最稳）`, 10000);
    } else {
      toast(`采集完成：写入 ${newCount} 条`);
    }
  } catch (err) {
    try {
      await db.from("crawl_jobs").insert({
        source_name: sourceId,
        trigger: "MANUAL",
        status: "FAILED",
        total_found: 0,
        new_count: 0,
        log: `采集失败：${err.message}`,
        finished_at: new Date().toISOString(),
      });
      await loadCrawlJobs();
    } catch (e) { console.error(e); }
    toast("采集失败：" + dbErrMsg(err));
  } finally {
    CRAWL_RUNNING = false;
    render();
  }
}

/* ============ AI 赛事简析报告 ============
   基于本站已收录的赛事信息生成四段式参赛参考（定位/关键信息/适合谁/参与建议），
   存 events.ai_brief 持久化；列还没建时也能当次展示（AI_BRIEF_FALLBACK），并提示跑迁移 SQL。 */
const AI_BRIEF_FALLBACK = {};   // event_id -> 生成的文本（ai_brief 列缺失时的临时展示，刷新即失）
let AI_BRIEF_BUSY = "";         // 正在生成的赛事 id

async function generateAiBrief(id){
  if (AI_BRIEF_BUSY) return;
  const e = EVENTS.find(x=>x.id===id);
  if (!e) return;
  AI_BRIEF_BUSY = id;
  render();
  const today = new Date().toISOString().slice(0, 10);
  const system = "你是青少年赛事分析助手。只依据给定的站内已收录信息写简析，不要编造；信息不足的地方明确写「原文未提及」。直接输出正文，不要 markdown 代码块。";
  const user = `请为下面这个赛事写一份简析报告（今天是 ${today}），分四小节，每节 1-3 句话，用「」小标题开头：
1.「赛事定位」这是什么类型/级别的赛事，面向谁；
2.「关键信息」报名时间、形式、费用、奖项等要点，没有的写「原文未提及」；
3.「适合谁参加」结合学段与学科方向给出建议；
4.「参与建议」报名与备赛注意事项，提醒以主办方官方章程为准。
赛事信息：${JSON.stringify({
  title: e.title, summary: (e.summary||"").slice(0,300), description: (e.description||"").slice(0,200),
  category: e.category||null, region: e.region||null, grade: e.gradeScope||null,
  format: e.format||null, fee: e.fee||null, prize: e.prize||null, organizer: e.organizer||null,
  registration_end: e.registrationEnd||null, event_start: e.eventStart||null,
  status: e.status, source: e.sourceName||null,
})}`;
  try {
    const text = await llmChat(loadLLMCfg(), system, user);
    AI_BRIEF_FALLBACK[id] = text;
    const { error } = await db.from("events").update({ ai_brief: text }).eq("id", id);
    if (error) {
      if (missingColumn(error) === "ai_brief") {
        toast("简析已生成展示；events 表缺 ai_brief 列，去后台「数据库体检」复制迁移 SQL 执行后才能永久保存", 8000);
      } else {
        toast("简析已生成展示，但保存失败：" + dbErrMsg(error), 8000);
      }
    } else {
      e.aiBrief = text;
      toast("AI 简析已生成并保存", 4000);
    }
  } catch (err) {
    toast("AI 简析生成失败：" + err.message, 8000);
  } finally {
    AI_BRIEF_BUSY = "";
    render();
  }
}

/* AI 复查赛事报名状态：让模型结合“今天”判断 OPEN/UPCOMING/CLOSED，
   只更新有变化的行；registration_end 仅在模型能明确推出时才覆盖 */
async function runRegStatusCheck(){
  const cfg = loadLLMCfg();
  if (!cfg.base || !cfg.key || !cfg.model) { toast("内置大模型配置缺失，请检查代码中的 LLM_DEFAULT_CFG", 6000); return; }
  if (CRAWL_RUNNING) return;
  const targets = EVENTS.filter(e => e.reviewStatus === "APPROVED" && ["OPEN","UPCOMING","CLOSED"].includes(e.status));
  if (!targets.length) { toast("没有可复查的赛事（需要有已通过审核且带报名状态的赛事）", 6000); return; }
  CRAWL_RUNNING = true;
  toast(`AI 复查报名状态（${targets.length} 条）…`, 5000);
  render();
  const today = new Date().toISOString().slice(0, 10);
  const system = "你是青少年赛事报名状态审核员。只输出 JSON 数组，不要 markdown 代码块标记，不要任何解释。";
  let checked = 0, changed = 0, firstErr = "";
  try {
    for (let i = 0; i < targets.length; i += 10) {
      AI_PROGRESS = `${Math.floor(i / 10) + 1}/${Math.ceil(targets.length / 10)}`;
      render();
      const batch = targets.slice(i, i + 10);
      const input = batch.map((it, j) => ({
        id: j, title: it.title, summary: (it.summary || "").slice(0, 120),
        registration_end: it.registrationEnd || null, status: it.status,
      }));
      const user = `今天是 ${today}。逐条判断青少年赛事当前报名状态：
- "OPEN"：报名进行中（今天在报名窗口内，或原文显示正在报名且未到截止）
- "UPCOMING"：报名尚未开始
- "CLOSED"：报名已截止、赛事已结束或原文日期已过
- registration_end：报名截止日期 YYYY-MM-DD，推不出来给 null（禁止编造）
无法判断时保持原 status 原样返回。
输入：${JSON.stringify(input)}
只输出数组，元素格式 {"id":0,"status":"OPEN","registration_end":null}，id 与输入对应：`;
      try {
        const text = await llmChat(cfg, system, user);
        const m = text.match(/\[[\s\S]*\]/);
        const arr = JSON.parse(m ? m[0] : text);
        for (const hit of (Array.isArray(arr) ? arr : [])) {
          const real = batch[Number(hit && hit.id)];
          if (!real) continue;
          checked++;
          const patch = {};
          if (["OPEN","UPCOMING","CLOSED"].includes(hit.status) && hit.status !== real.status) patch.status = hit.status;
          if (typeof hit.registration_end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(hit.registration_end)
              && hit.registration_end !== real.registrationEnd) patch.registration_end = hit.registration_end;
          if (Object.keys(patch).length) {
            const { error } = await db.from("events").update(patch).eq("id", real.id);
            if (error) { if (!firstErr) firstErr = error.message; }
            else changed++;
          }
        }
      } catch (e) {
        if (!firstErr) firstErr = e.message;
      }
      if (i + 10 < targets.length) await sleep(600);
    }
    await loadEvents();
    if (firstErr) toast(`AI 复查完成：${checked} 条，更新 ${changed} 条（出错：${firstErr}）`, 8000);
    else if (changed === 0) toast(`AI 复查完成：${checked} 条——模型判定与现状一致（或推不出截止日期），未做修改`, 6000);
    else toast(`AI 复查完成：${checked} 条，更新 ${changed} 条`, 6000);
  } finally {
    CRAWL_RUNNING = false;
    AI_PROGRESS = "";
    render();
  }
}

/* ============ AI 分类存量原始数据（kind 回填：NOTICE 报名启事 / NEWS 资讯） ============
   待分类清单直接从库里分页拉取：前端 RAW_DOCS 只加载最新 200 条，
   更早的未分类数据页面看不到，只按 RAW_DOCS 过滤会一直"分类不干净"。 */
async function runKindClassify(){
  const cfg = loadLLMCfg();
  if (!cfg.base || !cfg.key || !cfg.model) { toast("内置大模型配置缺失，请检查代码中的 LLM_DEFAULT_CFG", 6000); return; }
  if (CRAWL_RUNNING) return;
  CRAWL_RUNNING = true;
  render();
  let targets = [];
  try {
    const { data, error } = await db.from("raw_docs").select("id").eq("status", "NEW").is("kind", null).order("fetched_at", { ascending: false }).limit(1000);
    if (!error && Array.isArray(data)) targets = data.map(r => ({ id: r.id }));
  } catch (e) { /* 网络抖动时退回前端已加载数据 */ }
  if (!targets.length) targets = RAW_DOCS.filter(r => r.status === "NEW" && !r.kind).map(r => ({ id: r.id }));
  if (!targets.length) {
    CRAWL_RUNNING = false; AI_PROGRESS = ""; render();
    toast("没有待分类的原始数据（状态为 NEW 且未分类的条目已经分完了）", 5000);
    return;
  }
  toast(`AI 分类原始数据（${targets.length} 条）…`, 5000);
  let done = 0, news = 0, firstErr = "";
  try {
    const BATCH = 10;
    for (let i = 0; i < targets.length; i += BATCH) {
      AI_PROGRESS = `${Math.floor(i / BATCH) + 1}/${Math.ceil(targets.length / BATCH)}`;
      render();
      // 按 id 取这一批的标题与简介
      const batchIds = targets.slice(i, i + BATCH).map(r => r.id);
      let batch = [];
      const det = await db.from("raw_docs").select("id,raw_title,summary").in("id", batchIds);
      if (det.error || !Array.isArray(det.data)) { if (!firstErr) firstErr = det.error ? det.error.message : "读取原始数据失败"; continue; }
      batch = det.data;
      const input = batch.map((it, j) => ({ id: j, title: it.raw_title, summary: (it.summary || "").slice(0, 200) }));
      const system = "你是青少年赛事信息分类助手。只输出 JSON 数组，不要 markdown 代码块标记，不要解释。";
      const user = `逐条判断下面的网页条目属于哪类：
- "NOTICE"：报名启事/通知——告诉读者可以去报名（含报名时间、条件、入口、章程发布、选拔测评安排）；
- "NEWS"：资讯报道——新闻、获奖名单、政策解读、赛事回顾、盘点等，看完不能直接报名。
无法判断时填 null。
输入：${JSON.stringify(input)}
只输出数组，元素格式 {"id":0,"kind":"NOTICE"}，id 与输入对应：`;
      try {
        const text = await llmChat(cfg, system, user);
        const m = text.match(/\[[\s\S]*\]/);
        const arr = JSON.parse(m ? m[0] : text);
        for (const hit of (Array.isArray(arr) ? arr : [])) {
          const real = batch[Number(hit && hit.id)];
          if (!real) continue;
          if (hit.kind !== "NOTICE" && hit.kind !== "NEWS") continue;
          const { error } = await db.from("raw_docs").update({ kind: hit.kind }).eq("id", real.id);
          if (error) { if (!firstErr) firstErr = error.message; continue; }
          const localRow = RAW_DOCS.find(r => r.id === real.id);
          if (localRow) localRow.kind = hit.kind;
          done++;
          if (hit.kind === "NEWS") news++;
        }
      } catch (e) { if (!firstErr) firstErr = e.message; }
      // kind 列不存在：立即停，不继续空跑 API
      if (firstErr && /'kind'/.test(firstErr)) break;
      if (i + BATCH < targets.length) await sleep(600);
    }
    await loadRawDocs();
    if (firstErr && /'kind'/.test(firstErr)) {
      toast("raw_docs 缺 kind 列（SQL：alter table raw_docs add column kind text;）", 8000);
    } else if (firstErr) {
      toast(`AI 分类完成：${done} 条（出错：${firstErr}）`, 8000);
    } else if (done === 0) {
      toast("AI 分类完成：0 条——这批抓取结果多为图片/视频/下载页等无关内容，模型无法判断类型，已保持未分类", 8000);
    } else {
      toast(`AI 分类完成：${done} 条（报名启事 ${done - news} 条、资讯 ${news} 条）`, 6000);
    }
  } finally {
    CRAWL_RUNNING = false;
    AI_PROGRESS = "";
    render();
  }
}

/* ============ AI 补全存量赛事的属性字段 ============
   2026-10 之前转出来的赛事，分类/地区/学段/费用这些列是空的，
   所以在赛事库里筛不出来。这里用模型按标题+简介回填一遍。 */
async function runFieldBackfill(){
  const cfg = loadLLMCfg();
  if (!cfg.base || !cfg.key || !cfg.model) { toast("内置大模型配置缺失，请检查代码中的 LLM_DEFAULT_CFG"); return; }
  if (CRAWL_RUNNING) return;
  const targets = EVENTS.filter(e => !e.category || !e.region || !e.organizer);
  if (!targets.length) { toast("没有需要补全的赛事"); return; }
  CRAWL_RUNNING = true;
  toast(`AI 补全赛事属性（${targets.length} 条）…`);
  render();
  const system = "你是青少年赛事信息补全助手。只输出 JSON 数组，不要 markdown 代码块标记，不要任何解释。";
  let done = 0, firstErr = "";
  try {
    for (let i = 0; i < targets.length; i += 10) {
      const batch = targets.slice(i, i + 10);
      const input = batch.map((it, j) => ({
        id: j, title: it.title, summary: (it.summary || "").slice(0, 150),
        organizer: it.organizer || null, source: it.sourceName || null,
      }));
      const user = `根据下面的赛事标题与简介补全属性字段（已有的字段若与原文不符也可以修正）：
- category 只能从「${CATEGORIES.join(" / ")}」里选一个；region 优先从「${REGIONS.join(" / ")}」里选，其他省份直接写省名（如"湖北"），全国性填"全国"；grade 只能从「${GRADES.join(" / ")}」里选一个；
- format 如「线上」「线下」；fee 照抄原文写法如「免费」「200 元」；prize 为奖项设置；organizer 为主办方全称（不超过 20 字）；
- 推不出来的字段一律填 null，禁止编造，尤其不要编造日期和机构名。
输入：${JSON.stringify(input)}
只输出数组，元素格式 {"id":0,"category":null,"region":null,"grade":null,"format":null,"fee":null,"prize":null,"organizer":null}，id 与输入对应：`;
      try {
        const text = await llmChat(cfg, system, user);
        const m = text.match(/\[[\s\S]*\]/);
        const arr = JSON.parse(m ? m[0] : text);
        for (const hit of (Array.isArray(arr) ? arr : [])) {
          const real = batch[Number(hit && hit.id)];
          if (!real) continue;
          const patch = {};
          const cat = pickEnum(hit.category, CATEGORIES); if (cat && cat !== real.category) patch.category = cat;
          const region = pickEnum(hit.region, REGIONS) || pickPlace(hit.region); if (region && region !== real.region) patch.region = region;
          const grade = pickEnum(hit.grade, GRADES); if (grade && grade !== real.gradeScope) patch.grade_scope = grade;
          const fmt = pickText(hit.format, 20); if (fmt && fmt !== real.format) patch.format = fmt;
          const fee = pickText(hit.fee, 20); if (fee && fee !== real.fee) patch.fee = fee;
          const prize = pickText(hit.prize, 60); if (prize && prize !== real.prize) patch.prize = prize;
          const org = pickText(hit.organizer, 40); if (org && org !== real.organizer) patch.organizer = org;
          if (!Object.keys(patch).length) continue;
          const { error } = await writeWithFallback(r2 => db.from("events").update(r2).eq("id", real.id), patch);
          if (error) { if (!firstErr) firstErr = error.message; continue; }
          done++;
        }
      } catch (e) { if (!firstErr) firstErr = e.message; }
      if (i + 10 < targets.length) await sleep(600);
    }
    await loadEvents();
    toast(firstErr ? `AI 补全完成：${done} 条（出错：${firstErr}）` : `AI 补全完成：${done} 条赛事属性已更新`);
  } finally {
    CRAWL_RUNNING = false;
    render();
  }
}

/* ============ 前台：数据报告 ============ */
let REPORT_CHARTS = [];

function exportEventsCsv(){
  const list = EVENTS.filter(e => e.reviewStatus === "APPROVED");
  const rows = [["标题","分类","地区","学段","参赛形式","费用","奖项","主办方","报名截止","比赛开始","报名状态","审核状态","可信度","来源","来源链接","浏览量","收藏量","录入时间"]];
  list.forEach(e => rows.push([
    e.title, e.category, e.region, e.gradeScope, e.format, e.fee, e.prize, e.organizer,
    e.registrationEnd, e.eventStart, STATUS[e.status] || e.status, REVIEW[e.reviewStatus] || e.reviewStatus,
    e.credibilityScore, e.sourceName, e.sourceUrl, e.viewCount, e.favoriteCount, e.createdAt,
  ]));
  downloadText(`赛事明细_${todayStr()}.csv`, rows.map(r => r.map(csvCell).join(",")).join("\r\n"));
  toast(`已导出 ${list.length} 条赛事明细`);
}

function PageReport(){
  const approved = EVENTS.filter(e => e.reviewStatus === "APPROVED");
  const open = approved.filter(e => e.status === "OPEN").length;
  const soon = approved.filter(e => { const d = daysUntil(e.registrationEnd); return d !== null && d >= 0 && d <= 7; }).length;
  const sources = new Set(approved.map(e => e.sourceName).filter(Boolean)).size;
  const box = (title, sub, id, cls) => `
    <div class="rounded-lg border border-slate-200 bg-white p-5 space-y-2 ${cls||""}">
      <p class="text-base font-semibold">${title}</p>
      ${sub?`<p class="text-xs text-slate-500">${sub}</p>`:""}
      <div class="h-64"><canvas id="${id}"></canvas></div>
    </div>`;

  return `
  <div class="mx-auto max-w-7xl px-4 py-8 space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">数据报告</h1>
        <p class="text-sm text-slate-500">基于平台已发布的 ${approved.length} 条赛事实时统计，打开页面即刷新</p>
      </div>
      <button onclick="exportEventsCsv()" class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">⤓ 导出赛事明细 CSV</button>
    </div>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      ${statCard("已发布赛事", approved.length)}
      ${statCard("正在报名", open, "", "text-emerald-600")}
      ${statCard("7 天内截止", soon, "需要重点提醒", "text-amber-600")}
      ${statCard("覆盖信息来源", sources, "", "text-sky-600")}
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      ${box("赛事分类分布", "按 Category 聚合，取前 8", "chart-cat")}
      ${box("赛事地区分布", "按 Region 聚合，取前 10", "chart-region")}
    </div>
    <div class="grid gap-4 lg:grid-cols-3">
      ${box("报名截止趋势", "近 12 个月每月的报名截止数量", "chart-trend", "lg:col-span-2")}
      ${box("来源可信度分布", "高可信 ≥85 / 中等 ≥60 / 待核实", "chart-cred")}
    </div>
    ${box("信息来源 TOP 8", "按已发布赛事数量排序", "chart-src")}

    <p class="text-xs text-slate-400">图表由 Chart.js 渲染（jsDelivr CDN，与 supabase-js 同源）；导出内容为当前全部已发布赛事，含 BOM，Excel 打开不乱码。</p>
  </div>`;
}

function destroyReportCharts(){
  REPORT_CHARTS.forEach(c => { try { c.destroy(); } catch (e) {} });
  REPORT_CHARTS = [];
}

async function mountReport(){
  if (!location.hash.replace(/^#/,"").startsWith("/report")) return;
  try { await ensureChartJs(); }
  catch (e) { toast(e.message); return; }
  // 等图表的这段时间用户可能已经跳到别的页面
  if (!location.hash.replace(/^#/,"").startsWith("/report")) return;
  destroyReportCharts();
  if (!window.Chart) return;

  const approved = EVENTS.filter(e => e.reviewStatus === "APPROVED");
  const countBy = (arr, key) => { const m = {}; arr.forEach(e => { const v = e[key] || "未填"; m[v] = (m[v]||0)+1; }); return m; };
  const topN = (obj, n) => Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,n);
  const PALETTE = ["#2563eb","#10b981","#f59e0b","#8b5cf6","#ef4444","#06b6d4","#84cc16","#f97316"];
  const mk = (id, cfg) => {
    const el = document.getElementById(id);
    if (el) REPORT_CHARTS.push(new window.Chart(el, cfg));
  };
  const axis = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } };

  const cat = topN(countBy(approved, "category"), 8);
  mk("chart-cat", {
    type: "bar",
    data: { labels: cat.map(x=>x[0]), datasets: [{ data: cat.map(x=>x[1]), backgroundColor: "#2563eb", borderRadius: 4 }] },
    options: { ...axis, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  const region = topN(countBy(approved, "region"), 10);
  mk("chart-region", {
    type: "bar",
    data: { labels: region.map(x=>x[0]), datasets: [{ data: region.map(x=>x[1]), backgroundColor: "#10b981", borderRadius: 4 }] },
    options: { ...axis, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  const months = [];
  const base = new Date(); base.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`);
  }
  const trend = months.map(m => approved.filter(e => (e.registrationEnd||"").slice(0,7) === m).length);
  mk("chart-trend", {
    type: "line",
    data: { labels: months, datasets: [{ data: trend, borderColor: "#8b5cf6", backgroundColor: "rgba(139,92,246,.15)", fill: true, tension: .3, pointRadius: 3 }] },
    options: { ...axis, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  const cred = [["高可信", approved.filter(e=>e.credibilityScore>=85).length],
                ["中等可信", approved.filter(e=>e.credibilityScore>=60&&e.credibilityScore<85).length],
                ["待核实", approved.filter(e=>e.credibilityScore<60).length]];
  mk("chart-cred", {
    type: "doughnut",
    data: { labels: cred.map(x=>x[0]), datasets: [{ data: cred.map(x=>x[1]), backgroundColor: ["#10b981","#0ea5e9","#f59e0b"] }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
  });

  const src = topN(countBy(approved, "sourceName"), 8);
  mk("chart-src", {
    type: "bar",
    data: { labels: src.map(x=>x[0]), datasets: [{ data: src.map(x=>x[1]), backgroundColor: PALETTE.concat(PALETTE, PALETTE).slice(0, src.length), borderRadius: 4 }] },
    options: { ...axis, indexAxis: "y", scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
}

/* ============ 路由 & 渲染 ============ */
function renderLoading(){
  document.getElementById("app").innerHTML = `
    <div class="flex min-h-screen items-center justify-center">
      <div class="text-center space-y-3">
        <div class="spinner mx-auto"></div>
        <p class="text-sm text-slate-500">正在加载赛事数据…</p>
      </div>
    </div>`;
}

function render(){
  const hash = location.hash.replace(/^#/, "") || "/";
  const app = document.getElementById("app");
  closeModal();

  if (hash.startsWith("/admin")) {
    if (hash === "/admin/login") { app.innerHTML = AdminLoginPage(); return; }
    if (!ADMIN_LOGGED) { LOGIN_ERROR = "请先登录"; nav("/admin/login"); return; }
    app.innerHTML = `
      <div class="flex min-h-screen">
        ${AdminSidebar(hash)}
        <div class="flex min-w-0 flex-1 flex-col">
          ${AdminTopbar()}
          <main class="flex-1 bg-slate-100 p-4 md:p-6">${AdminContent(hash)}</main>
        </div>
      </div>`;
    window.scrollTo(0,0);
    return;
  }

  let content;
  // 带查询串的 hash（如 /events?cat=编程与信息学）必须先剥掉 ?…，否则 base 匹配不上直接 404
  const parts = hash.split("?")[0].split("/").filter(Boolean);
  const base = parts[0] || "";
  let detailId = "";
  if (!base) content = PageHome();
  else if (base === "events") {
    detailId = parts[1] ? parts[1].split("?")[0] : "";
    content = detailId ? PageEventDetail(detailId) : PageEvents();
  }
else if (base === "calendar") content = PageCalendar();
else if (base === "check") content = PageWhitelistCheck(hashQuery().get("q"));
else if (base === "news") content = PageNews();
  else if (base === "report") content = PageReport();
  else if (base === "me") content = PageMe();
  else if (base === "submit") content = PageSubmit();
  else if (base === "about") content = PageAbout();
  else if (base === "faq") content = PageFaq();
  else if (base === "org") content = PageOrg();
  else content = `<div class="mx-auto max-w-3xl px-4 py-20 text-center"><p class="text-2xl font-bold">404</p><a href="#/" class="mt-4 inline-block text-blue-600">返回首页</a></div>`;

  app.innerHTML = `
    <div class="flex min-h-screen flex-col">
      ${SiteHeader()}
      <main class="flex-1">${content}</main>
      ${SiteFooter()}
    </div>`;
  window.scrollTo(0,0);

  // 渲染完成后的副作用：详情页计一次浏览量、报告页挂图表
  if (detailId) { const e = EVENTS.find(x => x.id === detailId); if (e) bumpView(e); }
  if (base === "report") mountReport();
}

window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", async () => {
  renderLoading();
  restoreAdminSession();   // 后台登录态（sessionStorage，刷新不掉）
  try {
    await loadAll();
  } catch (err) {
    console.error(err);
    document.getElementById("app").innerHTML = `
      <div class="flex min-h-screen items-center justify-center p-6">
        <div class="max-w-md rounded-lg border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700 space-y-2">
          <p class="font-semibold">无法连接数据库</p>
          <p>${esc(err.message)}</p>
          <p class="text-xs">请刷新重试；若持续失败，请把这条信息反馈给我们。</p>
        </div>
      </div>`;
    return;
  }
  // 登录态存在服务端会话表里；表还没建时这里静默跳过，页面照常可用
  await restoreSession();
  if (CURRENT_USER) await Promise.all([loadUserData(), loadMySubmissions()]);
  render();
});