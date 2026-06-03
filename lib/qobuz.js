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

// Qobuz format_id quality codes.
const FORMAT = { MP3_320: 5, FLAC_16_44: 6, FLAC_24_96: 7, FLAC_24_192: 27 };

function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }

// The exact string that gets md5'd for track/getFileUrl. Exposed for testing.
function fileUrlSigString(trackId, formatId, ts, secret) {
  return 'trackgetFileUrlformat_id' + formatId + 'intentstreamtrack_id' + trackId + ts + secret;
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
    const params = new URLSearchParams({ email: email, password: md5(password), app_id: this.appId });
    const res = await fetch(API + '/user/login?' + params.toString(), {
      headers: { 'X-App-Id': this.appId }
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
      headers: { 'X-App-Id': this.appId, 'X-User-Auth-Token': this.authToken }
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
    const res = await fetch(info.url);
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
}

module.exports = { QobuzClient, FORMAT, fileUrlSigString, md5 };
