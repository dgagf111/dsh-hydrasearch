/**
 * dsh-hydrasearch — browser half.
 *
 * Registers one slot: `plugins.row.config`, keyed
 * `dsh-hydrasearch#hydrasearch` — the DSH 0.1.6-alpha.2+ Plugins page
 * ("已安装" → the row's configure control). The key is
 * `<package name>#<row id from cordis.patch.yml>`, per ui-plugin-manager's
 * `rowConfigKey`; the owner asks for `view: 'summary'` for the row's one-liner
 * and `view: 'page'` for the form itself.
 *
 * There is deliberately no `settings.plugin.item` registration: 0.1.6-alpha.2
 * REMOVED that slot (its replacement `plugins.item` is reserved for the
 * host-plane pages `ui-settings-plugins` ships). A third-party plugin's
 * configuration belongs in `plugins.row.config`.
 *
 * ## What the card edits
 *
 *   - a draggable priority list — the backend order the failover chain walks.
 *     Drag a row (or press Alt+↑/↓) to reorder. Reordering only changes the
 *     draft; the Save button persists it, so a drag is reviewable before it
 *     takes effect. The new order applies to the next search, no restart.
 *   - per-backend key fields, written to the credential center.
 *   - every API parameter each backend actually supports, persisted as a path op
 *     under that backend's own key (`['tinyfish','language']`), so editing one
 *     backend can never clobber the other's section.
 *
 * All reads and writes go through this plugin's own loopback bridge
 * (`/api/dsh-hydrasearch-settings/*`) instead of a generated Remote face, so the
 * browser half depends on no Host package beyond the slot registry.
 *
 * DSH loads this file through its client-module loader, which wraps the body in
 * a closure factory (`window.__ModuleLoader__.load({ id, factory })`). The
 * wrapper below mirrors what the tsdown client preset emits for a built UI
 * package, so this file needs no build step.
 */

window.__ModuleLoader__.load({
  id: 'dsh-hydrasearch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const jsx = require('react/jsx-runtime')

    const BRIDGE_PREFIX = '/api/dsh-hydrasearch-settings'
    const NS = 'hydrasearch'
    const BACKENDS = ['tinyfish', 'anysearch']

    /* ---------------------------------------------------------------- styles */

    const CSS = [
      '.dshhs-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;min-width:0;list-style:none;overflow:hidden;margin-bottom:8px}',
      '.dshhs-pageMode{border:0;background:0 0;border-radius:0;margin:0}',
      '.dshhs-headText{display:flex;flex-direction:column;gap:2px;min-width:0;padding:10px 14px 0;overflow:hidden}',
      '.dshhs-pageMode>.dshhs-headText{display:none}',
      '.dshhs-name{color:var(--dsw-alias-label-primary);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshhs-description{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshhs-badge{flex:none;border-radius:999px;padding:1px 6px;font-size:11px;white-space:nowrap;background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary)}',
      '.dshhs-badgeOk{border:1px solid rgba(80,200,120,.3);background:rgba(80,200,120,.15);color:#7ddb9c}',
      '.dshhs-badgeWarn{border:1px solid rgba(240,170,80,.3);background:rgba(240,170,80,.12);color:var(--dsw-alias-state-warn-primary)}',
      '.dshhs-badgeOff{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary)}',
      '.dshhs-body{display:flex;flex-direction:column;gap:14px;padding:0 14px 14px}',
      '.dshhs-section{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.dshhs-sectionHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshhs-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}',
      '.dshhs-input,.dshhs-select,.dshhs-textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 8px;font:inherit;font-size:13px;width:100%;box-sizing:border-box}',
      '.dshhs-textarea{min-height:56px;resize:vertical;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px}',
      '.dshhs-select{color-scheme:light dark}',
      '.dshhs-select option{background-color:#fff;color:#1f2328}',
      '@media (prefers-color-scheme:dark){.dshhs-select{color-scheme:dark}.dshhs-select option{background-color:#1e1f24;color:#e8e8ea}}',
      '.dshhs-input:focus-visible,.dshhs-select:focus-visible,.dshhs-textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dshhs-input:disabled{opacity:.6}',
      '.dshhs-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshhs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}',
      '.dshhs-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dshhs-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}',
      '.dshhs-check{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}',
      '.dshhs-check input{accent-color:var(--dsw-alias-state-business-primary)}',
      '.dshhs-priority{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}',
      '.dshhs-pItem{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:8px 10px;cursor:grab}',
      '.dshhs-pItem:active{cursor:grabbing}',
      '.dshhs-pItem:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dshhs-pItemDrag{opacity:.45;border-style:dashed}',
      '.dshhs-pItemOver{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshhs-pGrip{flex:none;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1;user-select:none}',
      '.dshhs-pRank{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary);font-size:11px;font-variant-numeric:tabular-nums}',
      '.dshhs-pName{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshhs-pMoves{display:flex;gap:4px;flex:none}',
      '.dshhs-iconBtn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;width:24px;height:24px;padding:0;font:inherit;font-size:12px;line-height:1;cursor:pointer}',
      '.dshhs-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshhs-iconBtn:disabled{opacity:.35;cursor:default}',
      '.dshhs-backend{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden}',
      '.dshhs-bHead{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dshhs-bHead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshhs-bBody{display:flex;flex-direction:column;gap:10px;padding:10px}',
      '.dshhs-chevron{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;transition:transform .12s}',
      '.dshhs-chevronOpen{transform:rotate(90deg)}',
      '.dshhs-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.dshhs-btn{border-radius:6px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}',
      '.dshhs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshhs-btn:disabled{opacity:.5;cursor:default}',
      '.dshhs-save{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dshhs-save:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}',
      '.dshhs-ok{color:#7ddb9c;font-size:12px;line-height:1.5;margin:0;white-space:pre-wrap}',
      '.dshhs-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;margin:0;word-break:break-word;white-space:pre-wrap}',
      '.dshhs-warn{margin:0;border:1px solid rgba(240,170,80,.35);background:rgba(240,170,80,.1);border-radius:6px;padding:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.dshhs-version{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}',
      '.dshhs-result{display:flex;flex-direction:column;gap:3px;margin-top:2px}',
      '.dshhs-result a{color:var(--dsw-alias-state-business-primary);font-size:12px;text-decoration:none;word-break:break-all}',
      '.dshhs-result a:hover{text-decoration:underline}',
      '.dshhs-sep{height:1px;background:var(--dsw-alias-border-l2);margin:2px 0}',
      '.dshhs-mono{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
    ].join('')

    const STYLE_TAG_ID = 'dsh-hydrasearch/card.css'

    /**
     * Install the card stylesheet once per document. A page that already holds
     * the tag after an HMR reload is left alone, so the check is by
     * `data-plugin-css` rather than module state.
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-hydrasearch'
      tag.dataset.pluginCss = STYLE_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* -------------------------------------------------------------- i18n copy */

    const I18N = {
      zh: {
        title: 'HydraSearch',
        description: 'TinyFish + AnySearch 双后端搜索与抓取，支持故障自动切换',
        summary: 'TinyFish + AnySearch 故障切换 · 拖动调整优先级',
        priority: '后端优先级',
        priorityHint: '拖动行（或用 ↑↓ / Alt+↑↓）调整顺序。搜索时自上而下依次尝试，失败自动切到下一个 —— 保存后下一次搜索立即生效，无需重启。',
        failover: '后端失败时自动切换到下一个',
        failoverHint: '关闭后只用顺序里第一个可用的后端，它的失败就是最终结果。',
        searchBackend: 'web_search 使用的后端',
        fetchBackend: 'web_fetch 使用的后端',
        fetchBackendAuto: '跟随优先级（自动切换）',
        keys: 'API Key',
        keyConfigured: '凭据中心已配置',
        keyFromEnvLayer: '凭据中心（环境变量层，只读）',
        keyFromDotenvLayer: '凭据中心（.env 文件层）',
        keyFromFileLayer: '凭据中心（本地文件）',
        keyNone: '未配置',
        keyPlaceholder: (has) => (has ? '已配置（留空则不修改）' : '粘贴 API Key'),
        keySave: '写入凭据中心',
        keyClear: '清除',
        keyWritable: '保存后立即生效，无需重启。读取、写入、清除都只针对凭据中心。',
        keyNotWritable: '凭据中心只读或被环境变量遮蔽 —— 请改用环境变量。',
        keyCredUnavailable: '凭据服务不可用；请改用环境变量或本地配置文件。',
        keyCleared: '已清除',
        keyClearShadowed: (source) => '已从凭据中心的可写存储中清除，但仍有只读层（' + source + '）在提供这个 key，所以它依然生效。',
        anysearchAnonNote: 'AnySearch 允许匿名访问（额度较低），不填 key 也能工作。',
        autoKeyTitle: 'AnySearch 自动注册了一个新 API Key',
        autoKeyBody: '每日免费额度已用尽，服务自动注册了账号并下发此 key。保存它才能继续以更高额度使用：',
        autoKeySaveCred: '存入凭据中心',
        autoKeySaved: (r) => '已保存到：' + r,
        tinyfishParams: 'TinyFish 参数（API 支持的全部字段）',
        anysearchParams: 'AnySearch 参数（API 支持的全部字段）',
        enabled: '参与切换链',
        testing: '测试中…',
        testChain: '测试链路',
        testBackend: (id) => '测试 ' + id,
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        noChanges: '无改动',
        unsaved: '未保存',
        reload: '重试',
        testOk: (r) => '成功：' + r.backend + ' 返回 ' + r.sources.length + ' 条结果（共 ' + r.totalResults + ' 条匹配），耗时 ' + r.latencyMs + 'ms',
        testNote: (n) => '切换说明：' + n,
        testEmpty: '搜索成功，但没有返回结果。',
        testFailed: '测试失败',
        loadFailed: '无法读取插件设置',
        saveFailed: '保存失败',
        pageHint: '设置经插件自带的 loopback 桥接读写并持久化；优先级与范围改动下一次搜索立即生效。',
        searchBaseURL: '搜索端点',
        fetchBaseURL: '抓取端点',
        purpose: '意图提示 purpose',
        language: '语言 language',
        location: '地区 location',
        domainType: '域名类型 domainType',
        domainTypeAny: '不限',
        includeDomains: '仅限域名 includeDomains',
        excludeDomains: '排除域名 excludeDomains',
        afterDate: '起始日期 after_date',
        beforeDate: '截止日期 before_date',
        recencyMinutes: '新鲜度 recency_minutes（分钟，0=关）',
        pubYearMin: '最早年份 pub_year_min（0=关）',
        pubYearMax: '最晚年份 pub_year_max（0=关）',
        maxPages: '每次搜索最多翻页数 maxPages',
        fetchFormat: '抓取格式 fetch format',
        fetchLinks: '抓取时同时返回页面链接',
        verbose: '记录每次搜索/抓取日志',
        baseURL: 'API 地址 baseURL',
        tag: '垂直子域 tag',
        params: '垂直参数 params（JSON）',
        zone: '地区 zone',
        maxResults: '单次结果数 max_results',
        commaHint: '逗号分隔',
        jsonHint: 'JSON 对象；需先填 tag',
      },
      en: {
        title: 'HydraSearch',
        description: 'TinyFish + AnySearch search and fetch with automatic failover',
        summary: 'TinyFish + AnySearch failover · drag to reorder',
        priority: 'Backend priority',
        priorityHint: 'Drag a row (or use ↑↓ / Alt+Arrows) to reorder. Each search tries them top to bottom and falls through on failure — saving applies it to the next search, no restart.',
        failover: 'Fail over to the next backend on error',
        failoverHint: 'Off uses only the first available backend; its failure is final.',
        searchBackend: 'Backend for web_search',
        fetchBackend: 'Backend for web_fetch',
        fetchBackendAuto: 'Follow priority (fail over)',
        keys: 'API keys',
        keyConfigured: 'Configured in the credential center',
        keyFromEnvLayer: 'Credential center (environment layer, read-only)',
        keyFromDotenvLayer: 'Credential center (.env layer)',
        keyFromFileLayer: 'Credential center (local file)',
        keyNone: 'Not configured',
        keyPlaceholder: (has) => (has ? 'Configured (leave blank to keep)' : 'Paste the API key'),
        keySave: 'Save to credential center',
        keyClear: 'Clear',
        keyWritable: 'Applies immediately, no restart. Read, save, and clear all target the credential center only.',
        keyNotWritable: 'The credential center is read-only or shadowed — use an environment variable instead.',
        keyCredUnavailable: 'The credentials service is unavailable; use an environment variable or a local config file.',
        keyCleared: 'Cleared',
        keyClearShadowed: (source) => 'Removed from the credential center\u2019s writable store, but a read-only layer (' + source + ') still supplies this key, so it stays in effect.',
        anysearchAnonNote: 'AnySearch allows anonymous access at a lower quota, so a key is optional.',
        autoKeyTitle: 'AnySearch auto-registered a new API key',
        autoKeyBody: 'The daily free quota is exhausted, and the service registered an account for you. Save this key to keep going at a higher quota:',
        autoKeySaveCred: 'Save to credential center',
        autoKeySaved: (r) => 'Saved to: ' + r,
        tinyfishParams: 'TinyFish parameters (every field the API supports)',
        anysearchParams: 'AnySearch parameters (every field the API supports)',
        enabled: 'In the failover chain',
        testing: 'Testing…',
        testChain: 'Test the chain',
        testBackend: (id) => 'Test ' + id,
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        noChanges: 'No changes',
        unsaved: 'Unsaved',
        reload: 'Retry',
        testOk: (r) => 'OK: ' + r.backend + ' returned ' + r.sources.length + ' sources of ' + r.totalResults + ' matches in ' + r.latencyMs + 'ms',
        testNote: (n) => 'Failover: ' + n,
        testEmpty: 'The search succeeded but returned no results.',
        testFailed: 'Test failed',
        loadFailed: 'Could not read the plugin settings',
        saveFailed: 'Save failed',
        pageHint: 'Settings are persisted through the plugin\u2019s own loopback bridge; priority and scoping changes apply to the next search.',
        searchBaseURL: 'Search endpoint',
        fetchBaseURL: 'Fetch endpoint',
        purpose: 'Intent hint (purpose)',
        language: 'Language',
        location: 'Location',
        domainType: 'Domain type',
        domainTypeAny: 'Any',
        includeDomains: 'Restrict to domains',
        excludeDomains: 'Exclude domains',
        afterDate: 'Earliest date (after_date)',
        beforeDate: 'Latest date (before_date)',
        recencyMinutes: 'Freshness (recency_minutes, 0 = off)',
        pubYearMin: 'Earliest year (pub_year_min, 0 = off)',
        pubYearMax: 'Latest year (pub_year_max, 0 = off)',
        maxPages: 'Max pages per search',
        fetchFormat: 'Fetch format',
        fetchLinks: 'Also return the page\u2019s links',
        verbose: 'Log every search and fetch',
        baseURL: 'API base URL',
        tag: 'Vertical tag',
        params: 'Vertical params (JSON)',
        zone: 'Zone',
        maxResults: 'Results per query (max_results)',
        commaHint: 'comma-separated',
        jsonHint: 'a JSON object; requires tag',
      },
    }

    /** Copy table for the active UI language. */
    function pickCopy() {
      const primary = typeof navigator === 'undefined'
        ? 'zh'
        : String((navigator.languages && navigator.languages[0]) || navigator.language || 'zh').toLowerCase()
      return primary.startsWith('en') ? I18N.en : I18N.zh
    }

    /* -------------------------------------------------------------- bridge IO */

    /** POST to the loopback bridge; always resolves to a JSON envelope. */
    async function bridge(path, payload) {
      try {
        const response = await fetch(BRIDGE_PREFIX + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload === undefined ? {} : payload),
        })
        return await response.json()
      } catch (error) {
        return { ok: false, code: 'bridge-unreachable', message: error instanceof Error ? error.message : String(error) }
      }
    }

    /* ---------------------------------------------------------- field schema */

    /**
     * The editable field tables: one entry per API parameter each backend
     * actually supports. Keeping them as data (rather than hand-written JSX per
     * field) means `pickEditable` and `diffOps` below stay in lockstep with the
     * form — adding a field is one entry and nothing else.
     */
    const TINYFISH_FIELDS = [
      { key: 'searchBaseURL', kind: 'text', label: 'searchBaseURL' },
      { key: 'fetchBaseURL', kind: 'text', label: 'fetchBaseURL' },
      { key: 'purpose', kind: 'text', label: 'purpose' },
      { key: 'language', kind: 'text', label: 'language' },
      { key: 'location', kind: 'text', label: 'location' },
      { key: 'domainType', kind: 'select', label: 'domainType', literalOptions: [
        ['', 'domainTypeAny'], ['web', 'domainType'], ['news', 'domainType'], ['research_paper', 'domainType'],
      ] },
      { key: 'includeDomains', kind: 'text', label: 'includeDomains', hint: 'commaHint' },
      { key: 'excludeDomains', kind: 'text', label: 'excludeDomains', hint: 'commaHint' },
      { key: 'afterDate', kind: 'text', label: 'afterDate', placeholder: 'YYYY-MM-DD' },
      { key: 'beforeDate', kind: 'text', label: 'beforeDate', placeholder: 'YYYY-MM-DD' },
      { key: 'recencyMinutes', kind: 'number', label: 'recencyMinutes' },
      { key: 'pubYearMin', kind: 'number', label: 'pubYearMin' },
      { key: 'pubYearMax', kind: 'number', label: 'pubYearMax' },
      { key: 'maxPages', kind: 'number', label: 'maxPages' },
      { key: 'fetchFormat', kind: 'select', label: 'fetchFormat', literalOptions: [
        ['markdown', null], ['html', null], ['json', null],
      ] },
      { key: 'fetchLinks', kind: 'toggle', label: 'fetchLinks' },
      { key: 'verbose', kind: 'toggle', label: 'verbose' },
    ]

    const ANYSEARCH_FIELDS = [
      { key: 'baseURL', kind: 'text', label: 'baseURL' },
      { key: 'tag', kind: 'text', label: 'tag', placeholder: 'finance.quote' },
      { key: 'params', kind: 'textarea', label: 'params', hint: 'jsonHint' },
      { key: 'zone', kind: 'text', label: 'zone' },
      { key: 'language', kind: 'text', label: 'language' },
      { key: 'maxResults', kind: 'number', label: 'maxResults' },
      { key: 'verbose', kind: 'toggle', label: 'verbose' },
    ]

    /** The field table for one backend id. */
    function fieldsOf(id) {
      return id === 'tinyfish' ? TINYFISH_FIELDS : ANYSEARCH_FIELDS
    }

    /** Extract the editable subset of a resolved config, per backend key. */
    function pickEditable(value) {
      const out = { priority: value.priority.slice(), failover: value.failover, searchBackend: value.searchBackend, fetchBackend: value.fetchBackend }
      for (const id of BACKENDS) {
        out[id] = { enabled: value[id].enabled }
        for (const field of fieldsOf(id)) out[id][field.key] = value[id][field.key]
      }
      return out
    }

    /**
     * Diff a draft against the saved baseline and emit path ops. Only changed
     * keys are sent, so a concurrent write to an unrelated field cannot be
     * clobbered by a stale full-section replace — the reason every field is
     * addressed by its own path instead of restating a whole section.
     */
    function diffOps(baseline, draft) {
      const ops = []
      if (draft.failover !== baseline.failover) ops.push({ op: 'set', path: ['failover'], value: draft.failover })
      if (draft.searchBackend !== baseline.searchBackend) ops.push({ op: 'set', path: ['searchBackend'], value: draft.searchBackend })
      if (draft.fetchBackend !== baseline.fetchBackend) ops.push({ op: 'set', path: ['fetchBackend'], value: draft.fetchBackend })
      if (draft.priority.join(',') !== baseline.priority.join(',')) {
        ops.push({ op: 'set', path: ['priority'], value: draft.priority })
      }
      for (const id of BACKENDS) {
        if (draft[id].enabled !== baseline[id].enabled) {
          ops.push({ op: 'set', path: [id, 'enabled'], value: draft[id].enabled })
        }
        for (const field of fieldsOf(id)) {
          if (draft[id][field.key] !== baseline[id][field.key]) {
            ops.push({ op: 'set', path: [id, field.key], value: draft[id][field.key] })
          }
        }
      }
      return ops
    }

    /* --------------------------------------------------------- shared widgets */

    /** One labelled control, driven entirely by a field descriptor. */
    function Field(props) {
      const { field, value, onChange, t, disabled } = props
      if (field.kind === 'toggle') {
        return jsx.jsxs('label', { className: 'dshhs-check', children: [
          jsx.jsx('input', {
            type: 'checkbox',
            checked: value === true,
            disabled: disabled === true,
            onChange: (event) => onChange(event.target.checked),
          }),
          jsx.jsx('span', { children: t[field.label] }),
        ] })
      }
      let control
      if (field.kind === 'select') {
        control = jsx.jsx('select', {
          className: 'dshhs-select',
          value: String(value),
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.value),
          children: field.literalOptions.map(([optionValue, labelKey]) =>
            jsx.jsx('option', { value: optionValue, children: labelKey === null ? optionValue : t[labelKey] }, optionValue)),
        })
      } else if (field.kind === 'textarea') {
        control = jsx.jsx('textarea', {
          className: 'dshhs-textarea',
          value: String(value),
          spellCheck: false,
          disabled: disabled === true,
          placeholder: field.placeholder,
          onChange: (event) => onChange(event.target.value),
        })
      } else if (field.kind === 'number') {
        control = jsx.jsx('input', {
          className: 'dshhs-input',
          type: 'number',
          value: String(value),
          disabled: disabled === true,
          onChange: (event) => {
            const parsed = Number(event.target.value)
            onChange(Number.isFinite(parsed) ? parsed : 0)
          },
        })
      } else {
        control = jsx.jsx('input', {
          className: 'dshhs-input',
          type: 'text',
          spellCheck: false,
          value: String(value),
          disabled: disabled === true,
          placeholder: field.placeholder,
          onChange: (event) => onChange(event.target.value),
        })
      }
      return jsx.jsxs('div', { className: 'dshhs-field', children: [
        jsx.jsxs('span', { className: 'dshhs-label', children: [
          t[field.label],
          field.hint === undefined ? null : ' ',
          field.hint === undefined ? null : jsx.jsx('span', { className: 'dshhs-version', children: '(' + t[field.hint] + ')' }),
        ] }),
        control,
      ] })
    }

    /**
     * The key badge for one backend. The credential center can be fed by
     * several layers of its own (`file` is the managed, writable document;
     * `env` is the launching environment, which is read-only and outranks it),
     * so naming the layer is what tells the operator whether the Clear button
     * can actually do anything.
     */
    function keyBadgeFor(credential, t, enabled) {
      if (!enabled) return { cls: ' dshhs-badgeOff', text: t.keyNone }
      if (!credential.configured) return { cls: ' dshhs-badgeWarn', text: t.keyNone }
      if (credential.source === 'env') return { cls: ' dshhs-badgeWarn', text: t.keyFromEnvLayer }
      if (credential.source === 'project-env' || credential.source === 'user-env') {
        return { cls: ' dshhs-badgeOk', text: t.keyFromDotenvLayer }
      }
      return { cls: ' dshhs-badgeOk', text: t.keyConfigured }
    }

    /** An accordion section holding one backend's key field and parameters. */
    function BackendSection(props) {
      const { id, t, draft, setDraft, open, setOpen, credential, keyDraft, setKeyDraft, onSaveKey, onClearKey, onTest, busy, keyNotice } = props
      const cfg = draft[id]
      const keyBadge = keyBadgeFor(credential, t, cfg.enabled === true)

      return jsx.jsxs('div', { className: 'dshhs-backend', children: [
        jsx.jsxs('button', {
          type: 'button',
          className: 'dshhs-bHead',
          'aria-expanded': open === id,
          onClick: () => setOpen(open === id ? '' : id),
          children: [
            jsx.jsx('span', { className: 'dshhs-chevron' + (open === id ? ' dshhs-chevronOpen' : ''), children: '\u25b6' }),
            jsx.jsx('span', { className: 'dshhs-pName', children: id }),
            jsx.jsx('span', { className: 'dshhs-badge' + keyBadge.cls, children: keyBadge.text }),
          ],
        }),
        open !== id ? null : jsx.jsxs('div', { className: 'dshhs-bBody', children: [
          jsx.jsx(Field, {
            field: { key: 'enabled', kind: 'toggle', label: 'enabled' },
            value: cfg.enabled,
            t,
            disabled: busy !== null,
            onChange: (next) => setDraft((prev) => Object.assign({}, prev, { [id]: Object.assign({}, prev[id], { enabled: next }) })),
          }),

          jsx.jsxs('div', { className: 'dshhs-section', children: [
            jsx.jsxs('div', { className: 'dshhs-sectionHead', children: [
              jsx.jsx('span', { className: 'dshhs-label', children: t.keys }),
              jsx.jsx('span', { className: 'dshhs-badge' + keyBadge.cls, children: keyBadge.text }),
            ] }),
            jsx.jsxs('div', { className: 'dshhs-row', children: [
              jsx.jsx('input', {
                className: 'dshhs-input',
                type: 'password',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: t.keyPlaceholder(credential.configured),
                value: keyDraft,
                disabled: busy !== null || !credential.available || !credential.writable,
                onChange: (event) => setKeyDraft(event.target.value),
              }),
              jsx.jsx('button', {
                type: 'button',
                className: 'dshhs-btn dshhs-save',
                disabled: busy !== null || keyDraft.trim().length === 0 || !credential.available || !credential.writable,
                onClick: onSaveKey,
                children: t.keySave,
              }),
              credential.configured
                ? jsx.jsx('button', {
                    type: 'button',
                    className: 'dshhs-btn',
                    // Clear stays enabled whenever a key is present, even when the
                    // credential center reports the store as non-writable: the
                    // key may live in a read-only layer that a human must remove
                    // elsewhere, and the click's answer says which. Disabling it
                    // outright is what made a configured key feel stuck.
                    disabled: busy !== null || !credential.available,
                    onClick: onClearKey,
                    children: t.keyClear,
                  })
                : null,
            ] }),
            jsx.jsx('p', { className: 'dshhs-hint', children: !credential.available
              ? t.keyCredUnavailable
              : credential.writable
                ? (id === 'anysearch' ? t.anysearchAnonNote + ' ' : '') + t.keyWritable
                : t.keyNotWritable }),
            keyNotice === null || keyNotice === undefined ? null : jsx.jsx('p', {
              className: keyNotice.kind === 'ok' ? 'dshhs-ok' : 'dshhs-err',
              children: keyNotice.text,
            }),
          ] }),

          jsx.jsx('div', { className: 'dshhs-sep' }),
          jsx.jsx('span', { className: 'dshhs-label', children: id === 'tinyfish' ? t.tinyfishParams : t.anysearchParams }),
          jsx.jsx('div', { className: 'dshhs-grid', children: fieldsOf(id).map((field) =>
            jsx.jsx(Field, {
              field,
              t,
              value: cfg[field.key],
              disabled: busy !== null,
              onChange: (next) => setDraft((prev) => Object.assign({}, prev, { [id]: Object.assign({}, prev[id], { [field.key]: next }) })),
            }, field.key)) }),
          jsx.jsxs('div', { className: 'dshhs-row', children: [
            jsx.jsx('button', {
              type: 'button',
              className: 'dshhs-btn',
              disabled: busy !== null,
              onClick: onTest,
              children: t.testBackend(id),
            }),
          ] }),
        ] }),
      ] })
    }

    /* --------------------------------------------------------- card component */

    /** The configuration card; `page: true` renders the bare form for the row page. */
    function HydraSearchCard(props) {
      const page = props !== null && typeof props === 'object' && props.page === true
      const t = pickCopy()

      const [phase, setPhase] = react.useState('loading')
      const [failure, setFailure] = react.useState('')
      const [draft, setDraft] = react.useState(null)
      const [baseline, setBaseline] = react.useState(null)
      const [meta, setMeta] = react.useState(null)
      const [busy, setBusy] = react.useState(null)
      const [notice, setNotice] = react.useState(null)
      const [keyDrafts, setKeyDrafts] = react.useState({ tinyfish: '', anysearch: '' })
      const [keyNotices, setKeyNotices] = react.useState({})
      const [open, setOpen] = react.useState('tinyfish')
      const [dragId, setDragId] = react.useState('')
      const [overId, setOverId] = react.useState('')
      const [autoKey, setAutoKey] = react.useState(null)

      const load = react.useCallback(async () => {
        setPhase('loading')
        const result = await bridge('/describe')
        if (!result.ok) {
          setFailure(result.message || t.loadFailed)
          setPhase('failed')
          return
        }
        const view = result.value.namespaces.find((entry) => entry.ns === NS)
        if (view === undefined) {
          setFailure(t.loadFailed)
          setPhase('failed')
          return
        }
        const editable = pickEditable(view.value)
        setDraft(editable)
        setBaseline(pickEditable(view.value))
        setMeta(Object.assign({}, result.value, { revision: view.revision }))
        setPhase('ready')
      }, [t])

      react.useEffect(() => {
        ensureStyles()
        void load()
      }, [load])

      const dirty = draft !== null && baseline !== null && diffOps(baseline, draft).length > 0

      const save = react.useCallback(async () => {
        if (draft === null || baseline === null) return
        const ops = diffOps(baseline, draft)
        if (ops.length === 0) {
          setNotice({ kind: 'ok', text: t.noChanges })
          return
        }
        setBusy('save')
        setNotice(null)
        const result = await bridge('/mutate', { ns: NS, ops, expectedRevision: meta ? meta.revision : undefined })
        setBusy(null)
        if (!result.ok) {
          setNotice({ kind: 'err', text: t.saveFailed + ': ' + result.message })
          void load()
          return
        }
        // Re-derive the baseline from what was actually written, so a field the
        // server normalized (e.g. a clamped number) does not stay "dirty".
        setBaseline(JSON.parse(JSON.stringify(draft)))
        setMeta((previous) => Object.assign({}, previous, { revision: result.value.revision }))
        setNotice({ kind: 'ok', text: t.saved })
      }, [baseline, draft, load, meta, t])

      const runTest = react.useCallback(async (backend) => {
        setBusy(backend === undefined ? 'chain' : 'backend:' + backend)
        setNotice(null)
        setAutoKey(null)
        const result = await bridge('/test', backend === undefined ? {} : { backend })
        setBusy(null)
        if (!result.ok) {
          setNotice({ kind: 'err', text: t.testFailed + ': ' + result.message })
          if (result.autoKey !== undefined) setAutoKey(result.autoKey)
          return
        }
        const value = result.value
        setNotice({
          kind: 'ok',
          text: (value.sources.length > 0 ? t.testOk(value) : t.testEmpty)
            + (value.note !== undefined && value.note.length > 0 ? '\n' + t.testNote(value.note) : ''),
          sources: value.sources,
        })
      }, [t])

      const saveKey = react.useCallback(async (backend) => {
        const value = keyDrafts[backend].trim()
        if (value.length === 0) return
        setBusy('key:' + backend)
        setKeyNotices((prev) => Object.assign({}, prev, { [backend]: null }))
        const result = await bridge('/key-set', { backend, value })
        setBusy(null)
        if (!result.ok) {
          setKeyNotices((prev) => Object.assign({}, prev, { [backend]: { kind: 'err', text: result.message } }))
          return
        }
        setKeyDrafts((prev) => Object.assign({}, prev, { [backend]: '' }))
        setKeyNotices((prev) => Object.assign({}, prev, { [backend]: { kind: 'ok', text: t.saved } }))
        void load()
      }, [keyDrafts, load, t])

      const clearKey = react.useCallback(async (backend) => {
        setBusy('key:' + backend)
        setKeyNotices((prev) => Object.assign({}, prev, { [backend]: null }))
        const result = await bridge('/key-unset', { backend })
        setBusy(null)
        if (!result.ok) {
          setKeyNotices((prev) => Object.assign({}, prev, { [backend]: { kind: 'err', text: result.message } }))
          return
        }
        // The route reports whether the clear actually took effect: a read-only
        // layer inside the credential center can still supply the reference
        // after the writable document is emptied. Saying "cleared" then would be
        // the exact lie this button exists to stop telling.
        const value = result.value
        setKeyNotices((prev) => Object.assign({}, prev, {
          [backend]: value !== null && value !== undefined && value.cleared === false
            ? { kind: 'err', text: t.keyClearShadowed(value.shadowedBy === undefined ? '?' : value.shadowedBy) }
            : { kind: 'ok', text: t.keyCleared },
        }))
        void load()
      }, [load, t])

      const adoptKey = react.useCallback(async () => {
        if (autoKey === null) return
        setBusy('adopt')
        const result = await bridge('/key-adopt', { key: autoKey })
        setBusy(null)
        if (!result.ok) {
          setNotice({ kind: 'err', text: result.message })
          return
        }
        setAutoKey(null)
        setNotice({ kind: 'ok', text: t.autoKeySaved(result.value.ref ?? result.value.stored) })
        void load()
      }, [autoKey, load, t])

      /**
       * Move the backend at `from` to index `to`, in the draft only. The order is
       * persisted by the same Save button as everything else, so a drag is
       * reviewable before it takes effect rather than writing on drop.
       */
      const move = react.useCallback((from, to) => {
        setDraft((prev) => {
          if (prev === null || from === to || to < 0 || to >= prev.priority.length) return prev
          const next = prev.priority.slice()
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          return Object.assign({}, prev, { priority: next })
        })
      }, [])

      const cardClass = 'dshhs-card' + (page ? ' dshhs-pageMode' : '')

      if (phase !== 'ready') {
        return jsx.jsxs('div', { className: cardClass, children: [
          jsx.jsxs('div', { className: 'dshhs-headText', children: [
            jsx.jsx('span', { className: 'dshhs-name', children: t.title }),
            jsx.jsx('span', { className: 'dshhs-description', children: t.description }),
          ] }),
          jsx.jsx('div', { className: 'dshhs-body', children: phase === 'failed'
            ? jsx.jsxs(react.Fragment, { children: [
                jsx.jsx('p', { className: 'dshhs-err', children: t.loadFailed + ': ' + failure }),
                jsx.jsx('div', { className: 'dshhs-row', children: jsx.jsx('button', {
                  type: 'button', className: 'dshhs-btn', onClick: () => void load(), children: t.reload,
                }) }),
              ] })
            : jsx.jsx('p', { className: 'dshhs-hint', children: '\u2026' }) }),
        ] })
      }

      /**
       * The card's view of one backend's credential. Everything comes from the
       * bridge's `credentials` block, which describes the credential center —
       * the only store this plugin reads, writes, or clears.
       */
      const credentialFor = (id) => Object.assign(
        { configured: false, writable: false, available: false, source: undefined },
        meta.credentials[id],
      )

      const priorityItem = (id, index) => {
        const enabled = draft[id].enabled === true
        const state = keyBadgeFor(credentialFor(id), t, enabled)
        return jsx.jsxs('li', {
          className: 'dshhs-pItem' + (dragId === id ? ' dshhs-pItemDrag' : '') + (overId === id && dragId !== id ? ' dshhs-pItemOver' : ''),
          draggable: true,
          tabIndex: 0,
          'aria-label': id + ' (' + (index + 1) + '/' + draft.priority.length + ')',
          onDragStart: (event) => {
            setDragId(id)
            event.dataTransfer.effectAllowed = 'move'
            // Some browsers require data to be set for a drag to start at all.
            try { event.dataTransfer.setData('text/plain', id) } catch { /* ignore */ }
          },
          onDragEnd: () => { setDragId(''); setOverId('') },
          onDragOver: (event) => { event.preventDefault(); setOverId(id) },
          onDragLeave: () => setOverId((prev) => (prev === id ? '' : prev)),
          onDrop: (event) => {
            event.preventDefault()
            if (dragId !== '' && dragId !== id) move(draft.priority.indexOf(dragId), index)
            setDragId('')
            setOverId('')
          },
          onKeyDown: (event) => {
            // Alt+Arrows move the focused row without a pointer: the keyboard
            // path for an operation the mouse alone would gate.
            if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); move(index, index - 1) }
            if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); move(index, index + 1) }
          },
          children: [
            jsx.jsx('span', { className: 'dshhs-pGrip', 'aria-hidden': 'true', children: '\u2630' }),
            jsx.jsx('span', { className: 'dshhs-pRank', children: String(index + 1) }),
            jsx.jsx('span', { className: 'dshhs-pName', children: id }),
            jsx.jsx('span', { className: 'dshhs-badge' + state.cls, children: state.text }),
            jsx.jsxs('span', { className: 'dshhs-pMoves', children: [
              jsx.jsx('button', {
                type: 'button', className: 'dshhs-iconBtn', title: '\u2191', 'aria-label': '\u2191',
                disabled: index === 0 || busy !== null,
                onClick: () => move(index, index - 1),
                children: '\u2191',
              }),
              jsx.jsx('button', {
                type: 'button', className: 'dshhs-iconBtn', title: '\u2193', 'aria-label': '\u2193',
                disabled: index === draft.priority.length - 1 || busy !== null,
                onClick: () => move(index, index + 1),
                children: '\u2193',
              }),
            ] }),
          ],
        }, id)
      }

      /**
       * One "which backend serves this capability" selector. Renders the same
       * way for search and fetch, and offers only ids that are actually in the
       * priority list so a pin can never name a backend the chain no longer has.
       */
      const backendSelect = (key, label) => jsx.jsxs('div', { className: 'dshhs-field', children: [
        jsx.jsx('span', { className: 'dshhs-label', children: label }),
        jsx.jsx('select', {
          className: 'dshhs-select',
          value: draft[key],
          disabled: busy !== null,
          onChange: (event) => setDraft((prev) => Object.assign({}, prev, { [key]: event.target.value })),
          children: [
            jsx.jsx('option', { value: 'auto', children: t.fetchBackendAuto }, 'auto'),
            ...draft.priority.map((id) => jsx.jsx('option', { value: id, children: id }, id)),
          ],
        }),
      ] }, key)

      const results = notice !== null && notice.kind === 'ok' && Array.isArray(notice.sources) && notice.sources.length > 0
        ? jsx.jsx('div', { className: 'dshhs-result', children: notice.sources.map((source, index) =>
            jsx.jsx('a', {
              href: source.url,
              target: '_blank',
              rel: 'noreferrer noopener',
              children: (index + 1) + '. ' + (source.title === undefined ? source.url : source.title),
            }, source.url)) })
        : null

      const body = jsx.jsxs('div', { className: 'dshhs-body', children: [
        page ? jsx.jsx('p', { className: 'dshhs-hint', children: t.pageHint }) : null,

        jsx.jsxs('div', { className: 'dshhs-section', children: [
          jsx.jsx('span', { className: 'dshhs-label', children: t.priority }),
          jsx.jsx('p', { className: 'dshhs-hint', children: t.priorityHint }),
          jsx.jsx('ul', { className: 'dshhs-priority', children: draft.priority.map(priorityItem) }),
          jsx.jsx(Field, {
            field: { key: 'failover', kind: 'toggle', label: 'failover' },
            value: draft.failover,
            t,
            disabled: busy !== null,
            onChange: (next) => setDraft((prev) => Object.assign({}, prev, { failover: next })),
          }),
          jsx.jsx('p', { className: 'dshhs-hint', children: t.failoverHint }),
          // Both capabilities get their own pin selector. Pinning is purely a
          // config concern now that the plugin registers a single provider, so
          // these two selects are the only way to bypass the chain.
          backendSelect('searchBackend', t.searchBackend),
          backendSelect('fetchBackend', t.fetchBackend),
        ] }),

        jsx.jsx('div', { className: 'dshhs-sep' }),

        ...BACKENDS.map((id) => jsx.jsx(BackendSection, {
          id,
          t,
          draft,
          setDraft,
          open,
          setOpen,
          credential: credentialFor(id),
          keyDraft: keyDrafts[id],
          setKeyDraft: (value) => setKeyDrafts((prev) => Object.assign({}, prev, { [id]: value })),
          onSaveKey: () => void saveKey(id),
          onClearKey: () => void clearKey(id),
          onTest: () => void runTest(id),
          busy,
          keyNotice: keyNotices[id],
        }, id)),

        autoKey === null ? null : jsx.jsxs('div', { className: 'dshhs-warn', children: [
          jsx.jsx('strong', { children: t.autoKeyTitle }),
          jsx.jsx('p', { className: 'dshhs-hint', children: t.autoKeyBody }),
          jsx.jsx('div', { className: 'dshhs-mono', children: autoKey }),
          jsx.jsxs('div', { className: 'dshhs-row', style: { marginTop: '6px' }, children: [
            jsx.jsx('button', {
              type: 'button', className: 'dshhs-btn dshhs-save',
              disabled: busy !== null,
              onClick: () => void adoptKey(),
              children: t.autoKeySaveCred,
            }),
          ] }),
        ] }),

        jsx.jsx('div', { className: 'dshhs-sep' }),

        jsx.jsxs('div', { className: 'dshhs-footer', children: [
          jsx.jsxs('div', { className: 'dshhs-row', children: [
            jsx.jsx('button', {
              type: 'button',
              className: 'dshhs-btn',
              disabled: busy !== null,
              onClick: () => void runTest(undefined),
              children: busy === 'chain' ? t.testing : t.testChain,
            }),
            jsx.jsx('span', { className: 'dshhs-version', children: 'v' + meta.version + ' \u00b7 ' + meta.chain.providerId }),
          ] }),
          jsx.jsxs('div', { className: 'dshhs-row', children: [
            dirty ? jsx.jsx('span', { className: 'dshhs-badge dshhs-badgeWarn', children: t.unsaved }) : null,
            jsx.jsx('button', {
              type: 'button',
              className: 'dshhs-btn dshhs-save',
              disabled: busy !== null || !dirty,
              onClick: () => void save(),
              children: busy === 'save' ? t.saving : t.save,
            }),
          ] }),
        ] }),

        notice === null ? null : jsx.jsx('p', {
          className: notice.kind === 'ok' ? 'dshhs-ok' : 'dshhs-err',
          children: notice.text,
        }),
        results,
      ] })

      return jsx.jsxs('div', { className: cardClass, children: [
        jsx.jsxs('div', { className: 'dshhs-headText', children: [
          jsx.jsx('span', { className: 'dshhs-name', children: t.title }),
          jsx.jsx('span', { className: 'dshhs-description', children: t.description }),
        ] }),
        body,
      ] })
    }

    /** One-line summary the Plugins page shows on the row (`view: 'summary'`). */
    function Summary() {
      return jsx.jsx('span', { children: pickCopy().summary })
    }

    /* ---------------------------------------------------------------- plugin */

    /** Services required by the browser half. */
    const inject = ['slots']

    /**
     * Mount the browser half.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      // DSH 0.1.6-alpha.2+ Plugins page: 已安装 → the row's configure control.
      // The key is `<package name>#<row id>`, so it must match the row id in
      // cordis.patch.yml. The owner renders `summary` inside a <p> (so that
      // branch must return inline nodes) and `page` as the form body.
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
        { name: 'plugins.row.config', key: 'dsh-hydrasearch#hydrasearch' },
        (slotProps) => (slotProps !== null && typeof slotProps === 'object' && slotProps.view === 'summary'
          ? jsx.jsx(Summary, {})
          : jsx.jsx(HydraSearchCard, { page: true })),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
