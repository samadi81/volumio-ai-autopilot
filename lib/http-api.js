'use strict';

const http = require('http');
const url = require('url');

/**
 * Tiny HTTP server that exposes a standalone remote-control panel for the plugin.
 *
 * Designed to be opened in a normal phone/desktop browser (outside the Volumio
 * app) at  http://<volumio-ip>:<port>/  — and "Added to Home Screen" for a
 * one-tap, app-like launch.
 *
 * Routes (GET unless noted):
 *   GET  /          → the remote panel (HTML)
 *   GET  /state     → full snapshot: now-playing, queue, feedback, quick settings
 *   GET  /status    → legacy lightweight {ok, track, counts}
 *   GET  /like      → plugin.likeCurrent()
 *   GET  /dislike   → plugin.dislikeCurrent()
 *   GET  /next      → plugin.triggerManual()  (pick next track now)
 *   POST /set       → plugin.applyQuickChange(<json patch>)   (also GET ?key=&value=)
 *
 * All responses include permissive CORS. No auth — local-network use only.
 */
class HttpApi {
  constructor({ plugin, port = 3001, logger }) {
    this.plugin = plugin;
    this.port = port;
    this.logger = logger || console;
    this.server = null;
  }

  start() {
    if (this.server) return;
    if (!this.port) {
      this.logger.info('[ai_autopilot] HTTP API disabled (port=0)');
      return;
    }
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('error', (err) => {
      this.logger.error('[ai_autopilot] HTTP API error: ' + err.message);
    });
    this.server.listen(this.port, () => {
      this.logger.info('[ai_autopilot] HTTP API listening on port ' + this.port);
    });
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch (e) {}
      this.server = null;
    }
  }

  _cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  _json(res, code, obj) {
    this._cors(res);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  _readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1e5) { data = data.slice(0, 1e5); req.destroy(); } // guard
      });
      req.on('end', () => resolve(data));
      req.on('error', () => resolve(data));
    });
  }

  _handle(req, res) {
    this._cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const parsed = url.parse(req.url, true);
    const path = (parsed.pathname || '/').replace(/\/+$/, '') || '/';

    try {
      if (path === '/' || path === '/index.html') return this._serveLanding(res);
      if (path === '/state')    return this._json(res, 200, this._safeState());
      if (path === '/status')   return this._legacyStatus(res);
      if (path === '/like')     return this._runAndReply(res, 'likeCurrent');
      if (path === '/dislike')  return this._runAndReply(res, 'dislikeCurrent');
      if (path === '/next')     return this._runAndReply(res, 'triggerManual');
      if (path === '/set')      return this._set(res, req, parsed.query);
      this._json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      this.logger.error('[ai_autopilot] HTTP handler error: ' + e.message);
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  _safeState() {
    try { return this.plugin.getQuickState(); }
    catch (e) { return { ok: false, error: e.message }; }
  }

  _legacyStatus(res) {
    const s = this._safeState();
    this._json(res, 200, { ok: !!s.ok, track: s.track || null, counts: s.counts || { likes: 0, dislikes: 0 } });
  }

  _runAndReply(res, methodName) {
    if (typeof this.plugin[methodName] !== 'function') {
      return this._json(res, 500, { ok: false, error: 'method missing: ' + methodName });
    }
    Promise.resolve()
      .then(() => this.plugin[methodName]())
      .then(() => this._json(res, 200, this._safeState()))
      .catch((err) => this._json(res, 500, { ok: false, error: err.message || String(err) }));
  }

  _set(res, req, query) {
    const apply = (patch) => {
      try {
        const state = this.plugin.applyQuickChange(patch || {});
        this._json(res, 200, state);
      } catch (e) {
        this._json(res, 500, { ok: false, error: e.message || String(e) });
      }
    };

    if (req.method === 'POST') {
      this._readBody(req).then((body) => {
        let patch = {};
        try { patch = body ? JSON.parse(body) : {}; } catch (e) { patch = {}; }
        apply(patch);
      });
      return;
    }
    // GET fallback: /set?key=energy_min&value=3  or  /set?patch=<urlencoded json>
    if (query && query.patch) {
      let patch = {};
      try { patch = JSON.parse(query.patch); } catch (e) {}
      return apply(patch);
    }
    if (query && query.key !== undefined) {
      const patch = {};
      patch[query.key] = query.value;
      return apply(patch);
    }
    apply({});
  }

  _serveLanding(res) {
    this._cors(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LANDING_HTML);
  }
}

const LANDING_HTML = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="AI Autopilot">
<meta name="theme-color" content="#1a1a1a">
<title>AI Autopilot Remote</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#141414;color:#eee;
margin:0;padding:1em;padding-bottom:3em;-webkit-user-select:none;user-select:none;max-width:560px;margin:0 auto}
h1{font-size:1em;margin:.2em 0 1em;color:#888;letter-spacing:.03em}
.card{background:#1f1f1f;border-radius:12px;padding:1em;margin-bottom:1em}
.np{display:flex;gap:1em;align-items:center}
.np img{width:84px;height:84px;border-radius:8px;object-fit:cover;background:#333;flex:0 0 auto}
.np .info{min-width:0;flex:1}
.np .title{font-size:1.1em;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.np .meta{color:#aaa;margin-top:.25em;font-size:.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.np .counts{color:#777;margin-top:.4em;font-size:.82em}
.row{display:flex;gap:.5em;margin-top:.8em}
button.act{flex:1;padding:.9em;font-size:1.05em;border:none;border-radius:9px;cursor:pointer;color:#fff;font-weight:600}
.like{background:#2a8f3a}.dislike{background:#8f2a2a}.next{background:#3a6a8f}
.sec-title{font-size:.8em;color:#888;text-transform:uppercase;letter-spacing:.05em;margin:.2em 0 .8em}
.ctl{display:flex;align-items:center;justify-content:space-between;margin:.7em 0}
.ctl label{font-size:.95em;color:#ddd}
select{background:#2a2a2a;color:#eee;border:1px solid #3a3a3a;border-radius:7px;padding:.5em;font-size:.95em;max-width:62%}
input[type=range]{width:60%;accent-color:#3a6a8f}
.val{color:#9bd;font-variant-numeric:tabular-nums;min-width:1.6em;text-align:right}
.switch{position:relative;width:52px;height:30px;flex:0 0 auto}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:#444;border-radius:30px;transition:.2s;cursor:pointer}
.slider:before{content:"";position:absolute;height:24px;width:24px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
.switch input:checked+.slider{background:#2a8f3a}
.switch input:checked+.slider:before{transform:translateX(22px)}
.warn{color:#e0a030;font-size:.8em;margin-top:.3em}
.qlist{max-height:46vh;overflow-y:auto;-webkit-overflow-scrolling:touch}
.qrow{display:flex;gap:.7em;align-items:center;padding:.45em;border-radius:8px}
.qrow.cur{background:#243040}
.qrow img{width:42px;height:42px;border-radius:5px;object-fit:cover;background:#333;flex:0 0 auto}
.qrow .qt{min-width:0;flex:1}
.qrow .qt .t{font-size:.92em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qrow .qt .a{font-size:.78em;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qrow .now{color:#5af;font-size:.75em;flex:0 0 auto}
.empty{color:#666;text-align:center;padding:1em;font-size:.9em}
.toast{position:fixed;bottom:1em;left:1em;right:1em;max-width:528px;margin:0 auto;background:#333;padding:.8em;
border-radius:8px;opacity:0;transition:opacity .2s;text-align:center;pointer-events:none}
.toast.show{opacity:1}
.hint{font-size:.78em;color:#666;text-align:center;margin-top:.5em}
</style></head><body>
<h1>🎛 AI Autopilot Remote</h1>

<div class="card">
  <div class="np">
    <img id="art" alt="">
    <div class="info">
      <div class="title" id="title">—</div>
      <div class="meta" id="meta"></div>
      <div class="counts" id="counts"></div>
    </div>
  </div>
  <div class="row">
    <button class="act like" onclick="hit('like')">👍 Like</button>
    <button class="act dislike" onclick="hit('dislike')">👎 Dislike</button>
    <button class="act next" onclick="hit('next')">⏭ Next</button>
  </div>
</div>

<div class="card">
  <div class="sec-title">빠른 설정</div>
  <div class="ctl">
    <label>자동운전</label>
    <span class="switch"><input type="checkbox" id="enabled" onchange="setVal('enabled', this.checked)"><span class="slider" onclick="var c=document.getElementById('enabled');c.checked=!c.checked;setVal('enabled',c.checked)"></span></span>
  </div>
  <div class="ctl">
    <label>에너지 최소</label>
    <input type="range" id="emin" min="0" max="10" step="1" oninput="document.getElementById('eminv').textContent=this.value" onchange="setVal('energy_min', +this.value)">
    <span class="val" id="eminv">0</span>
  </div>
  <div class="ctl">
    <label>에너지 최대</label>
    <input type="range" id="emax" min="0" max="10" step="1" oninput="document.getElementById('emaxv').textContent=this.value" onchange="setVal('energy_max', +this.value)">
    <span class="val" id="emaxv">10</span>
  </div>
  <div class="ctl">
    <label>무드 (프롬프트)</label>
    <select id="prompt" onchange="setVal('prompt_preset_selected', this.value)"></select>
  </div>
  <div class="ctl">
    <label>LLM 프로바이더</label>
    <select id="provider" onchange="setVal('llm_provider', this.value)"></select>
  </div>
  <div class="ctl">
    <label>모델</label>
    <select id="model" onchange="setVal('llm_model', this.value)"></select>
  </div>
  <div class="warn" id="keywarn" style="display:none">⚠ 이 프로바이더의 API 키가 비어 있습니다. 플러그인 설정에서 입력하세요.</div>
</div>

<div class="card">
  <div class="sec-title">재생 대기열 (Queue)</div>
  <div class="qlist" id="qlist"><div class="empty">—</div></div>
</div>

<div class="hint">홈 화면에 추가하면 앱처럼 한 번에 열립니다 (Safari 공유 → 홈 화면에 추가).</div>
<div class="toast" id="toast"></div>

<script>
var ART_BASE = location.protocol + "//" + location.hostname + ":3000";
function artUrl(a){ if(!a) return ""; if(/^https?:\\/\\//.test(a)) return a; return ART_BASE + (a.charAt(0)==="/"?a:"/"+a); }
function esc(s){ return (s||"").replace(/[&<>]/g, function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }); }
function toast(m){ var t=document.getElementById("toast"); t.textContent=m; t.classList.add("show"); clearTimeout(t._h); t._h=setTimeout(function(){t.classList.remove("show");},1600); }

var building=false, lastProvider=null;

function fillSelect(el, opts, value){
  el.innerHTML="";
  (opts||[]).forEach(function(o){
    var op=document.createElement("option");
    op.value=o.value; op.textContent=o.label;
    if(o.value===value) op.selected=true;
    el.appendChild(op);
  });
}

function render(d){
  if(!d || !d.ok) return;
  // now playing
  var img=document.getElementById("art");
  if(d.track){
    var u=artUrl(d.track.albumart);
    if(u){ img.src=u; img.style.visibility="visible"; img.onerror=function(){img.style.visibility="hidden";}; }
    else img.style.visibility="hidden";
    document.getElementById("title").textContent=d.track.title||"(재생 없음)";
    document.getElementById("meta").textContent=(d.track.artist||"")+(d.track.album?" — "+d.track.album:"");
  } else {
    img.style.visibility="hidden";
    document.getElementById("title").textContent="(재생 없음)";
    document.getElementById("meta").textContent="";
  }
  document.getElementById("counts").textContent="👍 "+(d.counts?d.counts.likes:0)+"   👎 "+(d.counts?d.counts.dislikes:0);

  // controls (rebuild selects only when provider changes or first load)
  building=true;
  var s=d.settings, o=d.options;
  if(!document.getElementById("enabled").matches(":active"))
    document.getElementById("enabled").checked=!!s.enabled;
  var emin=document.getElementById("emin"), emax=document.getElementById("emax");
  if(document.activeElement!==emin){ emin.value=s.energy_min; document.getElementById("eminv").textContent=s.energy_min; }
  if(document.activeElement!==emax){ emax.value=s.energy_max; document.getElementById("emaxv").textContent=s.energy_max; }
  fillSelect(document.getElementById("prompt"), o.prompts, s.prompt_preset_selected);
  fillSelect(document.getElementById("provider"), o.providers, s.llm_provider);
  fillSelect(document.getElementById("model"), (o.models&&o.models[s.llm_provider])||[], s.llm_model);
  document.getElementById("keywarn").style.display = s.has_key ? "none" : "block";
  lastProvider=s.llm_provider;
  building=false;

  // queue
  var q=document.getElementById("qlist");
  if(!d.queue || !d.queue.length){ q.innerHTML='<div class="empty">대기열이 비어 있습니다.</div>'; return; }
  q.innerHTML=d.queue.map(function(it){
    var u=artUrl(it.albumart);
    var thumb = u ? '<img src="'+u+'" onerror="this.style.visibility=\\'hidden\\'">' : '<img>';
    return '<div class="qrow'+(it.current?' cur':'')+'">'+thumb+
      '<div class="qt"><div class="t">'+esc(it.title)+'</div><div class="a">'+esc(it.artist)+'</div></div>'+
      (it.current?'<span class="now">▶ NOW</span>':'')+'</div>';
  }).join("");
}

function load(){ fetch("/state").then(function(r){return r.json();}).then(render).catch(function(){}); }

var setTimer=null, pending={};
function setVal(key, value){
  if(building) return;
  pending[key]=value;
  toast("저장…");
  clearTimeout(setTimer);
  setTimer=setTimeout(function(){
    var patch=pending; pending={};
    fetch("/set",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(patch)})
      .then(function(r){return r.json();})
      .then(function(d){ toast("저장됨"); render(d); })
      .catch(function(){ toast("오류"); });
  }, 250);
}

function hit(a){
  toast("…");
  fetch("/"+a).then(function(r){return r.json();}).then(function(d){
    toast({like:"👍 liked",dislike:"👎 disliked",next:"⏭ queued"}[a]||"ok");
    render(d);
  }).catch(function(){ toast("오류"); });
}

load();
setInterval(load, 3000);
</script>
</body></html>`;

module.exports = HttpApi;
