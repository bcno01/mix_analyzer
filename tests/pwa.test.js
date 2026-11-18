import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ja from '../src/i18n/ja.js';
import en from '../src/i18n/en.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('sw.js: プリキャッシュ一覧の全ファイルが存在し、src/css/icons/fonts の全ファイルが一覧にある', () => {
  const sw = read('sw.js');
  const list = [...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]).filter((p) => p !== './');
  for (const p of list) assert.ok(existsSync(join(root, p)), `${p} が存在しない`);
  const actual = ['src', 'css', 'icons', 'fonts'].flatMap((d) => walk(join(root, d))).map((p) => relative(root, p).split(sep).join('/'));
  for (const f of actual) assert.ok(list.includes(f), `${f} が sw.js の ASSETS に無い`);
  for (const f of ['index.html', 'manifest.webmanifest']) assert.ok(list.includes(f));
});

test('manifest: 必須項目・アイコン・maskable', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.ok(m.name && m.short_name && m.start_url === './' && m.display === 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '192x192' && i.purpose.includes('any')));
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose.includes('any')));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(existsSync(join(root, i.src)), i.src);
});

test('index.html: manifest・viewport・theme-color・apple-touch-icon', () => {
  const h = read('index.html');
  for (const needle of ['rel="manifest"', 'name="viewport"', 'name="theme-color"', 'rel="apple-touch-icon"', 'lang="ja"']) {
    assert.ok(h.includes(needle), needle);
  }
});

test('i18n: ja と en のキーが一致し、置換パラメータも揃っている', () => {
  assert.deepEqual(Object.keys(ja).sort(), Object.keys(en).sort());
  const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of Object.keys(ja)) assert.equal(params(ja[k]), params(en[k]), k);
});

test('i18n: 画像に必ず入れる注記が日本語に入っている', () => {
  assert.equal(
    ja['footer.notice'],
    '数値による客観分析です(聴感の判断ではありません)。ラウドネスは ITU-R BS.1770 / EBU R128 準拠',
  );
});

test('i18n: 画面・描画コードの t() キーがすべて定義されている', () => {
  const files = walk(join(root, 'src')).filter((p) => p.endsWith('.js') && !p.includes(`${sep}i18n${sep}`));
  const keys = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\('([\w.]+)'/g)) if (!m[1].endsWith('.')) keys.add(m[1]);
  }
  for (const m of read('index.html').matchAll(/data-i18n="([\w.]+)"/g)) keys.add(m[1]);
  for (const k of keys) assert.ok(k in ja, `未定義キー: ${k}`);
  // 動的に組み立てるキー
  for (const stage of ['read', 'decode', 'analyze', 'finalize']) assert.ok(`progress.${stage}` in ja, stage);
  for (let i = 0; i < 7; i++) assert.ok(`band.${i}` in ja, `band.${i}`);
});
