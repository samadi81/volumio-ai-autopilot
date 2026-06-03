'use strict';

const http = require('http');
const url = require('url');

/**
 * Tiny HTTP server that exposes a standalone remote-control panel for the plugin.
 *
 * Open it in a normal phone/desktop browser (outside the Volumio app) at
 *   http://<volumio-ip>:<port>/   — and "Add to Home Screen" for an app-like launch.
 *
 * If the configured port is busy it automatically tries the next few ports and
 * reports the one it actually bound to via `this.actualPort`.
 *
 * Routes (GET unless noted):
 *   GET  /          → the remote panel (HTML)
 *   GET  /state     → full snapshot: now-playing, player, queue, feedback, likes, settings
 *   GET  /status    → legacy lightweight {ok, track, counts}
 *   GET  /like      → plugin.likeCurrent()
 *   GET  /dislike   → plugin.dislikeCurrent()
 *   GET  /next      → plugin.triggerManual()  (AI: pick + queue next track)
 *   GET  /player    → plugin.playerControl(action[, value])  (toggle|play|pause|next|prev|volume)
 *   POST /set       → plugin.applyQuickChange(<json patch>)   (also GET ?key=&value=)
 *
 * All responses include permissive CORS. No auth — local-network use only.
 */
class HttpApi {
  constructor({ plugin, port = 8488, logger }) {
    this.plugin = plugin;
    this.port = port;
    this.actualPort = null;
    this.logger = logger || console;
    this.server = null;
  }

  start() {
    if (this.server) return;
    if (!this.port) {
      this.logger.info('[ai_autopilot] HTTP API disabled (port=0)');
      return;
    }
    this._tryListen(this.port, 0);
  }

  _tryListen(port, attempt) {
    const server = http.createServer((req, res) => this._handle(req, res));
    const onBindError = (err) => {
      if (err && err.code === 'EADDRINUSE' && attempt < 10) {
        this.logger.info('[ai_autopilot] HTTP API port ' + port + ' in use, trying ' + (port + 1));
        try { server.close(); } catch (e) {}
        this._tryListen(port + 1, attempt + 1);
      } else {
        this.logger.error('[ai_autopilot] HTTP API error: ' + (err && err.message));
      }
    };
    server.once('error', onBindError);
    server.listen(port, () => {
      server.removeListener('error', onBindError);
      server.on('error', (err) => this.logger.error('[ai_autopilot] HTTP API error: ' + (err && err.message)));
      this.server = server;
      this.actualPort = port;
      this.logger.info('[ai_autopilot] HTTP API listening on port ' + port);
    });
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch (e) {}
      this.server = null;
      this.actualPort = null;
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
        if (data.length > 1e5) { data = data.slice(0, 1e5); req.destroy(); }
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
      if (path === '/player')   return this._player(res, parsed.query);
      if (path === '/update')   return this._update(res);
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

  _player(res, query) {
    if (typeof this.plugin.playerControl !== 'function') {
      return this._json(res, 500, { ok: false, error: 'method missing: playerControl' });
    }
    const action = query && query.action;
    const value = query && query.value;
    Promise.resolve()
      .then(() => this.plugin.playerControl(action, value))
      .then((state) => this._json(res, 200, state || this._safeState()))
      .catch((err) => this._json(res, 500, { ok: false, error: err.message || String(err) }));
  }

  _update(res) {
    if (typeof this.plugin.remoteUpdate !== 'function') {
      return this._json(res, 500, { ok: false, message: 'method missing: remoteUpdate' });
    }
    Promise.resolve()
      .then(() => this.plugin.remoteUpdate())
      .then((result) => this._json(res, 200, result || { ok: false, message: 'no result' }))
      .catch((err) => this._json(res, 500, { ok: false, message: err.message || String(err) }));
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
.pb{margin:.9em 0 .3em}
.pb .bar{height:5px;background:#333;border-radius:3px;overflow:hidden}
.pb .fill{height:100%;width:0;background:#5af;border-radius:3px;transition:width .25s linear}
.pb .t{display:flex;justify-content:space-between;color:#888;font-size:.75em;margin-top:.3em;font-variant-numeric:tabular-nums}
.transport{display:flex;gap:.5em;align-items:center;justify-content:center;margin-top:.6em}
.transport button{background:#2a2a2a;border:none;color:#eee;border-radius:50%;width:52px;height:52px;font-size:1.4em;cursor:pointer}
.transport button.play{background:#3a6a8f;width:60px;height:60px;font-size:1.6em}
.vol{display:flex;align-items:center;gap:.6em;margin-top:.8em}
.vol input[type=range]{flex:1;accent-color:#5af}
.vol .vv{color:#9bd;font-size:.85em;min-width:2.4em;text-align:right;font-variant-numeric:tabular-nums}
.row{display:flex;gap:.5em;margin-top:.8em}
button.act{flex:1;padding:.9em;font-size:1em;border:none;border-radius:9px;cursor:pointer;color:#fff;font-weight:600}
.like{background:#2a8f3a}.dislike{background:#8f2a2a}.next{background:#5a4a8f}
.sec-title{font-size:.8em;color:#888;text-transform:uppercase;letter-spacing:.05em;margin:.2em 0 .8em}
.ctl{display:flex;align-items:center;justify-content:space-between;margin:.7em 0}
.ctl label{font-size:.95em;color:#ddd}
select{background:#2a2a2a;color:#eee;border:1px solid #3a3a3a;border-radius:7px;padding:.5em;font-size:.95em;max-width:62%}
input[type=number]{background:#2a2a2a;color:#eee;border:1px solid #3a3a3a;border-radius:7px;padding:.5em;font-size:.95em;width:5em;text-align:right}
textarea{width:100%;background:#2a2a2a;color:#eee;border:1px solid #3a3a3a;border-radius:7px;padding:.6em;font-size:.9em;margin-top:.4em;resize:vertical;font-family:inherit}
.fld{margin:.8em 0}
.fld>label{font-size:.85em;color:#bbb;display:block}
.updbtn{width:100%;padding:.9em;font-size:1em;border:none;border-radius:9px;cursor:pointer;color:#fff;font-weight:600;background:#3a6a8f}
input[type=range]{accent-color:#3a6a8f}
.ctl input[type=range]{width:60%}
.val{color:#9bd;font-variant-numeric:tabular-nums;min-width:1.6em;text-align:right}
.switch{position:relative;width:52px;height:30px;flex:0 0 auto}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:#444;border-radius:30px;transition:.2s;cursor:pointer}
.slider:before{content:"";position:absolute;height:24px;width:24px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
.switch input:checked+.slider{background:#2a8f3a}
.switch input:checked+.slider:before{transform:translateX(22px)}
.warn{color:#e0a030;font-size:.8em;margin-top:.3em}
.qlist,.llist{max-height:42vh;overflow-y:auto;-webkit-overflow-scrolling:touch}
.qrow{display:flex;gap:.7em;align-items:center;padding:.45em;border-radius:8px;cursor:pointer}
.qrow:active{background:#2f3f50}
.qrow.cur{background:#243040}
.qrow img{width:42px;height:42px;border-radius:5px;object-fit:cover;background:#333;flex:0 0 auto}
.qrow .qt{min-width:0;flex:1}
.qrow .qt .t{font-size:.92em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qrow .qt .a{font-size:.78em;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qrow .qt .u{font-size:.66em;color:#5a6b7a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:.1em}
.qcopy{flex:0 0 auto;background:#333;border:none;color:#bcd;border-radius:6px;padding:.45em .6em;font-size:.95em;cursor:pointer}
.qcopy:active{background:#456}
.qrow .now{color:#5af;font-size:.75em;flex:0 0 auto}
.lrow{padding:.4em .2em;border-bottom:1px solid #262626;font-size:.9em}
.lrow .a{color:#999;font-size:.82em}
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
  <div class="pb">
    <div class="bar"><div class="fill" id="pbfill"></div></div>
    <div class="t"><span id="pbcur">0:00</span><span id="pbtot">0:00</span></div>
  </div>
  <div class="transport">
    <button onclick="pc('prev')">⏮</button>
    <button class="play" id="playbtn" onclick="pc('toggle')">▶</button>
    <button onclick="pc('next')">⏭</button>
  </div>
  <div class="vol">
    <span>🔈</span>
    <input type="range" id="vol" min="0" max="100" step="1" oninput="document.getElementById('volval').textContent=this.value" onchange="pc('volume', this.value)">
    <span class="vv" id="volval">--</span>
  </div>
  <div class="row">
    <button class="act like" onclick="hit('like')">👍 Like</button>
    <button class="act dislike" onclick="hit('dislike')">👎 Dislike</button>
    <button class="act next" onclick="hit('next')">🤖 AI 추천</button>
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
  <div class="sec-title">프롬프트 / 추천 설정</div>
  <div class="ctl">
    <label>무드 (프리셋)</label>
    <select id="prompt" onchange="setVal('prompt_preset_selected', this.value)"></select>
  </div>
  <div class="ctl">
    <label>세부 변형</label>
    <select id="promptsub" onchange="setVal('prompt_sub_selected', this.value)"></select>
  </div>
  <div class="ctl">
    <label>힌트 프리셋</label>
    <select id="hintpreset" onchange="setVal('hint_preset_selected', this.value)"></select>
  </div>
  <div class="fld">
    <label>시스템 프롬프트 (직접 편집)</label>
    <textarea id="sysprompt" rows="5" onchange="setVal('llm_system_prompt', this.value)" placeholder="비워두면 기본 프롬프트 사용"></textarea>
  </div>
  <div class="fld">
    <label>취향 힌트 (자유 입력)</label>
    <textarea id="hints" rows="3" onchange="setVal('llm_hints', this.value)" placeholder="예: ECM 재즈 위주, 보컬 적게"></textarea>
  </div>
</div>

<div class="card">
  <div class="sec-title">일반 설정</div>
  <div class="ctl">
    <label>음악 소스</label>
    <select id="source" onchange="setVal('source', this.value)"></select>
  </div>
  <div class="ctl">
    <label>트리거 모드</label>
    <select id="trigmode" onchange="setVal('trigger_mode', this.value)"></select>
  </div>
  <div class="ctl">
    <label>N개 앞서 채우기</label>
    <input type="number" id="keepahead" min="1" max="50" onchange="setVal('keep_ahead_count', +this.value)">
  </div>
  <div class="ctl">
    <label>쿨다운 (초)</label>
    <input type="number" id="cooldown" min="0" max="3600" onchange="setVal('cooldown_sec', +this.value)">
  </div>
  <div class="ctl">
    <label>히스토리 (곡 수)</label>
    <input type="number" id="histwin" min="1" max="200" onchange="setVal('history_window', +this.value)">
  </div>
  <div class="ctl">
    <label>같은 앨범 회피 (N곡)</label>
    <input type="number" id="avalbum" min="0" max="200" onchange="setVal('avoid_same_album_window', +this.value)">
  </div>
  <div class="ctl">
    <label>같은 아티스트 회피 (N곡)</label>
    <input type="number" id="avartist" min="0" max="200" onchange="setVal('avoid_same_artist_window', +this.value)">
  </div>
</div>

<div class="card">
  <div class="sec-title">관리</div>
  <button class="updbtn" id="updbtn" onclick="doUpdate()">🔄 업데이트 확인 / 설치</button>
  <div class="hint" style="margin-top:.6em">업데이트 후 적용하려면 플러그인을 껐다 켜거나 Volumio를 재시작하세요.</div>
</div>

<div class="card">
  <div class="sec-title">재생 대기열 (Queue)</div>
  <div class="qlist" id="qlist"><div class="empty">—</div></div>
</div>

<div class="card">
  <div class="sec-title">👍 좋아요한 곡 <span id="likecount" style="color:#666"></span></div>
  <div class="llist" id="llist"><div class="empty">—</div></div>
</div>

<div class="hint">홈 화면에 추가하면 앱처럼 한 번에 열립니다 (Safari 공유 → 홈 화면에 추가).</div>
<div class="toast" id="toast"></div>

<script>
var ART_BASE = location.protocol + "//" + location.hostname + ":3000";
function artUrl(a){ if(!a) return ""; if(/^https?:\\/\\//.test(a)) return a; return ART_BASE + (a.charAt(0)==="/"?a:"/"+a); }
function esc(s){ return (s||"").replace(/[&<>]/g, function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }); }
function escA(s){ return (s||"").replace(/[&<>"']/g, function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function copyText(t){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(function(){ toast("📋 복사됨"); }, function(){ fallbackCopy(t); });
  } else fallbackCopy(t);
}
function fallbackCopy(t){
  try{
    var ta=document.createElement("textarea");
    ta.value=t; ta.readOnly=false; ta.contentEditable=true;
    ta.style.position="fixed"; ta.style.top="0"; ta.style.left="0"; ta.style.opacity="0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    if(ta.setSelectionRange) ta.setSelectionRange(0, t.length);
    var ok=document.execCommand("copy");
    document.body.removeChild(ta);
    if(ok){ toast("📋 복사됨"); return; }
  }catch(e){}
  window.prompt("주소 복사 (길게 눌러 복사):", t);
}
function copyUri(btn){ copyText(btn.getAttribute("data-uri")||""); }
function toast(m, ms){ var t=document.getElementById("toast"); t.textContent=m; t.classList.add("show"); clearTimeout(t._h); t._h=setTimeout(function(){t.classList.remove("show");}, ms||1600); }
function fmt(s){ s=Math.max(0,Math.floor(s)); var m=Math.floor(s/60), ss=s%60; return m+":"+(ss<10?"0":"")+ss; }

var building=false;
var pbBaseMs=0, pbDurMs=0, pbStatus="stop", pbAt=0;

function fillSelect(el, opts, value){
  if(!el) return;
  if(document.activeElement===el) return; // never disturb an open/focused dropdown
  // Only rebuild <option>s when the option set actually changes (stops the
  // 3s poll from collapsing an open picker and jumping it back to the top).
  var sig=(opts||[]).map(function(o){return o.value;}).join("\\u0001");
  if(el._sig!==sig){
    el.innerHTML="";
    (opts||[]).forEach(function(o){
      var op=document.createElement("option");
      op.value=o.value; op.textContent=o.label;
      el.appendChild(op);
    });
    el._sig=sig;
  }
  if(el.value!==value) el.value=value;
}
function setNum(id, val){ var el=document.getElementById(id); if(el && document.activeElement!==el) el.value=val; }
function setText(id, val){ var el=document.getElementById(id); if(el && document.activeElement!==el) el.value=(val==null?"":val); }

function tickProgress(){
  if(pbDurMs<=0){ document.getElementById("pbfill").style.width="0%"; document.getElementById("pbcur").textContent="0:00"; document.getElementById("pbtot").textContent="0:00"; return; }
  var el = (pbStatus==="play") ? pbBaseMs + (Date.now()-pbAt) : pbBaseMs;
  if(el>pbDurMs) el=pbDurMs;
  document.getElementById("pbfill").style.width=(el/pbDurMs*100)+"%";
  document.getElementById("pbcur").textContent=fmt(el/1000);
  document.getElementById("pbtot").textContent=fmt(pbDurMs/1000);
}

function render(d){
  if(!d || !d.ok) return;
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

  // progress + transport + volume
  var pl=d.player||{status:"stop",volume:null};
  pbBaseMs = d.track ? (d.track.seek||0) : 0;
  pbDurMs  = d.track ? (d.track.duration||0)*1000 : 0;
  pbStatus = pl.status||"stop";
  pbAt = Date.now();
  tickProgress();
  document.getElementById("playbtn").textContent = (pbStatus==="play") ? "⏸" : "▶";
  var vol=document.getElementById("vol"), volval=document.getElementById("volval");
  if(pl.volume===null || pl.volume===undefined){ volval.textContent="--"; }
  else if(document.activeElement!==vol){ vol.value=pl.volume; volval.textContent=pl.volume; }

  // quick settings
  building=true;
  var s=d.settings, o=d.options;
  if(!document.getElementById("enabled").matches(":active")) document.getElementById("enabled").checked=!!s.enabled;
  var emin=document.getElementById("emin"), emax=document.getElementById("emax");
  if(document.activeElement!==emin){ emin.value=s.energy_min; document.getElementById("eminv").textContent=s.energy_min; }
  if(document.activeElement!==emax){ emax.value=s.energy_max; document.getElementById("emaxv").textContent=s.energy_max; }
  fillSelect(document.getElementById("provider"), o.providers, s.llm_provider);
  fillSelect(document.getElementById("model"), (o.models&&o.models[s.llm_provider])||[], s.llm_model);
  document.getElementById("keywarn").style.display = s.has_key ? "none" : "block";

  // prompt-related
  fillSelect(document.getElementById("prompt"), o.prompts, s.prompt_preset_selected);
  fillSelect(document.getElementById("promptsub"), (o.promptSubs&&o.promptSubs[s.prompt_preset_selected])||[], s.prompt_sub_selected);
  fillSelect(document.getElementById("hintpreset"), o.hints, s.hint_preset_selected);
  setText("sysprompt", s.llm_system_prompt);
  setText("hints", s.llm_hints);

  // general
  fillSelect(document.getElementById("source"), o.sources, s.source);
  fillSelect(document.getElementById("trigmode"), o.triggerModes, s.trigger_mode);
  setNum("keepahead", s.keep_ahead_count);
  setNum("cooldown", s.cooldown_sec);
  setNum("histwin", s.history_window);
  setNum("avalbum", s.avoid_same_album_window);
  setNum("avartist", s.avoid_same_artist_window);
  building=false;

  // queue
  var q=document.getElementById("qlist");
  if(!d.queue || !d.queue.length){ q.innerHTML='<div class="empty">대기열이 비어 있습니다.</div>'; }
  else {
    q.innerHTML=d.queue.map(function(it,i){
      var u=artUrl(it.albumart);
      var thumb = u ? '<img src="'+u+'" onerror="this.style.visibility=\\'hidden\\'">' : '<img>';
      var uriLine = it.uri ? '<div class="u">'+esc(it.uri)+'</div>' : '';
      var copyBtn = it.uri ? '<button class="qcopy" title="주소 복사" onclick="event.stopPropagation();copyUri(this)" data-uri="'+escA(it.uri)+'">⧉</button>' : '';
      return '<div class="qrow'+(it.current?' cur':'')+'" onclick="playIdx('+i+')">'+thumb+
        '<div class="qt"><div class="t">'+esc(it.title)+'</div><div class="a">'+esc(it.artist)+'</div>'+uriLine+'</div>'+
        (it.current?'<span class="now">▶</span>':'')+copyBtn+'</div>';
    }).join("");
  }

  // liked songs
  var L=document.getElementById("llist");
  var likes=d.likes||[];
  document.getElementById("likecount").textContent = likes.length ? "("+likes.length+")" : "";
  if(!likes.length){ L.innerHTML='<div class="empty">아직 좋아요한 곡이 없습니다.</div>'; }
  else {
    L.innerHTML=likes.map(function(it){
      return '<div class="lrow"><div>'+esc(it.title)+'</div><div class="a">'+esc(it.artist)+'</div></div>';
    }).join("");
  }
}

function load(){
  // Pause refreshes while the user is actively picking from a dropdown or
  // editing text, so the poll can't collapse the open control.
  var ae=document.activeElement;
  if(ae && (ae.tagName==="SELECT" || ae.tagName==="TEXTAREA")) return;
  fetch("/state").then(function(r){return r.json();}).then(render).catch(function(){});
}

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

var volTimer=null;
function pc(action, value){
  if(action==="volume"){
    document.getElementById("volval").textContent=value;
    clearTimeout(volTimer);
    volTimer=setTimeout(function(){
      fetch("/player?action=volume&value="+encodeURIComponent(value)).then(function(r){return r.json();}).then(render).catch(function(){});
    }, 200);
    return;
  }
  // optimistic play/pause flip
  if(action==="toggle"){ pbStatus=(pbStatus==="play")?"pause":"play"; pbAt=Date.now(); document.getElementById("playbtn").textContent=(pbStatus==="play")?"⏸":"▶"; }
  fetch("/player?action="+encodeURIComponent(action)).then(function(r){return r.json();}).then(render).catch(function(){ toast("오류"); });
}

function playIdx(n){
  toast("▶ 재생…");
  fetch("/player?action=playindex&value="+n).then(function(r){return r.json();}).then(render).catch(function(){ toast("오류"); });
}

function doUpdate(){
  var b=document.getElementById("updbtn");
  b.disabled=true; var old=b.textContent; b.textContent="확인 중…";
  toast("업데이트 확인 중…");
  fetch("/update").then(function(r){return r.json();}).then(function(d){
    toast(d && d.message ? d.message : (d&&d.ok?"완료":"오류"), 7000);
    b.disabled=false; b.textContent=old;
  }).catch(function(){ toast("업데이트 오류"); b.disabled=false; b.textContent=old; });
}

function hit(a){
  toast("…");
  fetch("/"+a).then(function(r){return r.json();}).then(function(d){
    toast({like:"👍 liked",dislike:"👎 disliked",next:"🤖 추천 추가됨"}[a]||"ok");
    render(d);
  }).catch(function(){ toast("오류"); });
}

load();
setInterval(load, 3000);
setInterval(tickProgress, 1000);
</script>
</body></html>`;

module.exports = HttpApi;
