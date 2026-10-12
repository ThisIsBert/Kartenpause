import english from './i18n/en.json' with { type: 'json' };

export const LANGUAGE_KEY = 'kartenpause.language';
export function detectLanguage(languages = []) {
  for (const locale of languages) {
    const candidate = String(locale).toLowerCase().split(/[-_]/)[0];
    if (candidate === 'de' || candidate === 'en') return candidate;
  }
  return 'en';
}
export function initialLanguage(storage, languages) {
  try {
    const saved = storage?.getItem(LANGUAGE_KEY);
    if (saved === 'de' || saved === 'en') return saved;
  } catch { /* Storage can be disabled. */ }
  return detectLanguage(languages);
}
let language = 'de';
if (typeof document !== 'undefined') {
  let storage;
  try { storage = window.localStorage; } catch { /* Use browser language. */ }
  language = initialLanguage(storage, navigator.languages?.length ? navigator.languages : [navigator.language]);
  document.documentElement.lang = language;
}
export const getLanguage = () => language;
export const getLocale = () => language === 'de' ? 'de-DE' : 'en-US';
const reverse = new Map(Object.entries(english).map(([de, en]) => [en, de]));
// Recent messages retain their source and values for language changes.
const messages = new Map();
function remember(rendered, message) {
  messages.delete(rendered);
  messages.set(rendered, message);
  if (messages.size > 4000) messages.delete(messages.keys().next().value);
  return rendered;
}
function format(key, values) {
  const template = language === 'en' ? english[key] ?? key : key;
  return template.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? values[index] : match);
}
const escapePattern = value => value.replace(/[.*+?^$\u007b\u007d()|[\]\\]/g, '\\$&');
const nameTemplates = new Set([
  'Bild: {0} ({1}×{2} px)', '„{0}“ löschen', '{0} aus Auswahl entfernen',
  'Die Fläche „{0}“ hat einen ungültigen Rand: {1}. Bitte zuerst korrigieren.'
]);
const patterns = Object.entries(english).filter(([key]) => /\{\d+\}/.test(key)).flatMap(([key, translated]) => [key, translated].map(template => {
  const indexes = [];
  const parts = template.split(/(\{\d+\})/g).map(part => {
    const match = part.match(/^\{(\d+)\}$/);
    if (!match) return escapePattern(part);
    indexes.push(Number(match[1]));
    return '([\\s\\S]*?)';
  });
  return { key, indexes, pattern: new RegExp('^' + parts.join('') + '$'), weight: template.replace(/\{\d+\}/g, '').length };
})).sort((a, b) => b.weight - a.weight);
export function t(value) {
  if (typeof value !== 'string') return value;
  if (Object.hasOwn(english, value)) return language === 'en' ? english[value] : value;
  const original = reverse.get(value);
  if (original !== undefined) return language === 'de' ? original : value;
  const message = messages.get(value);
  if (message) return format(message.key, message.values.map(part => t(part)));
  // Worker messages arrive as plain strings. Match complete catalog templates.
  for (const { key, indexes, pattern } of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const values = [];
    indexes.forEach((index, i) => { values[index] = index === 0 && nameTemplates.has(key) ? match[i + 1] : t(match[i + 1]); });
    return format(key, values);
  }
  return value;
}
// Explicitly protect user-provided names inside translated sentences.
export const untranslated = value => ({ toString: () => String(value) });
export function tr(strings, ...values) {
  const key = strings.reduce((result, part, index) => result + part + (index < values.length ? '{' + index + '}' : ''), '');
  return remember(format(key, values), { key, values });
}
const bindings = new WeakMap();
const elements = new Set();
function bind(element, property, read, apply, current, translate = true) {
  let properties = bindings.get(element);
  if (!properties) { properties = new Map(); bindings.set(element, properties); elements.add(new WeakRef(element)); }
  let previous;
  const update = (force = false) => {
    // A list or preview can replace formerly bound text with richer content.
    // Do not restore that obsolete text during a later language change.
    if (!force && current() !== previous) { properties.delete(property); return; }
    const value = read();
    apply(translate ? t(value) : value);
    previous = current();
  };
  properties.set(property, update);
  update(true);
}
export function bindText(element, read, translate = true) {
  bind(element, 'textContent', read, value => { element.textContent = value; }, () => element.textContent, translate);
}
export function bindAttribute(element, name, read) {
  bind(element, name, read, value => element.setAttribute(name, value), () => element.getAttribute(name));
}
export function localizeDocument(root = document) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode, source = node.textContent;
    if (!Object.hasOwn(english, source.trim())) continue;
    const before = source.match(/^\s*/)[0], after = source.match(/\s*$/)[0];
    // Bind individual text nodes, preserving icons, inputs and other children.
    bindText(node, () => before + t(source.trim()) + after, false);
  }
  for (const element of root.querySelectorAll('[title], [aria-label], [placeholder], meta[name="description"], [data-empty-message]')) {
    for (const name of ['title', 'aria-label', 'placeholder', 'content', 'data-empty-message']) {
      const source = element.getAttribute(name);
      if (source && Object.hasOwn(english, source)) bindAttribute(element, name, () => t(source));
    }
  }
}
export function setLanguage(next) {
  if (next !== 'de' && next !== 'en') return;
  language = next;
  try { window.localStorage.setItem(LANGUAGE_KEY, next); } catch { /* In-memory selection still works. */ }
  document.documentElement.lang = next;
  for (const reference of elements) {
    const element = reference.deref();
    if (!element?.isConnected) { elements.delete(reference); continue; }
    for (const update of bindings.get(element)?.values() ?? []) update();
  }
  document.dispatchEvent(new CustomEvent('languagechange', { detail: { language: next } }));
}
export function localizeMapControls(map) {
  for (const [selector, label] of [['.leaflet-control-zoom-in', 'Vergrößern'], ['.leaflet-control-zoom-out', 'Verkleinern']]) {
    const button = map.getContainer().querySelector(selector);
    if (!button) continue;
    bindAttribute(button, 'title', () => t(label));
    bindAttribute(button, 'aria-label', () => t(label));
  }
}
