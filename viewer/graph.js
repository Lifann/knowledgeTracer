/* knowledgeTracer - canvas 图谱引擎(零依赖,确定性力导布局,无常驻 rAF) */
(function () {
  'use strict';

  var TAU = Math.PI * 2;

  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h >>> 0;
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function topDir(id) {
    var i = id.indexOf('/');
    return i < 0 ? '' : id.slice(0, i);
  }

  function create(canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext('2d');

    var nodes = [];        // {id,title,dir,isIndex,x,y,color,deg}
    var edges = [];        // {si,ti,type}
    var idIndex = {};      // id -> node index
    var adj = null;        // Map: idx -> Set(idx) 邻接表
    var currentId = null;
    var neighbors = new Set();
    var hoverIdx = -1;
    var showIndexEdges = true;
    var ego = false;
    var view = { ox: 0, oy: 0, k: 1 };
    var cssW = 0, cssH = 0, dpr = 1;
    var focusAnim = null;

    /* ---------------- 布局 ---------------- */
    function layout() {
      var n = nodes.length;
      if (!n) return;
      var L = 70;
      for (var i = 0; i < n; i++) {
        var rnd = mulberry32(hashStr(nodes[i].id));
        var r = 12 * Math.sqrt(i + 0.5);
        var a = i * 2.399963;               // 黄金角
        nodes[i].x = r * Math.cos(a) + (rnd() - 0.5) * 20;
        nodes[i].y = r * Math.sin(a) + (rnd() - 0.5) * 20;
      }
      var total = n > 500 ? 400 : 260;
      var temp = L * 2;
      var it = 0;

      function step(chunk) {
        var dispX = new Float64Array(n), dispY = new Float64Array(n);
        for (var c = 0; c < chunk && it < total; c++, it++) {
          dispX.fill(0); dispY.fill(0);
          var i2, j2, dx, dy, d2, d, f;
          for (i2 = 0; i2 < n; i2++) {
            for (j2 = i2 + 1; j2 < n; j2++) {
              dx = nodes[i2].x - nodes[j2].x;
              dy = nodes[i2].y - nodes[j2].y;
              d2 = dx * dx + dy * dy;
              if (d2 < 0.01) { dx = 0.1; dy = 0.1; d2 = 0.02; }
              if (d2 > 400 * 400) continue;      // 截断远处斥力
              d = Math.sqrt(d2);
              f = (L * L / d) / d;               // 单位方向上的力
              dispX[i2] += dx * f; dispY[i2] += dy * f;
              dispX[j2] -= dx * f; dispY[j2] -= dy * f;
            }
          }
          for (var e = 0; e < edges.length; e++) {
            var s = edges[e].si, t = edges[e].ti;
            dx = nodes[t].x - nodes[s].x;
            dy = nodes[t].y - nodes[s].y;
            d = Math.sqrt(dx * dx + dy * dy) || 0.01;
            f = (d * d / L) / d * 0.12;
            dispX[s] += dx * f; dispY[s] += dy * f;
            dispX[t] -= dx * f; dispY[t] -= dy * f;
          }
          for (i2 = 0; i2 < n; i2++) {           // 向心重力
            dispX[i2] -= nodes[i2].x * 0.02;
            dispY[i2] -= nodes[i2].y * 0.02;
          }
          for (i2 = 0; i2 < n; i2++) {
            var dl = Math.sqrt(dispX[i2] * dispX[i2] + dispY[i2] * dispY[i2]);
            if (dl > 0.001) {
              var lim = Math.min(dl, temp);
              nodes[i2].x += dispX[i2] / dl * lim;
              nodes[i2].y += dispY[i2] / dl * lim;
            }
          }
          temp *= 0.98;
        }
        if (it < total) setTimeout(function () { step(60); }, 0);
        else if (currentId != null && idIndex[currentId] != null) api.focus(currentId);
        else { fitView(false); draw(); }
      }
      step(n > 500 ? 60 : total);
    }

    /* ---------------- 视图变换 ---------------- */
    function toScreen(wx, wy) { return { x: wx * view.k + view.ox, y: wy * view.k + view.oy }; }
    function toWorld(sx, sy) { return { x: (sx - view.ox) / view.k, y: (sy - view.oy) / view.k }; }

    function fitView(animate) {
      var n = nodes.length;
      if (!n || !cssW || !cssH) return;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = 0; i < n; i++) {
        minX = Math.min(minX, nodes[i].x); maxX = Math.max(maxX, nodes[i].x);
        minY = Math.min(minY, nodes[i].y); maxY = Math.max(maxY, nodes[i].y);
      }
      var bw = Math.max(maxX - minX, 40), bh = Math.max(maxY - minY, 40);
      var k = Math.min(cssW / bw, cssH / bh) * 0.85;
      k = Math.max(0.2, Math.min(k, 2));
      setView({
        k: k,
        ox: cssW / 2 - (minX + maxX) / 2 * k,
        oy: cssH / 2 - (minY + maxY) / 2 * k
      }, animate);
    }

    function setView(target, animate) {
      if (focusAnim) { cancelAnimationFrame(focusAnim); focusAnim = null; }
      if (!animate) { view = target; draw(); return; }
      var from = { k: view.k, ox: view.ox, oy: view.oy };
      var t0 = performance.now(), dur = 320;
      function tick(t) {
        var p = Math.min((t - t0) / dur, 1);
        var e = 1 - Math.pow(1 - p, 3);          // ease-out cubic
        view = {
          k: from.k + (target.k - from.k) * e,
          ox: from.ox + (target.ox - from.ox) * e,
          oy: from.oy + (target.oy - from.oy) * e
        };
        draw();
        focusAnim = p < 1 ? requestAnimationFrame(tick) : null;
      }
      focusAnim = requestAnimationFrame(tick);
    }

    /* ---------------- 绘制 ---------------- */
    function nodeRadius(nd) { return nd.isIndex ? 7 : 5; }

    function edgeStyle(e, highlighted) {
      var k = view.k;
      if (highlighted) {
        return { stroke: 'rgba(230,110,30,0.95)', width: 2 / k, dash: [] };
      }
      switch (e.type) {
        case 'link':    return { stroke: 'rgba(90,115,190,0.75)', width: 1.2 / k, dash: [] };
        case 'parent':  return { stroke: 'rgba(130,130,130,0.5)', width: 1 / k, dash: [4 / k, 4 / k] };
        case 'sibling': return { stroke: 'rgba(150,150,150,0.32)', width: 1 / k, dash: [2 / k, 4 / k] };
        case 'index':   return { stroke: 'rgba(100,100,100,0.06)', width: 1 / k, dash: [] };
      }
      return { stroke: '#ccc', width: 1 / k, dash: [] };
    }

    function draw() {
      if (!cssW || !cssH) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      var n = nodes.length;
      if (!n) return;
      ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.ox, dpr * view.oy);

      var hasCur = currentId != null && idIndex[currentId] != null;
      var cur = hasCur ? idIndex[currentId] : -1;

      var egoOn = ego && hasCur;
      function edgeVisible(e) {
        if (e.type === 'index' && !showIndexEdges) return false;
        if (egoOn && !(e.si === cur || e.ti === cur)) return false;
        return true;
      }
      function nodeVisible(i) {
        return !egoOn || i === cur || neighbors.has(i);
      }

      // 边:先画普通,再画高亮(保证高亮在上层)
      var pass, e, st;
      for (pass = 0; pass < 2; pass++) {
        for (var i = 0; i < edges.length; i++) {
          e = edges[i];
          if (!edgeVisible(e)) continue;
          var hl = hasCur && (e.si === cur || e.ti === cur);
          if ((pass === 1) !== hl) continue;
          if (!nodeVisible(e.si) || !nodeVisible(e.ti)) continue;
          st = edgeStyle(e, hl);
          ctx.strokeStyle = st.stroke;
          ctx.lineWidth = st.width;
          ctx.setLineDash(st.dash);
          ctx.beginPath();
          ctx.moveTo(nodes[e.si].x, nodes[e.si].y);
          ctx.lineTo(nodes[e.ti].x, nodes[e.ti].y);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);

      // 节点
      for (i = 0; i < n; i++) {
        if (!nodeVisible(i)) continue;
        var nd = nodes[i];
        var isCur = i === cur, isHov = i === hoverIdx;
        var r = nodeRadius(nd) * (isCur ? 1.5 : isHov ? 1.3 : 1);
        var dim = hasCur && !isCur && !neighbors.has(i);
        ctx.globalAlpha = dim ? 0.35 : 1;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, r, 0, TAU);
        ctx.fillStyle = isCur ? '#e66e1e' : nd.color;
        ctx.fill();
        if (isCur || isHov) {
          ctx.lineWidth = 2 / view.k;
          ctx.strokeStyle = isCur ? 'rgba(230,110,30,0.45)' : 'rgba(60,60,60,0.4)';
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, r + 4 / view.k, 0, TAU);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // 标签(缩放足够大或当前/hover 节点)
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (i = 0; i < n; i++) {
        if (!nodeVisible(i)) continue;
        var big = view.k >= 1.3 || i === cur || i === hoverIdx || nodes[i].isIndex;
        if (!big) continue;
        nd = nodes[i];
        var fs = 11 / view.k;
        ctx.font = (i === cur ? 'bold ' : '') + fs + 'px sans-serif';
        ctx.fillStyle = i === cur ? '#c4530a' : 'rgba(40,40,40,0.85)';
        ctx.fillText(nd.title, nd.x, nd.y + nodeRadius(nd) + 3 / view.k);
      }
    }

    /* ---------------- 命中检测 ---------------- */
    function hit(sx, sy) {
      var best = -1, bestD = 10;   // 屏幕 10px 内
      for (var i = 0; i < nodes.length; i++) {
        var p = toScreen(nodes[i].x, nodes[i].y);
        var d = Math.hypot(p.x - sx, p.y - sy);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    /* ---------------- 事件 ---------------- */
    function pos(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = pos(e);
      var factor = Math.exp(-e.deltaY * 0.0012);
      var k = Math.max(0.2, Math.min(view.k * factor, 5));
      view = {
        k: k,
        ox: p.x - (p.x - view.ox) * (k / view.k),
        oy: p.y - (p.y - view.oy) * (k / view.k)
      };
      draw();
    }, { passive: false });

    var drag = null;
    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      var p = pos(e);
      var idx = hit(p.x, p.y);
      drag = { sx: p.x, sy: p.y, ox: view.ox, oy: view.oy, node: idx, moved: false };
    });
    canvas.addEventListener('pointermove', function (e) {
      var p = pos(e);
      if (drag) {
        if (Math.hypot(p.x - drag.sx, p.y - drag.sy) > 3) drag.moved = true;
        if (drag.moved && drag.node < 0) {          // 背景拖拽 = 平移
          view.ox = drag.ox + (p.x - drag.sx);
          view.oy = drag.oy + (p.y - drag.sy);
          draw();
        }
        return;
      }
      var idx = hit(p.x, p.y);
      if (idx !== hoverIdx) {
        hoverIdx = idx;
        canvas.style.cursor = idx >= 0 ? 'pointer' : 'default';
        if (opts.onHover) {
          opts.onHover(idx >= 0 ? nodes[idx].id : null, e.clientX, e.clientY);
        }
        draw();
      } else if (idx >= 0 && opts.onHover) {
        opts.onHover(nodes[idx].id, e.clientX, e.clientY);
      }
    });
    canvas.addEventListener('pointerup', function (e) {
      if (!drag) return;
      var p = pos(e);
      if (!drag.moved && drag.node >= 0 && opts.onNavigate) {
        opts.onNavigate(nodes[drag.node].id);
      }
      drag = null;
    });
    canvas.addEventListener('pointerleave', function () {
      if (hoverIdx >= 0) {
        hoverIdx = -1;
        if (opts.onHover) opts.onHover(null);
        draw();
      }
    });
    canvas.addEventListener('dblclick', function (e) {
      if (hit(pos(e).x, pos(e).y) < 0) fitView(true);
    });

    /* ---------------- 对外 API ---------------- */
    var api = {
      setData: function (g) {
        nodes = []; edges = []; idIndex = {}; adj = new Map();
        (g.nodes || []).forEach(function (nd) {
          idIndex[nd.id] = nodes.length;
          var hue = hashStr(topDir(nd.id) || '(root)') % 360;
          nodes.push({
            id: nd.id, title: nd.title, dir: nd.dir, isIndex: !!nd.isIndex,
            x: 0, y: 0,
            color: nd.isIndex ? '#444b53' : 'hsl(' + hue + ',58%,52%)'
          });
        });
        (g.edges || []).forEach(function (e) {
          var si = idIndex[e.s], ti = idIndex[e.t];
          if (si == null || ti == null) return;
          edges.push({ si: si, ti: ti, type: e.type });
          if (!adj.has(si)) adj.set(si, new Set());
          if (!adj.has(ti)) adj.set(ti, new Set());
          adj.get(si).add(ti); adj.get(ti).add(si);
        });
        layout();   // 结束后自行 fitView + draw
      },
      setCurrent: function (id) {
        currentId = id;
        neighbors = new Set();
        if (id != null && idIndex[id] != null && adj.has(idIndex[id])) {
          neighbors = adj.get(idIndex[id]);
        }
        draw();
      },
      focus: function (id) {
        var i = idIndex[id];
        if (i == null || !cssW || !cssH) return;
        var k = Math.max(view.k, 1.2);
        setView({
          k: k,
          ox: cssW / 2 - nodes[i].x * k,
          oy: cssH / 2 - nodes[i].y * k
        }, true);
      },
      setShowIndexEdges: function (b) { showIndexEdges = b; draw(); },
      setEgo: function (b) { ego = b; draw(); },
      resize: function () {
        var w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        dpr = window.devicePixelRatio || 1;
        cssW = w; cssH = h;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        draw();
      },
      fit: function () { fitView(true); }
    };
    return api;
  }

  window.KTGraph = { create: create };
})();
