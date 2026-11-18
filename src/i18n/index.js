// 文言の取得。UI・画像描画のすべての文言はここ（t）を通す。
// 言語を足すときは、同じキーを持つファイルを追加して LOCALES に登録するだけ。
import ja from './ja.js';
import en from './en.js';

export const LOCALES = { ja, en };
export const DEFAULT_LOCALE = 'ja';

let current = DEFAULT_LOCALE;

export function detectLocale() {
  try {
    const q = new URLSearchParams(globalThis.location?.search || '').get('lang');
    if (q && LOCALES[q]) return q;
  } catch { /* ignore */ }
  return DEFAULT_LOCALE;
}

export function setLocale(code) {
  current = LOCALES[code] ? code : DEFAULT_LOCALE;
  if (globalThis.document) document.documentElement.lang = current;
  return current;
}
export const getLocale = () => current;

/** t('key', {name: 'x'}) — {name} を置き換える。未定義キーは日本語→キー名の順でフォールバック。 */
export function t(key, params) {
  let s = LOCALES[current][key] ?? LOCALES[DEFAULT_LOCALE][key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return s;
}

/** data-i18n="key" を持つ要素の文言を差し替える（属性は data-i18n-attr="aria-label:key,title:key"）。 */
export function applyDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':');
      el.setAttribute(attr.trim(), t(key.trim()));
    }
  }
  document.title = t('app.title');
}
