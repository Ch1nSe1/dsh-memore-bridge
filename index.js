/**
 * memore-bridge —— 把 Memore 的记录接给 agent（2026-11-13）。
 *
 * 版本 2：**直连手机上的 App**，不再读本地副本。
 *
 * 为什么改：副本会过期，而过期是看不见的错误——agent 答的是三小时前的库，
 * 用户以为它知道刚记的东西。现在 App 自己就是服务端（8790 端口），
 * 插件只是它的客户端，读到的永远是当前数据。
 *
 * 端点配置在 %USERPROFILE%\.dsh\memore-agent.json（可用环境变量 MEMORE_AGENT_CONFIG 指到别处）：
 *   { "base": "http://<手机局域网 IP>:8790", "token": "..." }
 * （token 在 App 的「Agent 连接」页可以复制/重置）
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Schema from '@deepseek-ai/schemastery';
import { discoverMemore } from './mdns.js';
import { discoverTailnetPeers } from './tailnet.js';
import { registerReview } from './review-server.js';

/** 插件自己的版本：和手机 /health 的 client.min_version 比对（2026-11-20）。 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function versionAtLeast(current, required) {
  const a = String(current).split('.').map((x) => Number(x) || 0);
  const b = String(required).split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

export const name = 'memore-bridge';
/** 手机端 Agent 服务的固定端口（App 里写死的 8790）。 */
const AgentPort = 8790;
export const inject = ['tools', 'skills', 'systemPrompt'];

/**
 * 设置页里的配置项。DSH 会据此在「设置 → 插件配置」渲染表单，
 * 不必手改 JSON。url 就是 App「Agent 连接」页复制出来的那一整串。
 */
export const Config = Schema.object({
  urls: Schema.string()
    .description('可用地址：一行一条连接串，按顺序试（WLAN 那条、Tailscale 那条、USB 转发那条都可以放进来）')
    .default(''),
  url: Schema.string()
    .description('单条连接串，形如 memore://<手机 IP>:8790?token=…（只连一个地址时用它）')
    .default(''),
  token: Schema.string()
    .description('只有在上面的 url 只填了 http 地址时才需要；整串 memore:// 里已带令牌')
    .default(''),
  fallbackBase: Schema.string()
    .description('可选兜底地址，例如 USB 转发 http://127.0.0.1:18790')
    .default(''),
  timeoutMs: Schema.natural()
    .description('单次请求超时（毫秒）')
    .default(15000),
});

/** apply() 收到的配置。工具调用时读它，避免每次调用都解析文件。 */
let activeConfig = {};

// ===== Mirror 桥（2026-11-20）=====
// 模型不该靠试错才知道有哪些工具/档位。启动时把「自动生成的说明」注入 system prompt；
// 人可以在 global / workspace / session 三档里覆盖它，优先级从细到粗。
const GUIDE_PATH = path.join(os.homedir(), '.dsh', 'memore-guide.json');
let lastHealthCache = null;
let lastPromptContext = null;

function readGuideStore() {
  try {
    const raw = JSON.parse(readFileSync(GUIDE_PATH, 'utf8'));
    return {
      enabled: raw.enabled !== false,
      mode: raw.mode === 'session' || raw.mode === 'workspace' ? raw.mode : 'global',
      global: typeof raw.global === 'string' ? raw.global : '',
      workspaces: raw.workspaces && typeof raw.workspaces === 'object' ? raw.workspaces : {},
      sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
    };
  } catch {
    return { enabled: true, mode: 'global', global: '', workspaces: {}, sessions: {} };
  }
}

function writeGuideStore(store) {
  writeFileSync(GUIDE_PATH, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

function guideSessionId(context) {
  return String(context?.agent?.session?.header?.id ?? '');
}

function guideCwd(context) {
  return String(context?.agent?.session?.header?.cwd ?? '');
}

function autoGuideText() {
  const h = lastHealthCache;
  const port = h?.server?.port ?? 8790;
  const policy = h?.policy;
  const tierLine = policy
    ? `权限：一级免批（${(policy.tier1 ?? []).join('、')}）；二级需手机批准（${(policy.tier2 ?? []).length} 个）；三级禁止（${(policy.tier3 ?? []).join('、')}）。`
    : '权限：手机未连接，档位未知（一级免批 / 二级需批 / 三级禁止）。';
  return [
    '【Mirror 桥 · 提示词（自动生成）】',
    `手机 App 的 Agent 服务：端口 ${port}${h?.server?.bound === false ? '（未绑定）' : ''}。全部数据在手机上，没有本地副本。`,
    tierLine,
    '工具：memore_search / memore_recent / memore_get / memore_neighbors / memore_projection / memore_anchors / memore_insights / memore_versions / memore_relations / memore_prompts / memore_similar / memore_act / memore_actions / memore_act_status / memore_wait_pending。',
    '习惯：先用 memore_projection 看分段，再 search/similar 找具体记录；批量读用 /records?ids=；审边先 memore_relations（带正文与置信度）。',
    '写入：memore_act 提交动作；一级直接执行，二级要用户在手机上批（可按 wait_s 等结果）；三级会被拒。批准/拒绝/撤回只能手机操作，不要尝试代批。',
    '关联：建边必须带 quote_a/quote_b；删边用 relation.unlink（要手机批）；拒绝用 relation.reject，改类型用 relation.retype，恢复用 relation.restore。',
    '概念：改名/合并一律走别名映射——alias.add / alias.update / alias.delete / alias.merge（from 并入 to，方向由你提，执行要手机批）；concept.delete 只删锚点行，不删记录。',
    '日记：你有自己的日记（不是用户的）。写之前先用 memore_diary_today 看 04:00 日界和当天 rev；素材只来自本次对话，往期日记只作承接、不得照抄或续写，不要从 memore 记录取素材；正文写给“明天的自己”，第一人称、简短、不评判不诊断；entries 里 event 要带 HH:mm、memory 要带 original_date、reflection 自由；写完默认镜像一条 AI 札记到手机。',
    '其他：附件单文件上限 20MB，图片会先压到长边 2048 再传（memore_attachments 列文件、memore_attachment_fetch 取到本地再打开）；一次动作最多 20 步 / 50 条记录；提示词与设置只读。',
  ].join('\n');
}

function sessionEntry(store, sid) {
  if (!sid || store.sessions[sid] === undefined) return undefined;
  const raw = store.sessions[sid];
  if (typeof raw === 'string') return { enabled: true, text: raw };
  if (raw && typeof raw === 'object') return { enabled: raw.enabled !== false, text: typeof raw.text === 'string' ? raw.text : '' };
  return undefined;
}

function resolveGuide(context, override) {
  const store = readGuideStore();
  // 2026-11-20：开关做成总开关——停用后任何会话都不注入，和名字一致。
  if (store.enabled === false) return { text: '', source: 'disabled' };
  const sid = override && override.sid !== undefined ? override.sid : guideSessionId(context);
  const cwd = override && override.cwd !== undefined ? override.cwd : guideCwd(context);
  // 会话优先（关 / 开 / 自定义），其次工作区，再全局，最后自动。
  const sess = sessionEntry(store, sid);
  if (sess !== undefined) {
    if (sess.enabled === false) return { text: '', source: 'session-off' };
    const text = sess.text || store.global || autoGuideText();
    return { text, source: 'session' };
  }
  if (cwd && store.workspaces[cwd]) return { text: store.workspaces[cwd], source: 'workspace' };
  if (store.global) return { text: store.global, source: 'global' };
  return { text: autoGuideText(), source: 'auto' };
}

function guideText(context) {
  lastPromptContext = context;
  return resolveGuide(context).text;
}

function configPath() {
  return process.env.MEMORE_AGENT_CONFIG || path.join(os.homedir(), '.dsh', 'memore-agent.json');
}

/** 旧版的 JSON 配置，只作为兜底：设置页 / 环境变量优先。 */
function fileConfig() {
  try {
    const cfg = JSON.parse(readFileSync(configPath(), 'utf8'));
    return cfg && (cfg.base || (Array.isArray(cfg.endpoints) && cfg.endpoints.length > 0)) ? cfg : null;
  } catch {
    return null;
  }
}

/** 原始配置文件内容（不管有没有 base），面板读写端点时用。 */
function readConfigFileRaw() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** 面板改完端点后写回；只动 endpoints 这一个键，其它键保留。 */
function writeEndpointsToFile(list) {
  const path0 = configPath();
  const current = readConfigFileRaw();
  const next = { ...current, endpoints: list };
  // 老的 base/token 仍在时保留，它们和 endpoints 一起参与优先级，不会互相覆盖
  writeFileSync(path0, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** 解析 `memore://host:port?token=…` 或 `http://host:port`。 */
function parseEndpointString(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;  if (s.startsWith('memore://')) {
    try {
      const u = new URL('http://' + s.slice('memore://'.length));
      return { base: 'http://' + u.host, token: u.searchParams.get('token') || '' };
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return { base: u.origin, token: u.searchParams.get('token') || '' };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 面板写端点时的校验：地址能解析、**而且带令牌**才算可用。
 * 只有地址没有令牌的串连不上，存进去就是一条永远失败的行（2026-11-18 实测踩到）。
 */
function isUsableEndpointString(raw) {
  const p = parseEndpointString(raw);
  return Boolean(p && p.token);
}

/** 上次成功连上的地址（进程内存）。多网卡/多网络时，下一次先试它，省一次探测。 */
let lastGoodBase = '';

/**
 * mDNS 扫到的手机地址（进程内缓存）。
 *
 * 为什么不每次请求都扫：一轮 mDNS 要等 900ms，面板刷新会拖长；
 * 10 秒内复用上一次结果，够跟上换网络，又不会把界面卡住。
 */
let discoveredBases = [];
let discoveryAt = 0;
let discoveryRunning = false;

function refreshDiscovery() {
  if (discoveryRunning) return;
  if (Date.now() - discoveryAt < 10000) return;
  discoveryAt = Date.now();
  discoveryRunning = true;
  discoverMemore(900)
    .then((list) => {
      discoveredBases = list.map((d) => d.base);
      // 记住上次扫到的局域网地址：mDNS 有去重抑制，下一轮未必答得出来。
      const lan = discoveredBases.find((b) => /^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(b));
      if (lan) rememberLanBase(lan);
    })
    .catch(() => {
      // 扫不到就维持上一次结果，不影响已配置的地址
    })
    .finally(() => {
      discoveryRunning = false;
    });
}

/**
 * Tailscale 对端地址（进程内缓存）。
 *
 * 这条路替代 mDNS 解决「换网络」：手机切流量、只剩 Tailscale 时，
 * 组播没有出口扫不到手机，但 Tailscale 客户端自己知道对端 100.x。
 * 20 秒内复用，CLI 一次约 70ms，比 mDNS 快得多。
 */
let tailnetBases = [];
let tailnetAt = 0;
let tailnetRunning = false;

/**
 * 记住/读取上次发现的局域网地址（2026-11-18）。
 *
 * 为什么需要：mDNS 应答方对同一个 PTR 查询有去重抑制（RFC 6762 §6），
 * 实测连续两轮查询，第二轮就收不到应答。把上一轮结果存进配置当缓存，
 * 下次直接连；地址变了再由 mDNS/Tailscale 覆盖它。
 */
function rememberLanBase(base) {
  try {
    const raw = readConfigFileRaw();
    if (raw.lastLan === base) return;
    writeFileSync(configPath(), JSON.stringify({ ...raw, lastLan: base }, null, 2) + '\n', 'utf8');
  } catch {
    // 写不进去不影响本次连接
  }
}

function readRememberedLanBase() {
  try {
    const raw = readConfigFileRaw();
    const base = String(raw.lastLan ?? '').trim();
    return /^http:\/\//.test(base) ? base : '';
  } catch {
    return '';
  }
}
function refreshTailnet() {
  if (tailnetRunning) return;
  if (Date.now() - tailnetAt < 20000) return;
  tailnetAt = Date.now();
  tailnetRunning = true;
  discoverTailnetPeers(1500)
    .then((peers) => {
      tailnetBases = peers.map((p) => `http://${p.ip}:${AgentPort}`);
    })
    .catch(() => {})
    .finally(() => {
      tailnetRunning = false;
    });
}

/**
 * 取可用地址列表，按优先级排好：
 *   设置页「可用地址」（一行一条，按粘贴顺序）
 *   → 设置页单个 url → 环境变量 MEMORE_AGENT_URL → 旧 JSON 文件 → fallbackBase（USB 转发）
 * 上次成功的那条会被提到最前面。全都没有时给出"下一步该做什么"，而不是空白报错。
 */
function resolveEndpoints() {
  const cfg = activeConfig || {};
  const list = [];
  const push = (rawBase, rawToken) => {
    if (!rawBase) return;
    let base = String(rawBase).trim().replace(/\/+$/, '');
    if (!base) return;
    if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
    // 令牌可以为空（2026-11-18）：手机端改成「首次连进来在 App 里点允许」之后，
    // 没有令牌也该发一次请求——不然连「待确认」都到不了手机上。
    const token = String(rawToken || '').trim();
    if (list.some((e) => e.base === base && e.token === token)) return;
    list.push({ base, token });
  };

  // 1) 多行：一行一条
  for (const line of String(cfg.urls ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = parseEndpointString(line);
    if (p) push(p.base, p.token || cfg.token);
    else push(line, cfg.token);
  }

  // 2) 单条
  const single = parseEndpointString(cfg.url);
  if (single) push(single.base, single.token || cfg.token);
  else if (cfg.url) push(cfg.url, cfg.token);

  // 3) 环境变量
  const envStr = process.env.MEMORE_AGENT_URL;
  const env = parseEndpointString(envStr);
  if (env) push(env.base, env.token || process.env.MEMORE_AGENT_TOKEN);
  else if (envStr) push(envStr, process.env.MEMORE_AGENT_TOKEN);

  // 4) 旧 JSON 文件：endpoints 数组（面板写的）优先，其次老的 base/token
  const file = fileConfig();
  if (file) {
    for (const line of Array.isArray(file.endpoints) ? file.endpoints : []) {
      const p = parseEndpointString(line);
      if (p) push(p.base, p.token || file.token);
      else if (line) push(line, file.token);
    }
    if (file.base) push(file.base, file.token);
  }

  // 5) 兜底地址（开发期的 adb reverse 转发；仅排最后，功能不依赖它）
  if (cfg.fallbackBase) push(cfg.fallbackBase, list[0]?.token || file?.token);

  // 6) 自动发现（2026-11-18）：先 Tailscale 对端，再 mDNS。
  //    令牌沿用已配置的那一个——发现只负责“手机在哪”，不负责“凭据是什么”。
  //    发现的排最前：刚查出来的，比配置文件里那条更可能是活的。
  //    之所以两路都留着：家里同一个 Wi-Fi 只有 mDNS 能看见（Tailscale 可能没开）；
  //    切到流量时反过来，只有 Tailscale 知道对端在哪。
  refreshDiscovery();
  refreshTailnet();
  const autoToken = list[0]?.token || cfg.token || file?.token || process.env.MEMORE_AGENT_TOKEN || '';
  // 局域网优先，Tailscale 兜底（2026-11-18 按用户要求）：同一 Wi-Fi 走毫秒级直连，
  // 出门才落到 100.x。令牌为空也照样发——手机端会把它列进「请求访问」，等你点允许。
  const remembered = readRememberedLanBase();
  const autoBases = [...discoveredBases, ...(remembered ? [remembered] : []), ...tailnetBases];
  if (autoBases.length > 0) {
    for (const base of [...autoBases].reverse()) list.unshift({ base, token: autoToken });
  }

  if (list.length === 0) {
    throw new Error(
      '找不到手机：确认它和这台电脑在同一个 Wi-Fi，或两台都登录了 Tailscale。'
      + '手机上的「Agent 连接」服务也要开着。'
    );
  }

  const hit = list.findIndex((e) => e.base === lastGoodBase);
  if (hit > 0) list.unshift(list.splice(hit, 1)[0]);
  return list;
}

/** 依次试列表里每个地址，第一个成功的就是本次结果；失败的记下原因，全失败再抛。 */
async function requestEach(pathAndQuery, doRequest, timeoutMs, parse) {
  const endpoints = resolveEndpoints();
  let lastError;
  for (const ep of endpoints) {
    try {
      const body = await doRequest(ep.base, pathAndQuery, timeoutMs, ep.token);
      lastGoodBase = ep.base;
      return parse(body);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('没有可用地址');
}

/**
 * 这台电脑的名字，随每个请求带给手机（2026-11-18）。
 * 手机端据此显示「已连接 · <电脑名>」，而不是只看到一个 IP。
 */
function clientName() {
  try {
    return String(os.hostname() || '').trim().slice(0, 40) || 'computer';
  } catch {
    return 'computer';
  }
}

/** 网络错误翻成人话：模型和用户看到的都不该是 ECONNREFUSED。 */
function humanizeNetworkError(e, base) {
  if (!e || !e.code) return e;
  switch (e.code) {
    case 'ECONNREFUSED':
      return new Error(`手机没连上（${base}）：App 的「Agent 连接」没启动，或两台设备不在同一网络`);
    case 'ETIMEDOUT':
      return new Error('手机没响应（超时）：可能锁屏或后台被杀，打开 App 再试');
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new Error(`地址解析不了（${base}）：IP 写错了，或不在同一网络`);
    case 'ECONNRESET':
      return new Error('连接被手机掐断：可能刚换了网络或锁屏');
    default:
      return e;
  }
}

function getWithFallback(pathAndQuery, timeoutMs, parse) {
  return requestEach(
    pathAndQuery,
    (base, pq, t, token) => getFrom(base, pq, t, token),
    timeoutMs ?? activeConfig?.timeoutMs ?? 15000,
    parse
  );
}

function getFrom(base, pathAndQuery, timeoutMs, token) {
  const url = new URL(pathAndQuery, base);
  return new Promise((resolve, reject) => {
    // 硬截止（2026-11-18）：Node 的 timeout 只在 socket 空闲时触发，
    // 连一个不在网的局域网 IP 时 TCP 握手会干等几十秒。这里到点直接销毁。
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(arg);
    };
    const deadline = setTimeout(() => {
      req.destroy();
      finish(reject, new Error('手机没响应（超时）：可能锁屏或后台被杀，打开 App 再试'));
    }, Math.max(500, timeoutMs));
    const req = http.get(url, { headers: { 'X-Memore-Token': token, 'X-Memore-Client': clientName() }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.ok === false) return finish(reject, new Error(parsed.error || '请求失败'));
          finish(resolve, body);
        } catch {
          finish(reject, new Error(`返回不是 JSON（HTTP ${res.statusCode}）：${body.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('手机没响应（超时）')); });
    req.on('error', (e) => finish(reject, humanizeNetworkError(e, base)));
  });
}


// ========== 日记（2026-11-22） ==========
// 这是 **AI 自己的日记**：素材主要来自对话，落盘在本地（PC），默认镜像一份到手机的 AI 札记。
// 不依赖任何外部记忆服务；OpenViking 之类以后只做辅助检索，不做主存。
const DIARY_DAY_START_HOUR = 4;

function diaryDir() {
  return path.join(os.homedir(), '.dsh', 'memore-bridge', 'diaries');
}
function diaryHistoryDir() {
  return path.join(diaryDir(), 'history');
}
function pad2(n) {
  return String(n).padStart(2, '0');
}
function diaryDayKey(d = new Date()) {
  // 日界 04:00：凌晨 0-4 点算前一天（熬夜友好）。
  const shifted = new Date(d.getTime() - DIARY_DAY_START_HOUR * 3600 * 1000);
  return `${shifted.getFullYear()}-${pad2(shifted.getMonth() + 1)}-${pad2(shifted.getDate())}`;
}
function diaryWindow(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const start = new Date(y, m - 1, d, DIARY_DAY_START_HOUR, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, end };
}
function diaryPath(dateKey) {
  return path.join(diaryDir(), `${dateKey}.md`);
}
function parseDiaryText(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  let meta = {};
  try { meta = JSON.parse(m[1]); } catch { meta = {}; }
  return { meta, body: m[2].trim() };
}
function readDiary(dateKey) {
  const p = diaryPath(dateKey);
  try {
    if (!existsSync(p)) return null;
    return { ...parseDiaryText(readFileSync(p, 'utf8')), path: p };
  } catch { return null; }
}

function listDiaryDates() {
  try {
    if (!existsSync(diaryDir())) return [];
    return readdirSync(diaryDir())
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse();
  } catch { return []; }
}
function recentDiaries(beforeDate, n) {
  const out = [];
  for (const d of listDiaryDates()) {
    if (d >= beforeDate) continue;
    const item = readDiary(d);
    if (!item) continue;
    // 2026-11-23：只给索引（日期/标题/一句摘要），不再把正文塞进上下文——
    // 以前给 1200 字正文，模型会把它当素材甚至照抄。
    const entryTexts = (Array.isArray(item.meta?.entries) ? item.meta.entries : [])
      .map((e) => String(e?.text ?? '').trim())
      .filter(Boolean);
    const summary = (entryTexts.slice(0, 3).join(' · ') || String(item.meta?.title ?? '')).slice(0, 80);
    out.push({
      date: d,
      rev: Number(item.meta?.rev ?? 1),
      title: item.meta?.title ?? `${d} · 日记`,
      summary,
      role: 'past_reference',
    });
    if (out.length >= n) break;
  }
  return out;
}
function lastWrittenDate() {
  const ds = listDiaryDates();
  return ds.length ? ds[0] : null;
}
function daysBetweenKeys(fromKey, toKey) {
  const out = [];
  const [y, m, d] = fromKey.split('-').map(Number);
  const cur = new Date(y, m - 1, d);
  const end = new Date(...toKey.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  cur.setDate(cur.getDate() + 1);
  while (cur < end) {
    out.push(`${cur.getFullYear()}-${pad2(cur.getMonth() + 1)}-${pad2(cur.getDate())}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}
/**
 * 正文的日期 lint（2026-11-22）：硬约束原来只在 entries 上，正文可以把旧事写成今天。
 * 扫显式日期：只允许「当天」和 entries.memory 的 original_date；相对时间词（去年/上个月…）一律拒。
 */
function lintBodyDates(body, dateKey, entries) {
  const allowed = new Set([dateKey]);
  (Array.isArray(entries) ? entries : []).forEach((e) => {
    if (e && e.kind === 'memory' && /^\d{4}-\d{2}-\d{2}$/.test(String(e.original_date ?? ''))) {
      allowed.add(String(e.original_date));
    }
  });
  const allowedMonthDay = new Set([...allowed].map((d) => d.slice(5)));
  const found = [];
  const reFull = /(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/g;
  let m;
  while ((m = reFull.exec(body)) !== null) {
    const key = `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
    if (!allowed.has(key)) found.push(key);
  }
  const reMonthDay = /(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  while ((m = reMonthDay.exec(body)) !== null) {
    const key = `${pad2(Number(m[1]))}-${pad2(Number(m[2]))}`;
    if (!allowedMonthDay.has(key)) found.push(`${m[1]}月${m[2]}日`);
  }
  const rel = body.match(/(去年|前年|上上个月|上个月|上月|明年|后年)/g);
  if (rel) found.push(...rel);
  if (found.length) {
    return `正文里出现了窗口外的日期：${[...new Set(found)].join('、')}`
      + `（当天只允许 ${dateKey}${allowed.size > 1 ? ' 或 memory 的原日期 ' + [...allowed].filter((d) => d !== dateKey).join('、') : ''}；`
      + '旧事请写进 entries 的 kind=memory，不要在正文里当今天）';
  }
  return null;
}
async function importDiaryFromRecord(dateKey, recordId) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const prefixes = [`${y}年${m}月${d}日`, `${y}年${pad2(m)}月${pad2(d)}日`, dateKey];
  let rec = null;
  if (recordId) {
    const detail = JSON.parse(await get('/records/' + encodeURIComponent(recordId), 15000));
    rec = detail?.record ?? null;
  } else {
    const list = JSON.parse(await get('/records?limit=500', 20000));
    const rows = Array.isArray(list?.results) ? list.results : [];
    for (const row of rows) {
      const head = String(row.content ?? '').slice(0, 40);
      if (!prefixes.some((p) => head.startsWith(p))) continue;
      const detail = JSON.parse(await get('/records/' + encodeURIComponent(row.id), 15000));
      const r = detail?.record ?? null;
      if (r?.type === 'AI_NOTE') { rec = r; break; }
    }
  }
  if (!rec) return { ok: false, error: `没有找到 ${dateKey} 的 AI 札记` };
  if (rec.type !== 'AI_NOTE') return { ok: false, error: `记录 ${rec.id} 不是 AI 札记（${rec.type}）` };
  let body = String(rec.content ?? '').trim();
  for (const p of prefixes) {
    if (body.startsWith(p)) {
      body = body.slice(p.length).replace(/^[\s·:：\-—]+/, '').trim();
      break;
    }
  }
  if (!body) return { ok: false, error: '这条 AI 札记没有正文' };
  mkdirSync(diaryDir(), { recursive: true });
  const meta = {
    date: dateKey,
    rev: 1,
    title: `${dateKey} · 日记`,
    saved_at: new Date().toISOString(),
    source: 'record-mirror',
    record_id: rec.id,
    entries: [],
  };
  writeFileSync(diaryPath(dateKey), `---\n${JSON.stringify(meta)}\n---\n\n${body}\n`, 'utf8');
  return { ok: true, date: dateKey, rev: 1, path: diaryPath(dateKey), record_id: rec.id, body_length: body.length };
}


function diaryExportsDir() {
  return path.join(os.homedir(), '.dsh', 'memore-bridge', 'exports');
}
function exportDiariesFile(fromKey, toKey) {
  const days = [];
  for (const d of listDiaryDates()) {
    if (fromKey && d < fromKey) continue;
    if (toKey && d > toKey) continue;
    const item = readDiary(d);
    if (!item) continue;
    days.push({ date: d, meta: item.meta ?? {}, body: item.body });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  mkdirSync(diaryExportsDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(diaryExportsDir(), `diaries-${stamp}.json`);
  writeFileSync(file, JSON.stringify({
    format: 'memore-diary-export',
    version: 1,
    exported_at: new Date().toISOString(),
    count: days.length,
    days,
  }, null, 2), 'utf8');
  return { file, count: days.length };
}
function restoreDiariesFile(file, overwrite) {
  const target = path.isAbsolute(file) ? file : path.join(diaryExportsDir(), file);
  const data = JSON.parse(readFileSync(target, 'utf8'));
  if (data?.format !== 'memore-diary-export') throw new Error('不是 memore 日记导出文件');
  const days = Array.isArray(data.days) ? data.days : [];
  mkdirSync(diaryDir(), { recursive: true });
  let imported = 0;
  let skipped = 0;
  const errors = [];
  for (const item of days) {
    const date = String(item?.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(`坏日期：${date}`); continue; }
    if (!overwrite && readDiary(date)) { skipped++; continue; }
    try {
      const body = String(item.body ?? '').trim();
      if (!body) { errors.push(`${date}: 空正文`); continue; }
      const meta = { ...(item.meta ?? {}), date, rev: Number(item.meta?.rev ?? 1) };
      writeFileSync(diaryPath(date), `---\n${JSON.stringify(meta)}\n---\n\n${body}\n`, 'utf8');
      imported++;
    } catch (e) { errors.push(`${date}: ${e?.message ?? e}`); }
  }
  return { ok: true, file: target, imported, skipped, errors };
}

function validateDiaryEntries(entries, dateKey) {
  if (!Array.isArray(entries)) return 'entries 必须是数组';
  if (entries.length > 30) return 'entries 最多 30 条（日记不是对话转储）';
  const { start, end } = diaryWindow(dateKey);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] || {};
    const where = `entries[${i}]`;
    if (!['event', 'reflection', 'memory'].includes(e.kind)) {
      return `${where}.kind 只能是 event / reflection / memory`;
    }
    const text = String(e.text ?? '').trim();
    if (!text) return `${where}.text 不能为空`;
    if (text.length > 240) return `${where}.text 太长（≤240 字）`;
    if (e.kind === 'event') {
      if (!/^\d{2}:\d{2}$/.test(String(e.time ?? ''))) return `${where}（event）必须带 HH:mm`;
      const [hh, mm] = String(e.time).split(':').map(Number);
      if (hh > 23 || mm > 59) return `${where}.time 非法`;
      const at = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hh, mm);
      if (at < start || at >= end) return `${where}.time 不在当天窗口内（04:00→次日04:00）`;
      if (e.source === 'record') {
        if (!e.record_id) return `${where}（event/record）必须带 record_id`;
      } else if (e.source === 'conversation') {
        if (!String(e.quote ?? '').trim()) return `${where}（event/conversation）必须带 quote（对话原话）`;
      }
    }
    if (e.kind === 'memory') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.original_date ?? ''))) {
        return `${where}（memory）必须带 original_date（YYYY-MM-DD）——旧事不能当成今天`;
      }
    }
  }
  return null;
}
async function mirrorDiaryToApp(dateKey, body) {
  const content = `${dateKey} · 日记\n\n${body}`;
  return post('/actions', {
    action_id: 'diary-' + dateKey.replace(/-/g, '') + '-' + Date.now(),
    title: `写日记：${dateKey}`,
    verbs: [{ verb: 'record.note', payload: { content, type: 'AI_NOTE', origin_id: 'origin_agent_ai' } }],
  }, 20000);
}

function get(pathAndQuery, timeoutMs) {
  return getWithFallback(pathAndQuery, timeoutMs, (body) => body);
}

function post(pathAndQuery, payload, timeoutMs) {
  return requestEach(
    pathAndQuery,
    (base, pq, t, token) => postTo(base, pq, payload, t, token),
    timeoutMs ?? activeConfig?.timeoutMs ?? 30000,
    (body) => body
  );
}

function postTo(base, pathAndQuery, payload, timeoutMs, token) {
  const url = new URL(pathAndQuery, base);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    // 与 getFrom 同一个硬截止：连接阶段不靠 socket timeout。
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(arg);
    };
    const deadline = setTimeout(() => {
      req.destroy();
      finish(reject, new Error('手机没响应（超时）：可能锁屏或后台被杀，打开 App 再试'));
    }, Math.max(500, timeoutMs));
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'X-Memore-Token': token,
          'X-Memore-Client': clientName(),
          'Content-Type': 'application/json',
          // 必须显式给长度：Node 默认走 chunked，而 Memore 服务端按 Content-Length 读
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.ok === false) return finish(reject, new Error(parsed.error || '命令被拒绝'));
            finish(resolve, data);
          } catch {
            finish(reject, new Error(`返回不是 JSON（HTTP ${res.statusCode}）：${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('手机没响应（超时）')); });
    req.on('error', (e) => finish(reject, humanizeNetworkError(e, base)));
    req.write(body);
    req.end();
  });
}

const output = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      json: { type: 'string', description: '查询结果的 JSON 文本。' },
    },
    required: ['json'],
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.json ?? '') }],
};

const presentCall = () => ({ card: 'generic', title: 'Memore 查询', kind: 'other' });

/** 设置面板读的状态接口（只允许回环访问，防跨站读取）。 */
const BRIDGE_STATUS_PATH = '/api/dsh-memore-bridge/status';
/** 设置面板写端点用的接口。 */
const BRIDGE_ENDPOINTS_PATH = '/api/dsh-memore-bridge/endpoints';
/** 面板的「重连」：清缓存、重新发现、立刻探一次（2026-11-18）。 */
const BRIDGE_RECONNECT_PATH = '/api/dsh-memore-bridge/reconnect';
const BRIDGE_GUIDE_PATH = '/api/dsh-memore-bridge/guide';

/** 读请求体（限 32KB，够放一堆连接串）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeJson(res, code, body) {
  const text = JSON.stringify(body);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

/**
 * 面板请求日志（2026-11-18）：排查“点了没反应”用的。
 * 写到 ~/.dsh/memore-bridge-panel.log，一行一条；出错也不影响请求。
 */
function logPanel(line) {
  try {
    appendFileSync(
      path.join(os.homedir(), '.dsh', 'memore-bridge-panel.log'),
      new Date().toISOString() + ' ' + line + '\n',
      'utf8',
    );
  } catch {
    // 日志失败不影响主流程
  }
}

function isLoopbackRequest(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost';
}

function maskToken(token) {
  const s = String(token || '');
  return s.length <= 4 ? '····' : '····' + s.slice(-4);
}


export function apply(ctx, config = {}) {
  // 设置页里填的值在这里落地；工具调用时从 activeConfig 读，不再每次解析文件。
  activeConfig = config && typeof config === 'object' ? config : {};
  // 启动就先扫一轮：面板第一次打开时不用干等 900ms 的 mDNS。
  refreshDiscovery();
  refreshTailnet();

  // Mirror 桥：注入 system prompt，按 global → workspace → session 覆盖。
  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: 'memore-guide',
        order: 60,
        interpolate: false,
        text: (context) => guideText(context),
      }),
      'memore-bridge: guide section',
    );
  }

  // 设置面板的状态接口（2026-11-18）：页面是 client.js 那块面板，
  // 它读这里拿"连得上吗 / 几个端点 / 多少条记录"，不直接碰配置。
  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: BRIDGE_STATUS_PATH,
        handler: async (req, res) => {
          if (!isLoopbackRequest(req)) {
            writeJson(res, 403, { ok: false, error: 'loopback only' });
            return;
          }
          if ((req.method ?? 'GET') !== 'GET') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          let endpoints = [];
          let configError = null;
          try {
            endpoints = resolveEndpoints().map((e) => ({ base: e.base, token: maskToken(e.token) }));
          } catch (e) {
            configError = String(e?.message ?? e);
          }
          const stored = Array.isArray(readConfigFileRaw().endpoints) ? readConfigFileRaw().endpoints : [];
          let health = null;
          let reachError = null;
          if (endpoints.length > 0) {
            try {
              // 面板探测用短超时：列表里可能有好几条不可达地址，按 15s 一条会把页面卡死。
              health = JSON.parse(await get('/health', 1500));
              lastHealthCache = health;
            } catch (e) {
              reachError = String(e?.message ?? e);
            }
          }
          const required = String(health?.client?.min_version ?? '').trim();
          const versionWarning = required && !versionAtLeast(PLUGIN_VERSION, required)
            ? `手机端要求客户端 ≥ ${required}，当前 ${PLUGIN_VERSION}：请升级 memore-bridge 插件`
            : '';
          writeJson(res, 200, {
            ok: true,
            value: {
              endpoints,
              stored,
              versionWarning,
              // 面板只需要两件事：现在用的是哪个地址、连没连上。
              current: endpoints.length > 0 ? endpoints[0] : null,
              health,
              configError,
              reachError,
              lastGoodBase,
            },
          });
        },
      }),
      'memore-bridge: status bridge',
    );

    // 端点增删（2026-11-18）：面板直接改配置，不用手编 JSON。
    // body: { action: 'add'|'remove'|'replace', value?: string, list?: string[] }
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: BRIDGE_ENDPOINTS_PATH,
        handler: async (req, res) => {
          logPanel('POST /endpoints from=' + (req.socket?.remoteAddress || '?'));
          if (!isLoopbackRequest(req)) {
            logPanel('POST /endpoints REJECT non-loopback');
            writeJson(res, 403, { ok: false, error: 'loopback only' });
            return;
          }
          if ((req.method ?? '') !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          let body;
          try {
            body = JSON.parse(await readBody(req) || '{}');
          } catch {
            writeJson(res, 400, { ok: false, error: 'body 不是 JSON' });
            return;
          }
          const current = Array.isArray(readConfigFileRaw().endpoints) ? readConfigFileRaw().endpoints : [];
          const value = String(body.value ?? '').trim();
          const action = String(body.action ?? '');
          logPanel('  action=' + action + ' index=' + String(body.index ?? '-') + ' value=' + (value ? value.slice(0, 6) + '…' : '(空)') + ' 现有=' + current.length);
          let next = current;
          if (action === 'set') {
            // 面板的主操作：换掉当前连接串。
            // 令牌单独留一份（2026-11-18）：自动发现只找地址，凭据必须还在文件里，
            // 否则清掉地址后就没法靠 Tailscale 自动重连了。
            if (!isUsableEndpointString(value)) {
              writeJson(res, 400, { ok: false, error: '这条连接串不能用：要带令牌，形如 memore://IP:端口?token=…' });
              return;
            }
            next = [value];
            const raw = readConfigFileRaw();
            delete raw.base;
            raw.token = parseEndpointString(value)?.token || raw.token;
            writeFileSync(configPath(), JSON.stringify({ ...raw, endpoints: next }, null, 2) + '\n', 'utf8');
            lastGoodBase = '';
            writeJson(res, 200, { ok: true, value: { stored: next } });
            return;
          }
          if (action === 'clear') {
            // 清地址但保留令牌：用户清空后仍能靠自动发现重连（凭据不是地址信息）。
            next = [];
            const raw = readConfigFileRaw();
            delete raw.base;
            writeFileSync(configPath(), JSON.stringify({ ...raw, endpoints: next }, null, 2) + '\n', 'utf8');
            lastGoodBase = '';
            writeJson(res, 200, { ok: true, value: { stored: next } });
            return;
          }
          if (action === 'add') {
            if (!isUsableEndpointString(value)) {
              writeJson(res, 400, { ok: false, error: '这条连接串不能用：要带令牌，形如 memore://IP:端口?token=…' });
              return;
            }
            if (!current.includes(value)) next = [...current, value];
          } else if (action === 'update') {
            // 逐条更换：index 指向列表里的那一条，整条换成本次输入
            const index = Number(body.index);
            if (!Number.isInteger(index) || index < 0 || index >= current.length) {
              writeJson(res, 400, { ok: false, error: '要换的那一条不存在了，刷新再试' });
              return;
            }
            if (!isUsableEndpointString(value)) {
              writeJson(res, 400, { ok: false, error: '这条连接串不能用：要带令牌，形如 memore://IP:端口?token=…' });
              return;
            }
            next = current.slice();
            next[index] = value;
          } else if (action === 'remove') {
            next = current.filter((x) => x !== value);
          } else if (action === 'replace') {
            const list = Array.isArray(body.list) ? body.list.map((x) => String(x).trim()).filter(Boolean) : [];
            for (const item of list) {
              if (!isUsableEndpointString(item)) {
                writeJson(res, 400, { ok: false, error: '列表里有不能用的连接串（缺令牌）：' + item });
                return;
              }
            }
            next = list;
          } else {
            writeJson(res, 400, { ok: false, error: 'action 只能是 set / clear / add / remove / replace' });
            return;
          }
          writeEndpointsToFile(next);
          lastGoodBase = '';
          logPanel('  完成 stored=' + next.length);
          writeJson(res, 200, { ok: true, value: { stored: next } });
        },
      }),
      'memore-bridge: endpoints bridge',
    );

    // 「重连」（2026-11-18）：面板上的一个动作——清掉记忆的地址、重新发现、立刻探一次。
    // 注意它不是"编辑地址"：地址是发现出来的，用户能改的只有配置。换网络、手机重启之后按它。
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: BRIDGE_RECONNECT_PATH,
        handler: async (req, res) => {
          if (!isLoopbackRequest(req)) {
            writeJson(res, 403, { ok: false, error: 'loopback only' });
            return;
          }
          if ((req.method ?? '') !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          logPanel('POST /reconnect：清缓存重扫');
          lastGoodBase = '';
          discoveredBases = [];
          tailnetBases = [];
          discoveryAt = 0;
          tailnetAt = 0;
          try {
            const [mdns, tailnet] = await Promise.all([
              discoverMemore(1200).catch(() => []),
              discoverTailnetPeers(2000).catch(() => []),
            ]);
            discoveredBases = mdns.map((d) => d.base);
            tailnetBases = tailnet.map((p) => `http://${p.ip}:${AgentPort}`);
          } catch {
            // 两条都失败也算一次重连，下面的探测会给出原因
          }
          discoveryAt = Date.now();
          tailnetAt = Date.now();
          let health = null;
          let reachError = null;
          try {
            health = JSON.parse(await get('/health', 4000));
          } catch (e) {
            reachError = String(e?.message ?? e);
          }
          logPanel('  重连结果 health=' + Boolean(health?.ok) + ' base=' + lastGoodBase + ' err=' + (reachError ?? '-'));
          writeJson(res, 200, {
            ok: true,
            value: {
              health,
              reachError,
              lastGoodBase,
              found: { mdns: discoveredBases.length, tailnet: tailnetBases.length },
            },
          });
        },
      }),
      'memore-bridge: reconnect',
    );

  // 审边台（2026-11-20）：把待批动作的证据摊开给人判。
  // 独立运行版在 tools/review-ui/server.mjs；这里注册进 DSH 面板，URL 同 /api/dsh-memore-bridge/review。
  // Mirror 桥面板（2026-11-20）：读状态 / 改全局覆盖 / 启停。
  scope.effect(
    () => scope.webServer.register({
      kind: 'exact',
      path: BRIDGE_GUIDE_PATH,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'loopback only' });
          return;
        }
        if ((req.method ?? 'GET') === 'GET') {
          const store = readGuideStore();
          let q = {};
          try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams.entries()); } catch { q = {}; }
          const eff = resolveGuide(lastPromptContext, { sid: q.session || '', cwd: q.cwd || '' });
          writeJson(res, 200, {
            ok: true,
            value: {
              enabled: store.enabled !== false,
              mode: store.mode || 'global',
              source: eff.source,
              effective: eff.text,
              auto: autoGuideText(),
              global: store.global,
              workspaces: store.workspaces || {},
              sessions: store.sessions || {},
              session: (() => {
                const entry = sessionEntry(store, q.session);
                if (entry === undefined) return { mode: 'global', text: '' };
                return { mode: entry.enabled === false ? 'off' : 'session', text: entry.text || '' };
              })(),
              workspace_count: Object.keys(store.workspaces || {}).length,
              session_count: Object.keys(store.sessions || {}).length,
            },
          });
          return;
        }
        if ((req.method ?? '') !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        let body;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          writeJson(res, 400, { ok: false, error: 'body 不是 JSON' });
          return;
        }
        const store = readGuideStore();
        if (typeof body.enabled === 'boolean') store.enabled = body.enabled;
        if (body.mode === 'global' || body.mode === 'workspace' || body.mode === 'session') store.mode = body.mode;
        if (typeof body.global === 'string') store.global = body.global;
        if (typeof body.clearWorkspace === 'string' && body.clearWorkspace) delete store.workspaces[body.clearWorkspace];
        if (typeof body.clearSession === 'string' && body.clearSession) delete store.sessions[body.clearSession];
        if (typeof body.sessionId === 'string' && body.sessionId) {
          if (body.sessionMode === 'global') {
            delete store.sessions[body.sessionId];
          } else if (body.sessionMode === 'off') {
            store.sessions[body.sessionId] = { enabled: false, text: '' };
          } else if (body.sessionMode === 'session') {
            store.sessions[body.sessionId] = { enabled: true, text: typeof body.sessionText === 'string' ? body.sessionText : '' };
          } else if (typeof body.sessionText === 'string') {
            if (body.sessionText) store.sessions[body.sessionId] = { enabled: true, text: body.sessionText };
            else delete store.sessions[body.sessionId];
          }
        }
        if (typeof body.cwd === 'string' && body.cwd) {
          if (typeof body.workspaceText === 'string') {
            if (body.workspaceText) store.workspaces[body.cwd] = body.workspaceText;
            else delete store.workspaces[body.cwd];
          }
        }
        writeGuideStore(store);
        logPanel('guide save enabled=' + store.enabled + ' global_len=' + String(store.global || '').length);
        writeJson(res, 200, { ok: true });
      },
    }),
    'memore-bridge: guide api',
  );

  try {
    registerReview({ scope, get, post, writeJson, isLoopbackRequest, logPanel });
  } catch (e) {
    logPanel('review register failed: ' + (e?.message ?? e));
  }

  });

  // 心跳（2026-11-18）：DSH 开着的时候每 20 秒打一次 /health。
  // 目的不是保活（HTTP 本来就不用保活），而是让手机知道「这台电脑还在」——
  // 否则手机只能在收到请求的那一刻才亮「已连接」，用户看到的就是「没连上」。
  // 顺带把发现缓存和 lastGoodBase 保持新鲜，换网络后半分钟内自动跟上。
  ctx.effect(() => {
    let alive = true;
    const beat = async () => {
      if (!alive) return;
      try {
        lastHealthCache = JSON.parse(await get('/health', 4000));
      } catch {
        // 手机没开 / 换网络：下一拍再试，不打扰用户
      }
    };
    const timer = setInterval(beat, 20000);
    if (typeof timer.unref === 'function') timer.unref();
    beat();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, 'memore-bridge: heartbeat');

  // 技能：教 agent 怎么查 Mirror（2026-11-13）。
  // 这是"让它按设想工作"的位置——不需要改 DSH 内核，一页说明就够。
  const SKILL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'SKILL.md');
  const SKILL_DESC = '查 Memore（Mirror）记忆库的流程：先看目录再检索、引用要带时间、AI 分析不等于用户原话。'
  ctx.skills.registerProvider(() => ({
    name: 'memore-bridge',
    list: () => Promise.resolve([{
      name: 'memore-research',
      description: SKILL_DESC,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'memore-bridge',
      source: 'runtime',
      rank: 0,
      locator: SKILL_PATH,
    }]),
    async get() {
      let content = ''
      try {
        content = readFileSync(SKILL_PATH, 'utf8')
      } catch (e) {
        content = '（SKILL.md 读不到：' + (e?.message ?? e) + '）'
      }
      return {
        name: 'memore-research',
        description: SKILL_DESC,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'memore-bridge',
        source: 'runtime',
        content,
      }
    },
  }))


  ctx.tools.register({
    name: 'memore_search',
    description:
      '在 Memore 的记忆库里检索记录（手机上的实时数据，不是副本）。'
      + '库里是用户从 2025 年至今写的中文随笔、对话录、增修。'
      + '当用户问「我以前写过什么关于 X 的」「找找我关于 X 的记录」时用它。'
      + '返回 id、创建时间戳、来源 id、正文、备注。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '要找的词或短语，中文。' },
        k: { type: 'number', description: '返回几条，默认 8，最多 50。' },
      },
      required: ['query'],
    },
    output,
    presentCall,
    async execute(args) {
      const k = Math.min(Math.max(Number(args.k) || 8, 1), 50);
      const q = encodeURIComponent(String(args.query ?? ''));
      return { json: await get(`/records?q=${q}&k=${k}`) };
    },
  });

  ctx.tools.register({
    name: 'memore_recent',
    description:
      '取 Memore 最近的记录（手机上的实时数据），按时间倒序。'
      + '当用户问「我最近在写什么」「最近状态怎么样」时用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: { type: 'number', description: '天数，默认 7；0 表示不限。' },
        k: { type: 'number', description: '最多几条，默认 10，最多 50。' },
      },
    },
    output,
    presentCall,
    async execute(args) {
      const days = Math.min(Math.max(Number(args.days) || 0, 0), 3650);
      const k = Math.min(Math.max(Number(args.k) || 10, 1), 50);
      // 手机端按 created_at 倒序、支持 since（毫秒）。天数换算成 since。
      const since = days > 0 ? Date.now() - days * 86400000 : 0;
      return { json: await get(`/records?since=${since}&k=${k}`) };
    },
  });

  ctx.tools.register({
    name: 'memore_get',
    description: '按 id 取 Memore 里一条完整记录（含标签、协议）。id 来自 memore_search / memore_recent。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记录 id（UUID）。' },
      },
      required: ['id'],
    },
    output,
    presentCall,
    async execute(args) {
      return { json: await get(`/records/${encodeURIComponent(String(args.id ?? ''))}`) };
    },
  });

  ctx.tools.register({
    name: 'memore_neighbors',
    description:
      '取一条记录的邻居：已建立的关联边（relations，强关系）、增修链（amendments）、'
      + '共享标签的其它记录（shared_tags，弱关系）。'
      + '当用户问「和这条有关的还有什么」「这条后来补过吗」时用它——'
      + '结果比重新做一次语义检索稳定，因为关系是已经确认过的。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记录 id（UUID）。' },
      },
      required: ['id'],
    },
    output,
    presentCall,
    async execute(args) {
      return { json: await get(`/records/${encodeURIComponent(String(args.id ?? ''))}/neighbors`) };
    },
  });


  ctx.tools.register({
    name: 'memore_diary_today',
    description:
      '看今天（或指定日期）的日记窗口：当前时间、时区、04:00→次日04:00 的边界、当天是否已写及 rev。'
      + '写日记前先用它。日记素材只来自本次对话；往期日记（recent）只是索引，用来承接，不得照抄或续写；不要从 memore 记录取日记素材。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', description: '可选：YYYY-MM-DD；省略 = 按 04:00 日界算的今天。' },
        recent: { type: 'number', description: '可选：带回前几篇日记（0~5，默认 3）。' },
      },
      required: [],
    },
    output,
    presentCall,
    async execute(args) {
      const date = String(args.date ?? '').trim() || diaryDayKey();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { json: JSON.stringify({ ok: false, error: 'date 必须是 YYYY-MM-DD' }) };
      const { start, end } = diaryWindow(date);
      const existing = readDiary(date);
      const n = Math.max(0, Math.min(5, Number(args.recent ?? 3) || 0));
      const recent = recentDiaries(date, n);
      const last = lastWrittenDate();
      return {
        json: JSON.stringify({
          ok: true,
          date,
          now: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          window: { start: start.toISOString(), end: end.toISOString(), rule: '04:00 → 次日 04:00' },
          exists: !!existing,
          rev: existing ? Number(existing.meta?.rev ?? 1) : 0,
          path: diaryPath(date),
          last_written: last,
          unwritten_days: last ? daysBetweenKeys(last, date) : [],
          recent,
          recent_role: 'past_reference_only',
          recent_note: '往期日记只作承接索引，不属于当前窗口；不得照抄原句或续写。日记素材只来自本次对话，不要从 memore 记录取。',
          note: '日记是给你自己（明天的你）看的：正文只写本次对话里今天窗口内真正发生的事；旧事用 kind=memory 并带 original_date。',
        }),
      };
    },
  });

  ctx.tools.register({
    name: 'memore_diary_save',
    description:
      '写今天的日记（覆盖式，rev+1），并默认镜像一条 AI 札记到手机。'
      + 'entries 是结构化证据：kind=event 要带 HH:mm 且落在当天窗口；kind=memory 要带 original_date；reflection 自由。'
      + '正文写给"明天的自己"：第一人称、简短、不评判不诊断、不罗列。同一天重写会覆盖并把旧版存进 history。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD；省略 = 今天。' },
        title: { type: 'string', description: '可选标题（省略用日期）。' },
        body: { type: 'string', description: '日记正文（≤5000 字）。' },
        entries: {
          type: 'array',
          description: '结构化条目（0~30）。',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              kind: { type: 'string', enum: ['event', 'reflection', 'memory'] },
              time: { type: 'string', description: 'event 必填：HH:mm' },
              text: { type: 'string', description: '这条讲什么（≤240 字）' },
              source: { type: 'string', enum: ['conversation', 'record'] },
              quote: { type: 'string', description: 'source=conversation 时的对话原话' },
              record_id: { type: 'string', description: 'source=record 时的记录 id' },
              original_date: { type: 'string', description: 'memory 必填：这件事原本发生的日期' },
            },
            required: ['kind', 'text'],
          },
        },
        mirror: { type: 'boolean', description: '是否镜像一条 AI 札记到手机（默认 true）。' },
      },
      required: ['body'],
    },
    output,
    presentCall,
    async execute(args) {
      const date = String(args.date ?? '').trim() || diaryDayKey();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { json: JSON.stringify({ ok: false, error: 'date 必须是 YYYY-MM-DD' }) };
      const body = String(args.body ?? '').trim();
      if (!body) return { json: JSON.stringify({ ok: false, error: 'body 不能为空' }) };
      if (body.length > 5000) return { json: JSON.stringify({ ok: false, error: 'body 太长（≤5000 字）' }) };
      const entries = Array.isArray(args.entries) ? args.entries : [];
      const err = validateDiaryEntries(entries, date);
      if (err) return { json: JSON.stringify({ ok: false, error: err }) };
      const bodyErr = lintBodyDates(body, date, entries);
      if (bodyErr) return { json: JSON.stringify({ ok: false, error: bodyErr }) };

      const prev = readDiary(date);
      const rev = prev ? Number(prev.meta?.rev ?? 1) + 1 : 1;
      try {
        mkdirSync(diaryDir(), { recursive: true });
        if (prev) {
          mkdirSync(diaryHistoryDir(), { recursive: true });
          writeFileSync(path.join(diaryHistoryDir(), `${date}.r${prev.meta?.rev ?? 1}.md`), readFileSync(prev.path, 'utf8'));
        }
        const meta = {
          date,
          rev,
          title: String(args.title ?? '').trim() || `${date} · 日记`,
          saved_at: new Date().toISOString(),
          window: (() => { const w = diaryWindow(date); return { start: w.start.toISOString(), end: w.end.toISOString(), rule: '04:00 → 次日 04:00' }; })(),
          model: activeConfig?.model ?? null,
          entries,
        };
        writeFileSync(diaryPath(date), `---\n${JSON.stringify(meta)}\n---\n\n${body}\n`, 'utf8');
        let mirror = null;
        if (args.mirror !== false) {
          mirror = await mirrorDiaryToApp(date, body).then((r) => ({ ok: true, status: r?.status ?? 'unknown' })).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
        }
        return { json: JSON.stringify({ ok: true, date, rev, path: diaryPath(date), mirror, recent_after: recentDiaries(date, 2) }) };
      } catch (e) {
        return { json: JSON.stringify({ ok: false, error: e?.message ?? String(e) }) };
      }
    },
  });

  ctx.tools.register({
    name: 'memore_diary_export',
    description:
      '把日记导出成一个 JSON 文件（默认 ~/.dsh/memore-bridge/exports/），用于备份/迁移。'
      + '包含每天正文 + meta（rev/entries/来源）。这是正本的备份，不是镜像。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: '可选：起始日期 YYYY-MM-DD（含）。' },
        to: { type: 'string', description: '可选：结束日期 YYYY-MM-DD（含）。' },
      },
      required: [],
    },
    output,
    presentCall,
    async execute(args) {
      try {
        const r = exportDiariesFile(String(args.from ?? '').trim(), String(args.to ?? '').trim());
        return { json: JSON.stringify({ ok: true, ...r }) };
      } catch (e) {
        return { json: JSON.stringify({ ok: false, error: e?.message ?? String(e) }) };
      }
    },
  });

  ctx.tools.register({
    name: 'memore_diary_import',
    description:
      '导入日记：给 file 就从 memore 导出文件整批恢复（默认不覆盖已有）；给 date 就从手机上的 AI 札记导入单天。'
      + '单天导入只认标题以日期开头的 AI 札记，meta.source=record-mirror、rev=1。文件才是正本。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', description: '导入哪一天（YYYY-MM-DD）；给 file 时可省略。' },
        record_id: { type: 'string', description: '可选：直接指定 AI 札记 id；省略就按日期标题去找。' },
        file: { type: 'string', description: '可选：导出文件路径（绝对路径，或 exports 目录下的文件名）。' },
        overwrite: { type: 'boolean', description: 'file 导入时是否覆盖已有日记（默认 false）。' },
      },
      required: [],
    },
    output,
    presentCall,
    async execute(args) {
      const file = String(args.file ?? '').trim();
      if (file) {
        try {
          const r = restoreDiariesFile(file, args.overwrite === true);
          return { json: JSON.stringify(r) };
        } catch (e) {
          return { json: JSON.stringify({ ok: false, error: e?.message ?? String(e) }) };
        }
      }
      const date = String(args.date ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { json: JSON.stringify({ ok: false, error: '需要 date（YYYY-MM-DD）或 file' }) };
      if (readDiary(date)) return { json: JSON.stringify({ ok: false, error: `本地已经有 ${date} 的日记，先别导入（要覆盖请用 save）` }) };
      try {
        const r = await importDiaryFromRecord(date, String(args.record_id ?? '').trim() || null);
        return { json: JSON.stringify(r) };
      } catch (e) {
        return { json: JSON.stringify({ ok: false, error: e?.message ?? String(e) }) };
      }
    },
  });

  ctx.tools.register({
    name: 'memore_diary_read',
    description: '读某一天的日记（正文 + 元信息 + rev）。只在明确需要对照原文时用；读到的正文只作对照，不得照抄或续写。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD；省略 = 今天。' },
      },
      required: [],
    },
    output,
    presentCall,
    async execute(args) {
      const date = String(args.date ?? '').trim() || diaryDayKey();
      const d = readDiary(date);
      if (!d) return { json: JSON.stringify({ ok: false, error: `这一天还没有日记：${date}` }) };
      return { json: JSON.stringify({ ok: true, date, meta: d.meta, body: d.body, path: d.path }) };
    },
  });

  ctx.tools.register({
    name: 'memore_act',
    description:
      '向 Memore 提一个**动作**（一次动作 = 一组改动，最多 20 步）。'
      + '动作默认进队列等用户批准（返回 status: proposed），批准后才写库；'
      + '用户切到"自动"模式时立即执行。'
      + '一步 = {verb, payload}。verb 是**语义动词**：'
      + 'record.note（新建一条，默认 AI 札记）/ record.amend（加增修）/ '
      + 'tag.add（打标签）/ tag.remove（去标签）/ tag.merge（合并两个标签）/ '
      + 'origin.assign（指派来源）/ relation.link（建关联）/ '
      + 'tick.summary（改刻度总结）/ dial.summary（改表盘后记）/ tick.review.clear（删刻度回看）。'
      + '（老写法 {kind, payload} 仍可用，但新代码请用 verb。）'
      + '提交时就会校验参数：缺字段直接返回 error，不会进队列。'
      + '提交后要把 status 原样告诉用户——proposed 就是"还没写进去"。'
      + '撤回用 memore_undo，查状态用 memore_act_status。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: '一句话说清这个动作要做什么，会原样显示给用户（例如「把 5 条归到戒断」）。',
        },
        verbs: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              verb: {
                type: 'string',
                enum: ['record.note', 'record.amend', 'record.trash', 'record.restore', 'record.lock', 'record.unlock', 'tag.add', 'tag.remove', 'tag.merge', 'origin.assign', 'relation.link', 'relation.unlink', 'relation.reject', 'relation.retype', 'relation.restore', 'draft.create', 'draft.append', 'ai.analyze', 'tag.rename', 'protocol.merge', 'zone.rename', 'zone.delete', 'zone.create', 'zone.addMember', 'zone.removeMember', 'tick.summary', 'dial.summary', 'tick.review.clear'],
              },
              payload: {
                type: 'object',
                additionalProperties: true,
                description:
                  'record.note: {content, type?, origin_id?, tags?[]}；'
                  + 'record.amend: {parent_id, content}；'
                  + 'tag.add / tag.remove: {record_ids[], tags[]}；record.trash / record.restore: {record_ids[]}；record.lock / record.unlock: {record_ids[], password}；relation.unlink: {from_id, to_id}；zone.addMember / zone.removeMember: {record_ids[], zone_id}；zone.create: {name}；'
                  + 'tag.merge: {from_name, to_name}；'
                  + 'tick.summary: {id, summary}；dial.summary: {id, summary}（表盘后记）；tick.review.clear: {id}（删回看）；'
                  + 'origin.assign: {record_ids[], origin_id}；'
                  + 'relation.link: {from_id, to_id, why?, quote_a, quote_b}；'
                  + 'relation.reject / relation.restore: {from_id,to_id}；relation.retype: {from_id,to_id,type}；'
                  + 'draft.create: {name?}；draft.append: {draft_id, content, kind?}；ai.analyze: {record_ids[]}；'
                  + 'tag.rename: {from_name,to_name}；protocol.merge: {from_name,to_name}；zone.rename: {zone_id,name}；zone.delete: {zone_id}',
              },
            },
            required: ['verb', 'payload'],
          },
        },
        requires_confirm: {
          type: 'boolean',
          description: '高危动作（合并标签、进回收站等）设 true：用户要确认两次才执行。',
        },
        wait_s: {
          type: 'number',
          description: '可选：提交后等用户批/拒的秒数（0..25）。0/省略 = 立即返回；'
            + '大于 0 时阻塞到动作有结果或超时，返回值里多一个 final_status。',
        },
      },
      required: ['title', 'verbs'],
    },
    output,
    presentCall,
    async execute(args) {
      const actionId = 'act-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const raw = await post('/actions', {
        action_id: actionId,
        title: String(args.title ?? ''),
        actor: 'dsh-memore-bridge',
        requires_confirm: Boolean(args.requires_confirm),
        verbs: Array.isArray(args.verbs) ? args.verbs : [],
      });
      const waitS = Math.min(Math.max(Number(args.wait_s) || 0, 0), 25);
      if (waitS <= 0) return { json: raw };
      // 等待用户决定（2026-11-20）：每秒查一次动作状态，超时返回最后状态。
      const deadline = Date.now() + waitS * 1000;
      let last = null;
      while (Date.now() < deadline) {
        try {
          last = JSON.parse(await get('/actions/' + encodeURIComponent(actionId), 5000));
          const st = String(last?.status ?? '');
          if (st && st !== 'proposed') break;
        } catch {
          // 网络抖动：继续等
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return { json: JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), final_status: last?.status ?? 'proposed', action: last }) };
    },
  });

  ctx.tools.register({
    name: 'memore_actions',
    description: '列出还在等用户批准的动作（status: proposed）。用来确认"用户批了没有"。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    presentCall,
    async execute() {
      return { json: await get('/actions') };
    },
  });

  // 审边用（2026-11-20）：读边 + 置信度 + 两端正文，agent 据此提 reject/retype。
  ctx.tools.register({
    name: 'memore_relations',
    description:
      '读关联边和置信度（含两端正文摘录、why、双向引文）。审边/回答“这两条凭什么连”时用。'
      + 'min_confidence 从 0..1；置信度只表示“有多少可核对的依据”，不是“这条边成立”。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        min_confidence: { type: 'number', description: '只要这个置信度以上的边，默认 0.5。' },
        limit: { type: 'number', description: '最多几条，默认 20，最多 200。' },
        include_records: { type: 'boolean', description: '是否带两端正文摘录，默认 true。' },
      },
    },
    output,
    presentCall,
    async execute(args) {
      const min = Math.min(Math.max(Number(args.min_confidence ?? 0.5), 0), 1);
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
      const inc = args.include_records === false ? '0' : '1';
      return { json: await get(`/relations?min_confidence=${min}&limit=${limit}&include_records=${inc}&content_chars=300`, 20000) };
    },
  });

  // 等人批（2026-11-20）：提议动作后可以挂住等用户批/拒，不用盲轮询。
  ctx.tools.register({
    name: 'memore_wait_pending',
    description:
      '挂住等“待批动作”出现（长轮询）。刚提交动作、需要等用户在手机上批时用；'
      + '有动作就返回 id/title，超时返回空列表。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        since: { type: 'number', description: '只看 created_at 大于这个毫秒值的动作；默认 0 = 任何待批。' },
        wait_s: { type: 'number', description: '最多等几秒，1..25，默认 20。' },
      },
    },
    output,
    presentCall,
    async execute(args) {
      const since = Math.max(Number(args.since) || 0, 0);
      const wait = Math.min(Math.max(Number(args.wait_s) || 20, 1), 25);
      return { json: await get(`/events?since=${since}&wait=${wait}`, (wait + 5) * 1000) };
    },
  });

  // 结构读层（2026-11-20）：agent 先看“这段时期是什么”，再决定翻哪条记录。
  ctx.tools.register({
    name: 'memore_projection',
    description:
      '按刻度分段的结构投影：每段边界、记录数、字数、总结、增修数、锚定数，以及未归段记录。'
      + '回答“我这一年分成哪几段”“这一段有多少东西”时先用它，而不是逐条读记录。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    presentCall,
    async execute() {
      return { json: await get('/projection?summary_chars=300', 25000) };
    },
  });

  ctx.tools.register({
    name: 'memore_anchors',
    description:
      '读锚点：不带 record_id 时按名字聚合（谁反复出现、覆盖几条记录）；带 record_id 时给这条记录的锚点与原句。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        record_id: { type: 'string', description: '可选：只看这条记录的锚点。' },
        limit: { type: 'number', description: '最多几条，默认 50，最多 200。' },
      },
    },
    output,
    presentCall,
    async execute(args) {
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
      const rid = String(args.record_id ?? '').trim();
      const q = rid ? `record_id=${encodeURIComponent(rid)}&limit=${limit}` : `limit=${limit}`;
      return { json: await get(`/anchors?${q}`, 20000) };
    },
  });

  ctx.tools.register({
    name: 'memore_insights',
    description: '读 AI 洞察（claims：结论 + 依据 + 原句 + 日期），最新的在前。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: '最多几条，默认 20，最多 100。' },
      },
    },
    output,
    presentCall,
    async execute(args) {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      return { json: await get(`/insights?limit=${limit}`, 20000) };
    },
  });

  ctx.tools.register({
    name: 'memore_ticks',
    description: '列出刻度与表盘（id、名字、起止、总结/回看是否已有）。改刻度总结、改表盘后记、删回看之前，先用它拿 id。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_dials: { type: 'boolean', description: '是否连表盘一起列，默认 true。' },
      },
    },
    output,
    presentCall,
    async execute(args) {
      const withDials = args.include_dials !== false;
      const ticks = await get('/ticks', 20000);
      const dials = withDials ? await get('/dials', 20000) : null;
      return { json: { ticks, dials } };
    },
  });

  ctx.tools.register({
    name: 'memore_versions',
    description: '一条记录的历次分析（提示词版本、状态、总结、失败原因），最新在前，最多 5 版。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        record_id: { type: 'string', description: '记录 id（memore_search / memore_recent 的返回里）。' },
      },
      required: ['record_id'],
    },
    output,
    presentCall,
    async execute(args) {
      const rid = encodeURIComponent(String(args.record_id ?? '').trim());
      return { json: await get(`/records/${rid}/versions`, 20000) };
    },
  });

  ctx.tools.register({
    name: 'memore_prompts',
    description: '读手机上的提示词（标准/思考两槽）和当前生效的外部规则（system instruction）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    presentCall,
    async execute() {
      return { json: await get('/prompts', 20000) };
    },
  });

  ctx.tools.register({
    name: 'memore_similar',
    description: '找和某条记录语义相近的记录（向量近邻，不经过 AI）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '源记录 id。' },
        k: { type: 'number', description: '返回几条，默认 5，最多 20。' },
      },
      required: ['id'],
    },
    output,
    presentCall,
    async execute(args) {
      const id = encodeURIComponent(String(args.id ?? '').trim());
      const k = Math.min(Math.max(Number(args.k) || 5, 1), 20);
      return { json: await get(`/similar?id=${id}&k=${k}`, 25000) };
    },
  });

  ctx.tools.register({
    name: 'memore_guide',
    description: '读启动提示词：自动生成的工具/档位说明，加上 global / workspace / session 三档覆盖。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    presentCall,
    async execute() {
      const store = readGuideStore();
      const eff = resolveGuide(lastPromptContext);
      return {
        json: JSON.stringify({
          source: eff.source,
          effective: eff.text,
          auto: autoGuideText(),
          global: store.global,
        }),
      };
    },
  });

  ctx.tools.register({
    name: 'memore_guide_set',
    description:
      '改启动提示词的覆盖文本。scope=global 整个 profile；workspace 当前工作目录；'
      + 'session 只改当前会话。text 传空串 = 清除该档覆盖（回落到自动生成）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['global', 'workspace', 'session'], description: '生效范围。' },
        text: { type: 'string', description: '覆盖文本；空串清除。' },
      },
      required: ['scope', 'text'],
    },
    output,
    presentCall,
    async execute(args) {
      const scope = String(args.scope ?? '');
      const text = String(args.text ?? '');
      const store = readGuideStore();
      if (scope !== 'global' && scope !== 'workspace' && scope !== 'session') {
        throw new Error('scope 只能是 global / workspace / session');
      }
      if (scope === 'session') {
        const sid = guideSessionId(lastPromptContext);
        if (!sid) throw new Error('拿不到当前会话 id：先在当前会话里发一次消息再改');
        if (text) store.sessions[sid] = text; else delete store.sessions[sid];
      } else if (scope === 'workspace') {
        const cwd = guideCwd(lastPromptContext);
        if (!cwd) throw new Error('拿不到当前工作目录：先在当前会话里发一次消息再改');
        if (text) store.workspaces[cwd] = text; else delete store.workspaces[cwd];
      } else {
        store.global = text;
      }
      writeGuideStore(store);
      return { json: JSON.stringify({ ok: true, scope, cleared: !text }) };
    },
  });

  ctx.tools.register({
    name: 'memore_act_status',
    description: '查一个动作的状态：proposed（等你批）/ applied（已执行）/ reverted（已撤回）/ '
      + 'rejected（被拒）/ failed（执行出错，note 里有原因）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '动作 id（memore_act 的返回里那个）。' },
      },
      required: ['id'],
    },
    output,
    presentCall,
    async execute(args) {
      return { json: await get('/actions/' + encodeURIComponent(String(args.id ?? ''))) };
    },
  });

  ctx.tools.register({
    name: 'memore_undo',
    description: '撤回一个已执行的动作：按执行前的快照整批回滚。'
      + '如果这段时间里那些记录又被别的动作改过，会整批拒绝（不会半截回滚）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '动作 id。' },
      },
      required: ['id'],
    },
    output,
    presentCall,
    async execute(args) {
      return { json: await post('/actions/' + encodeURIComponent(String(args.id ?? '')) + '/undo', {}) };
    },
  });

  ctx.tools.register({
    name: 'memore_digest',
    description:
      '取一段压缩上下文：最近 N 天写了多少、最忙的一天、最常出现的情绪、'
      + '最常用的标签与概念、久未触及的标签、最近几条的摘要。'
      + '当需要"先知道这个人最近怎么样"时用它——它比逐条检索省得多。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: { type: 'number', description: '天数，默认 30。' },
      },
    },
    output,
    presentCall,
    async execute(args) {
      const days = Math.min(Math.max(Number(args.days) || 30, 1), 3650);
      return { json: await get(`/digest?days=${days}`) };
    },
  });

  ctx.tools.register({
    name: 'memore_stats',
    description:
      '时间聚合：按天/周/月统计记录条数、平均篇幅、情绪标签频次。'
      + '当用户问「这几个月状态怎么变的」「哪段时间写得最多」时用它。'
      + 'bucket 取 day / week / month。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bucket: { type: 'string', enum: ['day', 'week', 'month'], description: '粒度，默认 week。' },
        from: { type: 'number', description: '起始毫秒时间戳（可选）。' },
        to: { type: 'number', description: '结束毫秒时间戳（可选）。' },
      },
    },
    output,
    presentCall,
    async execute(args) {
      const bucket = ['day', 'week', 'month'].includes(args.bucket) ? args.bucket : 'week';
      const qs = [`bucket=${bucket}`];
      if (Number(args.from)) qs.push(`from=${Number(args.from)}`);
      if (Number(args.to)) qs.push(`to=${Number(args.to)}`);
      return { json: await get(`/stats?${qs.join('&')}`) };
    },
  });

  ctx.tools.register({
    name: 'memore_suggest',
    description:
      '整理候选：哪些记录高度相似（可能重复）、哪些标签名字包含关系（可合并）、'
      + '有多少记录没打标签。当用户想整理但不知道从哪下手时，先调它。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    presentCall,
    async execute() {
      return { json: await get('/suggest') };
    },
  });


  ctx.tools.register({
    name: 'memore_zones',
    description:
      'Mirror 的区域清单（区域是你自己划的「容器」，例如 创作 / 夢 / 锚点）：'
      + '返回每个区域的名字、条数；带 members 时还给出成员记录 id。'
      + '问「有哪些区域」「某个区域里装了什么」时先用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        members: { type: 'boolean', description: '是否返回每个区域的成员记录 id（默认 false）。' },
      },
    },
    output,
    presentCall,
    async execute(args) {
      const qs = args && args.members ? '?members=1' : '';
      return { json: await get('/zones' + qs) };
    },
  });

  ctx.tools.register({
    name: 'memore_zone_records',
    description:
      '某个区域里的记录：按区域名找到成员，再取这些记录的摘要。'
      + '问「创作区里都有什么」「这个区域最近写了什么」时用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        zone: { type: 'string', description: '区域名，例如 创作 / 夢。' },
        limit: { type: 'number', description: '最多返回几条（默认 30，上限 100）。' },
      },
      required: ['zone'],
    },
    output,
    presentCall,
    async execute(args) {
      const name = String(args.zone ?? '').trim();
      if (!name) return { json: { ok: false, error: '缺少 zone' } };
      const all = JSON.parse(await get('/zones?members=1', 15000));
      const zone = (all.zones || []).find((z) => z.name === name);
      if (!zone) return { json: { ok: false, error: '没有这个区域: ' + name, zones: (all.zones || []).map((z) => z.name) } };
      const ids = zone.member_ids || [];
      if (!ids.length) return { json: { ok: true, schema_version: 1, zone: name, total: 0, records: [] } };
      const cap = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
      const chosen = ids.slice(0, cap);
      const res = JSON.parse(await get('/records?ids=' + encodeURIComponent(chosen.join(',')), 20000));
      // /records 的返回体是 { ok, returned, results:[...] }，不是 records
      const list = res.results || res.records || [];
      return { json: { ok: true, schema_version: 1, zone: name, total: ids.length, returned: list.length, records: list } };
    },
  });

  ctx.tools.register({
    name: 'memore_attachments',
    description:
      '列出一条记录的附件（id / 文件名 / 类型 / 大小）。'
      + '要真的看图/听音频，用 memore_attachment_fetch 把内容落成本地文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        record_id: { type: 'string', description: '记录 id。' },
      },
      required: ['record_id'],
    },
    output,
    presentCall,
    async execute(args) {
      const rid = String(args.record_id ?? '').trim();
      if (!rid) return { json: { ok: false, error: '缺少 record_id' } };
      return { json: await get('/attachments?record_id=' + encodeURIComponent(rid), 15000) };
    },
  });

  ctx.tools.register({
    name: 'memore_attachment_fetch',
    description:
      '把手机上的附件内容取到这台电脑上，返回本地文件路径（图片就能直接用看图工具打开）。'
      + '单文件上限 20MB；图片会先压到长边 2048 再传。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number', description: '附件 id（来自 memore_attachments）。' },
      },
      required: ['id'],
    },
    output,
    presentCall,
    async execute(args) {
      const id = Number(args.id) || 0;
      if (!id) return { json: { ok: false, error: '缺少附件 id' } };
      const res = JSON.parse(await get('/attachments/' + id + '/content', 30000));
      if (!res.ok) return { json: res };
      const dir = path.join(os.homedir(), '.dsh', 'attachments');
      try { mkdirSync(dir, { recursive: true }) } catch {}
      const safeName = String(res.file_name || ('attachment-' + id)).replace(/[\/:*?"<>|]/g, '_');
      const dest = path.join(dir, id + '-' + safeName);
      writeFileSync(dest, Buffer.from(String(res.base64 || ''), 'base64'));
      // json 必须是字符串（工具输出约定：get() 返回的是文本）
      return {
        json: JSON.stringify({
          ok: true,
          path: dest,
          bytes: res.bytes,
          type: res.type,
          file_name: res.file_name,
          record_id: res.record_id,
        }),
      };
    },
  });

  ctx.tools.register({
    name: 'memore_health',
    description: '检查 Memore 手机端服务是否在线（端口、运行时长、记录数）。问「agent 连得上吗」时用它。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    presentCall,
    async execute() {
      return { json: await get('/health') };
    },
  });

  ctx.tools.register({
    name: 'memore_facets',
    description:
      'Mirror 的目录：记录总数、时间跨度、每个标签/来源/协议各有多少条。'
      + '不知道库里有哪些词、或要判断某类内容是否存在时，先调它，再决定怎么检索。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    presentCall,
    async execute() {
      return { json: await get('/facets') };
    },
  });


  ctx.logger?.info?.('[memore-bridge] 直连手机模式：memore_search / memore_recent / memore_get / memore_health / memore_facets / memore_zones / memore_zone_records / memore_neighbors / memore_digest / memore_stats / memore_suggest');
}



