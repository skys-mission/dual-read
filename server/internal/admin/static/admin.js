const KEEP = '__KEEP__';

let configData = null;
let activeTab = 'monitor';
let formDirty = false;
let toastTimer = null;
// Newly issued Client Keys remain plaintext only in this page's memory.
// The server stores an irreversible HMAC and never returns the original Key.
const sessionClientKeys = new Map();

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)dual_read_admin_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function headers(json) {
  const h = { Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  const csrf = csrfToken();
  if (csrf) h['X-CSRF-Token'] = csrf;
  return h;
}

function fmtMs(v) { return v == null || Number.isNaN(v) ? '—' : Math.round(v) + ' ms'; }
function fmtPct(v) { return ((v || 0) * 100).toFixed(1) + '%'; }
function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return String(iso || ''); }
}

function friendlyValkeyError(raw) {
  const message = String(raw || '');
  if (/WRONGPASS/i.test(message)) {
    return 'Redis / Valkey 认证失败：用户名或密码错误，或 Redis 用户已被禁用（WRONGPASS）。';
  }
  if (/NOAUTH/i.test(message)) {
    return 'Redis / Valkey 要求认证，但当前没有提供有效密码（NOAUTH）。';
  }
  if (/connection refused|connect: refused/i.test(message)) {
    return 'Redis / Valkey 拒绝连接，请检查服务是否启动以及地址、端口是否正确。';
  }
  if (/i\/o timeout|deadline exceeded|timed out/i.test(message)) {
    return 'Redis / Valkey 连接超时，请检查网络、防火墙和服务地址。';
  }
  return message || 'Redis / Valkey 当前不可连接，请检查地址和凭据。';
}

function isLocked(path) { return (configData?.meta?.env_locked || []).includes(path); }

function setText(el, text) {
  if (el) el.textContent = text == null ? '' : String(text);
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function showToast(message) {
  const node = document.getElementById('toast');
  setText(node, message);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2200);
}

async function copyText(value, message = '已复制') {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showToast(message);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.className = 'clipboard-fallback';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    showToast(message);
  }
}

function setFormDirty(dirty) {
  formDirty = dirty;
  const node = document.getElementById('formState');
  if (!node) return;
  node.classList.toggle('dirty', dirty);
  setText(node, dirty ? '有尚未保存的修改' : '配置已同步');
}

function el(tag, attrs = {}, children = []) {
  const svgTags = ['svg', 'path', 'rect', 'circle', 'line', 'polyline'];
  const node = svgTags.includes(tag)
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'className') node.setAttribute('class', value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'htmlFor') node.htmlFor = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function setFieldLock(inputEl, path, hintEl, hintWhenFree) {
  if (!inputEl) return;
  const locked = isLocked(path);
  inputEl.disabled = locked;
  if (hintEl) setText(hintEl, locked ? '由环境变量控制，此处不可改' : (hintWhenFree || ''));
}

function genClientKey() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return 'dr-' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function showLogin(message) {
  const overlay = document.getElementById('loginOverlay');
  overlay.hidden = false;
  setText(document.getElementById('loginError'), message || '');
  document.getElementById('loginToken').focus();
}

function hideLogin() {
  document.getElementById('loginOverlay').hidden = true;
  setText(document.getElementById('loginError'), '');
  document.getElementById('loginToken').value = '';
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    credentials: 'same-origin',
    headers: { ...headers(opts.body != null), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    showLogin('需要 Admin 口令登录');
    throw new Error('unauthorized');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || ('HTTP ' + res.status));
  return data;
}

function renderCards(m, data) {
  const cards = document.getElementById('cards');
  clearChildren(cards);
  const items = [
    { label: '累计请求', value: String(m.requests ?? 0), hint: '服务启动以来', tone: 'accent' },
    {
      label: '缓存命中率',
      value: fmtPct(m.cache_hit_rate),
      hint: `HIT ${m.cache_hits ?? 0} · MISS ${m.cache_misses ?? 0}`,
      tone: (m.cache_hit_rate || 0) > 0.5 ? 'ok' : 'accent',
    },
    {
      label: '平均延迟',
      value: fmtMs(m.avg_latency_ms),
      hint: '所有已完成请求',
      tone: (m.avg_latency_ms || 0) > 5000 ? 'warn' : 'ok',
    },
    {
      label: '限流请求',
      value: String(m.rate_limited ?? 0),
      hint: (m.rate_limited || 0) > 0 ? '建议检查并发设置' : '当前无阻塞',
      tone: (m.rate_limited || 0) > 0 ? 'warn' : 'ok',
    },
    {
      label: 'L1 缓存条目',
      value: String(data.cache?.local_items ?? 0),
      hint: data.cache?.local_enabled ? '本地缓存已启用' : '本地缓存未启用',
      tone: data.cache?.local_enabled ? 'ok' : '',
    },
  ];
  for (const item of items) {
    const article = el('article', { className: 'metric-card', 'data-tone': item.tone }, [
      el('div', { className: 'metric-top' }, [
        el('span', { className: 'metric-label', text: item.label }),
        el('span', { className: 'metric-mark' }),
      ]),
      el('div', { className: 'metric-value', text: item.value }),
      el('div', { className: 'metric-hint', text: item.hint }),
    ]);
    cards.appendChild(article);
  }
}

function renderConfigSummary(data) {
  const root = document.getElementById('config');
  clearChildren(root);
  const keys = data.auth?.keys || [];
  const valkeyState = data.cache?.valkey || 'disabled';
  const valkeyOK = valkeyState === 'ok';
  const valkeyFailed = valkeyState === 'unreachable';
  const anyCacheActive = valkeyOK || data.cache?.local_enabled;
  const items = [
    {
      label: '上游地址',
      value: data.upstream?.base_url || '—',
      code: true,
      state: '已配置',
      tone: data.upstream?.base_url ? 'ok' : 'warn',
    },
    {
      label: '默认模型',
      value: data.models?.default || '未配置',
      code: true,
      state: data.models?.default ? '可用' : '待配置',
      tone: data.models?.default ? 'ok' : 'warn',
    },
    {
      label: '访问控制',
      value: keys.length ? `${keys.length} 个 Client Key` : '未启用，当前为开放模式',
      state: keys.length ? '已保护' : '仅限本机',
      tone: keys.length ? 'ok' : 'warn',
    },
    {
      label: '缓存层',
      value: `L1 ${data.cache?.local_enabled ? '已启用' : '未启用'} · L2 ${valkeyOK ? '已连接' : (valkeyFailed ? '连接失败' : '未启用')}`,
      state: valkeyFailed ? '连接失败' : (anyCacheActive ? '运行中' : '未启用'),
      tone: valkeyFailed ? 'err' : (anyCacheActive ? 'ok' : ''),
    },
  ];
  for (const item of items) {
    const value = item.code
      ? el('code', { text: item.value, title: item.value })
      : document.createTextNode(item.value);
    root.appendChild(el('div', { className: 'summary-item' }, [
      el('span', { text: item.label }),
      el('div', { className: 'summary-value' }, [value]),
      el('span', { className: `state-pill ${item.tone}`, text: item.state }),
    ]));
  }
}

function renderRecent(rows) {
  const tbody = document.getElementById('recent');
  clearChildren(tbody);
  if (!rows || !rows.length) {
    tbody.appendChild(el('tr', { className: 'empty-row' }, [
      el('td', { colSpan: '8', text: '暂无请求记录，插件发起翻译后会显示在这里' }),
    ]));
    return;
  }
  for (const r of rows) {
    const fullID = r.request_id ? String(r.request_id) : '';
    const rid = fullID ? fullID.slice(0, 12) : '—';
    const status = Number(r.status || 0);
    const statusClass = status >= 500 ? 's5' : status >= 400 ? 's4' : status >= 200 ? 's2' : '';
    const cache = String(r.cache || '—');
    const cacheClass = cache.toLowerCase();
    const idCell = el('div', { className: 'request-id' }, [
      el('code', { text: rid, title: fullID || '无请求 ID' }),
    ]);
    if (fullID) {
      idCell.appendChild(el('button', {
        type: 'button',
        className: 'icon-button',
        title: '复制完整请求 ID',
        'aria-label': '复制完整请求 ID',
        onClick: () => copyText(fullID, '请求 ID 已复制'),
      }, [
        el('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' }, [
          el('rect', { x: '7', y: '7', width: '9', height: '9', rx: '2' }),
          el('path', { d: 'M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2' }),
        ]),
      ]));
    }
    tbody.appendChild(el('tr', {}, [
      el('td', { text: fmtTime(r.time), title: r.time || '' }),
      el('td', {}, [idCell]),
      el('td', {}, [el('span', { className: `status-badge ${statusClass}`, text: status || '—' })]),
      el('td', {}, [el('span', { className: `cache-pill ${cacheClass}`, text: cache })]),
      el('td', { text: fmtMs(r.duration_ms) }),
      el('td', {}, [el('code', { text: r.upstream_model || '—', title: r.upstream_model || '' })]),
      el('td', { text: r.auth_name || '—' }),
      el('td', { className: 'error-cell', text: r.error || '—', title: r.error || '' }),
    ]));
  }
}

async function loadMonitor() {
  const data = await api('api/overview');
  const m = data.metrics || {};
  const valkey = data.cache?.valkey || 'disabled';
  const valkeyError = data.cache?.valkey_error || '';
  const degraded = valkey === 'unreachable';
  const endpoint = `${window.location.origin}/v1`;
  setText(document.getElementById('subtitle'),
    `监听 ${data.listen} · ${data.auth?.keys?.length || 0} 个 Client Key · Valkey ${valkey}`);
  setText(document.getElementById('proxyEndpoint'), endpoint);
  setText(document.getElementById('serverVersion'),
    `v${data.version || 'dev'}${data.commit ? ` · ${String(data.commit).slice(0, 8)}` : ''}`);
  setText(document.getElementById('sidebarStatus'), degraded ? '服务降级运行' : '服务在线');
  document.getElementById('sidebarStatusDot').className = `status-dot ${degraded ? 'err' : 'ok'}`;
  setText(document.getElementById('healthLabel'), degraded ? '服务降级运行' : 'Proxy 服务运行正常');
  setText(document.getElementById('healthDetail'),
    degraded
      ? friendlyValkeyError(valkeyError)
      : `监听 ${data.listen}，上游 ${data.upstream?.base_url || '尚未配置'}`);
  document.getElementById('healthIndicator').className = `health-indicator ${degraded ? 'err' : 'ok'}`;
  renderCards(m, data);
  renderConfigSummary(data);
  renderRecent(m.recent || []);
  hideLogin();
  return data;
}

async function bootstrapAdmin() {
  const data = await loadMonitor();
  if (data.admin?.token_set === false && !csrfToken()) {
    await api('api/login', { method: 'POST', body: '{}' });
    await loadMonitor();
  }
}

function clientRow(item = {}, idx = -1, sessionKey = '') {
  const tr = document.createElement('tr');
  if (item.key_set) tr.dataset.keySet = '1';
  if (idx >= 0) tr.dataset.idx = String(idx);
  const nameInput = el('input', {
    type: 'text',
    'data-name': '',
    value: item.name || '',
    placeholder: '例如 alice',
    autocomplete: 'off',
  });
  const keyInput = el('input', {
    type: sessionKey ? 'text' : 'password',
    'data-key': '',
    value: sessionKey,
    placeholder: 'Client Key',
    autocomplete: 'new-password',
    spellcheck: 'false',
  });
  const actionButton = (label, path, handler, className = 'icon-button') => el('button', {
    type: 'button',
    className,
    title: label,
    'aria-label': label,
    onClick: handler,
  }, [el('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' }, [el('path', { d: path })])]);
  const revealBtn = actionButton(
    '显示或隐藏 Key',
    'M2.5 10s2.7-4 7.5-4 7.5 4 7.5 4-2.7 4-7.5 4-7.5-4-7.5-4Zm7.5 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; },
  );
  const copyBtn = actionButton(
    '复制 Key',
    'M7 7h9v9H7zM13 7V3H3v10h4',
    () => copyText(keyInput.value, 'Client Key 已复制'),
  );
  const genBtn = actionButton('重新生成 Key', 'M15.5 7A6 6 0 1 0 16 12M15.5 7V3m0 4h-4', () => {
    keyInput.value = genClientKey();
    keyInput.type = 'text';
    refreshKeyControls();
    setFormDirty(true);
    showToast('已生成新 Key，请复制并保存配置');
  });
  const removeBtn = actionButton(
    '删除用户',
    'M4 6h12M8 6V4h4v2m-6 0 1 10h6l1-10M8.5 9v4m3-4v4',
    () => {
      tr.remove();
      setFormDirty(true);
    },
    'icon-button danger',
  );
  const savedCredential = el('div', {
    className: 'saved-credential',
    title: '出于安全考虑，已保存的 Client Key 不可回读',
  }, [
    el('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' }, [
      el('path', { d: 'M6 9V6a4 4 0 0 1 8 0v3M5 9h10v8H5z' }),
    ]),
    el('span', {
      text: item.key_set
        ? `已安全保存${item.key_hint ? ` · ${item.key_hint}` : ''}`
        : '尚未生成 Key',
    }),
  ]);
  const keyState = el('span', { className: 'client-key-state' });
  const keyShell = el('div', { className: 'client-key-shell' }, [
    savedCredential,
    keyInput,
    keyState,
    revealBtn,
    copyBtn,
  ]);
  const refreshKeyControls = () => {
    const value = keyInput.value.trim();
    const hasPlaintext = value !== '';
    keyInput.hidden = !hasPlaintext;
    savedCredential.hidden = hasPlaintext;
    revealBtn.hidden = !hasPlaintext;
    copyBtn.hidden = !hasPlaintext;
    keyState.hidden = !hasPlaintext;
    if (hasPlaintext) {
      const savedInSession = item.key_set && sessionKey !== '' && value === sessionKey;
      setText(keyState, savedInSession ? '本次可见' : '未保存');
      keyState.className = `client-key-state ${savedInSession ? 'ok' : 'warn'}`;
      keyShell.dataset.state = savedInSession ? 'saved' : 'draft';
    } else {
      keyShell.dataset.state = item.key_set ? 'locked' : 'empty';
    }
  };
  keyInput.addEventListener('input', refreshKeyControls);
  refreshKeyControls();
  tr.append(
    el('td', { 'data-label': '标识名称' }, [nameInput]),
    el('td', { 'data-label': 'Client Key' }, [keyShell]),
    el('td', { className: 'actions', 'data-label': '操作' }, [genBtn, removeBtn]),
  );
  return tr;
}

function updateCacheControls() {
  const localEnabled = document.getElementById('cacheLocalEnabled').checked;
  const valkeyEnabled = document.getElementById('cacheValkeyEnabled').checked;
  for (const [id, path] of [
    ['cacheLocalTTL', 'cache.local.ttl'],
    ['cacheLocalMaxMB', 'cache.local.max_mb'],
  ]) {
    document.getElementById(id).disabled = !localEnabled || isLocked(path);
  }
  for (const [id, path] of [
    ['cacheValkeyAddr', 'cache.valkey.addr'],
    ['cacheValkeyPassword', 'cache.valkey.password'],
    ['cacheValkeyTTL', 'cache.valkey.ttl'],
    ['cacheValkeyDB', 'cache.valkey.db'],
  ]) {
    document.getElementById(id).disabled = !valkeyEnabled || isLocked(path);
  }
}

function fillSettings(data) {
  configData = data;
  const rt = data.runtime;
  const bs = data.bootstrap;

  document.getElementById('llmBase').value = rt.llm.base_url || '';
  document.getElementById('llmKey').value = '';
  setFieldLock(document.getElementById('llmKey'), 'llm.api_key', document.getElementById('llmKeyHint'),
    rt.llm.api_key_set ? '已设置，留空保持不变' : '');

  document.getElementById('modelDefault').value = rt.models.default || '';

  const tbody = document.getElementById('clientRows');
  clearChildren(tbody);
  const items = rt.clients.items || [];
  const savedNames = new Set(items.map(item => item.name));
  for (const name of sessionClientKeys.keys()) {
    if (!savedNames.has(name)) sessionClientKeys.delete(name);
  }
  if (!items.length) {
    tbody.appendChild(el('tr', { className: 'empty-row' }, [
      el('td', { colSpan: '3', text: '尚未配置 Client Key，点击“添加用户”开始保护 Proxy' }),
    ]));
  } else {
    items.forEach((it, i) => tbody.appendChild(
      clientRow(it, i, sessionClientKeys.get(it.name) || ''),
    ));
  }

  document.getElementById('cacheLocalEnabled').checked = !!rt.cache.local.enabled;
  document.getElementById('cacheLocalTTL').value = rt.cache.local.ttl || '10m';
  document.getElementById('cacheLocalMaxMB').value = rt.cache.local.max_mb || 256;
  setFieldLock(document.getElementById('cacheLocalEnabled'), 'cache.local.enabled');

  document.getElementById('cacheValkeyEnabled').checked = !!rt.cache.valkey.enabled;
  document.getElementById('cacheValkeyAddr').value = rt.cache.valkey.addr || '127.0.0.1:6379';
  document.getElementById('cacheValkeyPassword').value = '';
  document.getElementById('cacheValkeyTTL').value = rt.cache.valkey.ttl || '24h';
  document.getElementById('cacheValkeyDB').value = rt.cache.valkey.db ?? 0;
  setFieldLock(document.getElementById('cacheValkeyEnabled'), 'cache.valkey.enabled');
  setFieldLock(document.getElementById('cacheValkeyAddr'), 'cache.valkey.addr');
  setFieldLock(document.getElementById('cacheValkeyPassword'), 'cache.valkey.password', document.getElementById('cacheValkeyPasswordHint'),
    rt.cache.valkey.password_set ? '已设置，留空保持不变' : '');

  document.getElementById('adminToken').value = '';
  setFieldLock(document.getElementById('adminToken'), 'admin.token', document.getElementById('adminTokenHint'),
    rt.admin.token_set ? '已设置，留空保持不变' : '公网部署时务必设置');
  document.getElementById('logLevel').value = rt.log.level || 'info';
  setFieldLock(document.getElementById('logLevel'), 'log.level');

  setText(document.getElementById('bootstrapInfo'),
    `监听 ${bs.server.host}:${bs.server.port} · Admin ${bs.admin.path}` +
    ` · schema v${rt.schema_version || data.meta.schema_version || 2} rev ${rt.revision || data.meta.revision || 1}` +
    ` · ${data.meta.runtime_path}` +
    (data.meta.secrets_path ? ` · secrets ${data.meta.secrets_path}` : '') +
    (data.meta.bootstrap_path ? ` · bootstrap ${data.meta.bootstrap_path}` : ''));
  const clientSecurityNote = document.getElementById('clientSecurityNote');
  setText(clientSecurityNote,
    items.length
      ? `已配置 ${items.length} 个 Client Key，插件请求需要通过 Bearer Token 鉴权。`
      : '当前为无 Client Key 开放模式。仅建议在 127.0.0.1 本机使用，公网部署前必须添加用户。');
  clientSecurityNote.className = `security-callout ${items.length ? 'ok' : 'warn'}`;
  updateCacheControls();
  setFormDirty(false);
}

function collectPayload() {
  const rt = configData.runtime;
  const llmKey = document.getElementById('llmKey').value.trim();
  const adminTok = document.getElementById('adminToken').value.trim();
  const valkeyPassword = document.getElementById('cacheValkeyPassword').value.trim();

  const items = [];
  document.querySelectorAll('#clientRows tr').forEach(row => {
    if (!row.querySelector('[data-name]')) return;
    const name = row.querySelector('[data-name]').value.trim();
    const enteredKey = row.querySelector('[data-key]').value.trim();
    let key = enteredKey;
    if (!name && !key) return;
    // Existing client secrets are keyed by their stable name. Renaming without
    // issuing a replacement would orphan the stored HMAC.
    const orig = row.dataset.idx != null ? (rt.clients.items || [])[Number(row.dataset.idx)] : null;
    if (row.dataset.keySet && !enteredKey && orig && name !== orig.name) {
      throw new Error(`修改用户名称 ${orig.name} 时，请同时重新生成 Client Key`);
    }
    if (!key && row.dataset.keySet) key = KEEP;
    if (!key) throw new Error(`请先为 ${name || '新用户'} 生成 Client Key`);
    // Round-trip advanced per-client fields the form does not edit, so a
    // save never silently wipes default_model / models / upstream overrides.
    // dataset.idx points into the IMMUTABLE loaded view (rt.clients.items),
    // not the live row order — deleting rows needs no reindexing.
    const item = { name: name || 'user', key };
    if (orig?.default_model) item.default_model = orig.default_model;
    if (orig?.models) item.models = orig.models;
    if (orig?.upstream_base_url) item.upstream_base_url = orig.upstream_base_url;
    if (orig?.upstream_api_key_set) item.upstream_api_key = KEEP;
    items.push(item);
  });

  return {
    schema_version: rt.schema_version || 2,
    revision: rt.revision || 0,
    llm: {
      base_url: document.getElementById('llmBase').value.trim(),
      api_key: llmKey || (rt.llm.api_key_set ? KEEP : ''),
      timeout: rt.llm.timeout || '60s',
      passthrough_headers: rt.llm.passthrough_headers || [],
      extra_headers: rt.llm.extra_headers || {},
    },
    clients: {
      enabled: items.length > 0,
      items,
    },
    models: {
      default: document.getElementById('modelDefault').value.trim(),
      map: rt.models.map || {},
    },
    cache: {
      local: {
        enabled: document.getElementById('cacheLocalEnabled').checked,
        ttl: document.getElementById('cacheLocalTTL').value.trim() || '10m',
        max_mb: Number(document.getElementById('cacheLocalMaxMB').value) || 256,
      },
      valkey: {
        enabled: document.getElementById('cacheValkeyEnabled').checked,
        addr: document.getElementById('cacheValkeyAddr').value.trim() || '127.0.0.1:6379',
        password: valkeyPassword || (rt.cache.valkey.password_set ? KEEP : ''),
        db: Number(document.getElementById('cacheValkeyDB').value) || 0,
        key_prefix: rt.cache.valkey.key_prefix || 'dual_read:',
        ttl: document.getElementById('cacheValkeyTTL').value.trim() || '24h',
      },
    },
    log: { level: document.getElementById('logLevel').value },
    admin: { token: adminTok || (rt.admin.token_set ? KEEP : '') },
    // Limits have no form controls yet; echo the loaded values so a save
    // does not silently disable or reset rate/concurrency limits.
    limits: rt.limits || { enabled: false },
  };
}

function visibleClientKeys() {
  const keys = new Map();
  document.querySelectorAll('#clientRows tr').forEach(row => {
    const enteredName = row.querySelector('[data-name]')?.value.trim() || '';
    const key = row.querySelector('[data-key]')?.value.trim() || '';
    const name = enteredName || (key ? 'user' : '');
    if (name && key && key !== KEEP) keys.set(name, key);
  });
  return keys;
}

async function loadSettings() { fillSettings(await api('api/config')); }

function showBanner(text, kind = 'ok') {
  const node = document.getElementById('settingsBanner');
  node.hidden = false;
  node.className = 'banner ' + kind;
  setText(node, text);
}

async function saveSettings(ev) {
  ev.preventDefault();
  const button = document.getElementById('saveSettings');
  const originalText = button.textContent;
  button.disabled = true;
  setText(button, '保存中…');
  try {
    const payload = collectPayload();
    const issuedKeys = visibleClientKeys();
    const out = await api('api/config', { method: 'PUT', body: JSON.stringify(payload) });
    for (const [name, key] of issuedKeys) sessionClientKeys.set(name, key);
    const warning = out.warning ? friendlyValkeyError(out.warning) : '';
    const issuedMessage = issuedKeys.size
      ? '已保存。新 Client Key 仅在当前页面会话中可见，请立即复制到插件。'
      : '';
    const msg = warning || issuedMessage || (out.result?.restart_needed
      ? (out.result.message || '已保存，请重启 server 使缓存配置生效')
      : (out.result?.message || '已保存'));
    showBanner(msg, warning ? 'err' : (issuedMessage || out.result?.restart_needed ? 'warn' : 'ok'));
    await loadSettings();
  } catch (err) {
    if (String(err.message) !== 'unauthorized') showBanner(String(err.message || err), 'err');
  } finally {
    button.disabled = false;
    setText(button, originalText);
  }
}

function switchTab(tab, load = true) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.getElementById('panel-monitor').hidden = tab !== 'monitor';
  document.getElementById('panel-settings').hidden = tab !== 'settings';
  document.getElementById('refresh').hidden = tab !== 'monitor';
  setText(document.getElementById('pageEyebrow'), tab === 'settings' ? 'SERVER CONFIGURATION' : 'PROXY STATUS');
  setText(document.getElementById('pageTitle'), tab === 'settings' ? '服务设置' : '运行概览');
  if (tab === 'settings' && load) {
    setText(document.getElementById('subtitle'), '配置上游、访问控制、缓存与管理安全');
    loadSettings().catch(e => {
      if (String(e.message) !== 'unauthorized') showBanner(String(e.message || e), 'err');
    });
  } else if (tab === 'monitor' && load) {
    loadMonitor().catch(() => {});
  }
}

async function onLogin(ev) {
  ev.preventDefault();
  const token = document.getElementById('loginToken').value.trim();
  try {
    await api('api/login', { method: 'POST', body: JSON.stringify({ token }) });
    hideLogin();
    await loadMonitor();
  } catch (err) {
    showLogin(String(err.message || err));
  }
}

document.getElementById('tabs').addEventListener('click', e => {
  const b = e.target.closest('.tab');
  if (b) switchTab(b.dataset.tab);
});
document.querySelectorAll('[data-go-settings]').forEach(button => {
  button.addEventListener('click', () => switchTab('settings'));
});
document.getElementById('copyEndpoint').addEventListener('click', () => {
  copyText(document.getElementById('proxyEndpoint').textContent, 'Proxy API 地址已复制');
});
document.getElementById('refresh').addEventListener('click', async () => {
  const button = document.getElementById('refresh');
  button.disabled = true;
  try {
    await loadMonitor();
    showToast('运行数据已刷新');
  } finally {
    button.disabled = false;
  }
});
document.getElementById('reloadSettings').addEventListener('click', () => loadSettings().then(() => {
  showBanner('已放弃未保存的修改并重新载入配置', 'ok');
}).catch(e => {
  if (String(e.message) !== 'unauthorized') showBanner(String(e.message || e), 'err');
}));
document.getElementById('addClient').addEventListener('click', () => {
  const tbody = document.getElementById('clientRows');
  const placeholder = tbody.querySelector('.empty-row');
  if (placeholder) placeholder.remove();
  const row = clientRow(
    { name: 'user-' + (tbody.querySelectorAll('tr').length + 1) },
    -1,
    genClientKey(),
  );
  tbody.appendChild(row);
  row.querySelector('[data-name]').focus();
  setFormDirty(true);
});
const settingsForm = document.getElementById('settingsForm');
settingsForm.addEventListener('submit', saveSettings);
settingsForm.addEventListener('input', () => setFormDirty(true));
settingsForm.addEventListener('change', event => {
  setFormDirty(true);
  if (event.target.id === 'cacheLocalEnabled' || event.target.id === 'cacheValkeyEnabled') {
    updateCacheControls();
  }
});
document.getElementById('loginForm').addEventListener('submit', onLogin);
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    await api('api/logout', { method: 'POST', body: '{}' });
  } catch { /* ignore */ }
  showLogin('已退出登录');
});
window.addEventListener('beforeunload', event => {
  if (!formDirty) return;
  event.preventDefault();
  event.returnValue = '';
});

switchTab('monitor', false);
bootstrapAdmin().catch(() => {});
setInterval(() => { if (activeTab === 'monitor') loadMonitor().catch(() => {}); }, 5000);
