import test from 'node:test';
import assert from 'node:assert/strict';
import english from '../src/i18n/en.json' with { type: 'json' };
import { LANGUAGE_KEY, detectLanguage, initialLanguage, getLanguage, setLanguage, t, tr, bindText, untranslated } from '../src/i18n.js';

test('browser language recognizes regions and the first supported preference', () => {
  assert.equal(detectLanguage(['de-AT', 'en-US']), 'de');
  assert.equal(detectLanguage(['en-GB', 'de-DE']), 'en');
  assert.equal(detectLanguage(['fr-FR', 'de-CH']), 'de');
  assert.equal(detectLanguage(['DE_de']), 'de');
  assert.equal(detectLanguage(['fr-FR']), 'en');
  assert.equal(detectLanguage([]), 'en');
});
test('saved preference wins; invalid or blocked storage uses the browser language', () => {
  const saved = value => ({ getItem: key => { assert.equal(key, LANGUAGE_KEY); return value; } });
  assert.equal(initialLanguage(saved('de'), ['en-US']), 'de');
  assert.equal(initialLanguage(saved('en'), ['de-DE']), 'en');
  assert.equal(initialLanguage(saved('fr'), ['de-DE']), 'de');
  assert.equal(initialLanguage({ getItem() { throw new Error('blocked'); } }, ['en-GB']), 'en');
});
test('every English translation preserves its interpolation placeholders', () => {
  const placeholders = value => [...new Set(value.match(/\{\d+\}/g) ?? [])].sort();
  for (const [source, translated] of Object.entries(english)) {
    assert.ok(translated.trim(), source);
    assert.deepEqual(placeholders(translated), placeholders(source), source);
  }
});
test('switching updates messages and bindings and preserves user data', () => {
  const stored = new Map();
  globalThis.window = { localStorage: { setItem: (key, value) => stored.set(key, value) } };
  globalThis.document = { documentElement: {}, dispatchEvent() {} };
  try {
    const status = { isConnected: true }, name = { isConnected: true };
    const message = tr(['Objekte (', ')'], 3);
    bindText(status, () => message);
    bindText(name, () => 'Punkt', false);
    setLanguage('en');
    assert.equal(getLanguage(), 'en');
    assert.equal(status.textContent, 'Objects (3)');
    assert.equal(name.textContent, 'Punkt');
    assert.equal(t(tr(['„', '“ löschen'], untranslated('Punkt'))), getLanguage() === 'en' ? 'Delete “Punkt”' : '„Punkt“ löschen');
    assert.equal(t('Inseln und Löcher werden zugeordnet (3/8)'), 'Assigning islands and holes (3/8)');
    assert.equal(t('Unknown third-party error'), 'Unknown third-party error');
    assert.equal(t('Die Fläche „Punkt“ hat einen ungültigen Rand: Ungültige Koordinate. Bitte zuerst korrigieren.'), 'The area “Punkt” has an invalid boundary: Invalid coordinate. Please correct it first.');
    assert.equal(stored.get(LANGUAGE_KEY), 'en');
    setLanguage('de');
    assert.equal(status.textContent, 'Objekte (3)');
    assert.equal(name.textContent, 'Punkt');
    assert.equal(document.documentElement.lang, 'de');
    window.localStorage.setItem = () => { throw new Error('blocked'); };
    assert.doesNotThrow(() => setLanguage('en'));
    assert.equal(status.textContent, 'Objects (3)');
    setLanguage('fr');
    assert.equal(getLanguage(), 'en');
  } finally {
    setLanguage('de');
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('obsolete text bindings do not overwrite a rebuilt list', () => {
  globalThis.window = { localStorage: { setItem() {} } };
  globalThis.document = { documentElement: {}, dispatchEvent() {} };
  try {
    const list = { isConnected: true };
    bindText(list, () => 'Objekt auswählen.');
    list.textContent = 'Punkt · Eigener Objektname';
    setLanguage('en');
    assert.equal(list.textContent, 'Punkt · Eigener Objektname');
  } finally {setLanguage('de');delete globalThis.window;delete globalThis.document;}
});
