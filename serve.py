#!/usr/bin/env python3
"""knowledgeTracer - 知识库 Markdown 图谱浏览器本地服务。

用法:
    python3 serve.py [root] [--port 8000] [--host 127.0.0.1] [--force]

root: 知识库根目录(默认当前目录)。递归收集其下所有 .md 文件,
缺失时自动生成 knowledge_index.md 首页,并启动本地 HTTP 服务。
"""
import argparse
import json
import mimetypes
import os
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

INDEX_NAME = "knowledge_index.md"
VIEWER_DIR = Path(__file__).resolve().parent / "viewer"

MD_LINK = re.compile(r'(?<!!)\[[^\]]*\]\(([^)\s"#]+)[^)]*\)')
WIKI = re.compile(r'\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]')
SCHEME = re.compile(r'^[a-zA-Z][a-zA-Z0-9+.-]*:')
FENCE = re.compile(r'```.*?```', re.S)
INLINE_CODE = re.compile(r'`[^`\n]*`')
H1 = re.compile(r'^#\s+(.+?)\s*#*\s*$', re.M)

ROOT = None  # Path, 启动时赋值(resolve 后)
FORCE = False


# ---------------------------------------------------------------- 扫描与解析

def find_mds():
    """递归收集 root 下所有 .md,返回相对 root 的 posix 路径列表(排序)。
    跳过任何以 . 开头的目录/文件(如 .git)。"""
    out = []
    for dirpath, dirnames, filenames in os.walk(str(ROOT)):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        rel_dir = os.path.relpath(dirpath, str(ROOT))
        for fn in filenames:
            if fn.startswith('.') or not fn.lower().endswith('.md'):
                continue
            rel = fn if rel_dir == '.' else os.path.join(rel_dir, fn)
            out.append(Path(rel).as_posix())
    return sorted(out, key=str.lower)


def read_text(path):
    try:
        return path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return ''


def extract_title(text, fallback):
    m = H1.search(text)
    return m.group(1).strip() if m else fallback


def strip_code(text):
    """删除围栏代码块与行内代码,避免把代码里的字符误判为链接。"""
    return INLINE_CODE.sub('', FENCE.sub('', text))


# ------------------------------------------------------- knowledge_index 生成

def build_tree(mds):
    """{dir: {'dirs': {subdir: ...}, 'files': [relpath]}} 目录树, key 为相对路径。"""
    tree = {'dirs': {}, 'files': []}
    for rel in mds:
        if rel == INDEX_NAME:
            continue
        parts = rel.split('/')
        node = tree
        for d in parts[:-1]:
            node = node['dirs'].setdefault(d, {'dirs': {}, 'files': []})
        node['files'].append(rel)
    return tree


def emit_tree(node, prefix, lines, depth=0):
    """先子目录后文件,大小写不敏感排序,幂等输出。"""
    pad = '  ' * depth
    by_rel = {}
    for name, sub in node['dirs'].items():
        full = name if not prefix else prefix + '/' + name
        by_rel[full] = (name, sub)
    for full in sorted(by_rel, key=str.lower):
        name, sub = by_rel[full]
        lines.append('%s- **%s/**' % (pad, name))
        emit_tree(sub, full, lines, depth + 1)
    for rel in sorted(node['files'], key=str.lower):
        title = extract_title(read_text(ROOT / rel),
                              Path(rel).stem)
        lines.append('%s- [%s](%s)' % (pad, title, rel))


def generate_index():
    """缺失时(或 --force)生成 knowledge_index.md。返回是否写入了文件。"""
    target = ROOT / INDEX_NAME
    if target.exists() and not FORCE:
        return False
    mds = find_mds()
    lines = [
        '# Knowledge Index',
        '',
        '> 本文件由 knowledgeTracer 自动生成,可手工补充说明。',
        '> 删除后重启服务会重新生成;`--force` 强制重建。',
        '',
    ]
    emit_tree(build_tree(mds), '', lines)
    lines.append('')
    target.write_text('\n'.join(lines), encoding='utf-8')
    return True


# ------------------------------------------------------------------ 图谱构建

def build_graph():
    if not (ROOT / INDEX_NAME).exists():
        generate_index()
    mds = find_mds()
    node_set = set(mds)
    nodes = []
    stem_map = {}   # 'a/b'(无后缀,小写) -> relpath
    base_map = {}   # 'b'(basename 无后缀,小写) -> relpath
    title_map = {}  # 首个 H1 标题(小写) -> relpath,方便用标题写 wikilink
    for rel in mds:
        p = Path(rel)
        noext = rel[:-3] if rel.lower().endswith('.md') else rel
        title = extract_title(read_text(ROOT / rel), p.stem)
        stem_map.setdefault(noext.lower(), rel)
        base_map.setdefault(p.stem.lower(), rel)
        title_map.setdefault(title.lower(), rel)
        nodes.append({
            'id': rel,
            'title': title,
            'dir': p.parent.as_posix() if p.parent.as_posix() != '.' else '',
            'isIndex': rel == INDEX_NAME,
        })

    edges = set()

    def add(s, t, etype):
        if s != t and s in node_set and t in node_set:
            edges.add((s, t, etype))

    for rel in mds:
        text = strip_code(read_text(ROOT / rel))
        etype = 'index' if rel == INDEX_NAME else 'link'
        md_dir = os.path.dirname(rel)
        for m in MD_LINK.finditer(text):
            target = urllib.parse.unquote(m.group(1)).strip('<>')
            if not target or SCHEME.match(target) or target.startswith('#'):
                continue
            if not target.lower().endswith('.md'):
                continue
            resolved = os.path.normpath(os.path.join(md_dir, target))
            resolved = Path(resolved).as_posix()
            if resolved in node_set:
                add(rel, resolved, etype)
        for m in WIKI.finditer(text):
            name = m.group(1).strip().lower()
            hit = stem_map.get(name) or base_map.get(name) or title_map.get(name)
            if hit:
                add(rel, hit, etype)

    by_dir = {}
    for rel in mds:
        by_dir.setdefault(os.path.dirname(rel), []).append(rel)
    for d, group in by_dir.items():
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                add(group[i], group[j], 'sibling')
        if d:
            parent = os.path.dirname(d)
            for anc in by_dir.get(parent, []):
                for rel in group:
                    add(rel, anc, 'parent')

    return {
        'nodes': nodes,
        'edges': [{'s': s, 't': t, 'type': ty} for (s, t, ty) in sorted(edges)],
        'root': str(ROOT),
    }


# ------------------------------------------------------------------ 路径安全

def safe_join(base, rel):
    """把用户提供的相对路径限定在 base 内,越界返回 None。"""
    rel = urllib.parse.unquote(rel)
    if '\x00' in rel or rel.startswith('/'):
        return None
    p = (base / rel).resolve()
    try:
        if os.path.commonpath([str(base), str(p)]) != str(base):
            return None
    except ValueError:
        return None
    return p


# ------------------------------------------------------------------ HTTP 服务

class Handler(BaseHTTPRequestHandler):
    server_version = 'knowledgeTracer/1.0'

    def log_message(self, fmt, *args):
        sys.stderr.write('[kt] %s\n' % (fmt % args))

    # ---- 响应工具 ----
    def _send(self, code, body, ctype='text/plain; charset=utf-8'):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False),
                   'application/json; charset=utf-8')

    def _error(self, code, msg):
        self._json({'error': msg}, code)

    def _file(self, path, ctype=None):
        try:
            data = path.read_bytes()
        except OSError:
            self._error(404, 'not found')
            return
        if ctype is None:
            ctype = mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
        self._send(200, data, ctype)

    # ---- 路由 ----
    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if route == '/':
            self._file(VIEWER_DIR / 'index.html', 'text/html; charset=utf-8')
        elif route.startswith('/viewer/'):
            p = safe_join(VIEWER_DIR, route[len('/viewer/'):])
            allowed = ('.js', '.css', '.html', '.woff2', '.woff', '.ttf')
            if p is None or not p.is_file() or p.suffix.lower() not in allowed:
                self._error(404, 'not found')
            else:
                ctype = {'.js': 'text/javascript; charset=utf-8',
                         '.css': 'text/css; charset=utf-8',
                         '.html': 'text/html; charset=utf-8',
                         '.woff2': 'font/woff2',
                         '.woff': 'font/woff',
                         '.ttf': 'font/ttf'}.get(p.suffix.lower())
                self._file(p, ctype)
        elif route == '/api/graph':
            try:
                self._json(build_graph())
            except Exception as e:  # 图谱构建失败不应拖垮服务
                self._error(500, 'graph build failed: %s' % e)
        elif route == '/api/md':
            rel = (query.get('path') or [''])[0]
            if not rel.lower().endswith('.md'):
                self._error(400, 'only .md files are served')
                return
            p = safe_join(ROOT, rel)
            if p is None:
                self._error(400, 'path escapes root')
            elif not p.is_file():
                self._error(404, 'not found: %s' % rel)
            else:
                text = read_text(p)
                rel_posix = p.relative_to(ROOT).as_posix()
                self._json({
                    'path': rel_posix,
                    'title': extract_title(text, p.stem),
                    'content': text,
                    'mtime': p.stat().st_mtime,
                })
        elif route.startswith('/file/'):
            p = safe_join(ROOT, route[len('/file/'):])
            if p is None:
                self._error(400, 'path escapes root')
            elif not p.is_file():
                self._error(404, 'not found')
            else:
                self._file(p)
        else:
            self._error(404, 'not found')


def main():
    global ROOT, FORCE
    ap = argparse.ArgumentParser(description='knowledgeTracer 本地服务')
    ap.add_argument('root', nargs='?', default='.', help='知识库根目录')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--force', action='store_true',
                    help='强制重新生成 knowledge_index.md')
    args = ap.parse_args()

    ROOT = Path(args.root).resolve()
    FORCE = args.force
    if not ROOT.is_dir():
        sys.exit('root 不是目录: %s' % ROOT)
    if not VIEWER_DIR.is_dir():
        sys.exit('缺少 viewer 目录: %s' % VIEWER_DIR)

    if generate_index():
        print('[kt] 已生成 %s' % (ROOT / INDEX_NAME))

    mds = find_mds()
    print('[kt] root=%s 共 %d 个 markdown' % (ROOT, len(mds)))
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print('[kt] 访问 http://%s:%d/' % (args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
