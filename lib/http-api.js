'use strict';

const http = require('http');
const url = require('url');

/**
 * Tiny HTTP server that exposes the plugin's feedback actions over plain HTTP.
 *
 * Routes (all GET for easy bookmarking, POST also accepted):
 *   GET /          → landing HTML with Like/Dislike/Next buttons
 *   GET /like      → call plugin.likeCurrent()
 *   GET /dislike   → call plugin.dislikeCurrent()
 *   GET /next      → call plugin.triggerManual()  (pick next track now)
 *   GET /status    → return current track + feedback counts as JSON
 *
 * All responses include permissive CORS so a bookmarklet in any site can call
 * them. No auth — designed for local-network use only.
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
      if (path === '/like')     return this._runAndReply(res, 'likeCurrent');
      if (path === '/dislike')  return this._runAndReply(res, 'dislikeCurrent');
      if (path === '/next')     return this._runAndReply(res, 'triggerManual');
      if (path === '/status')   return this._status(res);
      this._json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      this.logger.error('[ai_autopilot] HTTP handler error: ' + e.message);
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  _runAndReply(res, methodName) {
    if (typeof this.plugin[methodName] !== 'function') {
      return this._json(res, 500, { ok: false, error: 'method missing: ' + methodName });
    }
    Promise.resolve()
      .then(() => this.plugin[methodName]())
      .then(() => this._status(res))
      .catch((err) => this._json(res, 500, { ok: false, error: err.message || String(err) }));
  }

  _status(res) {
    const plugin = this.plugin;
    let state = null;
    try {
      state = plugin.commandRouter.volumioGetState();
    } catch (e) {}
    const track = state && state.uri ? {
      title: state.title, artist: state.artist, album: state.album,
      uri: state.uri, service: state.service
    } : null;
    let counts = { likes: 0, dislikes: 0 };
    if (plugin.feedback) {
      const snap = plugin.feedback.snapshot({ maxLikes: 1000, maxDislikes: 1000 });
      counts = { likes: snap.likes.length, dislikes: snap.dislikes.length };
    }
    this._json(res, 200, { ok: true, track, counts });
  }

  _serveLanding(res) {
    const html =
      '<!DOCTYPE html>' +
      '<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>AI Autopilot</title>' +
      '<style>' +
      'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#1a1a1a;color:#eee;' +
      'margin:0;padding:1.2em;-webkit-user-select:none;user-select:none}' +
      'h1{font-size:1.1em;margin:0 0 .8em 0;color:#888}' +
      '.track{background:#222;padding:1em;border-radius:8px;margin-bottom:1em;min-height:3em}' +
      '.title{font-size:1.1em;font-weight:600}' +
      '.meta{color:#aaa;margin-top:.3em}' +
      '.row{display:flex;gap:.5em;margin-top:.5em}' +
      'button{flex:1;padding:1.1em;font-size:1.2em;border:none;border-radius:8px;cursor:pointer;' +
      'color:#fff;font-weight:600}' +
      '.like{background:#2a8f3a}.dislike{background:#8f2a2a}.next{background:#3a6a8f}' +
      '.small{font-size:.85em;color:#888;margin-top:1em;text-align:center}' +
      '.toast{position:fixed;bottom:1em;left:1em;right:1em;background:#333;padding:.8em;' +
      'border-radius:6px;opacity:0;transition:opacity .2s;text-align:center}' +
      '.toast.show{opacity:1}' +
      '</style></head><body>' +
      '<h1>AI Autopilot</h1>' +
      '<div class="track" id="t"><div class="title" id="title">—</div><div class="meta" id="meta"></div></div>' +
      '<div class="row">' +
        '<button class="like"    onclick="hit(\'like\')">👍 Like</button>' +
        '<button class="dislike" onclick="hit(\'dislike\')">👎 Dislike</button>' +
      '</div>' +
      '<div class="row">' +
        '<button class="next"    onclick="hit(\'next\')">⏭ Pick next now</button>' +
      '</div>' +
      '<div class="small">Add to Home Screen (iOS Safari ⎯ Share → Add to Home Screen) for one-tap access.</div>' +
      '<div class="toast" id="toast"></div>' +
      '<script>' +
      'function toast(m){var t=document.getElementById("toast");t.textContent=m;t.classList.add("show");setTimeout(function(){t.classList.remove("show")},1600)}' +
      'function fillState(d){if(!d||!d.track){document.getElementById("title").textContent="(nothing playing)";document.getElementById("meta").textContent=""}else{document.getElementById("title").textContent=d.track.title||"";document.getElementById("meta").textContent=(d.track.artist||"")+(d.track.album?" — "+d.track.album:"")+" · 👍 "+d.counts.likes+" 👎 "+d.counts.dislikes}}' +
      'function refresh(){fetch("/status").then(function(r){return r.json()}).then(fillState).catch(function(){})}' +
      'function hit(a){toast("…");fetch("/"+a).then(function(r){return r.json()}).then(function(d){toast({like:"👍 liked",dislike:"👎 disliked",next:"⏭ queued"}[a]);fillState(d)}).catch(function(e){toast("error")})}' +
      'refresh();setInterval(refresh,3000);' +
      '</script></body></html>';
    this._cors(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}

module.exports = HttpApi;
