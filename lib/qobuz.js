'use strict';

/**
 * Minimal Qobuz API client (personal-use track downloading).
 *
 * Credential source is pluggable — the same getFileUrl/download path works
 * whether the app_id/secret/auth-token come from:
 *   (a) the already-authenticated Volumio Qobuz plugin on the device, or
 *   (b) a direct email/password login here.
 *
 * Signing scheme follows the well-known qobuz-dl / streamrip approach:
 *   request_sig = md5("trackgetFileUrlformat_id" + fmt + "intentstreamtrack_id" + id + ts + secret)
 *
 * NOTE: This talks to Qobuz's private API. It is for the user's own personal
 * subscription and personal use only (same footing as streamrip, which this
 * project's handoff doc references). Not for distribution.
 */

const crypto = require('crypto');
const fs = require('fs');
const fetch = require('node-fetch');

const API = 'https://www.qobuz.com/api.json/0.2';

// Qobuz rejects requests without a browser-like User-Agent (returns 401).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0';

// Qobuz format_id quality codes.
const FORMAT = { MP3_320: 5, FLAC_16_44: 6, FLAC_24_96: 7, FLAC_24_192: 27 };

function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }

// The exact string that gets md5'd for track/getFileUrl. Exposed for testing.
function fileUrlSigString(trackId, formatId, ts, secret) {
  return 'trackgetFileUrlformat_id' + formatId + 'intentstreamtrack_id' + trackId + ts + secret;
}

const PLAY_BASE = 'https://play.qobuz.com';

/**
 * Scrape the Qobuz web player to obtain the public app_id and candidate
 * app secrets (the qobuz-dl / streamrip "spoofer" technique). Returns
 * { appId, secrets: [...] }. The correct secret is later picked by
 * QobuzClient.pickSecret() via a signed test request.
 *
 * This is the fragile bit — Qobuz occasionally changes the web bundle. If it
 * breaks, app_id/secret can be supplied manually instead.
 */
async function fetchAppConfig() {
  const loginPage = await (await fetch(PLAY_BASE + '/login', { headers: { 'User-Agent': UA } })).text();
  const bundleMatch = loginPage.match(/<script src="(\/resources\/[^"]+\/bundle\.js)"/);
  if (!bundleMatch) throw new Error('Qobuz spoofer: bundle.js URL not found');
  const bundle = await (await fetch(PLAY_BASE + bundleMatch[1], { headers: { 'User-Agent': UA } })).text();

  const appIdMatch = bundle.match(/production:\{api:\{appId:"(\d+)"/);
  if (!appIdMatch) throw new Error('Qobuz spoofer: app_id not found');
  const appId = appIdMatch[1];

  // seed per timezone
  const seedRe = /[a-z]\.initialSeed\("([\w=]+)",window\.utimezone\.([a-z]+)\)/g;
  const parts = {}; // timezone -> [seed]
  let m;
  while ((m = seedRe.exec(bundle))) parts[m[2]] = [m[1]];
  const tzs = Object.keys(parts);
  if (!tzs.length) throw new Error('Qobuz spoofer: no seeds found');

  // info + extras per (capitalized) timezone
  const capTzs = tzs.map((tz) => tz.charAt(0).toUpperCase() + tz.slice(1));
  const infoRe = new RegExp('name:"\\w+/(' + capTzs.join('|') + ')",info:"([\\w=]+)",extras:"([\\w=]+)"', 'g');
  while ((m = infoRe.exec(bundle))) {
    const tz = m[1].toLowerCase();
    if (parts[tz]) parts[tz].push(m[2], m[3]);
  }

  const secrets = [];
  for (const tz of tzs) {
    const joined = parts[tz].join('');
    if (joined.length <= 44) continue;
    try {
      const dec = Buffer.from(joined.slice(0, -44), 'base64').toString('utf-8');
      if (dec && /^[0-9a-f]{32}$/i.test(dec)) secrets.push(dec);
      else if (dec) secrets.push(dec);
    } catch (e) {}
  }
  if (!secrets.length) throw new Error('Qobuz spoofer: no secret candidates decoded');
  return { appId: appId, secrets: secrets };
}


class QobuzClient {
  constructor({ appId, secret, authToken } = {}) {
    this.appId = appId || null;
    this.secret = secret || null;
    this.authToken = authToken || null;
  }

  /** Direct login with email + password. Returns the user_auth_token. */
  async login(email, password) {
    if (!this.appId) throw new Error('Qobuz: appId is required to log in');
    const body = new URLSearchParams({ email: email, password: md5(password), app_id: this.appId });
    const res = await fetch(API + '/user/login', {
      method: 'POST',
      headers: {
        'X-App-Id': this.appId,
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    if (!res.ok) throw new Error('Qobuz login ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const data = await res.json();
    if (!data || !data.user_auth_token) throw new Error('Qobuz login: no user_auth_token in response');
    this.authToken = data.user_auth_token;
    return this.authToken;
  }

  /**
   * Resolve a temporary, signed download URL + metadata for one track.
   * Returns { url, format_id, mime_type, sampling_rate, bit_depth, ... }.
   */
  async getFileUrl(trackId, formatId) {
    if (!this.appId || !this.secret) throw new Error('Qobuz: appId and secret are required');
    if (!this.authToken) throw new Error('Qobuz: not authenticated (login or supply authToken)');
    const ts = Math.floor(Date.now() / 1000);
    const sig = md5(fileUrlSigString(trackId, formatId, ts, this.secret));
    const params = new URLSearchParams({
      request_ts: String(ts),
      request_sig: sig,
      track_id: String(trackId),
      format_id: String(formatId),
      intent: 'stream'
    });
    const res = await fetch(API + '/track/getFileUrl?' + params.toString(), {
      headers: { 'X-App-Id': this.appId, 'X-User-Auth-Token': this.authToken, 'User-Agent': UA }
    });
    if (!res.ok) throw new Error('Qobuz getFileUrl ' + res.status + ': ' + (await res.text()).slice(0, 200));
    return res.json();
  }

  /**
   * Download one track to destPath. onProgress(fraction 0..1) is called when a
   * content-length is known. Returns { path, info }.
   */
  async downloadTrack(trackId, formatId, destPath, onProgress) {
    const info = await this.getFileUrl(trackId, formatId);
    if (!info || !info.url) {
      throw new Error('Qobuz: no download URL (track not streamable at this quality / sub level?)');
    }
    const res = await fetch(info.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error('Qobuz file download ' + res.status);
    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(destPath);
      res.body.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total) onProgress(received / total);
      });
      res.body.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.body.pipe(out);
    });
    return { path: destPath, info: info, bytes: received };
  }

  /**
   * Given candidate secrets and a known track id, find the one whose signature
   * Qobuz accepts (wrong secrets return "Invalid Request Signature"). Requires
   * being logged in. Sets and returns the working secret.
   */
  async pickSecret(candidates, testTrackId, formatId) {
    formatId = formatId || FORMAT.FLAC_24_96;
    let lastErr = null;
    for (const sec of candidates) {
      this.secret = sec;
      try {
        const r = await this.getFileUrl(testTrackId, formatId);
        if (r) return sec; // signature accepted + got a response
      } catch (e) {
        lastErr = e;
        // Wrong secret -> bad signature; anything else means the signature was
        // accepted (e.g. track-specific issue) so this secret is the right one.
        if (!/Invalid Request Signature/i.test(e.message)) return sec;
      }
    }
    this.secret = null;
    throw new Error('Qobuz: no valid app secret found' + (lastErr ? ' (' + lastErr.message + ')' : ''));
  }

  /**
   * One-shot setup: obtain app_id/secret (auto-scrape unless supplied), log in,
   * and validate the secret against testTrackId. After this, getFileUrl/
   * downloadTrack are ready.
   *
   * @param {object} o { email, password, testTrackId, appId?, secret? }
   */
  async init(o) {
    o = o || {};
    let candidates;
    if (o.appId && o.secret) {
      this.appId = o.appId;
      candidates = [o.secret];
    } else {
      const cfg = await fetchAppConfig();
      this.appId = o.appId || cfg.appId;
      candidates = o.secret ? [o.secret] : cfg.secrets;
    }
    await this.login(o.email, o.password);
    this.secret = null;
    await this.pickSecret(candidates, o.testTrackId);
    return { appId: this.appId, secretFound: !!this.secret };
  }
}

module.exports = { QobuzClient, FORMAT, fetchAppConfig, fileUrlSigString, md5 };
