import { gzipSync } from 'node:zlib';

// 首屏只遍历静态依赖，动态页面、弹窗与语言包应在实际使用时下载。
export function analyzeFrontendBundle(output) {
  const files = new Map(output.map((file) => [file.fileName, file]));
  const entry = output.find((file) => file.type === 'chunk' && file.isEntry);
  if (!entry) throw new Error('Missing frontend entry chunk');

  function closure(roots) {
    const visited = new Set();
    function visit(name) {
      if (visited.has(name)) return;
      const file = files.get(name);
      if (!file) throw new Error(`Missing build output: ${name}`);
      visited.add(name);
      if (file.type === 'chunk') {
        file.imports.forEach(visit);
        file.viteMetadata?.importedCss.forEach(visit);
      }
    }
    roots.forEach(visit);
    return visited;
  }

  function chunkFor(source) {
    const file = output.find((file) => file.type === 'chunk' && file.facadeModuleId?.endsWith(source));
    if (!file) throw new Error(`Missing chunk for ${source}`);
    return file.fileName;
  }

  function size(names) {
    let raw = 0;
    let gzip = 0;
    for (const name of names) {
      const file = files.get(name);
      const bytes = Buffer.from(file.type === 'chunk' ? file.code : file.source);
      raw += bytes.length;
      gzip += gzipSync(bytes).length;
    }
    return { raw, gzip, files: names.size };
  }

  function modules(names) {
    return [...names].flatMap((name) => Object.keys(files.get(name).modules || {}));
  }

  const localeSources = ['/src/locales/zh-CN.js', '/src/locales/zh-TW.js', '/src/locales/en-US.js'];
  function pageFiles(page, locale) {
    const roots = [entry.fileName, 'index.html', chunkFor(`/src/pages/${page}.vue`), chunkFor(locale)];
    // 后台子路由还会加载外壳；一起计量，防止公共后台样式逃出首屏预算。
    if (page.startsWith('Admin')) roots.push(chunkFor('/src/pages/AdminPage.vue'));
    return closure(roots);
  }
  const pages = Object.fromEntries(['LoginPage', 'ChatPage', 'AdminDashboardPage', 'AdminUsersPage'].map((page) => [
    page,
    Object.fromEntries(localeSources.map((locale) => [locale.split('/').at(-1).slice(0, -3), size(pageFiles(page, locale))]))
  ]));
  const all = new Set(files.keys());
  // 编译产物包含全部语言和编辑器分包；public 内的自托管 Lute 由 CLI 单独报告，避免混淆预算。
  return { pages, compiled: size(all), closure, chunkFor, pageFiles, modules, size, files };
}
