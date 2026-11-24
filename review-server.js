'use strict'

/**
 * 审边台（2026-11-20）。
 *
 * 手机「信」里一条动作只显示标题和步数，人看不出「这条边到底该不该留」。
 * 这个页面把 /relations 的证据（why、双向引文、两端正文、置信度）摊开，
 * 人在这里逐条判：保留 / 拒绝 / 改类型，然后一次性提交成动作并执行。
 *
 * 为什么放在插件里：token 和地址只有插件知道；页面是同源静态页 + 两个代理端点，
 * 浏览器不直接接触手机，也不把 token 写进前端。
 */

const PREFIX = '/api/dsh-memore-bridge/review'

export function pageHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Memore 审边台</title>
<style>
:root{--bg:#f7f2e8;--fg:#2b2620;--muted:#6b6357;--line:rgba(43,38,32,.14);--accent:#7c5cd6;--ok:#2f7d6b;--bad:#b2554d}
@media (prefers-color-scheme:dark){:root{--bg:#171614;--fg:#ece6da;--muted:#9a9384;--line:rgba(236,230,218,.14);--accent:#a68cf0;--ok:#6fbfa8;--bad:#e08a80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.7 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 20px;display:flex;gap:12px;align-items:center;z-index:5}
header h1{font-size:15px;margin:0;font-weight:600}
header .sp{flex:1}
input,select,button{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:8px;padding:5px 9px}
button{cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
main{max-width:980px;margin:0 auto;padding:16px 20px 120px}
.card{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 12px}
.row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.tag{font-size:12px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.tag.ok{color:var(--ok);border-color:var(--ok)}
.tag.bad{color:var(--bad);border-color:var(--bad)}
.why{font-weight:600;margin:6px 0 4px}
.quote{font-size:12.5px;color:var(--muted);margin:2px 0}
.snippet{font-size:12.5px;color:var(--muted);margin:4px 0 0;white-space:pre-wrap;max-height:5.5em;overflow:hidden}
.dec{display:flex;gap:8px;align-items:center;margin-top:10px;border-top:1px dashed var(--line);padding-top:9px}
.dec label{display:flex;gap:5px;align-items:center;cursor:pointer}
footer{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:10px 20px;display:flex;gap:12px;align-items:center;justify-content:center}
#msg{color:var(--muted);font-size:12.5px;max-width:70ch}
.hidden{display:none}
</style></head><body>
<header>
  <h1>Memore 审边台</h1>
  <span class="sp"></span>
  <label>置信度 ≥ <input id="min" type="number" step="0.05" min="0" max="1" value="0.5" style="width:5em"/></label>
  <button id="load">读取</button>
</header>
<main id="list"></main>
<footer>
  <span id="count">未加载</span>
  <button id="submit" class="primary" disabled>提交</button>
  <span id="msg"></span>
</footer>
<script>
const DEC = new Map(); // key -> {verb,payload,label}
function key(e){return e.from_id+'|'+e.to_id}
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function label(d){return d? (d.verb==='relation.reject'?'拒绝':('改 '+d.payload.type)) : '保留'}
async function load(){
  const min = document.getElementById('min').value || '0.5'
  const msg = document.getElementById('msg')
  msg.textContent = '读取中…'
  DEC.clear(); updateCount()
  try{
    const r = await fetch('${PREFIX}/relations?min_confidence='+encodeURIComponent(min)+'&limit=200&chars=260')
    const j = await r.json()
    if(!j.ok) throw new Error(j.error||'读取失败')
    render(j.relations||[]); sessionStorage.setItem('lastEdges', JSON.stringify(j.relations||[]))
    msg.textContent = '共 '+ (j.relations||[]).length + ' 条'
  }catch(e){ msg.textContent = '失败：'+e.message }
}
function render(list){
  const box = document.getElementById('list')
  box.innerHTML = list.map((e,i)=>{
    const k = key(e)
    return '<section class="card" data-key="'+k+'">'
      + '<div class="row"><span class="tag">'+(i+1)+'</span>'
      + '<span class="tag">'+esc(e.type)+'</span>'
      + '<span class="tag">'+esc(e.source)+'</span>'
      + '<span class="tag ok">conf '+Number(e.confidence).toFixed(2)+'</span></div>'
      + '<div class="why">'+esc(e.why||'(无理由)')+'</div>'
      + '<div class="quote">引文 A：'+esc(e.quote_a)+'</div>'
      + '<div class="quote">引文 B：'+esc(e.quote_b)+'</div>'
      + '<div class="snippet">A · '+esc(e.from_content)+'</div>'
      + '<div class="snippet">B · '+esc(e.to_content)+'</div>'
      + '<div class="dec">'
      +   '<label><input type="radio" name="d'+i+'" value="keep" checked/>保留</label>'
      +   '<label><input type="radio" name="d'+i+'" value="reject" data-k="'+k+'"/>拒绝</label>'
      +   '<label><input type="radio" name="d'+i+'" value="retype" data-k="'+k+'"/>改类型</label>'
      +   '<select data-k="'+k+'" disabled><option>SUPPLEMENT</option><option>CORRECT</option><option>CITE</option><option>LINK</option></select>'
      + '</div></section>'
  }).join('')
  box.querySelectorAll('input[type=radio]').forEach(r=>{
    r.addEventListener('change',ev=>{
      const card = ev.target.closest('.card'); const k = card.dataset.key
      const sel = card.querySelector('select')
      if(ev.target.value==='reject'){ DEC.set(k,{verb:'relation.reject'}); sel.disabled=true }
      else if(ev.target.value==='retype'){ sel.disabled=false; DEC.set(k,{verb:'relation.retype',payload:{type:sel.value}}) }
      else { DEC.delete(k); sel.disabled=true }
      updateCount()
    })
  })
  box.querySelectorAll('select').forEach(s=>{
    s.addEventListener('change',()=>{
      const k=s.dataset.k
      if(DEC.has(k) && DEC.get(k).verb==='relation.retype'){ DEC.set(k,{verb:'relation.retype',payload:{type:s.value}}); updateCount() }
    })
  })
}
function updateCount(){
  const n = DEC.size
  document.getElementById('count').textContent = n? n+' 条改动' : '没有改动'
  document.getElementById('submit').disabled = n===0
}
async function submit(){
  const edges = JSON.parse(sessionStorage.getItem('lastEdges')||'[]')
  const verbs=[]
  // key -> 从当前列表里找回 from/to
  const byKey = new Map(edges.map(e=>[key(e),e]))
  for (const [k,d] of DEC) {
    const e = byKey.get(k); if(!e) continue
    verbs.push({verb:d.verb, payload:{from_id:e.from_id, to_id:e.to_id, ...(d.payload||{})}})
  }
  if(!verbs.length) return
  document.getElementById('msg').textContent='提交中…'
  try{
    const r = await fetch('${PREFIX}/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({verbs})})
    const j = await r.json()
    if(!j.ok) throw new Error(j.error||'执行失败')
    document.getElementById('msg').textContent = '已提交：'+j.status+'（'+j.details+'）'
    DEC.clear(); updateCount(); await load()
  }catch(e){ document.getElementById('msg').textContent='失败：'+e.message }
}
document.getElementById('load').addEventListener('click',load)
document.getElementById('submit').addEventListener('click',submit)
load()
</script></body></html>`
}

export function registerReview({ scope, get, post, writeJson, isLoopbackRequest, logPanel }) {
  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, error: 'loopback only' })
      return false
    }
    return true
  }

  scope.effect(() => scope.webServer.register({
    kind: 'exact',
    path: PREFIX,
    handler: (req, res) => {
      if (!guard(req, res)) return
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(pageHtml())
    },
  }), 'memore-bridge: review page')

  scope.effect(() => scope.webServer.register({
    kind: 'exact',
    path: PREFIX + '/relations',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      try {
        const u = new URL(req.url, 'http://x')
        const min = u.searchParams.get('min_confidence') || '0.5'
        const limit = u.searchParams.get('limit') || '100'
        const chars = u.searchParams.get('chars') || '260'
        const raw = await get(`/relations?min_confidence=${encodeURIComponent(min)}&limit=${encodeURIComponent(limit)}&include_records=1&content_chars=${encodeURIComponent(chars)}`, 20000)
        const data = JSON.parse(raw)
        writeJson(res, 200, data)
      } catch (e) {
        writeJson(res, 502, { ok: false, error: String(e?.message ?? e) })
      }
    },
  }), 'memore-bridge: review relations')

  scope.effect(() => scope.webServer.register({
    kind: 'exact',
    path: PREFIX + '/apply',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method ?? '') !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = JSON.parse(await (async () => {
          let data = ''
          for await (const chunk of req) data += chunk
          return data || '{}'
        })())
      } catch {
        writeJson(res, 400, { ok: false, error: 'body 不是 JSON' })
        return
      }
      const verbs = Array.isArray(body.verbs) ? body.verbs : []
      if (!verbs.length) { writeJson(res, 400, { ok: false, error: '空动作' }); return }
      if (verbs.length > 20) { writeJson(res, 400, { ok: false, error: '一次最多 20 步' }); return }
      const actionId = (globalThis.crypto?.randomUUID?.() || String(Date.now()) + '-' + Math.random().toString(16).slice(2))
      try {
        logPanel('review apply steps=' + verbs.length)
        // 2026-11-20：批准只能在手机上点，这里只提交待批动作。
        const created = await post('/actions', {
          action_id: actionId,
          title: `审边台：${verbs.length} 条判定`,
          actor: 'review-ui',
          verbs,
        }, 20000)
        const j = JSON.parse(created)
        writeJson(res, 200, {
          ok: j.ok !== false,
          status: j.status || 'proposed',
          details: '已提交，去手机「信」里批准',
          action_id: actionId,
        })
      } catch (e) {
        writeJson(res, 502, { ok: false, error: String(e?.message ?? e) })
      }
    },
  }), 'memore-bridge: review apply')
}

// 函数已在上方 export；这里不再重复导出
