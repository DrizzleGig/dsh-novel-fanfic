// DSH 侧边栏（右侧栏）客户端：同人「原著档案」面板。
// 信息架构按 docs/小说插件系列-fanfic-侧边栏IA-v1.md 与效果图 fanfic-sidebar-ia-v1.png：
//   4 个一级区（总览/设定/剧情/原文）+ 5 个设定子区（人物/势力/关系/世界/冲突）
//   + 审阅徽标（右上）+ 写作抽屉（右下）。
// 数据来自宿主的面板 read remote（0.2.3 起）：客户端不读文件、不复制 canon 逻辑；
// 写入与编译都在宿主（index.js）完成，这里只做展示与触发。
// 注意：读数据不许再借 `/fic ... --json` 命令——commands.execute() 会往会话日志写行。
// 样式只用 --dsw-alias-* 主题 token（深浅色跟随 DSH），不引外部图标库，图标是内联 SVG。

window.__ModuleLoader__.load({
  id: 'dsh-novel-fanfic',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const TAB_ID = 'dsh-novel-fanfic';
    const KIND = 'fanfic';
    const LABEL = '同人';
    const TITLE = '同人工作室';

    // ── panel remote 契约（与 lib/remote-contract.js 对齐）──────────────────────
    // 客户端不能 require 宿主的 lib/，所以协议在这里内嵌一份；test 里核对两侧一致。
    const panelScalar = (validate) => ({
      parse(value) {
        validate(value);
        return value;
      },
      safeParse(value) {
        try {
          validate(value);
          return { success: true, data: value };
        } catch (error) {
          return { success: false, error };
        }
      },
    });
    const panelCodec = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, create: () => schema });
    const panelParam = (name, schema) => ({ name, wire: name, source: 'json', codec: panelCodec(name, schema) });
    const PANEL_METHODS = [
      'identity', 'getPanel', 'listProjects', 'getChapter', 'getContract', 'getPlan',
      'search', 'previewImport', 'listImportFiles', 'checkDraft', 'pickDirectory', 'getDeltas',
    ];
    const TYPERT_REMOTE = {
      package: 'dsh-novel-fanfic',
      descriptors: PANEL_METHODS.map((method) => ({
        id: 'dsh-novel-fanfic#novelFanficPanel/' + method,
        namespace: 'novelFanficPanel',
        service: 'novelFanficPanel',
        method,
        invocation: { kind: 'direct' },
        parameters: method === 'identity'
          ? [panelParam('sessionId', panelScalar((v) => { if (typeof v !== 'string' || !v) throw new Error('sessionId must be a non-empty string'); }))]
          : [
            panelParam('sessionId', panelScalar((v) => { if (typeof v !== 'string' || !v) throw new Error('sessionId must be a non-empty string'); })),
            panelParam('request', panelScalar((v) => { if (v !== undefined && v !== null && (typeof v !== 'object' || Array.isArray(v))) throw new Error('request must be a plain object'); })),
          ],
        result: panelCodec('FanficPanelPayload', panelScalar(() => {})),
      })),
    };

    // ── 主题 token ────────────────────────────────────────────────────────────
    const c = {
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary)',
      caption: 'var(--dsw-alias-label-caption)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      base: 'var(--dsw-alias-bg-base)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      layer3: 'var(--dsw-alias-bg-layer-3)',
      brand: 'var(--dsw-alias-brand-primary)',
      onBrand: 'var(--dsw-alias-label-on-color)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      card: 'var(--dsw-alias-card-fill)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      business: 'var(--dsw-alias-state-business-primary)',
      mask: 'var(--dsw-alias-bg-mask-1)',
    };

    const STATUS = {
      confirmed: { label: '已确认', tone: c.success },
      pending: { label: '待审', tone: c.warn },
      conflict: { label: '有矛盾', tone: c.error },
      rejected: { label: '已拒绝', tone: c.faint },
      derived: { label: '归纳', tone: c.business },
      open: { label: '未裁决', tone: c.warn },
      resolved: { label: '已裁决', tone: c.success },
    };

    // ── 样式层（v0.2.0 重设计）────────────────────────────────────────────────
    // 只为「新的骨架」服务：顶栏 / 下一步 / 一级 tab / chips / 卡片 / sheet / 任务卡。
    // 颜色全部映射到宿主 token（hex 只是 fallback），深色跟随宿主，不自建开关。
    const CORE_CSS = [
      '.fic-panel{--fic-ink:var(--dsw-alias-label-primary,#1b2027);',
      '--fic-ink2:var(--dsw-alias-label-secondary,#4a545f);',
      '--fic-ink3:var(--dsw-alias-label-tertiary,#6f7a87);',
      '--fic-line:var(--dsw-alias-border-l1,#e3e7ec);',
      '--fic-line2:var(--dsw-alias-border-l2,#d3d9e1);',
      '--fic-surface:var(--dsw-alias-bg-layer-1,#fff);',
      '--fic-surface2:var(--dsw-alias-bg-layer-2,#f2f4f7);',
      '--fic-surface3:var(--dsw-alias-bg-layer-3,#e9edf2);',
      '--fic-brand:var(--dsw-alias-brand-primary,#3d5e8c);',
      '--fic-onbrand:var(--dsw-alias-label-on-color,#fff);',
      '--fic-ok:var(--dsw-alias-state-success-primary,#16805a);',
      '--fic-warn:var(--dsw-alias-state-warn-primary,#9a6410);',
      '--fic-bad:var(--dsw-alias-state-error-primary,#b23c40);}',
      '.fic-panel *{box-sizing:border-box;}',
      '.fic-head{padding:11px 14px 9px;background:var(--fic-surface);border-bottom:1px solid var(--fic-line);flex:none;}',
      '.fic-head-row{display:flex;align-items:center;gap:8px;}',
      '.fic-mark{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;flex:none;',
      'background:color-mix(in srgb,var(--fic-brand) 12%,var(--fic-surface2));color:var(--fic-brand);}',
      '.fic-title{font-size:14.5px;font-weight:600;color:var(--fic-ink);letter-spacing:.01em;}',
      '.fic-ver{font-family:Cascadia Mono,Consolas,ui-monospace,monospace;font-size:10.5px;color:var(--fic-ink3);',
      'border:1px solid var(--fic-line2);border-radius:5px;padding:0 4px;line-height:16px;}',
      '.fic-next{margin:10px 14px 0;padding:9px 11px;border-radius:12px;display:flex;align-items:flex-start;gap:9px;flex:none;',
      'background:color-mix(in srgb,var(--fic-brand) 8%,var(--fic-surface));border:1px solid color-mix(in srgb,var(--fic-brand) 28%,var(--fic-line));}',
      '.fic-next-kicker{font-family:Cascadia Mono,Consolas,monospace;font-size:9.5px;letter-spacing:.12em;',
      'text-transform:uppercase;color:var(--fic-brand);margin-top:3px;flex:none;}',
      '.fic-next-body{flex:1;min-width:0;}',
      '.fic-next-title{font-size:12.5px;color:var(--fic-ink);line-height:1.5;}',
      '.fic-next-title b{font-weight:600;}',
      '.fic-next-why{display:block;font-size:11px;color:var(--fic-ink3);margin-top:1px;line-height:1.5;}',
      '.fic-next .fic-btn{flex:none;}',
      '.fic-btn{height:28px;padding:0 11px;border-radius:8px;border:1px solid var(--fic-line2);background:var(--fic-surface);',
      'color:var(--fic-ink);font-size:12px;font-family:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;}',
      '.fic-btn:hover{background:var(--fic-surface2);}',
      '.fic-btn.primary{background:var(--fic-brand);border-color:var(--fic-brand);color:var(--fic-onbrand);font-weight:600;}',
      '.fic-btn.ghost{background:transparent;border-color:transparent;color:var(--fic-ink3);}',
      '.fic-btn.small{height:25px;padding:0 9px;font-size:11.5px;}',
      '.fic-btn:disabled{opacity:.5;cursor:default;}',
      '.fic-tabs{display:flex;gap:2px;padding:9px 14px 0;flex:none;border-bottom:1px solid var(--fic-line);}',
      '.fic-tab{flex:1;height:33px;border:0;background:transparent;color:var(--fic-ink2);font-family:inherit;font-size:12.5px;',
      'cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;border-bottom:2px solid transparent;padding:0;}',
      '.fic-tab:hover{color:var(--fic-ink);}',
      '.fic-tab[aria-selected="true"]{color:var(--fic-brand);font-weight:600;border-bottom-color:var(--fic-brand);}',
      '.fic-tab .n{font-family:Cascadia Mono,Consolas,monospace;font-size:10px;color:var(--fic-ink3);font-weight:400;}',
      '.fic-chips{display:flex;gap:6px;overflow-x:auto;padding:10px 14px 2px;scrollbar-width:none;flex:none;}',
      '.fic-chips::-webkit-scrollbar{display:none;}',
      '.fic-chip{flex:none;height:26px;padding:0 10px;border-radius:99px;border:1px solid var(--fic-line2);background:var(--fic-surface);',
      'color:var(--fic-ink2);font-family:inherit;font-size:11.5px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;}',
      '.fic-chip[aria-pressed="true"]{background:var(--fic-ink);border-color:var(--fic-ink);color:var(--fic-surface);font-weight:600;}',
      '.fic-chip .n{font-family:Cascadia Mono,Consolas,monospace;font-size:10px;color:var(--fic-ink3);}',
      '.fic-chip[aria-pressed="true"] .n{color:var(--fic-surface);opacity:.75;}',
      '.fic-chip .flag{width:5px;height:5px;border-radius:99px;background:var(--fic-warn);}',
      '.fic-pill{margin-left:auto;display:inline-flex;align-items:center;gap:5px;height:25px;padding:0 9px;border-radius:99px;',
      'border:1px solid var(--fic-line2);background:var(--fic-surface);color:var(--fic-ink2);font-family:inherit;font-size:11.5px;cursor:pointer;}',
      '.fic-pill.count{color:var(--fic-warn);font-weight:600;border-color:color-mix(in srgb,var(--fic-warn) 34%,var(--fic-line2));',
      'background:color-mix(in srgb,var(--fic-warn) 12%,var(--fic-surface));}',
      '.fic-sect{margin:14px 0 0;}',
      '.fic-sect:first-child{margin-top:0;}',
      '.fic-sect-head{display:flex;align-items:baseline;gap:6px;margin-bottom:7px;}',
      '.fic-sect-title{font-size:12px;font-weight:600;color:var(--fic-ink2);letter-spacing:.02em;}',
      '.fic-sect-meta{margin-left:auto;font-family:Cascadia Mono,Consolas,monospace;font-size:10px;color:var(--fic-ink3);}',
      '.fic-card{background:var(--fic-surface);border:1px solid var(--fic-line);border-radius:12px;padding:11px 12px;}',
      '.fic-card+.fic-card{margin-top:8px;}',
      '.fic-card.flat{background:var(--fic-surface2);border-color:transparent;}',
      '.fic-mission{background:var(--fic-surface);border:1px solid color-mix(in srgb,var(--fic-brand) 30%,var(--fic-line));',
      'border-radius:12px;overflow:hidden;}',
      '.fic-mission-head{padding:9px 12px;display:flex;align-items:center;gap:7px;',
      'background:color-mix(in srgb,var(--fic-brand) 8%,var(--fic-surface));border-bottom:1px solid color-mix(in srgb,var(--fic-brand) 22%,var(--fic-line));}',
      '.fic-mission-head .t{font-size:12.5px;font-weight:600;color:var(--fic-ink);}',
      '.fic-mission-body{padding:2px 12px 10px;}',
      '.fic-field{display:flex;gap:10px;padding:6px 0;border-bottom:1px dashed var(--fic-line);}',
      '.fic-field:last-child{border-bottom:0;}',
      '.fic-field .k{flex:none;width:54px;font-size:11.5px;color:var(--fic-ink3);padding-top:1px;}',
      '.fic-field .v{flex:1;font-size:12px;color:var(--fic-ink);line-height:1.65;min-width:0;word-break:break-word;}',
      '.fic-field .v.muted{color:var(--fic-ink3);}',
      '.fic-field .add{color:var(--fic-brand);cursor:pointer;border-bottom:1px dashed color-mix(in srgb,var(--fic-brand) 40%,transparent);}',
      '.fic-beats{margin:0;padding-left:15px;}',
      '.fic-beats li{font-size:12px;line-height:1.7;}',
      '.fic-beats li::marker{color:var(--fic-ink3);font-family:Cascadia Mono,Consolas,monospace;font-size:10px;}',
      '.fic-tag{display:inline-flex;align-items:center;height:17px;padding:0 5px;border-radius:4px;font-size:10px;',
      'background:var(--fic-surface3);color:var(--fic-ink3);}',
      '.fic-tag.brand{background:color-mix(in srgb,var(--fic-brand) 14%,var(--fic-surface));color:var(--fic-brand);}',
      '.fic-tag.warn{background:color-mix(in srgb,var(--fic-warn) 14%,var(--fic-surface));color:var(--fic-warn);}',
      '.fic-tag.ok{background:color-mix(in srgb,var(--fic-ok) 14%,var(--fic-surface));color:var(--fic-ok);}',
      '.fic-tag.bad{background:color-mix(in srgb,var(--fic-bad) 14%,var(--fic-surface));color:var(--fic-bad);}',
      '.fic-quote{border-left:2px solid color-mix(in srgb,var(--fic-brand) 40%,var(--fic-line));padding:2px 0 2px 9px;margin:6px 0 0;',
      'font-family:var(--dsw-font-family,inherit);font-size:12px;color:var(--fic-ink2);}',
      '.fic-quote .src{display:block;margin-top:2px;font-family:Cascadia Mono,Consolas,monospace;font-size:10px;color:var(--fic-ink3);}',
      '.fic-acc{border:1px solid var(--fic-line);border-radius:12px;background:var(--fic-surface);overflow:hidden;}',
      '.fic-acc+.fic-acc{margin-top:8px;}',
      '.fic-acc-head{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;}',
      '.fic-acc-head:hover{background:var(--fic-surface2);}',
      '.fic-acc-head .t{font-size:12px;font-weight:600;color:var(--fic-ink);}',
      '.fic-acc-head .n{margin-left:auto;font-family:Cascadia Mono,Consolas,monospace;font-size:10px;color:var(--fic-ink3);}',
      '.fic-acc-body{padding:0 12px 10px;}',
      '.fic-acc-line{display:flex;gap:8px;font-size:11.5px;padding:5px 0;border-top:1px dashed var(--fic-line);}',
      '.fic-acc-line b{flex:none;width:52px;font-weight:600;color:var(--fic-ink3);font-size:11px;}',
      '.fic-acc-line span{flex:1;color:var(--fic-ink2);line-height:1.65;min-width:0;word-break:break-word;}',
      '.fic-foot{flex:none;padding:9px 14px 11px;background:var(--fic-surface);border-top:1px solid var(--fic-line);',
      'display:flex;align-items:center;gap:8px;}',
      '.fic-foot .hint{margin-left:auto;font-family:Cascadia Mono,Consolas,monospace;font-size:10px;color:var(--fic-ink3);}',
      '.fic-sheet-mask{position:absolute;inset:0;z-index:40;background:var(--dsw-alias-bg-mask-1,rgba(16,22,32,.34));',
      'display:flex;flex-direction:column;justify-content:flex-end;}',
      '.fic-sheet{background:var(--fic-surface);border-radius:16px 16px 0 0;max-height:84%;display:flex;flex-direction:column;overflow:hidden;',
      'box-shadow:0 -8px 28px -12px rgba(16,22,32,.35);}',
      '.fic-sheet-body{padding:4px 14px 14px;overflow-y:auto;overscroll-behavior:contain;}',
      '@media (prefers-reduced-motion:no-preference){.fic-sheet{animation:fic-up .18s ease-out both;}}',
      '@keyframes fic-up{from{transform:translateY(14px);opacity:.72;}to{transform:none;opacity:1;}}',
      '.fic-link{border:0;background:transparent;padding:0;cursor:pointer;color:var(--fic-brand);font-family:inherit;font-size:11.5px;}',
      '.fic-link.muted{color:var(--fic-ink3);}',
    ].join('');

    function Styles() {
      return h('style', { 'data-novel-fanfic': '' }, CORE_CSS);
    }


    // ── 图标（内联 SVG，颜色跟随 currentColor） ───────────────────────────────
    const ICONS = {
      overview: ['M3 4h7v7H3z', 'M14 4h7v4h-7z', 'M14 11h7v9h-7z', 'M3 14h7v6H3z'],
      settings: ['M9 3.6a2 2 0 0 1 3.8 0l.4 1.2 1.2-.3a2 2 0 0 1 2.3 2.3l-.3 1.2 1.2.4a2 2 0 0 1 0 3.8l-1.2.4.3 1.2a2 2 0 0 1-2.3 2.3l-1.2-.3-.4 1.2a2 2 0 0 1-3.8 0l-.4-1.2-1.2.3a2 2 0 0 1-2.3-2.3l.3-1.2-1.2-.4a2 2 0 0 1 0-3.8l1.2-.4-.3-1.2a2 2 0 0 1 2.3-2.3l1.2.3z', 'M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2z'],
      plot: ['M3 5.5 10 3l7 2.5v12L10 20l-7-2.5z', 'M10 3v17'],
      source: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M8.5 12h7', 'M8.5 15.5h5'],
      user: ['M12 4.2a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2z', 'M4.8 20c.6-3.6 3.6-5.6 7.2-5.6s6.6 2 7.2 5.6'],
      faction: ['M12 3 4.5 6v6c0 4 3.1 6.9 7.5 9 4.4-2.1 7.5-5 7.5-9V6z'],
      link: ['M9.5 14.5 14.5 9.5', 'M7.2 16.8a3.5 3.5 0 0 1 0-5l2-2a3.5 3.5 0 0 1 5 0', 'M16.8 7.2a3.5 3.5 0 0 1 0 5l-2 2a3.5 3.5 0 0 1-5 0'],
      world: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.6 2.6 4 5.6 4 9s-1.4 6.4-4 9c-2.6-2.6-4-5.6-4-9s1.4-6.4 4-9z'],
      conflict: ['M13 3 5 13h5l-1 8 8-10h-5z'],
      search: ['M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M16 16l4 4'],
      bell: ['M6.5 9.5a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5z', 'M10 18.5a2 2 0 0 0 4 0'],
      refresh: ['M4.5 12a7.5 7.5 0 0 1 12.8-5.3L20 9', 'M20 4v5h-5', 'M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4 15', 'M4 20v-5h5'],
      close: ['M6 6l12 12', 'M18 6 6 18'],
      chevron: ['M9 6l6 6-6 6'],
      pen: ['M4 20l4-1 10-10-3-3L5 16z', 'M14.5 6.5l3 3'],
      check: ['M5 12.5 9.5 17 19 7'],
      bookmark: ['M7 4h10v16l-5-3.5L7 20z'],
      clock: ['M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z', 'M12 8v4.5l3 2'],
      flag: ['M6 3v18', 'M6 4.5h11l-2 4 2 4H6'],
      quote: ['M8 7H5v5h3c0 2-1 3-3 3.5', 'M17 7h-3v5h3c0 2-1 3-3 3.5'],
    };

    function Icon(props) {
      const paths = ICONS[props.name] || ICONS.overview;
      const size = props.size || 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: props.weight || 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: Object.assign({ display: 'block', flexShrink: 0 }, props.style || {}),
        },
        paths.map((d, i) => h('path', { key: 'p' + i, d: d })),
      );
    }

    // ── 小部件 ────────────────────────────────────────────────────────────────
    function chip(text, tone, extra) {
      return h(
        'span',
        {
          style: Object.assign(
            {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '1px 7px',
              borderRadius: 999,
              border: '1px solid ' + (tone || c.border2),
              color: tone || c.sub,
              fontSize: 10.5,
              lineHeight: '17px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            },
            extra || {},
          ),
        },
        text,
      );
    }

    function statusChip(status) {
      const meta = STATUS[status] || STATUS.pending;
      return chip(meta.label, meta.tone);
    }

    function dot(tone, size) {
      return h('span', {
        style: { width: size || 6, height: size || 6, borderRadius: 99, background: tone || c.success, display: 'inline-block', flexShrink: 0 },
      });
    }

    function iconButton(props) {
      return h(
        'button',
        {
          type: 'button',
          title: props.title,
          onClick: props.onClick,
          disabled: props.disabled,
          style: {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            padding: 0,
            border: '1px solid transparent',
            borderRadius: 8,
            background: 'transparent',
            color: props.active ? c.brand : c.sub,
            cursor: 'pointer',
            fontFamily: 'inherit',
          },
        },
        h(Icon, { name: props.icon, size: props.size || 16 }),
        props.badge ? h(
          'span',
          {
            style: {
              position: 'absolute', top: 0, right: 0, minWidth: 13, height: 13, padding: '0 3px',
              borderRadius: 99, background: c.error, color: c.onBrand, fontSize: 9, lineHeight: '13px',
              textAlign: 'center', fontWeight: 600, boxSizing: 'border-box',
              boxShadow: '0 0 0 2px ' + c.base,
            },
          },
          props.badge > 99 ? '99+' : String(props.badge),
        ) : null,
      );
    }

    function button(props) {
      const variant = props.variant || 'ghost';
      const base = {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        border: '1px solid ' + (variant === 'primary' ? 'transparent' : c.border2),
        background: variant === 'primary' ? c.brand : variant === 'soft' ? c.layer2 : 'transparent',
        color: variant === 'primary' ? c.onBrand : props.tone || c.text,
        borderRadius: 8,
        padding: props.small ? '3px 9px' : '5px 11px',
        fontSize: props.small ? 11.5 : 12.5,
        lineHeight: '18px',
        fontWeight: variant === 'primary' ? 600 : 500,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      };
      return h(
        'button',
        { type: 'button', onClick: props.onClick, disabled: props.disabled, title: props.title, style: Object.assign(base, props.style || {}) },
        props.icon ? h(Icon, { name: props.icon, size: props.small ? 12 : 14 }) : null,
        props.children,
      );
    }

    // 档案卡片的色彩与图案：同一个名字永远得到同一套色相和纹理，不读图片、不联网。
    // 图案只用 CSS 渐变，浅色/深色主题都能落在当前卡片上。
    function artOf(text) {
      const value = String(text || '?');
      let a = 0;
      let b = 0;
      for (let i = 0; i < value.length; i += 1) {
        a = (a * 31 + value.charCodeAt(i)) % 997;
        b = (b * 17 + value.charCodeAt(i) * (i + 3)) % 991;
      }
      const hue = a % 360;
      return { hue, hue2: (hue + 28 + (b % 70)) % 360, pattern: b % 6 };
    }

    function patternLayers(pattern, alpha) {
      const line = 'rgba(255,255,255,' + alpha + ')';
      if (pattern === 0) return 'repeating-linear-gradient(135deg, ' + line + ' 0 2px, transparent 2px 8px)';
      if (pattern === 1) return 'radial-gradient(circle, ' + line + ' 1px, transparent 1.4px)';
      if (pattern === 2) return 'repeating-linear-gradient(0deg, ' + line + ' 0 1px, transparent 1px 7px), repeating-linear-gradient(90deg, ' + line + ' 0 1px, transparent 1px 7px)';
      if (pattern === 3) return 'repeating-radial-gradient(circle at 50% 115%, transparent 0 5px, ' + line + ' 5px 6px)';
      if (pattern === 4) return 'repeating-linear-gradient(45deg, ' + line + ' 0 1px, transparent 1px 9px), repeating-linear-gradient(-45deg, ' + line + ' 0 1px, transparent 1px 9px)';
      return 'radial-gradient(circle at 22% 18%, ' + line + ' 0 3px, transparent 3.5px), radial-gradient(circle at 78% 68%, ' + line + ' 0 2px, transparent 2.5px)';
    }

    function artStyle(text, size) {
      const { hue, hue2, pattern } = artOf(text);
      const layer = patternLayers(pattern, size >= 44 ? 0.20 : 0.24);
      const dot = pattern === 1 || pattern === 2;
      return {
        backgroundImage: layer + ', linear-gradient(135deg, hsl(' + hue + ' 56% 58%), hsl(' + hue2 + ' 58% 42%))',
        backgroundSize: dot ? '7px 7px, cover' : 'auto, auto',
        color: '#fff',
        textShadow: '0 1px 2px rgba(0,0,0,.45)',
      };
    }

    function artWash(text) {
      const { hue, hue2 } = artOf(text);
      return {
        backgroundImage: 'linear-gradient(135deg, hsla(' + hue + ', 62%, 56%, .16), hsla(' + hue2 + ', 60%, 46%, .05))',
        borderColor: 'hsla(' + hue + ', 55%, 50%, .26)',
      };
    }

    function artGradient(text) {
      const { hue, hue2 } = artOf(text);
      return 'linear-gradient(90deg, hsl(' + hue + ' 62% 56%), hsl(' + hue2 + ' 62% 44%))';
    }

    function avatar(name, size, role) {
      const text = String(name || '?');
      const initial = text.slice(0, 1);
      const art = artStyle(text, size);
      return h(
        'div',
        {
          style: {
            width: size,
            height: size,
            borderRadius: size > 44 ? 14 : size > 26 ? 10 : 7,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            color: art.color,
            textShadow: art.textShadow,
            fontSize: size > 44 ? 24 : size > 26 ? 15 : 10.5,
            fontWeight: 700,
            backgroundImage: art.backgroundImage,
            backgroundSize: art.backgroundSize,
            border: '1px solid rgba(255,255,255,.24)',
            boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.06)',
          },
          title: role ? role + ' · ' + text : text,
        },
        initial,
      );
    }

    function bar(value, total, tone) {
      const ratio = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
      return h(
        'div',
        { style: { height: 5, borderRadius: 99, background: c.layer3, overflow: 'hidden', flex: 1, minWidth: 40 } },
        h('div', { style: { width: Math.round(ratio * 100) + '%', height: '100%', borderRadius: 99, background: tone || c.brand } }),
      );
    }

    function sectionLabel(text, extra) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, margin: '14px 0 6px' } },
        h('div', { style: { color: c.faint, fontSize: 11, letterSpacing: '0.06em' } }, text),
        extra || null,
      );
    }

    function card(props) {
      const interactive = typeof props.onClick === 'function';
      return h(
        interactive ? 'button' : 'div',
        {
          type: interactive ? 'button' : undefined,
          onClick: props.onClick,
          style: Object.assign(
            {
              display: 'block',
              width: '100%',
              textAlign: 'left',
              boxSizing: 'border-box',
              background: c.card,
              border: '1px solid ' + c.border,
              borderRadius: 12,
              padding: props.padding || '10px 11px',
              color: c.text,
              fontFamily: 'inherit',
              cursor: interactive ? 'pointer' : 'default',
              appearance: 'none',
            },
            props.style || {},
          ),
        },
        props.children,
      );
    }

    function emptyState(title, hint, action) {
      return h(
        'div',
        { style: { padding: '26px 14px', textAlign: 'center', color: c.faint } },
        h('div', { style: { fontSize: 12.5, color: c.sub, marginBottom: 4 } }, title),
        h('div', { style: { fontSize: 11.5, lineHeight: 1.7 } }, hint),
        action ? h('div', { style: { marginTop: 10, display: 'flex', justifyContent: 'center' } }, action) : null,
      );
    }

    function field(label, value) {
      if (value === null || value === undefined || value === '') return null;
      return h(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0', fontSize: 12 } },
        h('span', { style: { color: c.faint, minWidth: 34, flexShrink: 0 } }, label),
        h('span', { style: { color: c.text, lineHeight: 1.6, wordBreak: 'break-word' } }, value),
      );
    }

    function evidenceRow(ev, onOpen) {
      return h(
        'button',
        {
          type: 'button',
          onClick: onOpen,
          style: {
            display: 'block', width: '100%', textAlign: 'left', appearance: 'none',
            background: 'transparent', border: 'none', borderLeft: '2px solid ' + c.border2,
            padding: '3px 0 3px 8px', margin: '3px 0', color: c.sub, fontSize: 11.5,
            lineHeight: 1.65, fontFamily: 'inherit', cursor: 'pointer',
          },
        },
        '「' + ev.quote + '」',
        h('div', { style: { color: c.faint, fontSize: 10.5, marginTop: 1 } }, (ev.chapter || '') + (ev.offset !== null && ev.offset !== undefined ? ' · @' + ev.offset : '')),
      );
    }

    // ── 抽屉（底部升起的详情层） ───────────────────────────────────────────────
    function Sheet(props) {
      return h(
        'div',
        {
          className: 'fic-sheet-mask',
          onClick: props.onClose,
        },
        h(
          'div',
          {
            className: 'fic-sheet',
            role: 'dialog',
            'aria-modal': 'true',
            onClick: function (event) { event.stopPropagation(); },
          },
          h(
            'div',
            { style: { padding: '10px 14px 8px', borderBottom: '1px solid ' + c.border, display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } },
            h('div', { style: { flex: 1, minWidth: 0 } }, props.title),
            props.actions || null,
            h('button', {
              type: 'button', onClick: props.onClose, title: '关闭（Esc）',
              style: {
                appearance: 'none', border: 'none', background: 'transparent', color: c.faint,
                width: 28, height: 28, borderRadius: 7, cursor: 'pointer', display: 'flex',
                alignItems: 'center', justifyContent: 'center', padding: 0,
              },
            }, h(Icon, { name: 'close', size: 15 })),
          ),
          h(
            'div',
            { className: 'fic-sheet-body', style: { fontSize: 12.5, lineHeight: 1.7, padding: '10px 14px 14px' } },
            props.children,
          ),
        ),
      );
    }

    function tabs(items, active, onChange, compact) {
      return h(
        'div',
        { style: { display: 'flex', gap: 2, padding: compact ? '0' : '0 2px' } },
        items.map((item) =>
          h(
            'button',
            {
              key: item.key,
              type: 'button',
              onClick: function () { onChange(item.key); },
              style: {
                appearance: 'none', border: 'none', background: 'transparent', fontFamily: 'inherit',
                padding: compact ? '4px 8px' : '4px 10px', borderRadius: 7, cursor: 'pointer',
                fontSize: 11.5, lineHeight: '18px',
                color: active === item.key ? c.brand : c.sub,
                fontWeight: active === item.key ? 600 : 400,
                background: active === item.key ? c.layer2 : 'transparent',
              },
            },
            item.label + (item.count !== undefined ? ' ' + item.count : ''),
          ),
        ),
      );
    }

    // ── 主面板 ────────────────────────────────────────────────────────────────
    function Panel(props) {
      const face = props;

      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null });
      const [project, setProject] = React.useState('');
      // 写操作显式带上当前已解析的项目：不靠全局偏好，避免另一面板切项目后写错。
      const activeProject = function () {
        return (state && state.data && state.data.project) || project || undefined;
      };
      const [projects, setProjects] = React.useState([]);
      const [tab, setTab] = React.useState('canon');
      const [sub, setSub] = React.useState('characters');
      const [worldSub, setWorldSub] = React.useState('rules');
      const [plotSub, setPlotSub] = React.useState('timeline');
      const [sheet, setSheet] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [query, setQuery] = React.useState('');
      const [roleFilter, setRoleFilter] = React.useState('all');
      const [importOpen, setImportOpen] = React.useState(false);
      const [importPath, setImportPath] = React.useState('');
      const [importPreview, setImportPreview] = React.useState(null);
      const [importFiles, setImportFiles] = React.useState(null);
      const [pickingDir, setPickingDir] = React.useState(false);
      const [waiveDraft, setWaiveDraft] = React.useState(null);
      const [declareDraft, setDeclareDraft] = React.useState({});
      const [deltaDraft, setDeltaDraft] = React.useState({ kind: 'relationship', title: '', statement: '', subjects: '', fromChapter: '' });
      const [deltaFormOpen, setDeltaFormOpen] = React.useState(false);
      const [premiseDraft, setPremiseDraft] = React.useState(null);
      const [promoteDraft, setPromoteDraft] = React.useState(null);
      const [timelineAll, setTimelineAll] = React.useState(false);
      const [timelineLimit, setTimelineLimit] = React.useState(60);
      const [chapterLimit, setChapterLimit] = React.useState(120);
      const [showPrompt, setShowPrompt] = React.useState(false);
      const [chapterView, setChapterView] = React.useState(null);
      const [searchTerm, setSearchTerm] = React.useState('');
      const [searchResult, setSearchResult] = React.useState(null);
      const [writing, setWriting] = React.useState({ chapter: '', phase: 'idle', tags: null, markdown: '', draft: '', checked: null, error: null });
      // 章节任务卡的编辑草稿（v0.2.0）：{ chapter, goal, arc, beats, openQuestions }
      const [missionDraft, setMissionDraft] = React.useState(null);

      const refresh = React.useCallback(async function () {
        setState(function (prev) { return { phase: prev.data ? 'refreshing' : 'loading', data: prev.data, error: null }; });
        try {
          const data = await face.load(project || undefined);
          setState({ phase: 'ready', data: data, error: null });
        } catch (error) {
          setState({ phase: 'error', data: null, error: String((error && error.message) || error) });
        }
        try {
          const list = await face.projects();
          setProjects((list && list.projects) || []);
        } catch {
          // 项目列表只是页头的选择器；读不到不影响面板。
        }
      }, [face.load, face.projects, project]);

      React.useEffect(function () { refresh(); }, [refresh]);

      React.useEffect(function () {
        const onKey = function (event) {
          if (event.key === 'Escape') setSheet(null);
        };
        document.addEventListener('keydown', onKey);
        return function () { document.removeEventListener('keydown', onKey); };
      }, []);

      const data = state.data;
      const book = (data && data.book) || null;
      const deltaData = (data && data.deltas) || { premise: '', items: [] };

      React.useEffect(function () {
        if (data && data.deltas && premiseDraft === null) setPremiseDraft(data.deltas.premise || '');
      }, [data, premiseDraft]);
      const status = (data && data.status) || {};
      const enabled = Boolean(status.enabled);
      const chapters = (book && book.chapters) || (data && data.chapters) || [];
      const pending = (data && data.pending) || [];
      const contradictions = (data && data.contradictions) || [];
      const reviewCount = pending.length + contradictions.length;
      const chapterTitle = function (id) {
        const hit = chapters.find(function (ch) { return ch.id === id; });
        return hit ? hit.title || id : id || '';
      };
      const ordinalOf = function (id) {
        const hit = chapters.find(function (ch) { return ch.id === id; });
        return hit && Number.isFinite(hit.ordinal) ? hit.ordinal : null;
      };
      const chapterRange = function (first, last) {
        if (!first) return '-';
        const a = ordinalOf(first);
        const b = last ? ordinalOf(last) : null;
        if (a === null) return first + (last && last !== first ? '-' + last : '');
        if (b === null || last === first) return a === 0 ? '序' : '第' + a + '章';
        if (a === 0) return '序–第' + b + '章';
        return '第' + a + '-' + b + '章';
      };

      const run = React.useCallback(async function (label, task) {
        setBusy(label);
        setNotice(null);
        try {
          const result = await task();
          setNotice({ tone: c.success, text: typeof result === 'string' ? result : label + '完成' });
          await refresh();
          return result;
        } catch (error) {
          setNotice({ tone: c.error, text: label + '失败：' + String((error && error.message) || error) });
          return null;
        } finally {
          setBusy('');
        }
      }, [refresh]);

      const openChapter = React.useCallback(async function (id, focus) {
        setTab('source');
        setSheet(null);
        setChapterView({ id: id, title: chapterTitle(id), phase: 'loading', text: '', error: null, focus: focus || null });
        try {
          const body = await face.chapter(id, project || undefined);
          setChapterView({ id: id, title: body.title || chapterTitle(id), phase: 'ready', text: body.text || '', error: null, chars: body.chars, focus: focus || null });
        } catch (error) {
          setChapterView({ id: id, title: chapterTitle(id), phase: 'error', text: '', error: String((error && error.message) || error), focus: focus || null });
        }
      }, [face.chapter, chapters, project]);

      const doSearch = React.useCallback(async function () {
        const term = String(searchTerm || '').trim();
        if (!term) { setNotice({ tone: c.warn, text: '先输入要查的词。' }); return; }
        setBusy('检索');
        try {
          const result = await face.search(term, project || undefined);
          setSearchResult(result);
        } catch (error) {
          setNotice({ tone: c.error, text: '检索失败：' + String((error && error.message) || error) });
        } finally {
          setBusy('');
        }
      }, [face.search, searchTerm]);

      const openWriting = React.useCallback(async function (chapterId) {
        const pick = chapterId || (data && data.currentChapter) || (chapters[0] && chapters[0].id) || '';
        setSheet({ kind: 'writing' });
        setWriting({ chapter: pick, phase: 'loading', tags: null, markdown: '', draft: '', checked: null, error: null });
        if (!pick) { setWriting({ chapter: '', phase: 'empty', tags: null, markdown: '', draft: '', checked: null, error: null }); return; }
        try {
          const contract = await face.contract(pick, project || undefined);
          setWriting({ chapter: pick, phase: 'ready', tags: contract.tags || null, markdown: contract.markdown || '', draft: '', checked: null, error: null });
        } catch (error) {
          setWriting({ chapter: pick, phase: 'error', tags: null, markdown: '', draft: '', checked: null, error: String((error && error.message) || error) });
        }
      }, [data, chapters, face.contract]);

      const switchWritingChapter = React.useCallback(async function (id) {
        // 切章先清掉上一章的契约与检查结果：加载期间不能让人看到「上一章的契约」配这一章的标题。
        setWriting(function (prev) { return Object.assign({}, prev, { chapter: id, phase: 'loading', tags: null, markdown: '', checked: null, error: null }); });
        try {
          const contract = await face.contract(id, project || undefined);
          setWriting(function (prev) {
            // 回包可能是慢的那一次：章节已经被切走就丢弃。
            if (prev.chapter !== id) return prev;
            return Object.assign({}, prev, { chapter: id, phase: 'ready', tags: contract.tags || null, markdown: contract.markdown || '', error: null });
          });
        } catch (error) {
          setWriting(function (prev) {
            if (prev.chapter !== id) return prev;
            return Object.assign({}, prev, { phase: 'error', error: String((error && error.message) || error) });
          });
        }
      }, [face.contract]);

      const doCheck = React.useCallback(async function () {
        const body = String(writing.draft || '');
        if (!body.trim()) { setNotice({ tone: c.warn, text: '先把一段草稿贴进来。' }); return; }
        if (!writing.chapter) { setNotice({ tone: c.warn, text: '先选一章。' }); return; }
        setBusy('检查');
        try {
          const result = await face.checkDraft(writing.chapter, body, project || undefined);
          setWriting(function (prev) { return Object.assign({}, prev, { checked: result }); });
        } catch (error) {
          setNotice({ tone: c.error, text: '检查失败：' + String((error && error.message) || error) });
        } finally {
          setBusy('');
        }
      }, [face.checkDraft, writing.draft, writing.chapter]);

      // ── 头部 ────────────────────────────────────────────────────────────────
      const analysisDone = book && book.analysis ? book.analysis.filter(function (s) { return s.done; }).length : 0;
      const analysisTotal = book && book.analysis ? book.analysis.length : 0;

      function projectSelect() {
        const list = projects.length ? projects : (data && data.project ? [{ id: data.project, title: data.project, chapters: chapters.length }] : []);
        const currentId = project || (data && data.project) || '';
        if (!list.length) {
          return h('span', { style: { whiteSpace: 'nowrap', color: c.faint } }, data ? '项目 ' + data.project : '原著可核 · 本作设定 · 场景契约');
        }
        return h(
          'select',
          {
            value: currentId,
            title: '切换项目（.dsh-novel-fanfic/<项目>）',
            onChange: function (event) {
              const next = event.target.value;
              // 先让宿主记住这个项目（下次打开面板还是它），再切面板数据。
              Promise.resolve()
                .then(function () { return face.use(next); })
                .catch(function () { return null; })
                .then(function () { setProject(next); });
            },
            style: {
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              color: c.sub,
              fontSize: 11,
              fontFamily: 'inherit',
              padding: 0,
              margin: 0,
              maxWidth: 200,
              cursor: 'pointer',
              textOverflow: 'ellipsis',
            },
          },
          list.map(function (p) {
            const title = p.title && p.title !== p.id ? p.title : p.id;
            return h('option', { key: p.id, value: p.id }, title);
          }),
        );
      }

      const header = h(
        'div',
        { className: 'fic-head' },
        h(
          'div',
          { className: 'fic-head-row' },
          h('span', { className: 'fic-mark' }, h(Icon, { name: 'settings', size: 15 })),
          h('span', { className: 'fic-title' }, TITLE),
          h('span', { className: 'fic-ver', title: '项目版本：任意一次写操作 +1' }, 'v' + (typeof (data && data.revision) === 'number' ? data.revision : '–')),
          h('span', { style: { flex: 1 } }),
          reviewCount
            ? h('button', {
              type: 'button',
              className: 'fic-pill count',
              title: '待确认 ' + pending.length + ' · 设定矛盾 ' + contradictions.length,
              onClick: function () { setSheet({ kind: 'review', tab: pending.length ? 'pending' : 'contradictions' }); },
            }, '● 待办 ' + reviewCount)
            : h('button', {
              type: 'button',
              className: 'fic-pill',
              title: '审阅队列（空）',
              onClick: function () { setSheet({ kind: 'review', tab: 'pending' }); },
            }, '待办 0'),
          iconButton({ icon: 'refresh', title: state.phase === 'refreshing' ? '刷新中…' : '刷新', onClick: refresh, disabled: state.phase === 'loading' || state.phase === 'refreshing' }),
        ),
        h('div', { style: { color: c.faint, fontSize: 11, marginTop: 3, display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
          projectSelect(),
          book && book.stats ? h('span', { style: { color: c.border2 } }, '·') : null,
          book && book.stats ? h('span', { style: { whiteSpace: 'nowrap' } }, book.stats.chapters + ' 章 · ' + book.stats.chars + ' 字') : null,
          writing.chapter ? h('span', { style: { color: c.border2 } }, '·') : null,
          writing.chapter ? h('span', { style: { whiteSpace: 'nowrap' } }, '当前 ' + writing.chapter) : null,
        ),
      );

      // ── 一级 tab（v0.2.0：总览不再是入口，改成常驻「下一步」条）───────────────
      const TAB_ITEMS = [
        { key: 'canon', label: '原著', count: book ? book.characters.length : 0 },
        { key: 'delta', label: '本作', count: deltaData.items.length },
        { key: 'plot', label: '剧情', count: book ? book.timeline.length : 0 },
        { key: 'write', label: '写作', count: null },
      ];
      const tabBar = h(
        'div',
        { className: 'fic-tabs', role: 'tablist' },
        TAB_ITEMS.map(function (item) {
          const active = tab === item.key;
          return h(
            'button',
            {
              key: item.key,
              type: 'button',
              role: 'tab',
              'aria-selected': active ? 'true' : 'false',
              className: 'fic-tab',
              onClick: function () { setTab(item.key); },
            },
            item.label,
            h('span', { className: 'n' }, item.key === 'write' ? (writing.chapter || 'ch—') : String(item.count || 0)),
          );
        }),
      );

      // ── 原著内的分段（横向 chips，替代原来的左侧竖排六项）────────────────────
      const SETTING_ITEMS = [
        { key: 'characters', label: '人物', count: book ? book.characters.length : 0 },
        { key: 'factions', label: '势力', count: book ? book.factions.length : 0 },
        { key: 'relations', label: '关系', count: book ? book.matrix.people.length : 0 },
        { key: 'world', label: '世界', count: book ? book.world.rules.length : 0 },
        { key: 'conflicts', label: '冲突', count: book ? book.conflicts.length : 0 },
        { key: 'source', label: '原文', count: chapters.length },
      ];

      function chips() {
        const pendingByBucket = {};
        pending.forEach(function (row) { pendingByBucket[row.bucket] = (pendingByBucket[row.bucket] || 0) + 1; });
        const flag = function (key) {
          if (key === 'characters') return (pendingByBucket.characters || 0) > 0;
          if (key === 'world') return (pendingByBucket.worldRules || 0) > 0;
          return false;
        };
        return h(
          'div',
          { className: 'fic-chips', role: 'toolbar' },
          SETTING_ITEMS.map(function (item) {
            const active = sub === item.key;
            return h(
              'button',
              {
                key: item.key,
                type: 'button',
                className: 'fic-chip',
                'aria-pressed': active ? 'true' : 'false',
                onClick: function () { setSub(item.key); },
              },
              item.label,
              h('span', { className: 'n' }, String(item.count || 0)),
              flag(item.key) ? h('span', { className: 'flag', title: '有未确认条目' }) : null,
            );
          }),
        );
      }

      // ── 下一步：面板任何时刻只说一条「现在该做什么」──────────────────────────
      function nextStrip() {
        if (!book) {
          return h('div', { className: 'fic-next' },
            h('span', { className: 'fic-next-kicker' }, 'next'),
            h('div', { className: 'fic-next-body' },
              h('div', { className: 'fic-next-title' }, h('b', null, '先导入原著')),
              h('span', { className: 'fic-next-why' }, 'txt / md；导入后自动分章、建索引，再逐条确认 canon。'),
            ),
            h('button', { type: 'button', className: 'fic-btn primary', onClick: function () { setImportOpen(true); } }, '导入原著'),
          );
        }
        const missions = (data && data.missions) || {};
        const chapterId = writing.chapter || (chapters[0] && chapters[0].id) || '';
        const mission = chapterId ? missions[chapterId] : null;
        const hasContract = Boolean(writing.tags || writing.markdown);
        let title = '';
        let why = '';
        let label = '';
        let action = null;
        if (contradictions.length) {
          title = contradictions.length + ' 条设定矛盾挡着契约';
          why = '裁决前不会写进契约；先定下来写哪一版。';
          label = '去裁决';
          action = function () { setSheet({ kind: 'review', tab: 'contradictions' }); };
        } else if (pending.length) {
          title = pending.length + ' 条待确认，还没进契约';
          why = '确认后才会写进这一章的契约。';
          label = '去确认';
          action = function () { setSheet({ kind: 'review', tab: 'pending' }); };
        } else if (!mission) {
          title = (chapterId || '这一章') + ' 还没想好要写什么';
          why = '写之前 5 分钟：一句话目标 + 3 个节拍就够。';
          label = '写任务卡';
          action = function () { setTab('write'); setMissionDraft({ chapter: chapterId, open: true, goal: '', arc: '', beats: '', openQuestions: '' }); };
        } else if (!hasContract) {
          title = chapterId + ' 的任务卡有了，契约还没生成';
          why = '契约是这一章必须遵守的硬约束（' + ((mission.beats || []).length) + ' 个节拍、' + ((mission.openQuestions || []).length) + ' 项开放）。';
          label = '生成契约';
          action = function () { setTab('write'); openWriting(chapterId); };
        } else {
          title = chapterId + ' 可以开写：契约已生成';
          why = (mission.beats || []).length
            ? '任务卡有 ' + mission.beats.length + ' 个节拍，写之前把起稿指令发给模型。'
            : '写之前把起稿指令发给模型；写回来再贴进「检查」。';
          label = '写作准备';
          action = function () { setTab('write'); openWriting(chapterId); };
        }
        return h('div', { className: 'fic-next' },
          h('span', { className: 'fic-next-kicker' }, 'next'),
          h('div', { className: 'fic-next-body' },
            h('div', { className: 'fic-next-title' }, h('b', null, title)),
            why ? h('span', { className: 'fic-next-why' }, why) : null,
          ),
          action ? h('button', { type: 'button', className: 'fic-btn primary', onClick: action }, label) : null,
        );
      }

      // ── 写作：章选择 + 章节任务卡 + 契约 + 上一次检查 ──────────────────────────
      function writeView() {
        const missions = (data && data.missions) || {};
        const defaultChapter = (data && data.currentChapter)
          || (chapters.filter(function (ch) { return Number(ch.ordinal) > 0; })[0] || chapters[0] || {}).id
          || '';
        const chapterId = writing.chapter || defaultChapter;
        const mission = chapterId ? missions[chapterId] : null;
        const draft = missionDraft && missionDraft.chapter === chapterId ? missionDraft : null;
        const checked = writing.checked;
        const summary = (checked && checked.summary) || null;

        const saveMissionDraft = async function () {
          const value = missionDraft || {};
          await run('保存任务卡', async function () {
            const payload = {
              goal: value.goal || undefined,
              arc: value.arc || undefined,
              beats: value.beats ? String(value.beats).split(/[|\n]/).map(function (s) { return s.trim(); }).filter(Boolean) : undefined,
              openQuestions: value.openQuestions ? String(value.openQuestions).split(/[|\n]/).map(function (s) { return s.trim(); }).filter(Boolean) : undefined,
            };
            await face.planSet(chapterId, payload, project || undefined);
            setMissionDraft(null);
            // 刷新由外层 run() 统一做一次；这里再 refresh() 会重复两次读。v0.2.3 去掉。
          });
        };

        const chapterRow = h('div', { className: 'fic-card flat', style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px' } },
          h('span', { style: { fontSize: 11.5, color: c.faint } }, '章节'),
          h('select', {
            value: chapterId,
            onChange: function (event) { switchWritingChapter(event.target.value); },
            style: { appearance: 'none', border: '1px solid ' + c.border2, borderRadius: 8, background: c.layer, color: c.text, fontSize: 11.5, fontFamily: 'inherit', padding: '4px 6px', maxWidth: 210, cursor: 'pointer' },
          }, chapters.map(function (ch) { return h('option', { key: ch.id, value: ch.id, selected: ch.id === chapterId }, ch.id + (ch.title ? ' · ' + ch.title : '')); })),
          h('span', { style: { marginLeft: 'auto', fontFamily: 'Cascadia Mono,Consolas,monospace', fontSize: 10, color: c.faint } },
            (chapters.filter(function (ch) { return ch.id === chapterId; })[0] || {}).chars ? ((chapters.filter(function (ch) { return ch.id === chapterId; })[0].chars) + ' 字原著') : ''),
        );

        const missionCard = draft
          ? h('div', { className: 'fic-mission' },
            h('div', { className: 'fic-mission-head' },
              h('span', { className: 't' }, '章节任务卡'),
              h('span', { className: 'fic-tag brand' }, chapterId),
              h('span', { style: { flex: 1 } }),
              h('button', { type: 'button', className: 'fic-link', onClick: saveMissionDraft, disabled: !!busy }, '保存'),
              h('button', { type: 'button', className: 'fic-link muted', onClick: function () { setMissionDraft(null); } }, '取消'),
            ),
            h('div', { className: 'fic-mission-body' },
              h('div', { className: 'fic-field' },
                h('span', { className: 'k' }, '本章要干'),
                h('div', { style: { flex: 1 } },
                  h('textarea', {
                    value: draft.goal || '', rows: 2, placeholder: '一句话：这一章要让什么发生？',
                    onChange: function (event) { setMissionDraft(Object.assign({}, draft, { goal: event.target.value })); },
                    style: { width: '100%', resize: 'vertical', fontSize: 12, fontFamily: 'inherit', lineHeight: 1.6, padding: 6, borderRadius: 7, border: '1px solid ' + c.border2, background: c.layer, color: c.text, boxSizing: 'border-box' },
                  })),
              ),
              h('div', { className: 'fic-field' },
                h('span', { className: 'k' }, '情绪曲线'),
                h('div', { style: { flex: 1 } },
                  h('input', {
                    value: draft.arc || '', placeholder: '提防 → 松动 → 又一记冷下去',
                    onChange: function (event) { setMissionDraft(Object.assign({}, draft, { arc: event.target.value })); },
                    style: { width: '100%', fontSize: 12, fontFamily: 'inherit', padding: '5px 6px', borderRadius: 7, border: '1px solid ' + c.border2, background: c.layer, color: c.text, boxSizing: 'border-box' },
                  })),
              ),
              h('div', { className: 'fic-field' },
                h('span', { className: 'k' }, '节拍'),
                h('div', { style: { flex: 1 } },
                  h('textarea', {
                    value: draft.beats || '', rows: 4, placeholder: '一行一个节拍（最多 7 条）',
                    onChange: function (event) { setMissionDraft(Object.assign({}, draft, { beats: event.target.value })); },
                    style: { width: '100%', resize: 'vertical', fontSize: 12, fontFamily: 'inherit', lineHeight: 1.6, padding: 6, borderRadius: 7, border: '1px solid ' + c.border2, background: c.layer, color: c.text, boxSizing: 'border-box' },
                  })),
              ),
              h('div', { className: 'fic-field' },
                h('span', { className: 'k' }, '开放问题'),
                h('div', { style: { flex: 1 } },
                  h('textarea', {
                    value: draft.openQuestions || '', rows: 2, placeholder: '写之前要拍板的事；会进契约的「不确定」段',
                    onChange: function (event) { setMissionDraft(Object.assign({}, draft, { openQuestions: event.target.value })); },
                    style: { width: '100%', resize: 'vertical', fontSize: 12, fontFamily: 'inherit', lineHeight: 1.6, padding: 6, borderRadius: 7, border: '1px solid ' + c.border2, background: c.layer, color: c.text, boxSizing: 'border-box' },
                  })),
              ),
            ),
          )
          : mission
            ? h('div', { className: 'fic-mission' },
              h('div', { className: 'fic-mission-head' },
                h('span', { className: 't' }, mission.title || '这一章的任务卡'),
                h('span', { className: 'fic-tag brand' }, chapterId),
                h('span', { style: { flex: 1 } }),
                (mission.beats || []).length ? h('span', { className: 'n', style: { fontFamily: 'Cascadia Mono,Consolas,monospace', fontSize: 10, color: c.faint } }, mission.beats.length + ' beats') : null,
                h('button', {
                  type: 'button', className: 'fic-link',
                  onClick: function () {
                    setMissionDraft({
                      chapter: chapterId, open: true,
                      goal: mission.goal || '', arc: mission.arc || '',
                      beats: (mission.beats || []).join('\n'),
                      openQuestions: (mission.openQuestions || []).join('\n'),
                    });
                  },
                }, '编辑'),
              ),
              h('div', { className: 'fic-mission-body' },
                mission.goal ? h('div', { className: 'fic-field' }, h('span', { className: 'k' }, '本章要干'), h('span', { className: 'v' }, mission.goal)) : null,
                mission.arc ? h('div', { className: 'fic-field' }, h('span', { className: 'k' }, '情绪曲线'), h('span', { className: 'v' }, mission.arc)) : null,
                (mission.anchors || []).length ? h('div', { className: 'fic-field' }, h('span', { className: 'k' }, '原著锚点'), h('span', { className: 'v' }, mission.anchors.join('；'))) : null,
                mission.readerExpectation ? h('div', { className: 'fic-field' }, h('span', { className: 'k' }, '读者期待'), h('span', { className: 'v' }, mission.readerExpectation)) : null,
                (mission.beats || []).length
                  ? h('div', { className: 'fic-field' },
                    h('span', { className: 'k' }, 'beats'),
                    h('span', { className: 'v', style: { paddingLeft: 0 } },
                      h('ol', { className: 'fic-beats' }, mission.beats.map(function (beat, i) { return h('li', { key: 'b' + i }, beat); }))))
                  : null,
                (mission.avoid || []).length ? h('div', { className: 'fic-field' }, h('span', { className: 'k' }, '避开'), h('span', { className: 'v muted' }, mission.avoid.join('；'))) : null,
                (mission.openQuestions || []).length
                  ? h('div', { className: 'fic-field', style: { background: 'color-mix(in srgb, ' + c.warn + ' 10%, transparent)', margin: '0 -12px', padding: '6px 12px' } },
                    h('span', { className: 'k', style: { color: c.warn } }, '开放问题'),
                    h('span', { className: 'v' }, mission.openQuestions.join('；') + '（会进契约的「不确定」段）'))
                  : null,
              ),
            )
            : h('div', { className: 'fic-card' },
              emptyState('这一章还没有任务卡', '三行也算一张：一句话目标 + 情绪曲线 + 3 个节拍。它不是契约，删了也不影响编译。',
                button({ small: true, variant: 'primary', icon: 'pen', onClick: function () { setMissionDraft({ chapter: chapterId, open: true, goal: '', arc: '', beats: '', openQuestions: '' }); }, children: '写任务卡' })));

        const contractCard = (writing.tags || writing.markdown)
          ? h('div', { className: 'fic-acc' },
            h('div', { className: 'fic-acc-head', onClick: function () { openWriting(chapterId); } },
              h('span', { className: 't' }, '这一章的契约'),
              writing.tags && writing.tags['本作'] ? h('span', { className: 'fic-tag brand' }, '优先于原著') : null,
              h('span', { className: 'n' }, ((writing.markdown || '').length || (writing.tags ? Object.keys(writing.tags).length + ' 段' : '')) + ''),
              h('span', { style: { color: c.faint, fontSize: 11 } }, '打开 ›')),
          )
          : h('div', { className: 'fic-card' },
            emptyState('还没生成这一章的契约', '契约 = 视角 / 在场 / 称呼 / 知情 / 世界规则 / 时间线 / 禁忌 / 不确定 / 锚点。',
              button({ small: true, variant: 'primary', icon: 'settings', onClick: function () { openWriting(chapterId); }, children: '生成契约' })));

        const checkSummary = summary
          ? h('div', { className: 'fic-card' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              h('span', { className: 'fic-tag ' + (summary.blockers ? 'bad' : summary.warnings ? 'warn' : 'ok') }, summary.blockers ? 'blocker ' + summary.blockers : summary.warnings ? 'warning ' + summary.warnings : '通过'),
              h('span', { style: { fontSize: 11, color: c.faint } }, 'blocker ' + summary.blockers + ' · warning ' + summary.warnings + ' · info ' + summary.infos + (summary.waived ? ' · 放过 ' + summary.waived : '')),
              h('button', { type: 'button', className: 'fic-link', style: { marginLeft: 'auto' }, onClick: function () { openWriting(chapterId); } }, '看详情 ›'),
            ))
          : h('div', { className: 'fic-card' },
            emptyState('还没检查这一章的草稿', '贴一段正文进来，只报「在哪、凭什么、跟哪条设定冲突」；不评分、不改稿。',
              button({ small: true, icon: 'check', onClick: function () { openWriting(chapterId); }, children: '检查这一章' })));

        return h('div', { style: { padding: '10px 14px 14px', overflowY: 'auto', flex: 1, minHeight: 0 } },
          chapterRow,
          h('div', { className: 'fic-sect' }, missionCard),
          h('div', { className: 'fic-sect' }, contractCard),
          checkSummary ? h('div', { className: 'fic-sect' }, h('div', { className: 'fic-sect-head' }, h('span', { className: 'fic-sect-title' }, '写完之后')), checkSummary) : null,
          (data && data.beat && data.beat.available)
            ? h('div', { className: 'fic-sect' },
              h('div', { className: 'fic-sect-head' }, h('span', { className: 'fic-sect-title' }, 'beat 账本'), h('span', { className: 'fic-sect-meta' }, '只读')),
              h('div', { className: 'fic-card flat' },
                h('div', { style: { fontSize: 11.5, color: c.sub, lineHeight: 1.7 } },
                  '《' + data.beat.book + '》：已拍板 ' + data.beat.decided + ' 条，待拍板 ' + data.beat.open + ' 条。这一章要写的事如果已经拍过板，不要再在这里重复登记。')))
            : null,
        );
      }

      // ── 总览 ────────────────────────────────────────────────────────────────
      function overview() {
        if (!book) {
          return h(
            'div',
            { style: { padding: 14 } },
            emptyState(
              '还没有导入原著',
              'txt / md，UTF-8 或 GB18030；导入后自动分章、建索引，再逐条确认 canon。',
              button({ variant: 'primary', icon: 'source', onClick: function () { setImportOpen(true); }, children: '导入原著' }),
            ),
            importPanel(),
          );
        }
        const cov = book.coverage;
        const rows = [
          { label: '人物', value: cov.characters, tone: c.brand },
          { label: '事实', value: cov.facts, tone: c.brand },
          { label: '世界规则', value: cov.worldRules, tone: c.brand },
          { label: '秘密', value: cov.secrets, tone: c.brand },
          { label: '称呼', value: cov.addresses, tone: c.brand },
        ];
        return h(
          'div',
          { style: { padding: '12px 13px 96px' } },
          h(
            'div',
            { style: { display: 'flex', gap: 10, alignItems: 'flex-start' } },
            h('div', { style: { width: 44, height: 44, borderRadius: 12, background: 'color-mix(in srgb, ' + c.brand + ' 16%, ' + c.layer2 + ')', display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.brand, flexShrink: 0 } }, h(Icon, { name: 'source', size: 21 })),
            h(
              'div',
              { style: { minWidth: 0, flex: 1 } },
              h('div', { style: { color: c.text, fontSize: 14, fontWeight: 600, lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, book.title || '未命名原著'),
              h('div', { style: { color: c.faint, fontSize: 11, marginTop: 3, display: 'flex', gap: 6, flexWrap: 'wrap' } },
                h('span', null, book.stats.chapters + ' 章'),
                h('span', null, book.stats.chars + ' 字'),
                h('span', null, '人物 ' + book.stats.characters),
                h('span', null, '势力 ' + book.stats.factions),
                h('span', null, '线索 ' + book.stats.threads),
              ),
            ),
            h('div', { style: { flexShrink: 0, paddingTop: 2 } },
              enabled ? chip('已开启', c.success) : chip('未开启', c.warn),
            ),
          ),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' } },
            button({ small: true, icon: 'bell', onClick: function () { setSheet({ kind: 'review', tab: 'pending' }); }, children: '审阅 ' + reviewCount }),
            button({ small: true, icon: 'source', onClick: function () { setImportOpen(!importOpen); }, children: '导入原著' }),
            enabled ? null : button({ small: true, tone: c.brand, icon: 'check', onClick: function () { return run('开启', face.enable); }, children: '开启 /fic on' }),
          ),

          importOpen ? importPanel() : null,

          sectionLabel('分析进度', h('span', { style: { color: c.faint, fontSize: 10.5 } }, analysisDone + '/' + analysisTotal)),
          h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
            (book.analysis || []).map(function (stage) {
              return chip((stage.done ? '✓ ' : '○ ') + stage.label + ' · ' + stage.detail, stage.done ? c.success : c.faint);
            }),
          ),

          sectionLabel('覆盖度', h('span', { style: { color: c.faint, fontSize: 10.5 } }, 'confirmed / total')),
          h('div', { style: { display: 'grid', gap: 6 } },
            rows.map(function (row) {
              return h(
                'div',
                { key: row.label, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: { color: c.sub, fontSize: 11.5, width: 52, flexShrink: 0 } }, row.label),
                bar(row.value.confirmed, row.value.total, row.tone),
                h('span', { style: { color: c.faint, fontSize: 11, width: 44, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' } },
                  row.value.confirmed + '/' + row.value.total),
              );
            }),
          ),

          sectionLabel('关键数字'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 7 } },
            [
              { label: '人物', value: book.stats.characters, hint: '张卡' },
              { label: '势力', value: book.stats.factions, hint: '归纳' },
              { label: '冲突线索', value: book.stats.conflicts, hint: '条' },
              { label: '未回收伏笔', value: book.stats.openThreads, hint: '条', tone: book.stats.openThreads ? c.warn : c.text },
            ].map(function (tile) {
              return h(
                'div',
                { key: tile.label, style: { background: c.card, border: '1px solid ' + c.border, borderRadius: 11, padding: '9px 11px' } },
                h('div', { style: { color: c.faint, fontSize: 10.5 } }, tile.label),
                h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 3, marginTop: 2 } },
                  h('span', { style: { color: tile.tone || c.text, fontSize: 19, fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' } }, String(tile.value)),
                  h('span', { style: { color: c.faint, fontSize: 10 } }, tile.hint),
                ),
              );
            }),
          ),

          sectionLabel('需要你确认'),
          h(
            'div',
            { style: { display: 'grid', gap: 7 } },
            h(card, { onClick: function () { setSheet({ kind: 'review', tab: 'pending' }); } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('div', { style: { width: 28, height: 28, borderRadius: 8, background: 'color-mix(in srgb, ' + c.warn + ' 18%, ' + c.layer2 + ')', color: c.warn, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, h(Icon, { name: 'flag', size: 15 })),
                h('div', { style: { flex: 1 } },
                  h('div', { style: { color: c.text, fontSize: 12.5 } }, '待确认提案'),
                  h('div', { style: { color: c.faint, fontSize: 10.5, marginTop: 1 } }, '确认后才会进入契约'),
                ),
                h('div', { style: { color: pending.length ? c.warn : c.faint, fontSize: 16, fontWeight: 600 } }, String(pending.length)),
              ),
            ),
            h(card, { onClick: function () { setSheet({ kind: 'review', tab: 'contradictions' }); } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('div', { style: { width: 28, height: 28, borderRadius: 8, background: 'color-mix(in srgb, ' + c.error + ' 16%, ' + c.layer2 + ')', color: c.error, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, h(Icon, { name: 'conflict', size: 15 })),
                h('div', { style: { flex: 1 } },
                  h('div', { style: { color: c.text, fontSize: 12.5 } }, '设定矛盾'),
                  h('div', { style: { color: c.faint, fontSize: 10.5, marginTop: 1 } }, '裁决前不进入契约'),
                ),
                h('div', { style: { color: contradictions.length ? c.error : c.faint, fontSize: 16, fontWeight: 600 } }, String(contradictions.length)),
              ),
            ),
          ),

          sectionLabel('本作设定', h('span', { style: { color: c.faint, fontSize: 10.5 } }, '改动优先于原著')),
          h(card, { onClick: function () { setTab('settings'); setSub('deltas'); } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('div', { style: { width: 28, height: 28, borderRadius: 8, background: 'color-mix(in srgb, ' + c.brand + ' 16%, ' + c.layer2 + ')', color: c.brand, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, h(Icon, { name: 'pen', size: 15 })),
              h('div', { style: { flex: 1 } },
                h('div', { style: { color: c.text, fontSize: 12.5 } }, '本作设定'),
                h('div', { style: { color: c.faint, fontSize: 10.5, marginTop: 1 } }, '作者改过的事实；写进契约，检查器不再按原著报'),
              ),
              h('div', { style: { color: deltaData.items.length ? c.brand : c.faint, fontSize: 16, fontWeight: 600 } }, String(deltaData.items.length)),
            ),
          ),

          sectionLabel('作者私设', h('span', { style: { color: c.faint, fontSize: 10.5 } }, '不进 canon，只用来自查')),
          h(card, { onClick: function () { setSheet({ kind: 'declare' }); } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('div', { style: { width: 28, height: 28, borderRadius: 8, background: 'color-mix(in srgb, ' + c.business + ' 16%, ' + c.layer2 + ')', color: c.business, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, h(Icon, { name: 'pen', size: 15 })),
              h('div', { style: { flex: 1 } },
                h('div', { style: { color: c.text, fontSize: 12.5 } }, 'AU / 私设 / 错名'),
                h('div', { style: { color: c.faint, fontSize: 10.5, marginTop: 1 } }, '声明后，草稿里出现就会报 au_leak / headcanon / name_typo'),
              ),
              h('div', { style: { display: 'flex', gap: 4 } },
                chip('AU ' + ((data && data.declarations && data.declarations.auRules.length) || 0), c.faint),
                chip('私设 ' + ((data && data.declarations && data.declarations.headcanonSignatures.length) || 0), c.faint),
                chip('错名 ' + ((data && data.declarations && Object.keys(data.declarations.typos || {}).length) || 0), c.faint),              ),
            ),
          ),
        );
      }

      function importPanel() {
        const preview = importPreview;
        const doPreview = async function (targetOverride) {
          const target = String(targetOverride || importPath || '').trim();
          if (!target) { setNotice({ tone: c.warn, text: '先填一个本地 txt/md 路径，或用「选择目录」。' }); return; }
          setImportPreview({ phase: 'loading' });
          try {
            const data = await face.preview(target, project || undefined);
            setImportPreview({ phase: 'ready', data: data });
          } catch (error) {
            setImportPreview({ phase: 'error', error: String((error && error.message) || error) });
          }
        };
        const doImport = async function () {
          const target = String(importPath || '').trim();
          if (!target) { setNotice({ tone: c.warn, text: '先填一个本地 txt/md 路径。' }); return; }
          setBusy('导入');
          try {
            const text = await face.importSource(target, project || undefined);
            setNotice({ tone: c.success, text: typeof text === 'string' ? text : '导入完成' });
            setImportPath('');
            setImportPreview(null);
            setImportFiles(null);
            setImportOpen(false);
            // 宿主导入成功后会把这本设为当前项目；面板跟着切过去。
            setProject('');
            await refresh();
          } catch (error) {
            setNotice({ tone: c.error, text: '导入失败：' + String((error && error.message) || error) });
          } finally {
            setBusy('');
          }
        };
        const doPickDir = async function () {
          setPickingDir(true);
          try {
            const picked = await face.pickDir();
            if (!picked || !picked.ok) {
              setNotice({ tone: c.warn, text: (picked && picked.text) || '这个宿主不能弹系统选择器，请直接填路径。' });
              return;
            }
            if (picked.cancelled || !picked.path) return;
            const listed = await face.files(picked.path);
            setImportFiles(listed);
          } catch (error) {
            setNotice({ tone: c.warn, text: '打开选择器失败：' + String((error && error.message) || error) });
          } finally {
            setPickingDir(false);
          }
        };
        const pickFile = function (file) {
          setImportPath(file.path);
          setImportPreview(null);
          doPreview(file.path);
        };
        return h(
          'div',
          { style: { marginTop: 10, padding: '10px 11px', border: '1px solid ' + c.border2, borderRadius: 11, background: c.layer2 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
            h('span', { style: { color: c.sub, fontSize: 11.5, flex: 1, minWidth: 0 } }, '导入原著（txt / md，UTF-8 或 GB18030）'),
            button({ small: true, icon: 'source', disabled: pickingDir, onClick: doPickDir, children: pickingDir ? '选择中…' : '选择目录' }),
          ),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('input', {
              type: 'text', value: importPath, placeholder: 'D:\\books\\我的原著.txt',
              onChange: function (event) { setImportPath(event.target.value); setImportPreview(null); },
              onKeyDown: function (event) { if (event.key === 'Enter') doPreview(); },
              style: {
                flex: 1, minWidth: 0, appearance: 'none', border: '1px solid ' + c.border2,
                background: c.layer, color: c.text, borderRadius: 8, padding: '5px 8px',
                fontSize: 12, lineHeight: '18px', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
              },
            }),
            button({
              small: true, disabled: preview && preview.phase === 'loading',
              onClick: doPreview,
              children: preview && preview.phase === 'loading' ? '解析中…' : '预览',
            }),
            preview && preview.phase === 'ready'
              ? button({ variant: 'primary', small: true, disabled: busy === '导入', onClick: doImport, children: busy === '导入' ? '导入中…' : '确认导入' })
              : null,
          ),
          importFiles
            ? h('div', { style: { marginTop: 8, padding: '7px 8px', borderRadius: 9, border: '1px solid ' + c.border, background: c.layer } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
                  h('span', { style: { color: c.faint, fontSize: 10, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, importFiles.dir),
                  h('button', {
                    type: 'button', onClick: function () { setImportFiles(null); },
                    style: { appearance: 'none', border: 'none', background: 'transparent', color: c.faint, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', padding: 0 },
                  }, '收起'),
                ),
                importFiles.files && importFiles.files.length
                  ? h('div', { style: { maxHeight: 160, overflow: 'auto' } },
                      importFiles.files.map(function (file) {
                        return h('button', {
                          key: file.path, type: 'button', onClick: function () { pickFile(file); },
                          style: {
                            display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
                            appearance: 'none', background: 'transparent', border: 'none', borderBottom: '1px solid ' + c.border,
                            padding: '3px 2px', color: c.text, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
                          },
                        },
                          h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file.name),
                          h('span', { style: { color: c.faint, fontSize: 10, flexShrink: 0 } }, Math.max(1, Math.round(file.bytes / 1024)) + ' KB'),
                        );
                      }),
                    )
                  : h('div', { style: { color: c.faint, fontSize: 10.5, padding: '3px 0' } }, '这个目录里没有 txt/md（≤20MB）。'),
              )
            : null,
          preview && preview.phase === 'error'
            ? h('div', { style: { color: c.error, fontSize: 11, marginTop: 6, lineHeight: 1.6 } }, '预览失败：' + preview.error)
            : null,
          preview && preview.phase === 'ready'
            ? h('div', { style: { marginTop: 8 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  h('span', { style: { color: c.text, fontSize: 12, fontWeight: 600 } }, preview.data.title || '(未命名)'),
                  chip(preview.data.encoding, c.business),
                  chip(preview.data.chars + ' 字', c.sub),
                  chip(preview.data.chapterCount + ' 章', c.sub),
                  preview.data.duplicate ? chip('已导入过·去重', c.warn) : null,
                ),
                h('div', { style: { marginTop: 6, maxHeight: 150, overflow: 'auto' } },
                  (preview.data.chapters || []).slice(0, 12).map(function (ch) {
                    return h('div', { key: ch.id, style: { display: 'flex', gap: 6, alignItems: 'baseline', padding: '2px 0', fontSize: 10.5, color: c.sub, borderBottom: '1px solid ' + c.border } },
                      h('span', { style: { color: c.faint, width: 34, flexShrink: 0 } }, ch.id),
                      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ch.title || '(无题)'),
                      h('span', { style: { color: c.faint, flexShrink: 0 } }, ch.chars + ' 字'),
                    );
                  }),
                  (preview.data.chapters || []).length > 12
                    ? h('div', { style: { color: c.faint, fontSize: 10, paddingTop: 4 } }, '…共 ' + preview.data.chapters.length + ' 章')
                    : null,
                ),
              )
            : null,
          h('div', { style: { color: c.faint, fontSize: 10.5, marginTop: 5, lineHeight: 1.6 } },
            '「选择目录」走宿主原生目录选择器，再从这里挑文件；先预览分章，再确认导入（同一文件按 sha256 去重）。'),
        );
      }

      // ── 设定 · 人物 ─────────────────────────────────────────────────────────
      function characterGrid() {
        const q = String(query || '').trim();
        const roles = Array.from(new Set((book.characters || []).map(function (x) { return x.role; }).filter(Boolean)));
        const list = (book.characters || []).filter(function (ch) {
          if (roleFilter !== 'all' && ch.role !== roleFilter) return false;
          if (!q) return true;
          return [ch.name, ch.summary, (ch.aliases || []).join(' '), ch.role].join(' ').indexOf(q) >= 0;
        });
        return h(
          'div',
          { style: { padding: '9px 10px 96px' } },
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('div', { style: { position: 'relative', flex: 1, minWidth: 0 } },
              h('div', { style: { position: 'absolute', left: 8, top: 6, color: c.faint } }, h(Icon, { name: 'search', size: 13 })),
              h('input', {
                type: 'text', value: query, placeholder: '搜索人物…',
                onChange: function (event) { setQuery(event.target.value); },
                style: {
                  width: '100%', boxSizing: 'border-box', appearance: 'none', border: '1px solid ' + c.border,
                  background: c.layer2, color: c.text, borderRadius: 8, padding: '4px 8px 4px 26px',
                  fontSize: 11.5, lineHeight: '18px', fontFamily: 'inherit', outline: 'none',
                },
              }),
            ),
            h('select', {
              value: roleFilter,
              onChange: function (event) { setRoleFilter(event.target.value); },
              style: {
                appearance: 'none', border: '1px solid ' + c.border, background: c.layer2, color: c.sub,
                borderRadius: 8, padding: '4px 6px', fontSize: 11, fontFamily: 'inherit', outline: 'none', maxWidth: 80,
              },
            },
              h('option', { value: 'all' }, '全部'),
              roles.map(function (role) { return h('option', { key: role, value: role }, role); }),
            ),
          ),
          list.length
            ? h('div', { className: 'fic-people', style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 8 } },
                list.map(function (ch) { return characterCard(ch); }))
            : emptyState('没有匹配的角色', '换个关键词，或把筛选切回全部。'),
          list.length
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '8px 2px', borderTop: '1px dashed ' + c.border } },
              h('span', { style: { fontSize: 11, color: c.faint } },
                '共 ' + list.length + ' 人' + (roleFilter && roleFilter !== 'all' ? '（已按「' + roleFilter + '」筛选）' : '')),
              h('button', {
                type: 'button', className: 'fic-link', style: { marginLeft: 'auto' },
                onClick: function () { setSub('source'); },
              }, '按章节看全部出场 ›'))
            : null,
        );
      }

      function characterCard(ch) {
        return h(
          card,
          {
            key: ch.id,
            onClick: function () { setSheet({ kind: 'character', id: ch.id }); },
            padding: '11px 10px 9px',
            // v0.2.0：去掉每张卡一套彩色渐变顶边（不承载信息，只是噪音）。
            // 人物的色相只在头像上出现一次。
            style: { position: 'relative', overflow: 'hidden' },
          },
          ch.status !== 'confirmed' ? h('span', { className: 'fic-tag warn', style: { position: 'absolute', top: 8, right: 8 } }, '待确认') : null,
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            avatar(ch.name, 36, ch.role),
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
                h('span', { style: { color: c.text, fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, ch.name),
                ch.status !== 'confirmed' ? statusChip(ch.status) : null,
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, minWidth: 0 } },
                chip(ch.role, c.brand, { fontSize: 9.5, lineHeight: '15px', padding: '0 5px' }),
                (ch.aliases || []).length
                  ? h('span', { style: { color: c.faint, fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, ch.aliases.join(' / '))
                  : null,
              ),
            ),
          ),
          h('div', { style: { color: c.sub, fontSize: 11, lineHeight: 1.55, marginTop: 6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, ch.summary),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, color: c.faint, fontSize: 10 } },
            h('span', null, '出场 ' + chapterRange(ch.firstChapter, ch.lastChapter)),
            h('span', { style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 } },
              h(Icon, { name: 'quote', size: 11 }),
              String(ch.mentions),
            ),
          ),
        );
      }

      // ── 设定 · 本作（Fic Canon）─────────────────────────────────────────────
      function deltaView() {
        const items = deltaData.items || [];
        const kinds = [
          ['premise', '前提'],
          ['character', '人物'],
          ['relationship', '关系'],
          ['timeline', '时间线'],
          ['knowledge', '知情'],
          ['world', '世界'],
          ['address', '称呼'],
          ['other', '其他'],
        ];
        const inputStyle = {
          width: '100%', boxSizing: 'border-box', appearance: 'none', border: '1px solid ' + c.border,
          background: c.layer2, color: c.text, borderRadius: 8, padding: '6px 8px',
          fontSize: 11.5, lineHeight: '18px', fontFamily: 'inherit', outline: 'none',
        };
        const areaStyle = Object.assign({}, inputStyle, { resize: 'vertical', minHeight: 54, lineHeight: 1.65 });
        const savePremiseNow = function () {
          return run('保存本作前提', function () {
            return face.savePremise(String(premiseDraft || ''), project || undefined);
          });
        };
        const addNow = function () {
          return run('添加本作设定', function () {
            return face.addDelta({
              kind: deltaDraft.kind,
              title: deltaDraft.title,
              statement: deltaDraft.statement,
              subjects: deltaDraft.subjects,
              fromChapter: deltaDraft.fromChapter,
            }, project || undefined);
          }).then(function (result) {
            if (result) {
              setDeltaDraft({ kind: 'relationship', title: '', statement: '', subjects: '', fromChapter: '' });
              setDeltaFormOpen(false);
            }
          });
        };
        const removeNow = function (id) {
          return run('删除本作设定', function () { return face.removeDelta(id, project || undefined); });
        };
        return h(
          'div',
          { style: { padding: '10px 11px 96px' } },
          h('div', { style: { color: c.text, fontSize: 13.5, fontWeight: 600 } }, '本作设定'),
          h('div', { style: { color: c.faint, fontSize: 10.5, lineHeight: 1.65, marginTop: 3 } },
            '作者明确改过的原著事实。会写进契约最前面的【本作】段，优先于原著；'
            + '带「放过」的条目会让检查器不再按原著报同类问题。'),
          sectionLabel('本作前提'),
          h('textarea', {
            value: premiseDraft === null ? deltaData.premise : premiseDraft,
            rows: 2,
            placeholder: '一句话说清这本同人从哪一刻开始不一样，例如：裴照在 ch002 就认出了沈砚，而不是等到 ch005。',
            onChange: function (event) { setPremiseDraft(event.target.value); },
            style: areaStyle,
          }),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 5 } },
            button({ small: true, variant: 'primary', disabled: busy === '保存本作前提', onClick: savePremiseNow, children: '保存前提' }),
          ),
          sectionLabel('改动清单', h('span', { style: { color: c.faint, fontSize: 10.5 } }, items.length + ' 条')),
          deltaFormOpen
            ? h('div', { style: { background: c.card, border: '1px solid ' + c.border, borderRadius: 10, padding: '9px 10px', marginBottom: 7 } },
                h('div', { style: { display: 'flex', gap: 6, marginBottom: 5 } },
                  h('select', {
                    value: deltaDraft.kind,
                    onChange: function (event) { setDeltaDraft(Object.assign({}, deltaDraft, { kind: event.target.value })); },
                    style: Object.assign({}, inputStyle, { flex: 1 }),
                  }, kinds.map(function (k) { return h('option', { key: k[0], value: k[0] }, k[1]); })),
                  h('input', {
                    type: 'text', value: deltaDraft.fromChapter, placeholder: '从 ch002 起（可空）',
                    onChange: function (event) { setDeltaDraft(Object.assign({}, deltaDraft, { fromChapter: event.target.value })); },
                    style: Object.assign({}, inputStyle, { width: 120, flex: '0 0 120px' }),
                  }),
                ),
                h('input', {
                  type: 'text', value: deltaDraft.title, placeholder: '一句话标题，如 裴照与沈砚是恋人',
                  onChange: function (event) { setDeltaDraft(Object.assign({}, deltaDraft, { title: event.target.value })); },
                  style: Object.assign({}, inputStyle, { marginBottom: 5 }),
                }),
                h('textarea', {
                  value: deltaDraft.statement, rows: 3,
                  placeholder: '本作里改成什么、和原著哪里冲突、从哪一章起生效。',
                  onChange: function (event) { setDeltaDraft(Object.assign({}, deltaDraft, { statement: event.target.value })); },
                  style: Object.assign({}, areaStyle, { marginBottom: 5 }),
                }),
                h('input', {
                  type: 'text', value: deltaDraft.subjects, placeholder: '涉及人物，逗号分隔（可空）',
                  onChange: function (event) { setDeltaDraft(Object.assign({}, deltaDraft, { subjects: event.target.value })); },
                  style: Object.assign({}, inputStyle, { marginBottom: 6 }),
                }),
                h('div', { style: { display: 'flex', gap: 6 } },
                  button({ small: true, variant: 'primary', disabled: busy === '添加本作设定', onClick: addNow, children: '添加' }),
                  button({ small: true, onClick: function () { setDeltaFormOpen(false); }, children: '取消' }),
                ),
              )
            : button({ small: true, icon: 'pen', onClick: function () { setDeltaFormOpen(true); }, children: '添加本作改动' }),
          items.length
            ? h('div', { style: { display: 'grid', gap: 6, marginTop: 7 } },
                items.map(function (row) {
                  return h('div', {
                    key: row.id,
                    style: {
                      background: c.card, border: '1px solid ' + c.border, borderLeft: '3px solid ' + c.brand,
                      borderRadius: '0 9px 9px 0', padding: '7px 9px',
                    },
                  },
                    h('div', { style: { display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' } },
                      chip((kinds.find(function (k) { return k[0] === row.kind; }) || ['other', '其他'])[1], c.brand, { fontSize: 9.5 }),
                      h('span', { style: { color: c.text, fontSize: 12, fontWeight: 600, flex: 1, minWidth: 0 } }, row.title),
                      h('button', {
                        type: 'button', onClick: function () { removeNow(row.id); },
                        style: { appearance: 'none', border: 'none', background: 'transparent', color: c.faint, cursor: 'pointer', fontFamily: 'inherit', fontSize: 10.5, padding: 0 },
                      }, '删除'),
                    ),
                    h('div', { style: { color: c.sub, fontSize: 11, lineHeight: 1.6, marginTop: 3 } }, row.statement),
                    h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 } },
                      row.fromChapter ? chip('从 ' + row.fromChapter, c.faint, { fontSize: 9.5 }) : null,
                      row.source === 'finding' ? chip('从检查登记', c.business, { fontSize: 9.5 }) : null,
                      (row.suppress || []).map(function (s, i) {
                        return h('span', { key: 's' + i, style: { display: 'inline-flex' } },
                          chip('放过 ' + s.detector + '/' + s.code, c.success, { fontSize: 9.5 }));
                      }),
                    ),
                  );
                }),
              )
            : h('div', { style: { color: c.faint, fontSize: 11.5, marginTop: 7 } }, '还没有本作改动；没有改动的书按原著 canon 写。'),
        );
      }

      function characterSheet(ch) {
        const sheetTab = (sheet && sheet.tab) || 'profile';
        const edges = (book.matrix.edges || []).filter(function (e) { return e.from === ch.id || e.to === ch.id; });
        const rels = (book.relations || []).filter(function (r) { return r.from === ch.name; });
        const knows = (book.conflicts || []).map(function (k) {
          const known = (k.known || []).find(function (x) { return x.id === ch.id; });
          const unknown = (k.unknown || []).indexOf(ch.name) >= 0;
          return known ? { kind: '知道', from: known.fromChapter, title: k.title }
            : unknown ? { kind: '不知道', from: null, title: k.title } : null;
        }).filter(Boolean);
        return h(
          Sheet,
          { title: null, onClose: function () { setSheet(null); } },
          h(
            'div',
            {
              style: Object.assign(
                {
                  height: 58, borderRadius: 10, marginBottom: -26,
                  display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 14,
                },
                artStyle(ch.name, 58),
              ),
            },
            h('span', { style: { fontSize: 34, fontWeight: 700, opacity: 0.6 } }, ch.name.slice(0, 1)),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 11, alignItems: 'center', marginBottom: 8, paddingLeft: 8 } },
            avatar(ch.name, 56, ch.role),
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('span', { style: { color: c.text, fontSize: 16, fontWeight: 600 } }, ch.name),
                chip(ch.role, c.brand),
                statusChip(ch.status),
              ),
              h('div', { style: { color: c.faint, fontSize: 11, marginTop: 3 } },
                '出场 ' + chapterRange(ch.firstChapter, ch.lastChapter) + ' · 提及 ' + ch.mentions + ' · 证据 ' + ch.evidenceCount),
            ),
          ),
          tabs([
            { key: 'profile', label: '档案' },
            { key: 'relations', label: '关系' },
            { key: 'evidence', label: '证据' },
          ], sheetTab, function (key) { setSheet({ kind: 'character', id: ch.id, tab: key }); }, true),
          h('div', { style: { marginTop: 8 } },
            sheetTab === 'profile' ? h('div', null,
              field('别名', (ch.aliases || []).join('、')),
              field('身份', ch.role),
              field('一句话', ch.summary),
              field('声线', (ch.voiceSamples || []).join(' / ')),
              (ch.evidenceCount ? null : null),
              h('div', { style: { height: 6 } }),
              h('div', { style: { color: c.faint, fontSize: 10.5, margin: '6px 0 4px' } }, '知情'),
              knows.length
                ? knows.map(function (k, i) {
                    return h('div', { key: 'k' + i, style: { display: 'flex', gap: 6, alignItems: 'baseline', padding: '2px 0', fontSize: 11.5 } },
                      chip(k.kind, k.kind === '知道' ? c.success : c.warn),
                      h('span', { style: { color: c.sub, flex: 1, minWidth: 0 } }, k.title),
                      k.from ? h('span', { style: { color: c.faint, fontSize: 10.5 } }, k.from) : null,
                    );
                  })
                : h('div', { style: { color: c.faint, fontSize: 11.5 } }, '没有和秘密相关。'),
            ) : null,
            sheetTab === 'relations' ? h('div', null,
              h('div', { style: { color: c.faint, fontSize: 10.5, margin: '2px 0 4px' } }, '称呼'),
              edges.length
                ? edges.map(function (e) {
                    return h('div', { key: e.id, style: { display: 'flex', gap: 6, alignItems: 'baseline', padding: '3px 0', fontSize: 11.5, borderBottom: '1px solid ' + c.border } },
                      h('span', { style: { color: c.text, minWidth: 0 } }, e.fromName + ' → ' + e.toName),
                      h('span', { style: { color: c.sub, marginLeft: 'auto', whiteSpace: 'nowrap' } }, e.publicForm + (e.privateForm && e.privateForm !== e.publicForm ? ' / ' + e.privateForm : '')),
                      h('span', { style: { color: c.faint, fontSize: 10.5, whiteSpace: 'nowrap' } }, e.fromChapter || ''),
                    );
                  })
                : h('div', { style: { color: c.faint, fontSize: 11.5 } }, '没有称呼记录。'),
              h('div', { style: { color: c.faint, fontSize: 10.5, margin: '10px 0 4px' } }, '关系'),
              rels.length
                ? rels.map(function (r) {
                    return h('div', { key: r.id, style: { padding: '3px 0', fontSize: 11.5, borderBottom: '1px solid ' + c.border } },
                      h('span', { style: { color: c.text } }, r.text),
                      h('span', { style: { color: c.faint, fontSize: 10.5, marginLeft: 6 } }, r.chapter + (r.status !== 'confirmed' ? ' · 待审' : '')),
                    );
                  })
                : h('div', { style: { color: c.faint, fontSize: 11.5 } }, '没有关系事实。'),
            ) : null,
            sheetTab === 'evidence' ? h('div', null,
              ch.evidence.length
                ? ch.evidence.map(function (ev, i) {
                    return h('div', { key: 'ev' + i }, evidenceRow(ev, function () { openChapter(ev.chapter); }));
                  })
                : h('div', { style: { color: c.faint, fontSize: 11.5 } }, '还没有证据片段。'),
            ) : null,
          ),
        );
      }

      // ── 设定 · 势力 ─────────────────────────────────────────────────────────
      function factionGrid() {
        if (!book.factions.length) {
          return emptyState('还没有势力卡', 'v0.1 从「身份」事实归纳组织与地点；确认更多角色身份后自动出现。');
        }
        return h('div', { style: { padding: '9px 10px 96px' } },
          h('div', { style: { color: c.faint, fontSize: 10.5, lineHeight: 1.6, marginBottom: 7 } },
            '由身份事实归纳（不是独立实体）：卡片上的人是成员，证据指向原文。'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(138px, 1fr))', gap: 7 } },
            book.factions.map(function (f) {
              return h(card, { key: f.id, onClick: function () { setSheet({ kind: 'faction', id: f.id }); }, padding: '9px 10px' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('span', { style: { color: c.text, fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
                  statusChip(f.status),
                ),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 5 } },
                  chip(f.kind, c.business),
                  h('span', { style: { color: c.faint, fontSize: 10 } }, (f.members || []).length + ' 人'),
                ),
                h('div', { style: { display: 'flex', gap: 3, marginTop: 6 } },
                  (f.members || []).slice(0, 4).map(function (m) { return avatar(m.name, 20, m.role); }),
                  (f.members || []).length > 4 ? h('span', { style: { color: c.faint, fontSize: 10, alignSelf: 'center' } }, '+' + (f.members.length - 4)) : null,
                ),
              );
            }),
          ),
        );
      }

      function factionSheet(f) {
        return h(Sheet, { title: h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('span', { style: { color: c.text, fontSize: 15, fontWeight: 600 } }, f.name), chip(f.kind, c.business), statusChip(f.status)),
          onClose: function () { setSheet(null); } },
          h('div', { style: { color: c.faint, fontSize: 10.5, marginBottom: 8 } }, '从身份事实归纳，成员与证据都可追溯到原文。'),
          field('类型', f.kind),
          field('成员', (f.members || []).map(function (m) { return m.name + '（' + m.role + '）'; }).join('、')),
          field('首次出场', f.firstChapter),
          sectionLabel('成员'),
          (f.members || []).map(function (m) {
            const ch = (book.characters || []).find(function (x) { return x.id === m.id; });
            return h('button', {
              key: m.id, type: 'button',
              onClick: function () { if (ch) setSheet({ kind: 'character', id: ch.id }); },
              style: { display: 'flex', alignItems: 'center', gap: 7, width: '100%', appearance: 'none', background: 'transparent', border: 'none', borderBottom: '1px solid ' + c.border, padding: '5px 0', cursor: ch ? 'pointer' : 'default', fontFamily: 'inherit', textAlign: 'left' },
            }, avatar(m.name, 24, m.role), h('span', { style: { color: c.text, fontSize: 12 } }, m.name), h('span', { style: { color: c.faint, fontSize: 10.5, marginLeft: 'auto' } }, m.role));
          }),
          sectionLabel('证据'),
          (f.evidence || []).map(function (ev, i) { return h('div', { key: 'fe' + i }, evidenceRow(ev, function () { openChapter(ev.chapter); })); }),
        );
      }

      // ── 设定 · 关系 ─────────────────────────────────────────────────────────
      function relationView() {
        const people = book.matrix.people || [];
        const find = function (fromId, toId) {
          return (book.matrix.edges || []).find(function (e) { return e.from === fromId && e.to === toId; });
        };
        return h('div', { style: { padding: '9px 10px 96px' } },
          h('div', { style: { color: c.faint, fontSize: 10.5, marginBottom: 7, lineHeight: 1.6 } },
            '行 = 称呼者，列 = 被称呼者。格子里是公开称呼 / 私下称呼与改口章；点格子看证据。'),
          h('div', { style: { overflowX: 'auto', border: '1px solid ' + c.border, borderRadius: 10 } },
            h('table', { style: { borderCollapse: 'collapse', width: '100%', fontSize: 10.5 } },
              h('thead', null,
                h('tr', null,
                  h('th', { style: { padding: '5px 6px', color: c.faint, textAlign: 'left', fontWeight: 500, borderBottom: '1px solid ' + c.border, position: 'sticky', left: 0, background: c.layer } }, '谁 \\ 叫谁'),
                  people.map(function (p) {
                    return h('th', { key: p.id, style: { padding: '5px 4px', color: c.sub, fontWeight: 600, textAlign: 'center', borderBottom: '1px solid ' + c.border, whiteSpace: 'nowrap' } }, p.name);
                  }),
                ),
              ),
              h('tbody', null,
                people.map(function (row) {
                  return h('tr', { key: row.id },
                    h('th', { style: { padding: '5px 6px', color: c.sub, fontWeight: 600, textAlign: 'left', borderBottom: '1px solid ' + c.border, whiteSpace: 'nowrap', position: 'sticky', left: 0, background: c.layer } }, row.name),
                    people.map(function (col) {
                      if (row.id === col.id) {
                        return h('td', { key: col.id, style: { padding: '4px 5px', textAlign: 'center', color: c.border2, borderBottom: '1px solid ' + c.border } }, '—');
                      }
                      const edge = find(row.id, col.id);
                      const tone = edge ? (edge.status === 'confirmed' ? c.text : c.warn) : c.faint;
                      return h('td', {
                        key: col.id,
                        onClick: edge ? function () { setSheet({ kind: 'edge', id: edge.id }); } : undefined,
                        style: { padding: '4px 5px', textAlign: 'center', borderBottom: '1px solid ' + c.border, color: tone, cursor: edge ? 'pointer' : 'default', lineHeight: 1.35 },
                      }, edge
                        ? h('span', null,
                            edge.publicForm || edge.form,
                            edge.privateForm && edge.privateForm !== (edge.publicForm || edge.form)
                              ? h('span', { style: { display: 'block', color: c.faint, fontSize: 9.5 } }, '私下 ' + edge.privateForm) : null,
                            h('span', { style: { display: 'block', color: c.faint, fontSize: 9 } }, edge.fromChapter || ''),
                          )
                        : '·');
                    }),
                  );
                }),
              ),
            ),
          ),
          sectionLabel('关系事实', h('span', { style: { color: c.faint, fontSize: 10.5 } }, (book.relations || []).length + ' 条')),
          (book.relations || []).length
            ? book.relations.map(function (r) {
                return h(card, { key: r.id, padding: '7px 10px', style: { marginBottom: 6 }, onClick: function () { if (r.evidence[0]) openChapter(r.evidence[0].chapter); } },
                  h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
                    h('span', { style: { color: c.text, fontSize: 11.5, fontWeight: 600 } }, r.from),
                    h('span', { style: { color: c.sub, fontSize: 11.5, flex: 1, minWidth: 0 } }, r.text),
                    statusChip(r.status),
                  ),
                  h('div', { style: { color: c.faint, fontSize: 10, marginTop: 2 } }, r.chapter + ' · ' + (r.evidence[0] ? r.evidence[0].quote : '')),
                );
              })
            : h('div', { style: { color: c.faint, fontSize: 11.5 } }, '还没有关系事实。'),
        );
      }

      function edgeSheet(edge) {
        return h(Sheet, { title: h('div', { style: { color: c.text, fontSize: 14.5, fontWeight: 600 } }, edge.fromName + ' → ' + edge.toName),
          onClose: function () { setSheet(null); } },
          field('公开称呼', edge.publicForm || edge.form),
          field('私下称呼', edge.privateForm),
          field('改口章', edge.fromChapter),
          field('禁忌', (edge.taboo || []).join('、')),
          h('div', { style: { marginTop: 6 } }, statusChip(edge.status)),
          sectionLabel('证据'),
          (edge.evidence || []).map(function (ev, i) { return h('div', { key: 'e' + i }, evidenceRow(ev, function () { openChapter(ev.chapter); })); }),
        );
      }

      // ── 设定 · 世界 ─────────────────────────────────────────────────────────
      function worldView() {
        const world = book.world || { rules: [], locations: [], items: [], terms: [] };
        const tabsRow = tabs([
          { key: 'rules', label: '规则', count: world.rules.length },
          { key: 'locations', label: '地点', count: world.locations.length },
          { key: 'items', label: '物品', count: world.items.length },
          { key: 'terms', label: '术语', count: world.terms.length },
        ], worldSub, setWorldSub, true);
        let body = null;
        if (worldSub === 'rules') {
          body = world.rules.length
            ? world.rules.map(function (r) {
                return h(card, { key: r.id, padding: '8px 10px', style: { marginBottom: 6, borderLeft: '3px solid ' + (r.status === 'confirmed' ? c.success : c.warn) } },
                  h('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start' } },
                    h('span', { style: { color: c.text, fontSize: 11.5, lineHeight: 1.65, flex: 1, minWidth: 0 } }, r.text),
                    statusChip(r.status),
                  ),
                  h('div', { style: { color: c.faint, fontSize: 10, marginTop: 3 } }, (r.evidence[0] ? r.evidence[0].chapter + ' · ' + r.evidence[0].quote : '')),
                );
              })
            : emptyState('还没有世界规则', '规则来自原著里可核对的句子；确认后进入契约的【世界规则】段。');
        } else if (worldSub === 'locations' || worldSub === 'items') {
          const list = world[worldSub];
          body = list.length
            ? list.map(function (x) {
                return h(card, { key: x.id, padding: '8px 10px', style: { marginBottom: 6 }, onClick: function () { if (x.evidence[0]) openChapter(x.evidence[0].chapter); } },
                  h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                    h('span', { style: { color: c.text, fontSize: 12, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.name),
                    statusChip(x.status),
                  ),
                  h('div', { style: { color: c.faint, fontSize: 10.5, marginTop: 2 } }, (x.owner ? '归属 ' + x.owner : x.holder ? '持有 ' + x.holder : '') + ' · ' + (x.chapter || '')),
                  h('div', { style: { color: c.sub, fontSize: 10.5, marginTop: 2 } }, x.evidence[0] ? '「' + x.evidence[0].quote + '」' : ''),
                );
              })
            : emptyState(worldSub === 'locations' ? '还没有地点卡' : '还没有物品卡', 'v0.1 从「居住/持有」事实归纳。');
        } else {
          body = world.terms.length
            ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
                world.terms.map(function (t) {
                  return h('div', { key: t.id, title: t.note || '', style: { border: '1px solid ' + c.border, background: c.card, borderRadius: 8, padding: '4px 8px', fontSize: 11 } },
                    h('span', { style: { color: c.text } }, t.name),
                    h('span', { style: { color: c.faint, fontSize: 9.5, marginLeft: 4 } }, t.kind),
                  );
                }))
            : emptyState('还没有术语', '术语由人物、势力、地点、物品名归纳。');
        }
        return h('div', { style: { padding: '9px 10px 96px' } }, h('div', { style: { marginBottom: 6 } }, tabsRow), body);
      }

      // ── 设定 · 冲突 ─────────────────────────────────────────────────────────
      function conflictView() {
        return h('div', { style: { padding: '9px 10px 96px' } },
          h('div', { style: { color: c.faint, fontSize: 10.5, lineHeight: 1.65, marginBottom: 7 } },
            '故事冲突（谁和谁在争什么），不是设定矛盾。v0.1 从「秘密 + 知情状态」归纳：知道的人 vs 还不知道的人。'),
          (book.conflicts || []).length
            ? book.conflicts.map(function (k) {
                return h(card, { key: k.id, padding: '9px 10px', style: { marginBottom: 7 } },
                  h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 6 } },
                    h('div', { style: { color: c.text, fontSize: 11.5, lineHeight: 1.65, flex: 1, minWidth: 0 } }, k.title),
                    statusChip(k.status),
                  ),
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, flexWrap: 'wrap' } },
                    h('span', { style: { color: c.faint, fontSize: 10 } }, '知道'),
                    (k.known || []).map(function (p) { return chip(p.name + (p.fromChapter ? '·' + p.fromChapter : ''), c.success); }),
                  ),
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, marginTop: 4, flexWrap: 'wrap' } },
                    h('span', { style: { color: c.faint, fontSize: 10 } }, '不知道'),
                    (k.unknown || []).length ? (k.unknown || []).map(function (n) { return chip(n, c.warn); }) : h('span', { style: { color: c.faint, fontSize: 10.5 } }, '都知道了'),
                  ),
                  h('div', { style: { color: c.faint, fontSize: 10, marginTop: 5 } },
                    (k.chapters || []).filter(Boolean).filter(function (x, i, arr) { return arr.indexOf(x) === i; }).join(' → ')
                    + (k.publicAtChapter ? ' · 公开于 ' + k.publicAtChapter : '')),
                );
              })
            : emptyState('还没有冲突线索', '秘密（secrets）一旦确认，就会在这里显示知情双方。'),
          sectionLabel('设定矛盾（另一回事）', h('span', { style: { color: c.faint, fontSize: 10.5 } }, contradictions.length + ' 条')),
          h('div', { style: { color: c.faint, fontSize: 10.5, lineHeight: 1.65 } },
            contradictions.length
              ? '同一件事在不同章节写得不一样，去「审阅」里裁决；裁决前不进入契约。'
              : '没有未裁决矛盾。'),
        );
      }

      // ── 剧情 ────────────────────────────────────────────────────────────────
      function plotView() {
        const body = plotSub === 'timeline' ? timelineList()
          : plotSub === 'threads' ? threadList()
            : eventList();
        const drawn = (book.timeline || []).filter(function (t) { return t.factCount > 0; }).length;
        return h('div', { style: { padding: '9px 10px 96px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 } },
            tabs([
              { key: 'timeline', label: '时间线', count: (book.timeline || []).length },
              { key: 'threads', label: '伏笔', count: (book.threads || []).length },
              { key: 'events', label: '事件', count: book.coverage.facts.total },
            ], plotSub, setPlotSub, true),
            h('span', { style: { flex: 1 } }),
            plotSub === 'timeline'
              ? h('button', {
                  type: 'button',
                  onClick: function () { setTimelineAll(!timelineAll); },
                  style: { appearance: 'none', border: 'none', background: 'transparent', color: c.brand, fontSize: 10.5, fontFamily: 'inherit', cursor: 'pointer', padding: '0 2px', whiteSpace: 'nowrap' },
                }, timelineAll ? '只看已抽 · ' + drawn : '全部 · ' + (book.timeline || []).length)
              : null,
          ),
          body,
        );
      }

      function timelineList() {
        const all = book.timeline || [];
        // 长篇几百章：默认只看抽过 canon 的章，避免一次渲染几百张卡。
        const rows = timelineAll ? all : all.filter(function (t) { return t.factCount > 0; });
        const shown = rows.slice(0, timelineLimit);
        return h('div', null,
          shown.length
            ? shown.map(function (ch, index) {
                return h('div', { key: ch.id, style: { display: 'flex', gap: 8 } },
                  h('div', { style: { width: 10, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 6 } },
                    h('div', { style: { width: 7, height: 7, borderRadius: 99, background: index === 0 ? c.brand : c.border2, marginBottom: 4 } }),
                    h('div', { style: { flex: 1, width: 1, background: c.border, minHeight: 18 } }),
                  ),
                  h('div', { style: { flex: 1, minWidth: 0, paddingBottom: 8 } },
                    h(card, { padding: '8px 10px', onClick: function () { openChapter(ch.id); } },
                      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                        h('span', { style: { color: c.faint, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' } }, ch.id),
                        h('span', { style: { color: c.text, fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0 } }, ch.title || '(无题)'),
                        h('span', { style: { color: c.faint, fontSize: 10 } }, ch.chars + ' 字'),
                      ),
                      h('div', { style: { display: 'flex', gap: 4, marginTop: 5, flexWrap: 'wrap' } },
                        ch.factCount ? chip(ch.factCount + ' 条事实', c.business) : chip('无事实', c.faint),
                        (ch.present || []).map(function (n) { return chip(n, c.sub); }),
                      ),
                      ch.quote ? h('div', { style: { color: c.sub, fontSize: 10.5, marginTop: 5, lineHeight: 1.6 } }, '「' + ch.quote.quote + '」') : null,
                    ),
                  ),
                );
              })
            : emptyState('这些章还没有 canon', '导入原著后先做提案与确认；切「全部」可以看到全书章节。'),
          rows.length > shown.length
            ? h('div', { style: { display: 'flex', justifyContent: 'center', padding: '6px 0' } },
                button({ small: true, onClick: function () { setTimelineLimit(timelineLimit + 60); }, children: '再显示 60 章（还有 ' + (rows.length - shown.length) + '）' }))
            : null,
        );
      }

      function threadList() {
        return (book.threads || []).length
          ? book.threads.map(function (t) {
              return h(card, { key: t.id, padding: '8px 10px', style: { marginBottom: 6, borderLeft: '3px solid ' + (t.revealed ? c.success : c.warn) } },
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start' } },
                  h('span', { style: { color: c.text, fontSize: 11.5, lineHeight: 1.65, flex: 1, minWidth: 0 } }, t.title),
                  chip(t.revealed ? '已回收' : '未回收', t.revealed ? c.success : c.warn),
                ),
                h('div', { style: { color: c.faint, fontSize: 10.5, marginTop: 4 } },
                  '埋设 ' + (t.setup || '-') + ' · 公开 ' + (t.payoff || '未定') + ' · ' + t.status),
                t.evidence[0] ? h('div', { style: { color: c.sub, fontSize: 10.5, marginTop: 3 } }, '「' + t.evidence[0].quote + '」') : null,
              );
            })
          : emptyState('还没有伏笔', '秘密（secrets）会在这里按「埋设章 / 公开章」列出。');
      }

      function eventList() {
        const rows = [];
        (book.timeline || []).forEach(function (ch) {
          (ch.facts || []).forEach(function (f) {
            rows.push(h('div', { key: f.id, style: { display: 'flex', gap: 6, alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid ' + c.border, fontSize: 11 } },
              h('span', { style: { color: c.faint, fontSize: 10, width: 38, flexShrink: 0 } }, ch.id),
              h('span', { style: { color: c.text, flex: 1, minWidth: 0, lineHeight: 1.55 } },
                h('span', { style: { color: c.sub } }, f.subject + ' · '),
                f.predicate,
                h('span', { style: { color: c.text } }, ' ' + f.object),
              ),
              f.status !== 'confirmed' ? chip('待审', c.warn) : null,
            ));
          });
        });
        return rows.length ? rows : emptyState('还没有事件', '事实按章分到这里；先确认 canon 提案。');
      }

      // ── 原文 ────────────────────────────────────────────────────────────────
      function sourceView() {
        if (chapterView) {
          return h('div', { style: { padding: '9px 10px 96px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
              button({ small: true, icon: 'chevron', onClick: function () { setChapterView(null); }, children: '章节列表' }),
              h('span', { style: { color: c.text, fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                chapterView.id + ' ' + (chapterView.title || '')),
              h('span', { style: { color: c.faint, fontSize: 10 } }, chapterView.chars ? chapterView.chars + ' 字' : ''),
            ),
            chapterView.phase === 'loading'
              ? h('div', { style: { color: c.faint, fontSize: 12, padding: 12 } }, '读正文…')
              : chapterView.phase === 'error'
                ? h('div', { style: { color: c.error, fontSize: 12, padding: 12 } }, '读不到：' + chapterView.error)
                : h('pre', {
                    style: {
                      margin: 0, padding: '10px 12px', borderRadius: 10, background: c.layer2,
                      border: '1px solid ' + c.border, color: c.text, fontSize: 12, lineHeight: 1.95,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit',
                    },
                  }, (function () {
                    const full = String(chapterView.text || '');
                    const focus = chapterView.focus;
                    if (!focus) return full;
                    let start = Number.isFinite(focus.offset) ? focus.offset : -1;
                    if (start < 0 || full.slice(start, start + 8) !== String(focus.quote || '').slice(0, 8)) {
                      start = focus.quote ? full.indexOf(focus.quote) : -1;
                    }
                    if (start < 0) return full;
                    const end = Math.min(full.length, start + String(focus.quote || '').length);
                    return [
                      full.slice(0, start),
                      h('mark', {
                        key: 'hit',
                        style: {
                          background: 'color-mix(in srgb, ' + c.warn + ' 34%, transparent)',
                          color: c.text, borderRadius: 3, padding: '0 1px',
                        },
                      }, full.slice(start, end)),
                      full.slice(end),
                    ];
                  })()),
          );
        }
        return h('div', { style: { padding: '9px 10px 96px' } },
          h('div', { style: { display: 'flex', gap: 6 } },
            h('div', { style: { position: 'relative', flex: 1, minWidth: 0 } },
              h('div', { style: { position: 'absolute', left: 8, top: 6, color: c.faint } }, h(Icon, { name: 'search', size: 13 })),
              h('input', {
                type: 'text', value: searchTerm, placeholder: '全文检索，如「阿砚」「灯油」…',
                onChange: function (event) { setSearchTerm(event.target.value); },
                onKeyDown: function (event) { if (event.key === 'Enter') doSearch(); },
                style: {
                  width: '100%', boxSizing: 'border-box', appearance: 'none', border: '1px solid ' + c.border,
                  background: c.layer2, color: c.text, borderRadius: 8, padding: '4px 8px 4px 26px',
                  fontSize: 11.5, lineHeight: '18px', fontFamily: 'inherit', outline: 'none',
                },
              }),
            ),
            button({ small: true, onClick: doSearch, disabled: busy === '检索', children: busy === '检索' ? '…' : '检索' }),
          ),
          searchResult
            ? h('div', { style: { marginTop: 8 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, color: c.faint, fontSize: 10.5, marginBottom: 4 } },
                  h('span', null, '「' + searchResult.term + '」命中 ' + searchResult.total + ' 处'),
                  h('button', { type: 'button', onClick: function () { setSearchResult(null); }, style: { appearance: 'none', border: 'none', background: 'transparent', color: c.brand, fontSize: 10.5, cursor: 'pointer', fontFamily: 'inherit', marginLeft: 'auto' } }, '清除'),
                ),
                (searchResult.hits || []).map(function (hit, i) {
                  return h('button', {
                    key: 'hit' + i, type: 'button', onClick: function () { openChapter(hit.chapter); },
                    style: { display: 'block', width: '100%', textAlign: 'left', appearance: 'none', background: 'transparent', border: 'none', borderLeft: '2px solid ' + c.border2, padding: '3px 0 3px 8px', margin: '3px 0', color: c.sub, fontSize: 11, lineHeight: 1.6, fontFamily: 'inherit', cursor: 'pointer' },
                  },
                    '「' + hit.quote + '」',
                    h('div', { style: { color: c.faint, fontSize: 10 } }, hit.chapter + ' · ' + (hit.title || '') + ' · @' + hit.offset),
                  );
                }),
              )
            : null,
          sectionLabel('章节', h('span', { style: { color: c.faint, fontSize: 10.5 } }, chapters.length + ' 章' + (chapters.length > chapterLimit ? '（显示前 ' + chapterLimit + '）' : ''))),
          chapters.slice(0, chapterLimit).map(function (ch) {
            return h('button', {
              key: ch.id, type: 'button', onClick: function () { openChapter(ch.id); },
              style: {
                display: 'flex', width: '100%', alignItems: 'baseline', gap: 7, appearance: 'none',
                background: 'transparent', border: 'none', borderBottom: '1px solid ' + c.border,
                padding: '6px 2px', color: c.text, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', fontSize: 12,
              },
            },
              h('span', { style: { color: c.faint, fontSize: 10.5, fontVariantNumeric: 'tabular-nums', width: 34, flexShrink: 0 } }, ch.id),
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ch.title || '(无题)'),
              h('span', { style: { color: c.faint, fontSize: 10.5 } }, ch.chars + ' 字'),
            );
          }),
          chapters.length > chapterLimit
            ? h('div', { style: { display: 'flex', justifyContent: 'center', paddingTop: 6 } },
                button({ small: true, onClick: function () { setChapterLimit(chapterLimit + 120); }, children: '再显示 120 章（还有 ' + (chapters.length - chapterLimit) + '）' }))
            : null,
        );
      }

      // ── 审阅抽屉 ────────────────────────────────────────────────────────────
      function reviewSheet() {
        const tabKey = (sheet && sheet.tab) || 'pending';
        return h(Sheet, {
          title: h('div', { style: { color: c.text, fontSize: 14.5, fontWeight: 600 } }, '审阅队列'),
          onClose: function () { setSheet(null); },
        },
          tabs([
            { key: 'pending', label: '待确认', count: pending.length },
            { key: 'contradictions', label: '设定矛盾', count: contradictions.length },
          ], tabKey, function (key) { setSheet({ kind: 'review', tab: key }); }, true),
          h('div', { style: { marginTop: 8 } },
            tabKey === 'pending'
              ? (pending.length
                  ? pending.map(function (item) {
                      return h('div', { key: item.id, style: { padding: '8px 0', borderBottom: '1px solid ' + c.border } },
                        h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
                          chip(item.kind, c.business),
                          h('span', { style: { color: c.faint, fontSize: 10.5 } }, item.id + (item.chapter ? ' · ' + item.chapter : '')),
                        ),
                        h('div', { style: { color: c.text, fontSize: 11.5, lineHeight: 1.65, margin: '3px 0 6px' } }, item.label),
                        h('div', { style: { display: 'flex', gap: 5 } },
                          button({ small: true, variant: 'primary', icon: 'check', disabled: busy === '确认 ' + item.id, onClick: function () { return run('确认 ' + item.id, function () { return face.confirm([item.id], activeProject()); }); }, children: '确认' }),
                          button({ small: true, tone: c.error, disabled: busy === '拒绝 ' + item.id, onClick: function () { return run('拒绝 ' + item.id, function () { return face.reject([item.id], activeProject()); }); }, children: '拒绝' }),
                        ),
                      );
                    })
                  : emptyState('没有待确认条目', '导入原著后，AI 的提案会排队到这里；确认后才进入契约。'))
              : (contradictions.length
                  ? contradictions.map(function (fc) {
                      return h('div', { key: fc.id, style: { padding: '8px 0', borderBottom: '1px solid ' + c.border } },
                        h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
                          chip('设定矛盾', c.error),
                          h('span', { style: { color: c.faint, fontSize: 10.5 } }, fc.id + (fc.chapters && fc.chapters.length ? ' · ' + fc.chapters.join(' / ') : '')),
                        ),
                        h('div', { style: { color: c.text, fontSize: 11.5, lineHeight: 1.65, margin: '3px 0' } }, fc.description),
                        fc.values && fc.values.length ? h('div', { style: { color: c.warn, fontSize: 10.5, marginBottom: 6 } }, fc.values.join('  vs  ')) : null,
                        h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
                          button({ small: true, disabled: !!busy, onClick: function () { return run('裁决 ' + fc.id + ' later', function () { return face.resolve(fc.id, 'later', activeProject()); }); }, children: '以后章为准' }),
                          button({ small: true, disabled: !!busy, onClick: function () { return run('裁决 ' + fc.id + ' earlier', function () { return face.resolve(fc.id, 'earlier', activeProject()); }); }, children: '以前章为准' }),
                          button({ small: true, disabled: !!busy, onClick: function () { return run('裁决 ' + fc.id + ' both', function () { return face.resolve(fc.id, 'both', activeProject()); }); }, children: '两者都算' }),
                        ),
                      );
                    })
                  : emptyState('没有未裁决矛盾', '同一事实在不同章节不一致时，会在这里出现；裁决前不会被写进契约。')),
          ),
        );
      }

      // ── 写作抽屉 ────────────────────────────────────────────────────────────
      function writingSheet() {
        const tags = writing.tags;
        const ORDER = ['本作', '视角', '在场', '称呼', '知情', '世界规则', '时间线', '禁忌', '不确定', '锚点'];
        const findings = (writing.checked && writing.checked.findings) || [];
        const suppressed = (writing.checked && writing.checked.suppressed) || [];
        const summary = (writing.checked && writing.checked.summary) || {};
        const kindOfDetector = function (detector) {
          if (detector === 'address') return 'address';
          if (detector === 'knowledge') return 'knowledge';
          if (detector === 'worldRule') return 'world';
          if (detector === 'appearance' || detector === 'name') return 'character';
          return 'other';
        };
        const waivers = (data && data.waivers) || [];
        const waiverFor = function (f) {
          return waivers.find(function (w) {
            return w.chapter === writing.chapter && w.detector === f.detector && w.code === f.code
              && (!w.quote || !f.quote || w.quote === f.quote);
          });
        };
        const openFindings = findings.filter(function (f) { return !waiverFor(f); });
        const waivedFindings = findings.filter(function (f) { return Boolean(waiverFor(f)); });

        const copyContract = async function () {
          const text = writing.markdown || ORDER.map(function (name) {
            return tags && tags[name] ? '【' + name + '】' + tags[name] : '';
          }).filter(Boolean).join('\n');
          try {
            await navigator.clipboard.writeText(text);
            setNotice({ tone: c.success, text: '契约已复制（' + text.length + ' 字）' });
          } catch (error) {
            setNotice({ tone: c.error, text: '复制失败：' + String((error && error.message) || error) });
          }
        };

        // 把九段契约拼成一段可以直接丢给模型的起稿指令。
        const buildPrompt = function () {
          const title = (book && book.title) || (data && data.project) || '这本书';
          const ch = writing.chapter || '';
          const lines = [
            '你是《' + title + '》的同人作者。写 ' + ch + '（' + chapterTitle(ch) + '）的一个场景：800–1200 字，第三人称受限视角。',
            '',
            '格式：第一行写【标签】原著向，第二行写【正文】，之后只写正文，不要标题、提纲或解释。',
            '',
            '硬契约（必须遵守）：',
          ];
          if (tags && tags['本作']) {
            lines.push('本作设定优先于下文原著事实；两者冲突时按【本作】写，不要拿原著纠正作者。');
          }
          for (const name of ORDER) {
            const value = tags && tags[name];
            if (value) lines.push('【' + name + '】' + value);
          }
          lines.push('');
          lines.push('要求：');
          lines.push('- 只写这一章的时间点，不推进到下一章；');
          lines.push('- 不连续照抄原著 20 字以上，原文只作事实核对后转述；');
          lines.push('- 不给不知情的角色安排知情者的台词、念头或叙述；');
          lines.push('- 不使用【禁忌】里列出的任何写法；');
          lines.push('- 如果草稿与【本作】冲突，按【本作】改，不要按原著纠正作者。');
          return lines.join('\n');
        };

        const copyPrompt = async function () {
          const text = buildPrompt();
          try {
            await navigator.clipboard.writeText(text);
            setNotice({ tone: c.success, text: '起稿指令已复制（' + text.length + ' 字）' });
          } catch (error) {
            setNotice({ tone: c.error, text: '复制失败：' + String((error && error.message) || error) });
          }
        };

        // 侧边栏只做资料台与检查台：正文在工作区的会话里写。
        // 这里把「契约 + 本作 + 约束」复制好，并明确告诉作者下一步去哪。
        const startInConversation = async function () {
          const text = buildPrompt();
          try {
            await navigator.clipboard.writeText(text);
            setNotice({ tone: c.success, text: '起稿指令已复制。到工作区新建一个对话，粘贴后让 AI 按这一章写；侧边栏只负责契约与检查。' });
          } catch (error) {
            setNotice({ tone: c.error, text: '复制失败：' + String((error && error.message) || error) });
          }
        };

        const savePromote = async function (f) {
          const draft = promoteDraft || {};
          const title = String(draft.title || '').trim();
          const statement = String(draft.statement || '').trim();
          if (!title || !statement) {
            setNotice({ tone: c.warn, text: '登记本作改动要写标题和一句说明。' });
            return;
          }
          setBusy('登记改动');
          try {
            await face.addDelta({
              kind: kindOfDetector(f.detector),
              title,
              statement,
              fromChapter: writing.chapter,
              source: 'finding',
              suppress: [{ detector: f.detector, code: f.code, quote: f.quote, chapter: writing.chapter }],
            }, project || undefined);
            setPromoteDraft(null);
            setNotice({ tone: c.success, text: '已登记为本作设定：检查器以后不再按原著报这条。' });
            await refresh();
            if (String(writing.draft || '').trim()) await doCheck();
          } catch (error) {
            setNotice({ tone: c.error, text: '登记失败：' + String((error && error.message) || error) });
          } finally {
            setBusy('');
          }
        };

        const saveWaive = async function (f) {
          const reason = String((waiveDraft && waiveDraft.reason) || '').trim();
          if (!reason) { setNotice({ tone: c.warn, text: '忽略一条要写一句理由。' }); return; }
          setBusy('忽略');
          try {
            await face.waive(writing.chapter, f.detector + '/' + f.code, f.quote || '', reason, project || undefined);
            setWaiveDraft(null);
            setNotice({ tone: c.success, text: '已记录忽略：' + reason });
            await refresh();
          } catch (error) {
            setNotice({ tone: c.error, text: '忽略失败：' + String((error && error.message) || error) });
          } finally {
            setBusy('');
          }
        };

        const undoWaive = async function (id) {
          try {
            await face.unwaive(id, project || undefined);
            setNotice({ tone: c.success, text: '已撤销忽略 ' + id });
            await refresh();
          } catch (error) {
            setNotice({ tone: c.error, text: '撤销失败：' + String((error && error.message) || error) });
          }
        };

        const tinyLink = { appearance: 'none', border: 'none', background: 'transparent', color: c.brand, fontSize: 10.5, fontFamily: 'inherit', cursor: 'pointer', padding: '0 2px' };

        return h(Sheet, {
          title: h('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } },
            h('span', { style: { color: c.text, fontSize: 14.5, fontWeight: 600 } }, '写作准备'),
            h('span', { style: { color: c.faint, fontSize: 10.5 } }, '这一章 AI 看到了什么；正文去工作区写'),
          ),
          onClose: function () { setSheet(null); },
        },
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 } },
            h('span', { style: { color: c.faint, fontSize: 10.5 } }, '章节'),
            h('select', {
              value: writing.chapter,
              onChange: function (event) { switchWritingChapter(event.target.value); },
              style: { appearance: 'none', border: '1px solid ' + c.border, background: c.layer2, color: c.text, borderRadius: 8, padding: '4px 7px', fontSize: 11.5, fontFamily: 'inherit', outline: 'none', flex: 1, minWidth: 0 },
            }, chapters.map(function (ch) { return h('option', { key: ch.id, value: ch.id }, ch.id + ' ' + (ch.title || '')); })),
            button({ small: true, icon: 'bookmark', onClick: copyContract, children: '复制契约' }),
            button({ small: true, icon: 'pen', onClick: function () { setShowPrompt(!showPrompt); }, children: '起稿指令' }),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 } },
            button({ small: true, variant: 'primary', icon: 'pen', onClick: startInConversation, children: '去会话开写' }),
            h('span', { style: { color: c.faint, fontSize: 10, lineHeight: 1.5 } }, '复制起稿指令；正文在工作区新对话里写，写完再贴回来检查'),
          ),
          writing.phase === 'loading' ? h('div', { style: { color: c.faint, fontSize: 12, padding: 10 } }, '编译契约…')
            : writing.phase === 'error' ? h('div', { style: { color: c.error, fontSize: 12, padding: 10 } }, '编译失败：' + writing.error)
              : writing.phase === 'empty' ? emptyState('还没有章节', '先在总览里导入原著。')
                : h('div', null,
                    showPrompt
                      ? h('div', { style: { marginBottom: 9 } },
                          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
                            h('span', { style: { color: c.faint, fontSize: 10.5, flex: 1, minWidth: 0 } }, '起稿指令：契约 + 格式 + 约束，可复制到会话里让模型照着写'),
                            button({ small: true, icon: 'bookmark', onClick: copyPrompt, children: '复制' }),
                            button({ small: true, onClick: function () { setShowPrompt(false); }, children: '收起' }),
                          ),
                          h('textarea', {
                            readOnly: true, value: buildPrompt(), rows: 9,
                            style: {
                              width: '100%', boxSizing: 'border-box', resize: 'vertical', appearance: 'none',
                              border: '1px solid ' + c.border2, background: c.layer2, color: c.sub,
                              borderRadius: 8, padding: '7px 9px', fontSize: 11, lineHeight: 1.7,
                              fontFamily: 'inherit', outline: 'none', whiteSpace: 'pre-wrap',
                            },
                          }),
                        )
                      : null,
                    sectionLabel('契约', h('span', { style: { color: c.faint, fontSize: 10 } }, (writing.markdown || '').length + ' 字')),
                    ORDER.map(function (name) {
                      const value = tags && tags[name];
                      if (!value) return null;
                      return h('div', { key: name, style: { marginBottom: 7 } },
                        h('div', { style: { color: c.faint, fontSize: 10, marginBottom: 1 } }, name),
                        h('div', { style: { color: c.text, fontSize: 11.5, lineHeight: 1.75, paddingLeft: 7, borderLeft: '2px solid ' + c.border2 } }, value),
                      );
                    }),
                    sectionLabel('草稿检查'),
                    h('textarea', {
                      value: writing.draft, rows: 5,
                      placeholder: '把一段草稿贴进来，按这一章的契约检查…',
                      onChange: function (event) { setWriting(Object.assign({}, writing, { draft: event.target.value })); },
                      style: {
                        width: '100%', boxSizing: 'border-box', resize: 'vertical', appearance: 'none',
                        border: '1px solid ' + c.border, background: c.layer2, color: c.text,
                        borderRadius: 8, padding: '7px 9px', fontSize: 11.5, lineHeight: 1.75,
                        fontFamily: 'inherit', outline: 'none', whiteSpace: 'pre-wrap',
                      },
                    }),
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
                      button({ variant: 'primary', small: true, disabled: busy === '检查', onClick: doCheck, children: busy === '检查' ? '检查中…' : '运行检查' }),
                      writing.checked
                        ? h('span', { style: { color: summary.blockers ? c.error : summary.warnings ? c.warn : c.success, fontSize: 11 } },
                            'blocker ' + (summary.blockers || 0) + ' · warning ' + (summary.warnings || 0) + ' · 必检 ' + (summary.gateFindings || 0)
                            + (summary.suppressed ? ' · 本作放过 ' + summary.suppressed : '')
                            + (waivedFindings.length ? ' · 已忽略 ' + waivedFindings.length : ''))
                        : h('span', { style: { color: c.faint, fontSize: 10.5 } }, '只报告，不改稿'),
                    ),

                    openFindings.length
                      ? openFindings.map(function (f, i) {
                          const tone = f.severity === 'blocker' ? c.error : f.severity === 'warning' ? c.warn : c.faint;
                          const draftKey = (f.detector || '') + '/' + (f.code || '') + '#' + i;
                          const editing = waiveDraft && waiveDraft.key === draftKey;
                          const promoting = promoteDraft && promoteDraft.key === draftKey;
                          return h('div', { key: 'f' + i, style: { marginTop: 6, padding: '6px 8px', borderLeft: '3px solid ' + tone, background: c.layer2, borderRadius: '0 7px 7px 0' } },
                            h('div', { style: { display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' } },
                              chip(f.severity, tone),
                              h('span', { style: { color: c.faint, fontSize: 10 } }, f.detector + '/' + f.code),
                              h('span', { style: { marginLeft: 'auto', display: 'inline-flex', gap: 6 } },
                                f.offset !== null && f.offset !== undefined
                                  ? h('button', { type: 'button', onClick: function () { openChapter(writing.chapter, { offset: f.offset, quote: f.quote }); }, style: tinyLink }, '看原文')
                                  : null,
                                h('button', {
                                  type: 'button',
                                  onClick: function () {
                                    setPromoteDraft({
                                      key: draftKey,
                                      finding: f,
                                      title: (f.detector || '') + '/' + (f.code || '') + ' 的有意改动',
                                      statement: '本作中「' + (f.quote || '这一段') + '」是有意改动，不是笔误；按本作设定处理。',
                                    });
                                  },
                                  style: tinyLink,
                                }, '登记为改动'),
                                h('button', { type: 'button', onClick: function () { setWaiveDraft({ key: draftKey, reason: '', finding: f }); }, style: tinyLink }, '忽略'),
                              ),
                            ),
                            h('div', { style: { color: c.text, fontSize: 11.5, lineHeight: 1.7, marginTop: 3 } }, f.quote),
                            f.why ? h('div', { style: { color: c.sub, fontSize: 10.5, marginTop: 2 } }, f.why) : null,
                            editing
                              ? h('div', { style: { marginTop: 6, display: 'flex', gap: 5, alignItems: 'center' } },
                                  h('input', {
                                    type: 'text', value: (waiveDraft && waiveDraft.reason) || '', placeholder: '为什么可以忽略（必填）',
                                    onChange: function (event) { setWaiveDraft({ key: draftKey, reason: event.target.value, finding: f }); },
                                    onKeyDown: function (event) { if (event.key === 'Enter') saveWaive(f); },
                                    style: { flex: 1, minWidth: 0, appearance: 'none', border: '1px solid ' + c.border2, background: c.layer, color: c.text, borderRadius: 7, padding: '3px 7px', fontSize: 11, fontFamily: 'inherit', outline: 'none' },
                                  }),
                                  button({ small: true, variant: 'primary', disabled: busy === '忽略', onClick: function () { return saveWaive(f); }, children: '保存' }),
                                  button({ small: true, onClick: function () { setWaiveDraft(null); }, children: '取消' }),
                                )
                              : null,
                            promoting
                              ? h('div', { style: { marginTop: 6, display: 'grid', gap: 4 } },
                                  h('input', {
                                    type: 'text', value: (promoteDraft && promoteDraft.title) || '', placeholder: '一句话标题，如 裴照与沈砚是恋人',
                                    onChange: function (event) { setPromoteDraft(Object.assign({}, promoteDraft, { title: event.target.value })); },
                                    style: { width: '100%', boxSizing: 'border-box', appearance: 'none', border: '1px solid ' + c.border2, background: c.layer, color: c.text, borderRadius: 7, padding: '3px 7px', fontSize: 11, fontFamily: 'inherit', outline: 'none' },
                                  }),
                                  h('textarea', {
                                    value: (promoteDraft && promoteDraft.statement) || '', rows: 3, placeholder: '本作改成什么、为什么；写进契约的【本作】段',
                                    onChange: function (event) { setPromoteDraft(Object.assign({}, promoteDraft, { statement: event.target.value })); },
                                    style: { width: '100%', boxSizing: 'border-box', resize: 'vertical', appearance: 'none', border: '1px solid ' + c.border2, background: c.layer, color: c.text, borderRadius: 7, padding: '4px 7px', fontSize: 11, lineHeight: 1.6, fontFamily: 'inherit', outline: 'none' },
                                  }),
                                  h('div', { style: { display: 'flex', gap: 5 } },
                                    button({ small: true, variant: 'primary', disabled: busy === '登记改动', onClick: function () { return savePromote(f); }, children: '登记' }),
                                    button({ small: true, onClick: function () { setPromoteDraft(null); }, children: '取消' }),
                                  ),
                                )
                              : null,
                          );
                        })
                      : writing.checked ? h('div', { style: { color: c.success, fontSize: 11.5, marginTop: 8 } }, '没有未忽略的问题（这一章契约下）。') : null,

                    suppressed.length
                      ? h('div', null,
                          sectionLabel('本作设定放过', h('span', { style: { color: c.faint, fontSize: 10 } }, suppressed.length + ' 条')),
                          suppressed.map(function (f, i) {
                            return h('div', { key: 'x' + i, style: { marginTop: 4, padding: '5px 8px', borderLeft: '3px solid ' + c.business, background: c.layer2, borderRadius: '0 7px 7px 0', opacity: 0.9 } },
                              h('div', { style: { display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' } },
                                chip('本作放过', c.business),
                                h('span', { style: { color: c.faint, fontSize: 10 } }, f.detector + '/' + f.code),
                              ),
                              h('div', { style: { color: c.sub, fontSize: 10.5, marginTop: 2 } }, f.quote),
                              h('div', { style: { color: c.faint, fontSize: 10, marginTop: 1 } },
                                '按「' + ((f.suppressedBy && f.suppressedBy.title) || '本作设定') + '」放过'),
                            );
                          }),
                        )
                      : null,

                    waivedFindings.length
                      ? h('div', null,
                          sectionLabel('已忽略', h('span', { style: { color: c.faint, fontSize: 10 } }, waivedFindings.length + ' 条')),
                          waivedFindings.map(function (f, i) {
                            const w = waiverFor(f);
                            return h('div', { key: 'w' + i, style: { marginTop: 4, padding: '5px 8px', borderLeft: '3px solid ' + c.border2, background: c.layer2, borderRadius: '0 7px 7px 0', opacity: 0.85 } },
                              h('div', { style: { display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' } },
                                chip('已忽略', c.faint),
                                h('span', { style: { color: c.faint, fontSize: 10 } }, f.detector + '/' + f.code),
                                h('span', { style: { marginLeft: 'auto' } },
                                  h('button', { type: 'button', onClick: function () { return undoWaive(w && w.id); }, style: tinyLink }, '撤销')),
                              ),
                              h('div', { style: { color: c.sub, fontSize: 10.5, marginTop: 2 } }, '理由：' + ((w && w.reason) || '')),
                            );
                          }),
                        )
                      : null,
                  ),
        );
      }

      // ── 作者私设（AU / 私设 / 错名） ──────────────────────────────────────────
      function declareSheet() {
        const d = (data && data.declarations) || { auRules: [], headcanonSignatures: [], typos: {} };
        const draft = declareDraft || {};
        const setDraft = function (patch) { setDeclareDraft(Object.assign({}, draft, patch)); };
        const save = async function (kind, payload, okText) {
          try {
            await face.declare(kind, payload, project || undefined);
            setDeclareDraft({});
            setNotice({ tone: c.success, text: okText });
            await refresh();
          } catch (error) {
            setNotice({ tone: c.error, text: '保存失败：' + String((error && error.message) || error) });
          }
        };
        const inputStyle = {
          flex: 1, minWidth: 0, appearance: 'none', border: '1px solid ' + c.border2,
          background: c.layer, color: c.text, borderRadius: 7, padding: '3px 7px',
          fontSize: 11, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
        };
        const rowStyle = { display: 'flex', gap: 5, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid ' + c.border, fontSize: 11.5 };
        const xButton = function (onClick) {
          return h('button', {
            type: 'button', onClick: onClick, title: '删除',
            style: { appearance: 'none', border: 'none', background: 'transparent', color: c.faint, cursor: 'pointer', fontSize: 12, padding: '0 3px', fontFamily: 'inherit' },
          }, '✕');
        };
        const typos = Object.entries(d.typos || {});
        return h(Sheet, {
          title: h('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } },
            h('span', { style: { color: c.text, fontSize: 14.5, fontWeight: 600 } }, '作者私设'),
            h('span', { style: { color: c.faint, fontSize: 10.5 } }, '不进 canon，只用来抓漏'),
          ),
          onClose: function () { setSheet(null); },
        },
          h('div', { style: { color: c.faint, fontSize: 10.5, lineHeight: 1.7, marginBottom: 6 } },
            '原著向场景里出现这些词，检查器会报 blocker/warning：AU 规则 → au_leak，私设句 → headcanon，错名 → name_typo。'),

          sectionLabel('AU 规则', chip(String(d.auRules.length), c.faint)),
          d.auRules.length
            ? d.auRules.map(function (rule) {
                return h('div', { key: rule.id, style: rowStyle },
                  h('span', { style: { color: c.text, minWidth: 56, flexShrink: 0 } }, rule.name),
                  h('span', { style: { display: 'flex', gap: 3, flex: 1, flexWrap: 'wrap' } },
                    (rule.signatures || []).map(function (sig) { return chip(sig, c.business); })),
                  xButton(function () { return save('au', { remove: rule.id }, '已删除 ' + rule.name); }),
                );
              })
            : h('div', { style: { color: c.faint, fontSize: 11, padding: '3px 0' } }, '还没有 AU 规则。'),
          h('div', { style: { display: 'flex', gap: 5, marginTop: 6 } },
            h('input', { type: 'text', value: draft.auName || '', placeholder: '规则名，如 回魂钟', onChange: function (e) { setDraft({ auName: e.target.value }); }, style: inputStyle }),
            h('input', { type: 'text', value: draft.auSigs || '', placeholder: '触发词，逗号分隔', onChange: function (e) { setDraft({ auSigs: e.target.value }); }, style: inputStyle }),
            button({ small: true, onClick: function () { return save('au', { name: draft.auName, signatures: draft.auSigs, text: draft.auText }, '已记下 AU 规则'); }, children: '添加' }),
          ),

          sectionLabel('私设签名', chip(String(d.headcanonSignatures.length), c.faint)),
          d.headcanonSignatures.length
            ? d.headcanonSignatures.map(function (sig, i) {
                return h('div', { key: 'hc' + i, style: rowStyle },
                  h('span', { style: { color: c.faint, width: 18, flexShrink: 0 } }, String(i + 1)),
                  h('span', { style: { color: c.text, flex: 1, minWidth: 0, lineHeight: 1.6 } }, sig),
                  xButton(function () { return save('headcanon', { remove: String(i + 1) }, '已删除私设签名'); }),
                );
              })
            : h('div', { style: { color: c.faint, fontSize: 11, padding: '3px 0' } }, '还没有私设签名。'),
          h('div', { style: { display: 'flex', gap: 5, marginTop: 6 } },
            h('input', { type: 'text', value: draft.hcText || '', placeholder: '一句会被误当成原著的私设，如 苏鹤其实是沈九的女儿', onChange: function (e) { setDraft({ hcText: e.target.value }); }, style: inputStyle }),
            button({ small: true, onClick: function () { return save('headcanon', { text: draft.hcText }, '已记下私设签名'); }, children: '添加' }),
          ),

          sectionLabel('错名', chip(String(typos.length), c.faint)),
          typos.length
            ? typos.map(function ([wrong, right]) {
                return h('div', { key: 'ty' + wrong, style: rowStyle },
                  h('span', { style: { color: c.error } }, wrong),
                  h('span', { style: { color: c.faint } }, '→'),
                  h('span', { style: { color: c.text, flex: 1 } }, right),
                  xButton(function () { return save('typo', { remove: wrong }, '已删除错名 ' + wrong); }),
                );
              })
            : h('div', { style: { color: c.faint, fontSize: 11, padding: '3px 0' } }, '还没有错名。'),
          h('div', { style: { display: 'flex', gap: 5, marginTop: 6 } },
            h('input', { type: 'text', value: draft.typoWrong || '', placeholder: '错名，如 沈研', onChange: function (e) { setDraft({ typoWrong: e.target.value }); }, style: inputStyle }),
            h('input', { type: 'text', value: draft.typoRight || '', placeholder: '正确名，如 沈砚', onChange: function (e) { setDraft({ typoRight: e.target.value }); }, style: inputStyle }),
            button({ small: true, onClick: function () { return save('typo', { wrong: draft.typoWrong, right: draft.typoRight }, '已记下错名'); }, children: '添加' }),
          ),
        );
      }

      // ── 内容路由 ────────────────────────────────────────────────────────────
      function content() {
        if (state.phase === 'error') {
          return h('div', { style: { padding: 14 } }, emptyState('读不到项目状态', state.error || '', button({ small: true, onClick: refresh, children: '重试' })));
        }
        if (!data) {
          return h('div', { style: { padding: 14, color: c.faint, fontSize: 12 } }, '正在读取项目状态…');
        }
        if (!book && !importOpen) return overview();
        if (tab === 'canon') {
          if (!book) return emptyState('还没有设定数据', '先在「下一步」里导入原著；分析结果确认后，人物/势力/关系/世界/冲突会出现在这里。');
          const inner = sub === 'characters' ? characterGrid()
            : sub === 'factions' ? factionGrid()
              : sub === 'relations' ? relationView()
                : sub === 'world' ? worldView()
                  : sub === 'source' ? sourceView()
                    : conflictView();
          return h('div', { className: 'fic-canon' },
            chips(),
            h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' } }, inner),
          );
        }
        if (tab === 'delta') {
          return h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto' } }, deltaView(), waiversSection(), declarationsEntry());
        }
        if (tab === 'plot') {
          return book ? plotView() : emptyState('还没有剧情数据', '导入原著并确认 canon 后，时间线与伏笔会出现在这里。');
        }
        return writeView();
      }

      // 本作区尾部：被放过的检查（可撤销）+ 作者私设入口
      function waiversSection() {
        const list = (data && data.waivers) || [];
        if (!list.length) return null;
        return h('div', { className: 'fic-sect', style: { padding: '0 14px 12px' } },
          h('div', { className: 'fic-sect-head' },
            h('span', { className: 'fic-sect-title' }, '被放过的检查'),
            h('span', { className: 'fic-sect-meta' }, list.length + ' 条 · 可撤销')),
          h('div', { className: 'fic-card' },
            list.slice(0, 20).map(function (w, i) {
              return h('div', { key: 'w' + i, style: { padding: '6px 0', borderBottom: i === Math.min(list.length, 20) - 1 ? 'none' : '1px dashed ' + c.border } },
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { className: 'fic-tag warn' }, w.chapter),
                  h('span', { style: { fontFamily: 'Cascadia Mono,Consolas,monospace', fontSize: 10, color: c.faint } }, w.detector + '/' + w.code),
                  h('button', {
                    type: 'button', className: 'fic-link muted', style: { marginLeft: 'auto' },
                    onClick: function () { return run('撤销放过', function () { return face.unwaive(w.id, project || undefined); }); },
                  }, '撤销'),
                ),
                h('div', { className: 'fic-quote' }, w.quote || '（没有引文）', h('span', { className: 'src' }, '理由：' + (w.reason || '（未写）'))),
              );
            })));
      }

      function declarationsEntry() {
        return h('div', { className: 'fic-sect', style: { padding: '0 14px 14px' } },
          h('div', { className: 'fic-sect-head' },
            h('span', { className: 'fic-sect-title' }, '作者私设'),
            h('span', { className: 'fic-sect-meta' }, '检查器要抓的签名')),
          h('div', { className: 'fic-acc' },
            h('div', { className: 'fic-acc-head', onClick: function () { setSheet({ kind: 'declare' }); } },
              h('span', { className: 't' }, 'AU 规则 / 私设句 / 错名'),
              h('span', { className: 'n' }, '不进 canon'),
              h('span', { style: { color: c.faint, fontSize: 11 } }, '打开 ›'))));
      }

      // ── 抽屉路由 ────────────────────────────────────────────────────────────
      let sheetNode = null;
      if (sheet) {
        if (sheet.kind === 'character') {
          const ch = (book.characters || []).find(function (x) { return x.id === sheet.id; });
          sheetNode = ch ? characterSheet(ch) : null;
        } else if (sheet.kind === 'faction') {
          const f = (book.factions || []).find(function (x) { return x.id === sheet.id; });
          sheetNode = f ? factionSheet(f) : null;
        } else if (sheet.kind === 'edge') {
          const e = (book.matrix.edges || []).find(function (x) { return x.id === sheet.id; });
          sheetNode = e ? edgeSheet(e) : null;
        } else if (sheet.kind === 'review') {
          sheetNode = reviewSheet();
        } else if (sheet.kind === 'writing') {
          sheetNode = writingSheet();
        } else if (sheet.kind === 'declare') {
          sheetNode = declareSheet();
        }
      }

      return h(
        'div',
        {
          className: 'fic-panel',
          style: {
            position: 'relative', height: '100%', display: 'flex', flexDirection: 'column',
            background: c.base, color: c.text, fontFamily: 'inherit', fontSize: 12.5,
            overflow: 'hidden', boxSizing: 'border-box',
          },
        },
        h(Styles, null),
        header,
        nextStrip(),
        tabBar,
        h('div', {
          style: {
            flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
            // 原著区靠 chips + 内层滚动；其它区整块滚
            overflow: tab === 'canon' ? 'hidden' : tab === 'write' ? 'hidden' : 'auto',
          },
        }, content()),
        sheetNode,
        notice
          ? h('div', {
              style: {
                position: 'absolute', left: 10, right: 10, bottom: 10, zIndex: 50,
                padding: '7px 10px', borderRadius: 9, fontSize: 11.5, lineHeight: 1.6,
                background: c.layer3, color: notice.tone || c.text, border: '1px solid ' + c.border2,
              },
            },
            h('div', { style: { display: 'flex', gap: 6 } },
              h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' } }, notice.text),
              h('button', {
                type: 'button', onClick: function () { setNotice(null); },
                style: { appearance: 'none', border: 'none', background: 'transparent', color: c.faint, cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: 11 },
              }, '×'),
            ),
          )
          : null,
      );
    }

    // ── 会话头入口 ────────────────────────────────────────────────────────────
    function OpenButton(props) {
      return h(
        'button',
        {
          type: 'button',
          title: '同人写作闸门：原著档案 / 契约 / 检查',
          onClick: props.open,
          style: {
            appearance: 'none', border: '1px solid var(--dsw-alias-border-l1)',
            background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
            borderRadius: 6, padding: '2px 8px', fontSize: 12, lineHeight: '18px',
            cursor: 'pointer', fontFamily: 'inherit',
          },
        },
        '同人',
      );
    }

    return {
      inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.commands'],
      async apply(ctx) {
        // v0.2.3：面板读数据走 panel remote（Host 进程内调用），不再执行 /fic 命令。
        // 命令通道只留给作者显式写操作（on/off、plan set、confirm/reject/resolve…）。
        let panelRemote = null
        try {
          const dispose = await ctx.remote.$mount(TYPERT_REMOTE)
          if (typeof dispose === 'function') {
            ctx.effect(() => () => {
              try {
                dispose()
              } catch {
                // 已经卸载
              }
            })
          }
          panelRemote = ctx.get('remote.novelFanficPanel') ?? null
          if (!panelRemote) console.error('[novel-fanfic] remote.novelFanficPanel 未注册')
        } catch (error) {
          console.error('[novel-fanfic] panel remote mount 失败', error)
        }
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', function () {
              return ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: TAB_ID,
                  inject: function (sessionId) {
                    // 远端命令调用的返回是 RPC 包装：{ ok, value?, error? }；
                    // value 是宿主 CommandExecution：{ commandId, result: { kind, text? } }。
                    async function run(line) {
                      let rpc;
                      try {
                        rpc = await ctx.remote.commands.execute(sessionId, line, []);
                      } catch (error) {
                        throw new Error('命令通道不可用：' + String((error && error.message) || error));
                      }
                      if (!rpc || !rpc.ok) {
                        const reason = rpc && rpc.error ? rpc.error.message || rpc.error.code : '未知错误';
                        throw new Error('执行 ' + line + ' 失败：' + String(reason || ''));
                      }
                      const exec = rpc.value;
                      if (!exec) throw new Error('未知命令：' + line + '（插件未加载，或该会话没有这个命令）');
                      const result = exec.result;
                      if (!result || result.kind !== 'success') {
                        throw new Error((result && result.text) || line + ' 没有返回结果');
                      }
                      return result.text;
                    }

                    async function runJson(line) {
                      const text = await run(line);
                      try {
                        return JSON.parse(text);
                      } catch (error) {
                        throw new Error(line + ' 返回的不是 JSON：' + String((error && error.message) || error));
                      }
                    }

                    const withProject = (project) => (project ? ' --project ' + project : '');

                    // panel remote 的返回是 RPC 包装 { ok, value?, error? }；成功时直接用 value。
                    const unwrap = (rpc) => {
                      if (rpc && rpc.ok === false) {
                        const reason = rpc.error ? (rpc.error.message || rpc.error.code) : '未知错误';
                        throw new Error('面板读接口调用失败：' + String(reason || ''));
                      }
                      return rpc && typeof rpc === 'object' && 'value' in rpc ? rpc.value : rpc;
                    };
                    const callRemote = (method, request) => {
                      const remote = panelRemote;
                      if (!remote || typeof remote[method] !== 'function') {
                        return Promise.reject(new Error('面板读接口未就绪：请更新并重载 DSH（0.2.3 起面板读取走 remote）。'));
                      }
                      return Promise.resolve(remote[method](sessionId, request || {})).then(unwrap);
                    };

                    return {
                      load: function (project) {
                        return callRemote('getPanel', { project: project || null });
                      },
                      projects: function () {
                        return callRemote('listProjects', {});
                      },
                      use: function (project) {
                        return runJson('/fic use ' + project + ' --json');
                      },
                      enable: function () {
                        return run('/fic on');
                      },
                      chapter: function (id, project) {
                        return callRemote('getChapter', { chapter: id, project: project || null });
                      },
                      contract: function (id, project) {
                        return callRemote('getContract', { chapter: id, project: project || null });
                      },
                      // 章节任务卡（v0.2.0）：读走 remote，写仍走 /fic plan set。
                      plan: function (id, project) {
                        return callRemote('getPlan', { chapter: id, project: project || null });
                      },
                      planSet: function (id, patch, project) {
                        const p = patch || {};
                        // 数组字段用 U+001F（单元分隔符）拼接：作者在节拍里写「|」也不会被拆开。
                        const SEP = '\u001f';
                        let line = '/fic plan set ' + id;
                        const add = function (flag, value) {
                          if (value === undefined || value === null || value === '') return;
                          const text = Array.isArray(value) ? value.join(SEP) : String(value);
                          line += ' ' + flag + ' ' + encodeURIComponent(text);
                        };
                        add('--title', p.title);
                        add('--goal', p.goal);
                        add('--arc', p.arc);
                        add('--pov', p.pov);
                        add('--place-time', p.placeTime);
                        add('--reader', p.readerExpectation);
                        add('--anchors', p.anchors);
                        add('--beats', p.beats);
                        add('--avoid', p.avoid);
                        add('--open', p.openQuestions);
                        add('--target-chars', p.targetChars);
                        add('--status', p.status);
                        add('--source-chapter', p.sourceChapter);
                        return runJson(line + ' --json' + withProject(project));
                      },
                      planClear: function (id, project) {
                        return runJson('/fic plan clear ' + id + ' --json' + withProject(project));
                      },
                      search: function (term, project) {
                        // 0.2.3：走 remote，term/limit 结构化传递（旧命令路径会把 --limit 的 20 拼进搜索词）。
                        return callRemote('search', { term: term, limit: 20, project: project || null });
                      },
                      preview: function (file, project) {
                        return callRemote('previewImport', { file: file, project: project || null });
                      },
                      pickDir: async function () {
                        // 只有作者点按钮时才调用；不在挂载/刷新时触发。
                        return callRemote('pickDirectory');
                      },
                      files: function (dir) {
                        return callRemote('listImportFiles', { dir: dir });
                      },
                      waive: function (chapter, code, quote, reason, project) {
                        return runJson('/fic waive ' + chapter + ' ' + code
                          + ' --quote ' + encodeURIComponent(quote || '')
                          + ' --reason ' + encodeURIComponent(reason || '')
                          + ' --json' + withProject(project));
                      },
                      unwaive: function (id, project) {
                        return runJson('/fic unwaive ' + id + ' --json' + withProject(project));
                      },
                      declare: function (kind, payload, project) {
                        const p = payload || {};
                        let line = '/fic declare ' + kind;
                        if (p.remove) {
                          line += ' --remove ' + encodeURIComponent(p.remove);
                        } else {
                          if (p.name) line += ' --name ' + encodeURIComponent(p.name);
                          if (p.text) line += ' --text ' + encodeURIComponent(p.text);
                          if (p.signatures) line += ' --signatures ' + encodeURIComponent(p.signatures);
                          if (p.wrong) line += ' --wrong ' + encodeURIComponent(p.wrong);
                          if (p.right) line += ' --right ' + encodeURIComponent(p.right);
                        }
                        return runJson(line + ' --json' + withProject(project));
                      },
                      deltas: function (project) {
                        return callRemote('getDeltas', { project: project || null });
                      },
                      addDelta: function (payload, project) {
                        const p = payload || {};
                        let line = '/fic delta add';
                        if (p.kind) line += ' --kind ' + encodeURIComponent(p.kind);
                        if (p.title) line += ' --title ' + encodeURIComponent(p.title);
                        if (p.statement) line += ' --text ' + encodeURIComponent(p.statement);
                        if (p.subjects) {
                          const subjects = Array.isArray(p.subjects) ? p.subjects.join(',') : p.subjects;
                          line += ' --subjects ' + encodeURIComponent(subjects);
                        }
                        if (p.fromChapter) line += ' --from ' + encodeURIComponent(p.fromChapter);
                        if (p.source === 'finding' && p.suppress && p.suppress[0]) {
                          const s = p.suppress[0];
                          line += ' --detector ' + encodeURIComponent(s.detector)
                            + ' --code ' + encodeURIComponent(s.code)
                            + ' --quote ' + encodeURIComponent(s.quote || '')
                            + ' --chapter ' + encodeURIComponent(s.chapter || '');
                        }
                        return runJson(line + ' --json' + withProject(project));
                      },
                      removeDelta: function (id, project) {
                        return runJson('/fic delta remove ' + id + ' --json' + withProject(project));
                      },
                      savePremise: function (text, project) {
                        return runJson('/fic delta premise --text ' + encodeURIComponent(text || '') + ' --json' + withProject(project));
                      },
                      confirm: function (ids, project) {
                        return run('/fic confirm ' + ids.join(',') + withProject(project));
                      },
                      reject: function (ids, project) {
                        return run('/fic reject ' + ids.join(',') + withProject(project));
                      },
                      resolve: function (id, choice, project) {
                        return run('/fic resolve ' + id + ' ' + choice + withProject(project));
                      },
                      importSource: function (file, project) {
                        return run('/fic import ' + file + withProject(project));
                      },
                      checkDraft: function (id, text, project) {
                        return callRemote('checkDraft', { chapter: id, text: text, project: project || null });
                      },
                    };
                  },
                },
                Panel,
              );
            }),
          'novel-fanfic: sidebar body',
        );

        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: KIND,
              priority: 'extension',
              title: function () {
                return LABEL;
              },
              guide: [
                {
                  id: 'studio',
                  order: 10,
                  title: function () {
                    return '同人工作室';
                  },
                  description: function () {
                    return '总览 / 设定（人物·势力·关系·世界·冲突·本作）/ 剧情 / 原文；本作设定优先于原著，审阅徽标与写作抽屉。';
                  },
                },
              ],
              keepMounted: true,
            }),
          'novel-fanfic: sidebar tab',
        );

        ctx.effect(
          () =>
            ctx.slots.inject('conversation.session.header.utilities', function () {
              return ctx.slots.register(
                {
                  name: 'conversation.session.header.utilities',
                  id: 'novel-fanfic-open',
                  order: 40,
                  inject: function () {
                    return {
                      open: function () {
                        ctx.sidebarRight.openTab(KIND);
                      },
                    };
                  },
                },
                OpenButton,
              );
            }),
          'novel-fanfic: header button',
        );
      },
    };
  },
});
