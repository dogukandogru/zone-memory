'use strict'

/**
 * ESLint yapilandirmasi (ESLint 9 duz bicim).
 *
 * NEDEN SADECE UC KURAL
 * Amac bicim tartismasi degil, derlenmeyen dile karsi agdir: JavaScript'te
 * yazim hatasi (`sonuc` yerine `sonucc`), silinmis degiskenin kalan kullanimi
 * ve erken `return`'den sonra olu kalan satirlar ancak calisma aninda, o da
 * yalnizca o dal girilirse patlar. Bu uc kural (no-undef, no-unused-vars,
 * no-unreachable) o uc sinifi statik olarak yakalar. Stil kurallari acilirsa
 * gercek bulgular yuzlerce bicim uyarisinin arasinda kaybolur.
 *
 * NEDEN ELLE GLOBAL LISTESI
 * `globals` paketini bagimlilik olarak eklemek yerine listeler burada duruyor:
 * yapilandirma hicbir sey import etmedigi icin `npx eslint` ile kurulum
 * yapmadan da kosturulabiliyor ve bu projenin hangi ortam degiskenlerine
 * dayandigi tek bakista gorunuyor.
 *
 * NEDEN UC AYRI BLOK
 * Depoda uc farkli ortam var ve karistirilirsa no-undef ise yaramaz hale
 * gelir: cekirdek ile ana surec CommonJS + Node, scripts/ ESM + Node,
 * renderer ESM + tarayici. Renderer'a Node globalleri verilseydi `process`
 * gibi bir kacak kod incelemeden gecerdi, tersi durumda da yuzlerce yanlis
 * no-undef cikardi.
 */

// Node tarafi (cekirdek, ana surec, isci, testler, scripts).
const NODE_GLOBALLERI = {
  // CommonJS sarmalayicisi
  module: 'writable',
  exports: 'writable',
  require: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  // Calisma ortami
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  fetch: 'readonly',
  crypto: 'readonly',
  performance: 'readonly',
  Intl: 'readonly',
  Event: 'readonly',
  EventTarget: 'readonly',
  MessageChannel: 'readonly',
  MessagePort: 'readonly',
}

// Renderer tarafi. Liste index.html ve tradingview.html'in sagladigi ortamdir;
// `LightweightCharts` kutuphanenin standalone <script> etiketiyle gelen
// kuresel adidir, import edilmez, bu yuzden elle ilan edilmek zorunda.
const TARAYICI_GLOBALLERI = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  performance: 'readonly',
  devicePixelRatio: 'readonly',
  getComputedStyle: 'readonly',
  matchMedia: 'readonly',
  ResizeObserver: 'readonly',
  MutationObserver: 'readonly',
  IntersectionObserver: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  EventTarget: 'readonly',
  Node: 'readonly',
  Element: 'readonly',
  HTMLElement: 'readonly',
  HTMLCanvasElement: 'readonly',
  DOMParser: 'readonly',
  Image: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  WebSocket: 'readonly',
  AbortController: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  crypto: 'readonly',
  Intl: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
  LightweightCharts: 'readonly',
}

// NEDEN argsIgnorePattern: geri cagrilarda imzayi bozmadan bir parametreyi
// gormezden gelmek gerekiyor (`(err, _veri) => ...`), alt cizgi bunun isareti.
// NEDEN caughtErrors 'none': `catch (e) {}` ile hatayi yutmak bu depoda bilincli
// bir karar (agdan gelen veri eksikse akis durmamali), uyari degil.
const KURALLAR = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-unreachable': 'error',
}

module.exports = [
  {
    // Uretilen ve indirilen ne varsa disarida: bunlar el yazmasi degil.
    ignores: ['node_modules/**', 'release/**', 'dist/**', 'out/**', 'build/**'],
  },
  {
    // Cekirdek, ana surec ve testler: CommonJS.
    // NEDEN .cjs de: package.json "type": "commonjs" oldugu icin buradaki .js
    // zaten CommonJS'tir, .cjs yalnizca niyeti acik yazan es anlamlisidir.
    files: [
      'src/core/**/*.js',
      'src/core/**/*.cjs',
      'src/main/**/*.js',
      'src/main/**/*.cjs',
      'test/**/*.js',
      'test/**/*.cjs',
      'scripts/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: NODE_GLOBALLERI,
    },
    rules: KURALLAR,
  },
  {
    // Node ortaminda ESM: bakim betikleri ve .mjs uzantili cekirdek/test
    // dosyalari. Uzanti burada tek belirleyici, cunku paketin turu commonjs.
    files: ['scripts/**/*.mjs', 'src/core/**/*.mjs', 'src/main/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: NODE_GLOBALLERI,
    },
    rules: KURALLAR,
  },
  {
    // Arayuz: ESM modul olarak yuklenir, Node globali yoktur.
    files: ['src/renderer/**/*.js', 'src/renderer/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: TARAYICI_GLOBALLERI,
    },
    rules: KURALLAR,
  },
]
