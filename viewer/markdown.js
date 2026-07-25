/* knowledgeTracer - 轻量 Markdown 渲染器(零依赖,先转义后解析,无 XSS 面) */
(function () {
  'use strict';

  var SCHEME = /^[a-zA-Z][\w+.-]*:/;

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* posix 风格路径拼接 + 规范化(处理 . 与 ..) */
  function normJoin(dir, rel) {
    var parts = ((dir ? dir + '/' : '') + rel).split('/');
    var stack = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || p === '.') continue;
      if (p === '..') { stack.pop(); continue; }
      stack.push(p);
    }
    return stack.join('/');
  }

  function slugify(text) {
    return text.trim().toLowerCase()
      .replace(/[^\w一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  /* 把 md 里的链接目标改写成站内 hash 路由或外链 */
  function resolveTarget(rawTarget, currentPath, currentDir) {
    var target = rawTarget.trim();
    var anchor = '';
    var hashIdx = target.indexOf('#');
    if (hashIdx >= 0) {
      anchor = target.slice(hashIdx + 1);
      target = target.slice(0, hashIdx);
    }
    target = safeDecode(target);
    if (!target) {                       // 纯锚点 #sec -> 当前页
      return '#/' + encodeURI(currentPath) + (anchor ? '#' + anchor : '');
    }
    if (SCHEME.test(target) || target.indexOf('//') === 0) {
      return null;                       // 外链,交给调用方
    }
    if (/\.md$/i.test(target)) {
      var p = normJoin(currentDir, target);
      return '#/' + encodeURI(p) + (anchor ? '#' + anchor : '');
    }
    return '/file/' + encodeURI(normJoin(currentDir, target));
  }

  /* ---- 行内解析(text 已是转义后的 HTML 安全串) ---- */
  function inline(text, ctx) {
    var codes = [];
    // 1. 行内代码 -> 占位符,避免后续规则污染代码内容
    text = text.replace(/`([^`\n]+)`/g, function (m, c) {
      codes.push('<code>' + c + '</code>');
      return '\u0001' + (codes.length - 1) + '\u0001';
    });
    // 2. 图片
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
      function (m, alt, src) {
        var dec = safeDecode(src);
        var url = (SCHEME.test(dec) || dec.indexOf('/') === 0)
          ? src
          : '/file/' + encodeURI(normJoin(ctx.dir, dec));
        return '<img src="' + url + '" alt="' + alt + '">';
      });
    // 3. [[wikilink]] / [[name|alias]]
    text = text.replace(/\[\[([^\]|#]+)(?:\|([^\]]*))?\]\]/g,
      function (m, name, alias) {
        var label = alias || name;
        var hit = ctx.resolveWiki ? ctx.resolveWiki(safeDecode(name).trim()) : null;
        if (hit) return '<a href="#/' + encodeURI(hit) + '">' + label + '</a>';
        return '<span class="wiki-missing">' + label + '</span>';
      });
    // 4. 普通链接
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
      function (m, label, url) {
        var href = resolveTarget(url, ctx.path, ctx.dir);
        if (href === null) {
          return '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
        }
        return '<a href="' + href + '">' + label + '</a>';
      });
    // 5. 粗/斜/删
    text = text
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // 6. 还原代码占位符
    text = text.replace(/\u0001(\d+)\u0001/g, function (m, i) { return codes[+i]; });
    return text;
  }

  /* ---- 公式提取(在转义之前进行,避免 LaTeX 被 markdown 规则破坏) ---- */
  function extractMath(src) {
    var store = [];
    function keep(tex, display) {
      store.push({ tex: tex, display: display });
      return '\x02' + (store.length - 1) + '\x02';
    }
    function fromText(t) {
      t = t.replace(/\$\$([\s\S]+?)\$\$/g, function (m, tex) { return keep(tex, true); });
      t = t.replace(/\\\[([\s\S]+?)\\\]/g, function (m, tex) { return keep(tex, true); });
      t = t.replace(/\\\(([\s\S]+?)\\\)/g, function (m, tex) { return keep(tex, false); });
      // 行内 $...$:开$前不能有 \,内容首尾非空白,闭$后不跟数字(货币保护)
      t = t.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/g,
        function (m, pre, tex) { return pre + keep(tex, false); });
      return t;
    }
    // 围栏代码块内不做提取
    var rows = src.split('\n'), out = [], buf = [], inFence = false;
    function flush() { if (buf.length) { out.push(fromText(buf.join('\n'))); buf = []; } }
    for (var k = 0; k < rows.length; k++) {
      if (/^```/.test(rows[k])) { flush(); inFence = !inFence; out.push(rows[k]); continue; }
      if (inFence) { flush(); out.push(rows[k]); }
      else buf.push(rows[k]);
    }
    flush();
    return { text: out.join('\n'), store: store };
  }

  function renderMath(m) {
    if (window.katex) {
      try {
        return window.katex.renderToString(m.tex, {
          displayMode: m.display, throwOnError: false, strict: false
        });
      } catch (e) { /* fallthrough 到源码兜底 */ }
    }
    return m.display
      ? '<pre class="math-fallback">$$' + esc(m.tex) + '$$</pre>'
      : '<code class="math-fallback">$' + esc(m.tex) + '$</code>';
  }

  /* ---- 块级解析 ---- */
  function render(mdText, currentPath, resolveWiki) {
    var ctx = {
      path: currentPath,
      dir: currentPath.indexOf('/') >= 0
        ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '',
      resolveWiki: resolveWiki
    };
    var slugUsed = {};
    var math = extractMath(mdText.replace(/\r\n?/g, '\n'));
    var lines = esc(math.text).split('\n');
    var html = [];
    var i = 0, n = lines.length;

    function slug(text) {
      var s = slugify(text.replace(/<[^>]*>/g, '')) || 'sec';
      var k = s, c = 1;
      while (slugUsed[k]) k = s + '-' + (++c);
      slugUsed[k] = 1;
      return k;
    }

    while (i < n) {
      var line = lines[i];

      // 空行
      if (/^\s*$/.test(line)) { i++; continue; }

      // 围栏代码块
      var fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        var buf = [];
        i++;
        while (i < n && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过收尾 ```
        html.push('<pre>' +
          (fence[1] ? '<span class="code-lang">' + fence[1] + '</span>' : '') +
          '<code>' + buf.join('\n') + '</code></pre>');
        continue;
      }

      // 标题 h1-h6
      var h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        var lv = h[1].length;
        html.push('<h' + lv + ' id="' + slug(h[2]) + '">' +
          inline(h[2], ctx) + '</h' + lv + '>');
        i++; continue;
      }

      // 分割线
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        html.push('<hr>'); i++; continue;
      }

      // 引用块(连续 > 行)
      if (/^&gt;\s?/.test(line) || /^>/.test(line)) {
        var q = [];
        while (i < n && (/^&gt;\s?/.test(lines[i]) || /^>/.test(lines[i]))) {
          q.push(lines[i].replace(/^(&gt;|>)\s?/, ''));
          i++;
        }
        html.push('<blockquote><p>' +
          inline(q.join('\n'), ctx).replace(/\n/g, '<br>') + '</p></blockquote>');
        continue;
      }

      // 表格(当前行含 | 且下一行是分隔行)
      if (line.indexOf('|') >= 0 && i + 1 < n &&
          /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        var splitRow = function (r) {
          return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
            .map(function (c) { return c.trim(); });
        };
        var heads = splitRow(line);
        i += 2;
        var rows = [];
        while (i < n && lines[i].indexOf('|') >= 0 && !/^\s*$/.test(lines[i])) {
          rows.push(splitRow(lines[i])); i++;
        }
        var th = '<table><thead><tr>' + heads.map(function (c) {
          return '<th>' + inline(c, ctx) + '</th>';
        }).join('') + '</tr></thead><tbody>' + rows.map(function (r) {
          return '<tr>' + r.map(function (c) {
            return '<td>' + inline(c, ctx) + '</td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody></table>';
        html.push(th);
        continue;
      }

      // 列表(按缩进嵌套,至多 3 层)
      var li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        var stack = [];   // {indent, tag}
        var out = [];
        while (i < n) {
          var m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (!m) {
            if (/^\s*$/.test(lines[i])) { i++; if (!/^\s*([-*+]|\d+[.)])/.test(lines[i] || '')) break; continue; }
            break;
          }
          var indent = m[1].replace(/\t/g, '    ').length;
          var tag = /^\d/.test(m[2]) ? 'ol' : 'ul';
          while (stack.length && indent < stack[stack.length - 1].indent) {
            out.push('</' + stack.pop().tag + '>');
          }
          if (!stack.length || indent > stack[stack.length - 1].indent) {
            if (stack.length < 3) { stack.push({ indent: indent, tag: tag }); out.push('<' + tag + '>'); }
            else { i++; continue; }
          } else if (stack[stack.length - 1].tag !== tag) {
            out.push('</' + stack.pop().tag + '>');
            stack.push({ indent: indent, tag: tag });
            out.push('<' + tag + '>');
          }
          out.push('<li>' + inline(m[3], ctx) + '</li>');
          i++;
        }
        while (stack.length) out.push('</' + stack.pop().tag + '>');
        html.push(out.join(''));
        continue;
      }

      // 段落(聚合到空行或下一个块级元素)
      var para = [line];
      i++;
      while (i < n && !/^\s*$/.test(lines[i]) &&
             !/^(#{1,6}\s|```|&gt;|>|\s*([-*+]|\d+[.)])\s+|\s*(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      html.push('<p>' + inline(para.join('\n'), ctx).replace(/\n/g, '<br>') + '</p>');
    }
    return html.join('\n').replace(/\x02(\d+)\x02/g,
      function (m, i) { return renderMath(math.store[+i]); });
  }

  window.MD = { render: render, slugify: slugify, normJoin: normJoin };
})();
