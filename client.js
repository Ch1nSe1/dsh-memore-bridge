window.__ModuleLoader__.load({
  id: 'dsh-memore-bridge',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const { useState, useEffect, useCallback } = react;
    const h = react.createElement;

    const STATUS_PATH = '/api/dsh-memore-bridge/status';
    const ENDPOINTS_PATH = '/api/dsh-memore-bridge/endpoints';
    const RECONNECT_PATH = '/api/dsh-memore-bridge/reconnect';
    const GUIDE_PATH = '/api/dsh-memore-bridge/guide';
    const CONNECTION_SECTION_ID = 'memore-bridge';

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px' },
      card: {
        padding: '14px 16px',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-base)',
        boxShadow: 'var(--dsw-elevation-panel)',
      },
      head: { display: 'flex', alignItems: 'center', gap: '8px' },
      dot: (on) => ({
        width: '7px',
        height: '7px',
        borderRadius: '50%',
        background: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
        flex: 'none',
      }),
      label: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px' },
      muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
      right: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
      list: { listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' },
      item: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'rgba(127,127,127,0.08)',
      },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      btn: {
        padding: '5px 12px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        cursor: 'pointer',
        flex: 'none',
      },
      btnPlain: {
        padding: '0',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '12px',
        cursor: 'pointer',
        flex: 'none',
      },
      btnDanger: {
        padding: '4px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(200,80,80,0.5)',
        background: 'transparent',
        color: 'rgba(200,80,80,1)',
        fontSize: '12px',
        cursor: 'pointer',
        flex: 'none',
      },
      input: {
        flex: '1',
        minWidth: '0',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
      },
      rowTop: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' },
      chip: {
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      overlay: {
        position: 'absolute',
        left: '0',
        bottom: 'calc(100% + 8px)',
        width: '280px',
        padding: '6px',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-base)',
        boxShadow: 'var(--dsw-elevation-panel)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      },
      backdrop: {
        position: 'fixed',
        inset: 0,
        background: 'transparent',
        zIndex: 9998,
      },
    };

    function fmt(ms) {
      if (!ms) return '—';
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return d.getMonth() + 1 + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function short(s) {
      return s.length > 44 ? s.slice(0, 41) + '…' : s;
    }

    async function fetchJson(url, opts, ms) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms);
      try {
        const res = await fetch(url, { ...opts, signal: ctl.signal });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error('接口回了 HTTP ' + res.status + '，不是 JSON');
        }
        return { status: res.status, json };
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('请求超时（' + ms + 'ms 没回应）');
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }

    const sourceLabel = (source) => source === 'session'
      ? '本会话'
      : source === 'workspace'
        ? '工作区'
        : source === 'global'
          ? '全局'
          : source === 'disabled'
            ? '已停用'
            : '自动生成';

    // ===== 设置 → Agent 连接 =====
    function ConnectionSection() {
      const [state, setState] = useState({ loading: true });
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      const load = useCallback(async () => {
        try {
          const r = await fetchJson(STATUS_PATH, { headers: { accept: 'application/json' } }, 8000);
          if (!r.json || r.json.ok !== true) throw new Error(r.json?.error || '状态接口不可用');
          setState({ loading: false, value: r.json.value });
        } catch (e) {
          setState({ loading: false, failure: String(e && e.message ? e.message : e) });
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const send = useCallback(async (body) => {
        setBusy(true);
        setError(null);
        try {
          const r = await fetchJson(ENDPOINTS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 10000);
          if (!r.json || r.json.ok !== true) throw new Error(r.json?.error || '保存失败');
          setDraft('');
          await load();
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setBusy(false);
        }
      }, [load]);

      const reconnect = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const r = await fetchJson(RECONNECT_PATH, { method: 'POST' }, 20000);
          if (!r.json || r.json.ok !== true) throw new Error(r.json?.error || '重连失败');
          await load();
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setBusy(false);
        }
      }, [load]);

      const v = state.value || {};
      const health = v.health;
      const online = Boolean(health && health.ok);
      const stored = Array.isArray(v.stored) ? v.stored : [];
      const resolved = Array.isArray(v.endpoints) ? v.endpoints : [];
      const currentBase = online ? v.lastGoodBase : '';
      const rawRows = stored.length > 0
        ? stored.map((raw) => ({ raw, base: raw.replace(/^memore:\/\//, 'http://').split('?')[0], editable: true }))
        : resolved.map((e) => ({ raw: e.base, base: e.base, editable: false }));
      const seen = new Set();
      const rows = rawRows.filter((r) => {
        if (seen.has(r.base)) return false;
        seen.add(r.base);
        return true;
      });
      const statusText = state.loading ? '检查中' : online ? '已连接' : '未连接';
      const problem = v.reachError || v.configError || state.failure;

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.card },
          h('div', { style: S.head },
            h('span', { style: S.dot(online) }),
            h('span', { style: S.label }, statusText),
            h('span', { style: S.right }, online && health.db ? health.db.records + ' 条记录' : '')),
          online && health.db ? h('div', { style: { ...S.muted, marginTop: '4px' } }, '最近一条 ' + fmt(health.db.last_record_at)) : null,
          !online && !v.current ? h('div', { style: { ...S.muted, marginTop: '6px' } }, '手机上的 Memore → 设置 → Agent 连接 → 打开服务') : null,
          !online && v.current && problem ? h('div', { style: { ...S.muted, marginTop: '6px' } }, problem) : null,
          !online && !v.current && state.failure ? h('div', { style: { ...S.muted, marginTop: '4px' } }, state.failure) : null,
          online && v.versionWarning ? h('div', { style: { ...S.muted, marginTop: '6px', color: '#b2554d' } }, v.versionWarning) : null,
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.head }, h('span', { style: S.label }, '地址'), h('span', { style: S.right }, rows.length + ' 条')),
          h('ul', { style: S.list }, rows.map((row, i) => {
            const isCurrent = Boolean(currentBase) && currentBase.indexOf(row.base.replace(/^https?:\/\//, '')) >= 0;
            const controls = [];
            if (row.editable) {
              controls.push(h('button', { key: 'again', type: 'button', style: S.btnPlain, disabled: busy, onClick: reconnect }, '重连'));
              controls.push(h('button', { key: 'del', type: 'button', style: S.btnDanger, disabled: busy, onClick: () => send({ action: 'remove', value: row.raw }) }, '删除'));
            }
            return h('li', { key: row.raw + i, style: S.item },
              h('span', { style: S.dot(isCurrent) }),
              h('span', { style: S.mono }, short(row.base)),
              h('span', { style: S.right }, isCurrent ? '当前' : '没试过'),
              controls);
          })),
          h(
            'div',
            { style: S.rowTop },
            h('input', {
              style: S.input,
              value: draft,
              placeholder: '从手机「Agent 连接」复制连接串，粘到这里',
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && draft.trim() && !busy) send({ action: 'add', value: draft.trim() });
              },
            }),
            h('button', { type: 'button', style: S.btn, disabled: busy || !draft.trim(), onClick: () => send({ action: 'add', value: draft.trim() }) }, '添加'),
          ),
          error ? h('div', { style: { ...S.muted, marginTop: '8px' } }, error) : null,
        ),
      );
    }

    // ===== 设置 → 启动提示词（只管全局与总开关） =====
    function GuideSection() {
      const [guide, setGuide] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [draft, setDraft] = useState('');
      const [editing, setEditing] = useState(false);
      const [preview, setPreview] = useState(false);

      const load = useCallback(async () => {
        try {
          const r = await fetchJson(GUIDE_PATH, { headers: { accept: 'application/json' } }, 8000);
          if (!r.json || r.json.ok !== true) throw new Error(r.json?.error || '提示词接口不可用');
          setGuide(r.json.value);
          setDraft(r.json.value.global || '');
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const save = useCallback(async (payload) => {
        setBusy(true);
        setError(null);
        try {
          const r = await fetchJson(GUIDE_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, 10000);
          if (!r.json || r.json.ok !== true) throw new Error(r.json?.error || '保存失败');
          await load();
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setBusy(false);
        }
      }, [load]);

      const v = guide || {};
      const enabled = v.enabled !== false;
      const hasGlobal = Boolean(v.global);
      const effective = v.effective || v.auto || '';
      const workspaces = v.workspaces || {};
      const sessions = v.sessions || {};

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.card },
          h('div', { style: S.head },
            h('span', { style: S.dot(enabled) }),
            h('span', { style: S.label }, '启动提示词'),
            h('span', { style: S.right }, enabled ? '已启用 · 全局' : '已停用'),
            h('button', { type: 'button', style: S.btnPlain, disabled: busy, onClick: () => save({ enabled: !enabled }) }, enabled ? '停用' : '启用')),
          h('div', { style: { ...S.muted, marginTop: '6px' } }, '给助手看的说明书，每个请求自动注入；不改也能用。指定会话在自己输入框上方挑。'),
          h('div', { style: S.rowTop, marginTop: '10px' },
            h('button', { type: 'button', style: S.btnPlain, onClick: () => setPreview(!preview) }, preview ? '收起内容' : '查看内容'),
            h('button', {
              type: 'button',
              style: S.btnPlain,
              disabled: busy,
              onClick: () => { setEditing(!editing); setPreview(false); if (!editing) setDraft(v.global || ''); },
            }, hasGlobal ? '修改全局版本' : '自定义全局版本'),
            hasGlobal ? h('button', { type: 'button', style: S.btnPlain, disabled: busy, onClick: () => save({ global: '' }) }, '恢复自动') : null),
          preview ? h('pre', { style: { ...S.muted, marginTop: '8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '240px', overflow: 'auto' } }, effective) : null,
          editing ? h('div', { style: { marginTop: '10px' } },
            h('textarea', {
              style: { ...S.input, width: '100%', minHeight: '160px', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' },
              value: draft,
              placeholder: '留空 = 自动生成',
              onChange: (e) => setDraft(e.target.value),
            }),
            h('div', { style: S.rowTop },
              h('button', { type: 'button', style: S.btn, disabled: busy || draft === (v.global || ''), onClick: () => save({ global: draft }) }, '保存'),
              h('button', { type: 'button', style: S.btnPlain, disabled: busy, onClick: () => { setEditing(false); setDraft(v.global || ''); } }, '取消'))) : null,
          error ? h('div', { style: { ...S.muted, marginTop: '8px', color: 'rgba(200,80,80,1)' } }, error) : null,
        ),
        Object.keys(workspaces).length + Object.keys(sessions).length > 0
          ? h(
              'div',
              { style: S.card },
              h('div', { style: S.head }, h('span', { style: S.label }, '单独覆盖'), h('span', { style: S.right }, (Object.keys(workspaces).length + Object.keys(sessions).length) + ' 条')),
              h('ul', { style: S.list },
                Object.keys(workspaces).map((cwd) => h('li', { key: 'w' + cwd, style: S.item },
                  h('span', { style: S.mono }, '工作区 · ' + short(cwd)),
                  h('span', { style: S.right }, String((workspaces[cwd] || '').length) + ' 字'),
                  h('button', { type: 'button', style: S.btnPlain, disabled: busy, onClick: () => save({ clearWorkspace: cwd }) }, '删除'))),
                Object.keys(sessions).map((sid) => {
                  const raw = sessions[sid];
                  const off = raw && typeof raw === 'object' && raw.enabled === false;
                  const text = typeof raw === 'string' ? raw : ((raw && raw.text) || '');
                  return h('li', { key: 's' + sid, style: S.item },
                    h('span', { style: S.mono }, '会话 · ' + short(sid)),
                    h('span', { style: S.right }, off ? '关闭' : String(text.length) + ' 字'),
                    h('button', { type: 'button', style: S.btnPlain, disabled: busy, onClick: () => save({ clearSession: sid }) }, '删除'));
                })),
            )
          : null,
      );
    }

    // ===== 输入框上方：本会话用哪份 =====
    function GuideDock(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const useSessions = props?.useSessions;
      const cwd = typeof useSessions === 'function'
        ? useSessions((snap) => {
            const entry = sessionId && snap && snap.byId ? snap.byId[sessionId] : undefined;
            return entry && typeof entry.cwd === 'string' ? entry.cwd : '';
          })
        : '';
      const [guide, setGuide] = useState(null);
      const [open, setOpen] = useState(false);
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      const load = useCallback(async () => {
        if (!sessionId) return;
        try {
          const url = GUIDE_PATH + '?session=' + encodeURIComponent(sessionId) + (cwd ? '&cwd=' + encodeURIComponent(cwd) : '');
          const r = await fetchJson(url, { headers: { accept: 'application/json' } }, 8000);
          if (!r.json || r.json.ok !== true) throw new Error(r.json?.error || '提示词接口不可用');
          setGuide(r.json.value);
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        }
      }, [sessionId, cwd]);

      useEffect(() => { load(); }, [load]);

      const save = async (payload) => {
        setBusy(true);
        setError(null);
        try {
          const r = await fetchJson(GUIDE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...payload, sessionId, cwd }),
          }, 10000);
          if (!r.json || r.json.ok !== true) throw new Error(r.json?.error || '保存失败');
          await load();
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setBusy(false);
        }
      };

      if (!sessionId) return null;
      const v = guide || {};
      const source = v.source || 'auto';
      const sessionMode = (v.session && v.session.mode) || 'global';
      const isOff = sessionMode === 'off';
      const isSession = sessionMode === 'session';
      const label = isOff ? '关闭' : isSession ? '本会话' : sourceLabel(source);

      const optionRow = (active, title, desc, onClick) =>
        h(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '7px 9px',
              borderRadius: '8px',
              border: 'none',
              background: active ? 'rgba(127,127,127,0.12)' : 'transparent',
              textAlign: 'left',
              cursor: 'pointer',
            },
          },
          h('span', { style: { ...S.dot(active), width: '6px', height: '6px' } }),
          h(
            'span',
            { style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 } },
            h('span', { style: { ...S.label, fontSize: '12px' } }, title),
            h('span', { style: { ...S.muted, fontSize: '11px' } }, desc),
          ),
        );

      const overlay = open
        ? h('div', null,
            h('div', { style: S.backdrop, onClick: () => setOpen(false) }),
            h('div', { style: S.overlay },
              h('div', { style: { ...S.muted, padding: '4px 9px 6px' } }, '当前读到：' + (isOff ? '不注入' : label) + (v.effective ? ' · ' + v.effective.length + ' 字' : '')),
              optionRow(
                !isOff && !isSession,
                '跟随全局',
                '和设置里保持一致',
                async () => { await save({ sessionMode: 'global' }); setOpen(false); },
              ),
              optionRow(
                isSession,
                '只在这个会话开',
                '只影响当前这条对话',
                () => {
                  setEditing(true);
                  setDraft((v.session && v.session.text) || '');
                },
              ),
              optionRow(
                isOff,
                '不开',
                '这条对话不注入',
                async () => { await save({ sessionMode: 'off' }); setOpen(false); },
              ),
              editing
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px 2px 2px' } },
                    h('textarea', {
                      style: { ...S.input, width: '100%', minHeight: '120px', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' },
                      value: draft,
                      placeholder: '留空 = 用自动生成的内容',
                      onChange: (e) => setDraft(e.target.value),
                    }),
                    h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
                      h('button', { type: 'button', style: S.btn, disabled: busy, onClick: async () => { await save({ sessionMode: 'session', sessionText: draft }); setEditing(false); setOpen(false); } }, '保存'),
                      h('button', { type: 'button', style: S.btnPlain, disabled: busy, onClick: () => setEditing(false) }, '取消')))
                : null,
              error ? h('div', { style: { ...S.muted, padding: '4px 9px', color: 'rgba(200,80,80,1)' } }, error) : null,
            ))
        : null;

      return h('div', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('button', {
          type: 'button',
          style: S.chip,
          title: '选择本会话启动提示词：' + label,
          onClick: () => setOpen(!open),
        }, '提示词：' + label + ' ▾'),
        overlay,
      );
    }

    const apply = (ctx) => {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: CONNECTION_SECTION_ID, order: 19, label: () => 'Agent 连接' }, ConnectionSection),
      );
      // 2026-11-24：不再注册「启动提示词」设置页 —— 主界面 composer 已经有同一个入口，
      // 设置页再来一份属于重复 UI。GuideDock 保留。
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register({ name: 'conversation.composer.dock', id: 'memore-guide-dock', order: 60 }, GuideDock),
      );
    };

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.ConnectionSection = ConnectionSection;
    exports.GuideSection = GuideSection;
    exports.GuideDock = GuideDock;
    return module.exports;
  },
});
