/* knowledgeTracer - 路由、数据加载与浮动面板交互 */
(function () {
  'use strict';

  var DEFAULT_PAGE = 'knowledge_index.md';
  var content = document.getElementById('content');
  var panel = document.getElementById('panel');
  var panelHeader = document.getElementById('panel-header');
  var panelBody = document.getElementById('panel-body');
  var canvas = document.getElementById('graph');
  var tooltip = document.getElementById('tooltip');
  var btnCollapse = document.getElementById('btn-collapse');
  var optIndexEdges = document.getElementById('opt-index-edges');
  var optEgo = document.getElementById('opt-ego');
  var panelResize = document.getElementById('panel-resize');
  var toc = document.getElementById('toc');
  var tocList = document.getElementById('toc-list');

  var currentPath = null;
  var stemMap = {}, baseMap = {}, titleMap = {};   // wikilink 解析表

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  /* ---------------- 图谱 ---------------- */
  var graph = window.KTGraph.create(canvas, {
    onNavigate: function (id) {
      if (id === currentPath) { graph.focus(id); return; }
      location.hash = '#/' + encodeURI(id);
    },
    onHover: function (id, x, y) {
      if (!id) { tooltip.hidden = true; return; }
      tooltip.textContent = id;
      var rect = panelBody.getBoundingClientRect();
      tooltip.hidden = false;
      var tx = x - rect.left + 10, ty = y - rect.top + 14;
      tx = Math.min(tx, rect.width - tooltip.offsetWidth - 4);
      ty = Math.min(ty, rect.height - tooltip.offsetHeight - 4);
      tooltip.style.left = Math.max(0, tx) + 'px';
      tooltip.style.top = Math.max(0, ty) + 'px';
    }
  });

  optIndexEdges.addEventListener('change', function () {
    graph.setShowIndexEdges(optIndexEdges.checked);
  });
  optEgo.addEventListener('change', function () {
    graph.setEgo(optEgo.checked);
  });

  fetch('/api/graph').then(function (r) { return r.json(); }).then(function (g) {
    (g.nodes || []).forEach(function (nd) {
      var noext = nd.id.replace(/\.md$/i, '');
      if (!(noext.toLowerCase() in stemMap)) stemMap[noext.toLowerCase()] = nd.id;
      var base = noext.slice(noext.lastIndexOf('/') + 1).toLowerCase();
      if (!(base in baseMap)) baseMap[base] = nd.id;
      var tk = (nd.title || '').toLowerCase();
      if (tk && !(tk in titleMap)) titleMap[tk] = nd.id;
    });
    graph.setData(g);
  }).catch(function () {
    panelHeader.title = '图谱数据加载失败';
  });

  function resolveWiki(name) {
    var k = name.toLowerCase();
    return stemMap[k] || baseMap[k] || titleMap[k] || null;
  }

  /* ---------------- 路由 ---------------- */
  function parseHash() {
    var h = location.hash || '';
    if (h.charAt(0) === '#') h = h.slice(1);
    if (h.charAt(0) === '/') h = h.slice(1);
    var anchor = '', ai = h.indexOf('#');
    if (ai >= 0) { anchor = h.slice(ai + 1); h = h.slice(0, ai); }
    return {
      path: h ? safeDecode(h) : DEFAULT_PAGE,
      anchor: safeDecode(anchor)
    };
  }

  function scrollToAnchor(anchor) {
    if (!anchor) { window.scrollTo(0, 0); return; }
    var el = document.getElementById(anchor);
    if (!el) {
      var hs = content.querySelectorAll('h1,h2,h3,h4,h5,h6');
      for (var i = 0; i < hs.length; i++) {
        if (hs[i].id === anchor ||
            window.MD.slugify(hs[i].textContent) === anchor.toLowerCase()) {
          el = hs[i]; break;
        }
      }
    }
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /* ---------------- 目录(TOC) ---------------- */
  var spyObserver = null;
  var tocLinkById = {};   // heading id -> <a>

  function buildToc() {
    tocList.innerHTML = '';
    tocLinkById = {};
    var heads = content.querySelectorAll('h1,h2,h3,h4,h5,h6');
    var count = 0;
    for (var i = 0; i < heads.length; i++) {
      var hEl = heads[i];
      var text = (hEl.textContent || '').trim();
      if (!text || !hEl.id) continue;
      var lv = +hEl.tagName.slice(1);
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.className = 'toc-link toc-h' + lv;
      a.textContent = text;                  // textContent:不注入 HTML
      a.title = text;
      a.href = '#/' + encodeURI(currentPath) + '#' + encodeURIComponent(hEl.id);
      li.appendChild(a);
      tocList.appendChild(li);
      tocLinkById[hEl.id] = a;
      count++;
    }
    var empty = count === 0;
    toc.classList.toggle('empty', empty);
    document.body.classList.toggle('no-toc', empty);
    setupScrollSpy(empty ? [] : heads);
  }

  function setActive(id) {
    for (var k in tocLinkById) {
      if (tocLinkById.hasOwnProperty(k)) tocLinkById[k].classList.remove('active');
    }
    var a = tocLinkById[id];
    if (a) { a.classList.add('active'); a.scrollIntoView({ block: 'nearest' }); }
  }

  function setupScrollSpy(heads) {
    if (spyObserver) { spyObserver.disconnect(); spyObserver = null; }
    if (!window.IntersectionObserver || !heads.length) return;
    var visible = {};
    spyObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) visible[en.target.id] = true;
        else delete visible[en.target.id];
      });
      // 取当前可见标题中文档顺序最靠前者作为「当前章节」
      var chosen = null;
      for (var i = 0; i < heads.length; i++) {
        if (visible[heads[i].id]) { chosen = heads[i].id; break; }
      }
      if (chosen) setActive(chosen);
    }, { root: null, rootMargin: '0px 0px -70% 0px', threshold: 0 });
    for (var i = 0; i < heads.length; i++) {
      if (heads[i].id) spyObserver.observe(heads[i]);
    }
  }

  function load() {
    var route = parseHash();
    if (route.path === currentPath && route.anchor) {   // 同页锚点跳转
      scrollToAnchor(route.anchor);
      graph.focus(route.path);
      return;
    }
    fetch('/api/md?path=' + encodeURIComponent(route.path))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.error || '加载失败');
        var d = res.j;
        currentPath = d.path;
        content.innerHTML = window.MD.render(d.content, d.path, resolveWiki);
        document.title = d.title + ' - knowledgeTracer';
        buildToc();
        graph.setCurrent(d.path);
        graph.focus(d.path);
        scrollToAnchor(route.anchor);
      })
      .catch(function (err) {
        content.innerHTML = '<div class="md-error"><b>无法加载 ' +
          route.path.replace(/</g, '&lt;') + '</b><br>' +
          (err.message || '').replace(/</g, '&lt;') +
          '<br><a href="#/' + encodeURI(DEFAULT_PAGE) + '">返回首页</a></div>';
        buildToc();
      });
  }

  window.addEventListener('hashchange', load);

  /* ---------------- 面板拖拽 / 折叠 / 持久化 ---------------- */
  var LS_KEY = 'kt-panel';

  function savePanel() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        x: panel.style.left || '', y: panel.style.top || '',
        w: panel.style.width || '', h: panel.style.height || '',
        collapsed: panel.classList.contains('collapsed')
      }));
    } catch (e) { /* 隐私模式下静默 */ }
  }

  function restorePanel() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (!s) return;
      if (s.x) { panel.style.left = s.x; panel.style.right = 'auto'; }
      if (s.y) panel.style.top = s.y;
      if (s.w) panel.style.width = s.w;
      if (s.h) panel.style.height = s.h;
      if (s.collapsed) setCollapsed(true);
    } catch (e) { /* ignore */ }
  }

  function setCollapsed(b) {
    panel.classList.toggle('collapsed', b);
    btnCollapse.textContent = b ? '+' : '–';
    if (!b) graph.resize();
  }

  btnCollapse.addEventListener('click', function () {
    setCollapsed(!panel.classList.contains('collapsed'));
    savePanel();
  });

  panelHeader.addEventListener('pointerdown', function (e) {
    if (e.target.closest('button,label,input')) return;   // 控件不触发拖拽
    e.preventDefault();
    var rect = panel.getBoundingClientRect();
    var dx = e.clientX - rect.left, dy = e.clientY - rect.top;
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.right = 'auto';
    function move(ev) {
      var w = panel.offsetWidth, h = panel.offsetHeight;
      var x = Math.max(0, Math.min(ev.clientX - dx, window.innerWidth - w));
      var y = Math.max(0, Math.min(ev.clientY - dy, window.innerHeight - h));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      savePanel();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  /* ---------------- 面板尺寸缩放 ---------------- */
  panelResize.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    e.stopPropagation();               // 不触发面板拖拽
    if (panel.classList.contains('collapsed')) return;
    panelResize.setPointerCapture(e.pointerId);
    var rect = panel.getBoundingClientRect();
    var startX = e.clientX, startY = e.clientY;
    var startW = rect.width, startH = rect.height;
    // 固定左上角:先锁定 left/top,避免 right 定位导致向左伸展
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.right = 'auto';
    var minW = 220, minH = 160;
    function move(ev) {
      var maxW = window.innerWidth - rect.left - 4;
      var maxH = window.innerHeight - rect.top - 4;
      var w = Math.max(minW, Math.min(startW + (ev.clientX - startX), maxW));
      var h = Math.max(minH, Math.min(startH + (ev.clientY - startY), maxH));
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
      graph.resize();
    }
    function up() {
      panelResize.removeEventListener('pointermove', move);
      panelResize.removeEventListener('pointerup', up);
      graph.resize();
      savePanel();
    }
    panelResize.addEventListener('pointermove', move);
    panelResize.addEventListener('pointerup', up);
  });

  /* ---------------- 启动 ---------------- */
  if (window.ResizeObserver) {
    new ResizeObserver(function () { graph.resize(); }).observe(panelBody);
  }
  window.addEventListener('resize', function () { graph.resize(); });

  restorePanel();
  graph.resize();
  load();
})();
