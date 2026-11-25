/**
 * English ⇄ Indonesian.
 *
 * The code is written in English; English strings are the translation keys.
 * Translation happens once, where text reaches the screen (`h()` in dom.js and
 * the few places that set text directly), so views stay free of t() noise and
 * server messages (errors, validation) are translated by the same dictionary.
 */
import { EXACT, PATTERNS } from './i18n.id.js';

const KEY = 'rei.crm.lang';
export const LANGUAGES = Object.freeze({ en: 'English', id: 'Bahasa Indonesia' });

function stored() {
  try {
    const value = localStorage.getItem(KEY);
    return value in LANGUAGES ? value : null;
  } catch {
    return null;
  }
}

let lang = stored() ?? 'en';
document.documentElement.lang = lang;

export const currentLang = () => lang;

/** Number/date locale: Indonesian grouping in both languages, words follow the language. */
export const locale = () => (lang === 'id' ? 'id-ID' : 'en-ID');

export function setLang(next) {
  if (!(next in LANGUAGES) || next === lang) return;
  lang = next;
  document.documentElement.lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage blocked: the language still applies for this visit */
  }
  window.dispatchEvent(new CustomEvent('lang:change', { detail: next }));
}

/** Translates one UI string; anything unknown (names, numbers, data) is returned unchanged. */
export function t(text) {
  if (lang === 'en' || typeof text !== 'string' || text.length < 2) return text;
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const exact = EXACT[core];
  if (exact !== undefined) return lead + exact + trail;
  for (const [pattern, replace] of PATTERNS) {
    if (pattern.test(core)) return lead + core.replace(pattern, replace) + trail;
  }
  return text;
}
