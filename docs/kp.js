/*!
 * kp.js — kinopub source plugin for Lampa
 *
 * Author: mainsync-afk
 * Repo:   https://github.com/mainsync-afk/lampa_kinopub
 * URL:    https://mainsync-afk.github.io/lampa_kinopub/kp.js
 *
 * Targets: Samsung Tizen (primary), webOS, Android, browser.
 * Plays through Lampa's built-in HTML5 player and Tizen AVPlayer.
 *
 * Logs are streamed to a remote log-server (see log-server/server.js)
 * when its URL is set in plugin settings.
 */
(function () {
  'use strict';

  if (window.online_kp_plugin) {
    console.warn('[KP:boot] another online_kp plugin is already active; remove duplicate extensions and fully restart Lampa');
    return;
  }
  if (typeof Lampa === 'undefined' || !Lampa.Manifest) return;
  if (Lampa.Manifest.app_digital && Lampa.Manifest.app_digital < 155) return;
  window.online_kp_plugin = true;

  /* ============================================================ *
   *  CONSTANTS                                                   *
   * ============================================================ */

  var PLUGIN_VERSION  = '1.0.73-mx.12';
  // Public manifest-proxy URL — set near KP_PROXY_URL declaration below.
  var COMPONENT_NAME  = 'online_kp';
  var BALANSER        = 'kpapi';

  // ── DIAGNOSTIC: BARE PLAYBACK MODE ────────────────────────────────────
  // When true, strips voice-track manipulation (applyVoiceTrack, MutationObserver
  // on player-panel, play.voiceovers single entry, pendingVoice, play.translate).
  // Used in v1.0.22-bare to isolate the cause of 4K crashes — diagnosis
  // confirmed the issue was HLS4 multi-track demux on Tizen AVPlayer, not
  // our hooks. Flag kept for future diagnostic use; default false in production.
  var KP_BARE_MODE = false;

  // ── BLOB-TEST mode (legacy) — kept for diagnostics, default false. ────
  // v1.0.29-blob-test/data-test confirmed Tizen AVPlayer rejects both blob:
  // and data:application/vnd.apple.mpegurl URI schemes for HLS masters.
  // Replaced by KP_PROXY_MODE which routes through public manifest-proxy.
  var KP_BLOB_TEST = false;

  // ── HLS4 MANIFEST PROXY (production solution from v1.0.30) ─────────────
  // Plugin pings KP_PROXY_URL/health on startup. Availability is separate
  // from policy: only compatible Tizen launches in auto/HLS4 use the proxy.
  // Otherwise falls back to v1.0.28 behaviour (HLS2 stable but voice
  // picker decorative).
  //
  // Why this is needed: kinopub HLS4 master has 12 audio renditions × 4
  // quality groups + 7 subtitles. Tizen 9.0 native AVPlayer hangs on
  // master parse at 4K (state=PLAYING but no frames; black screen with
  // infinite loading). The proxy fetches that master, builds a reduced
  // version with 1 audio + 1 video stream-inf, returns it. Player sees
  // same demux load as HLS2 single-audio = stable. URLs INSIDE the
  // reduced master point at kinopub CDN, so video/audio segments are
  // still fetched directly — proxy only handles the master itself.
  //
  // Public proxy on Eugene's VPS (mirror of lampac architecture):
  //   GET https://kinopub.fastcdn.pics/manifest-proxy?master=<encoded>&voice=<N>
  // Source: github.com/mainsync-afk/lampa_kinopub /proxy-server/
  var KP_PROXY_URL = 'https://kinopub.fastcdn.pics';

  // Set by checkProxyAvailability() at startup; gates voice switching.
  // null  — not yet checked
  // true  — health endpoint responded; playback policy still decides usage
  // false — unreachable, fall back to HLS2-only mode
  var kpProxyAvailable = null;

  // v1.0.66: voice-sync state. kpUserId is the kinopub username (extracted
  // from /v1/user response); used as namespace key in VPS voice-sync store.
  // No auth — personal use only. Pull on full/complite, push debounced on
  // every voice change. Fail-soft: if VPS unreachable, plugin works locally.
  var kpUserId = null;
  var kpVoiceSyncDebounce = {};
  var KP_VOICE_SYNC_DEBOUNCE_MS = 2000;

  // OAuth credentials of the public xbmc/Kodi-style client used by
  // virtually every unofficial kinopub client. Documented in many
  // open-source projects (kodi.kino.pub, kinopub.webos, etc).
  var CLIENT_ID       = 'xbmc';
  var CLIENT_SECRET   = 'cgg3gtifu46urtfp2zp1nqtba0k2ezxh';

  var API_HOST        = 'https://api.service-kp.com';
  var DEVICE_PAGE     = 'https://kino.pub/device';

  // Storage keys
  var KEY_TOKEN       = 'kp_token';
  var KEY_REFRESH     = 'kp_refresh';
  var KEY_LOG_URL     = 'kp_log_url';
  var KEY_MAX_QUAL    = 'kp_max_quality';
  var KEY_FORMAT      = 'kp_format';
  var KEY_PROXY       = 'kp_proxy';
  var KEY_SUBS        = 'kp_subtitles_enabled';
  var KEY_LAUNCH_TRACE = 'kp_launch_trace';
  // Kept only in this JS session, never in storage or a remote diagnostic.
  var lastInfuseAttempt = null;

  // Opt-in, bounded, session-local observations. Equality labels are assigned
  // by exact string comparison, not reversible URL hashes. Nothing is sent to
  // Logger/storage/server; disabling clears even the private equality table.
  var LaunchTrace = (function () {
    var attempts = [], identities = [], sequence = 0, identitySequence = 0;
    var session = Math.random().toString(36).slice(2, 8);
    function now() {
      return window.performance && window.performance.now ? window.performance.now() : Date.now();
    }
    function elapsed(at) { return Math.max(0, Math.round(now() - at)); }
    function clear() { attempts = []; identities = []; }
    function enabled() {
      if (!Lampa.Storage.get(KEY_LAUNCH_TRACE, false)) { clear(); return false; }
      return Lampa.Platform.is('apple_tv') || Lampa.Platform.is('apple');
    }
    function active(trace) { return trace && enabled() && attempts.indexOf(trace) !== -1; }
    function label(value, type) {
      if (!value) return null;
      var found = identities.find(function (entry) { return entry.type === type && entry.value === value; });
      if (found) return found.label;
      var id = type + (++identitySequence);
      identities.push({ type: type, value: value, label: id });
      if (identities.length > 64) identities.shift();
      return id;
    }
    function start(player, item, raw) {
      if (!enabled()) return null;
      if (player === 'tvosselect') player = 'tvosSelect';
      if (player === 'lampa') player = 'inner';
      if (['tvospro', 'tvos', 'tvosl', 'tvosSelect', 'vlc', 'infuse', 'senplayer', 'vidhub', 'inner', 'svplayer'].indexOf(player) === -1) player = 'other';
      var trace = { at: now(), data: {
        attempt: ++sequence, session: session, player: player,
        kp_id: numberValue(raw && raw.id), year: numberValue(raw && raw.year),
        season: numberValue(item.season), episode: numberValue(item.episode),
        status: 'preparing', item_ms: null, build_ms: null, link_ms: null, prepare_ms: null, dispatch_ms: null
      } };
      attempts.push(trace);
      if (attempts.length > 8) attempts.shift();
      return trace;
    }
    function selected(trace, stream) {
      if (!active(trace)) return;
      trace.data.file = label(stream.file, 'F');
      trace.data.quality = stream.currentQuality;
      trace.data.delivery = stream.delivery || null;
      trace.data.input = label(stream.url, 'U');
      // This is an extension hint, never proof of the container or codec.
      var extension = /\.(mp4|mkv|m4v|mov|ts)$/i.exec(stream.file || '');
      trace.data.extension_hint = extension ? extension[1].toLowerCase() : null;
    }
    function endStage(trace) {
      if (trace.stage) { trace.data[trace.stage + '_ms'] = elapsed(trace.stageAt); trace.stage = null; }
    }
    function stage(trace, name) {
      if (!active(trace)) return;
      endStage(trace);
      trace.stage = name;
      trace.stageAt = now();
    }
    function ready(trace, play) {
      if (!active(trace)) return;
      endStage(trace);
      // Older item metadata can omit file and gain it during the refresh.
      // Report the final selected file, not the incomplete pre-refresh hint.
      if (play._kpInfuse) {
        trace.data.file = label(play._kpFile, 'F');
        trace.data.quality = play._kpQuality;
        var extension = /\.(mp4|mkv|m4v|mov|ts)$/i.exec(play._kpFile || '');
        trace.data.extension_hint = extension ? extension[1].toLowerCase() : null;
      }
      trace.readyAt = now();
      trace.data.prepare_ms = elapsed(trace.at);
      trace.data.output = label(play.url, 'U');
      trace.data.resource = resourceInfo(play.url);
      trace.data.position = play.timeline && isFinite(Number(play.timeline.time)) ? Number(play.timeline.time) : null;
    }
    function sent(trace, boundary, entries) {
      if (!active(trace)) return;
      trace.data.dispatch_ms = trace.readyAt == null ? null : elapsed(trace.readyAt);
      trace.data.boundary = boundary;
      trace.data.entries = entries;
      trace.data.status = 'submitted';
    }
    function fail(trace, reason, status) {
      if (!active(trace)) return;
      trace.data.error_stage = trace.stage || (trace.data.boundary ? 'dispatch' : 'selection');
      endStage(trace);
      trace.data.status = reason;
      trace.data.http_status = numberValue(status);
      trace.data.elapsed_ms = elapsed(trace.at);
    }
    function snapshot() {
      if (!enabled()) return [];
      return JSON.parse(JSON.stringify(attempts.map(function (trace) { return trace.data; })));
    }
    function show() {
      var records = snapshot();
      if (!records.length) { Lampa.Noty.show(Lampa.Lang.translate('kp_trace_empty')); return; }
      var controller = Lampa.Controller.enabled().name;
      function back() { Lampa.Controller.toggle(controller); }
      function value(v) { return v == null ? '?' : v; }
      function menu() {
        Lampa.Select.show({ title: Lampa.Lang.translate('kp_trace_report'),
          items: records.slice().reverse().map(function (r) {
            return { title: '#' + r.attempt + ' ' + r.player + ' / ' + value(r.quality) + 'p / ' + value(r.delivery),
              subtitle: 'KP ' + value(r.kp_id) + ' / ' + value(r.file) + ' / ' + value(r.output) + ' / ' + r.status,
              record: r };
          }), onBack: back, onSelect: function (entry) {
            var r = entry.record;
            var text = 'KinoPub ' + PLUGIN_VERSION + ' / Lampa ' + (Lampa.Manifest.app_digital || '?') +
              '\nsession: ' + r.session + ' / #' + r.attempt + ' / ' + r.player +
              '\nKP: ' + value(r.kp_id) + ' / year: ' + value(r.year) + ' / S:' + value(r.season) + ' E:' + value(r.episode) +
              '\n' + value(r.quality) + 'p / ' + value(r.delivery) + ' / file: ' + value(r.file) +
              '\ninput: ' + value(r.input) + ' / output: ' + value(r.output) +
              '\nhost: ' + value(r.resource && r.resource.host) + ' / extension_hint: ' + value(r.extension_hint) +
              '\nitem_ms: ' + value(r.item_ms) + ' / link_ms: ' + value(r.link_ms) + ' / build_ms: ' + value(r.build_ms) +
              '\nprepare_ms: ' + value(r.prepare_ms) + ' / dispatch_ms: ' + value(r.dispatch_ms) +
              '\nstatus: ' + r.status + ' / boundary: ' + value(r.boundary) +
              '\nposition: ' + value(r.position) + ' s / entries: ' + value(r.entries) +
              (r.error_stage ? '\nerror_stage: ' + r.error_stage + ' / HTTP: ' + value(r.http_status) + ' / elapsed_ms: ' + value(r.elapsed_ms) : '') +
              '\n\n' + Lampa.Lang.translate('kp_trace_limits') + '\n\n' + Lampa.Lang.translate('kp_trace_fields');
            Lampa.Modal.open({ title: '#' + r.attempt + ' ' + r.player, size: 'large',
              html: $('<div></div>').css({ 'white-space': 'pre-wrap', 'font-size': '0.8em' }).text(text),
              onBack: function () { Lampa.Modal.close(); menu(); } });
          } });
      }
      menu();
    }
    return { start: start, selected: selected, stage: stage, ready: ready, sent: sent,
      fail: fail, snapshot: snapshot, clear: clear, show: show };
  })();

  // Never log URL paths: KinoPub can carry the credential in the path as
  // well as the query. This affects diagnostics only, never the media URL.
  function redactDiagnostic(value, key) {
    if (/token|secret|authorization|cookie|device_code|refresh|^code$/i.test(key || '')) return '[redacted]';
    if (/^(body|responseText|keep|master|path|stack)$/i.test(key || '')) return '[redacted]';
    if (typeof value === 'string') {
      if (/^(url|src|file|failedUrl)$/i.test(key || '')) return resourceInfo(value);
      return value.replace(/(?:https?|infuse|blob|data)(?:%3a|%253a)[^\s"'<>]+/gi, '[redacted-url]')
        .replace(/(?:https?|infuse|blob|data):[^\s"'<>]+/gi, function (url) {
        var info = resourceInfo(url);
        return info.host ? info.scheme + '://' + info.host + '/[redacted]' : '[redacted-url]';
      }).replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
        .replace(/((?:access_token|refresh_token|token|signature|sig|secret|cookie)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
    }
    if (Array.isArray(value)) return value.map(function (v) { return redactDiagnostic(v); });
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) { out[k] = redactDiagnostic(value[k], k); });
      return out;
    }
    return value;
  }

  function redactConsole(value) {
    try { return redactDiagnostic(JSON.parse(JSON.stringify(value))); }
    catch (e) { return '[unserializable]'; }
  }

  function resourceInfo(url) {
    var info = { scheme: '', host: '', kind_hint: 'unknown' };
    if (typeof url !== 'string') return info;
    try {
      var parsed = new URL(url);
      info.scheme = parsed.protocol.replace(':', '');
      info.host = parsed.hostname;
      info.kind_hint = /\.m3u8(?:$|\/)/i.test(parsed.pathname) ? 'manifest-extension' :
        /\.(mp4|mkv|mov|m4v|ts)$/i.test(parsed.pathname) ? 'file-extension' : 'unknown';
      if (url.indexOf(KP_PROXY_URL + '/manifest-proxy?') === 0) info.kind_hint = 'manifest-proxy-path';
    } catch (e) {}
    return info;
  }

  function mediaUrl(value) {
    // Do not reserialize, decode, upgrade http, or rewrite a signed URL.
    return typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value) ? value : null;
  }

  function infuseFileUrl(value) {
    if (!mediaUrl(value)) return null;
    // A file field is not proof of the response's type. Reject recognisable
    // manifest/reducer URLs; leave opaque signed file URLs byte-for-byte intact.
    var path = value.split('?')[0].split('#')[0];
    if (/\.(m3u8|mpd)$/i.test(path) || /\/(hls(?:2|4)?|manifest-proxy)(?:\/|$)/i.test(path)) return null;
    return value;
  }

  function numberValue(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    var text = String(value).trim();
    if (!/^\d+$/.test(text)) return null;
    var n = Number(text);
    return isFinite(n) && n >= 0 && n <= 2147483647 ? n : null;
  }

  function infuseHls2TestUrl(value) {
    if (!mediaUrl(value)) return null;
    // Only urls.hls2 or a type=hls2 resolver may supply this test resource.
    // KinoPub documents HLS URLs ending in .mp4 too: never rewrite the path.
    var path = value.split('?')[0].split('#')[0];
    if (/\.mpd$/i.test(path) || /\/(http|hls|hls4|manifest-proxy)(?:\/|$)/i.test(path)) return null;
    return value;
  }

  function thumbnailUrl(value) {
    // String is confirmed by kinoapi.com and the bundled Kodi fixtures.
    // An explicit {url: string} is accepted defensively; it is NOT claimed
    // to be the live shape of the user's unavailable KinoPub response.
    if (value && typeof value === 'object' && !Array.isArray(value)) value = value.url;
    if (typeof value !== 'string') return null;
    value = value.trim();
    if (/^\/media\/thumbnail\/[^\s]+$/i.test(value)) value = 'https://kino.pub' + value;
    return mediaUrl(value);
  }

  function tmdbStillUrl(path) {
    if (typeof path !== 'string' || !/^\/(?!\/)[^\s]+$/.test(path) || /^\/(null|undefined)$/i.test(path)) return null;
    return mediaUrl(Lampa.TMDB.image('t/p/w300' + path));
  }

  function episodeImages(episode, thumb) {
    var urls = [tmdbStillUrl(episode && episode.still_path), thumbnailUrl(thumb)];
    return urls.filter(function (url, i) { return !!url && urls.indexOf(url) === i; });
  }

  function tmdbSeriesId(movie, source) {
    var explicit = numberValue(movie && movie.tmdb_id);
    if (explicit) return explicit;
    if (!movie || (movie.source && movie.source !== 'tmdb') || (source && source !== 'tmdb')) return null;
    return movie.name && (movie.original_name || movie.first_air_date || movie.media_type === 'tv')
      ? numberValue(movie.id) : null;
  }

  function sameSeries(item, movie) {
    if (!item || !movie) return false;
    var imdb = movie.imdb_id || movie.external_ids && movie.external_ids.imdb_id;
    if (imdb && item.imdb) return String(imdb).replace(/^tt/, '') === String(item.imdb).replace(/^tt/, '');
    var titles = splitKpTitle(item.title);
    var matches = (movie.original_name && normalize(movie.original_name) === normalize(titles.orig)) ||
      (movie.name && normalize(movie.name) === normalize(titles.rus));
    var year = Number(String(movie.first_air_date || '').slice(0, 4));
    return !!matches && (!year || !item.year || Math.abs(year - Number(item.year)) <= 1);
  }

  function findEpisode(episodes, season, episode) {
    season = numberValue(season);
    episode = numberValue(episode);
    if (season === null || episode === null) return null;
    return (episodes || []).find(function (e) {
      return numberValue(e.episode_number) === episode &&
        (e.season_number == null || numberValue(e.season_number) === season);
    }) || null;
  }

  // Two candidates, one attempt each, five seconds each. Detached Image
  // objects keep late events from an old request off the current DOM node.
  function loadImageCandidates(target, candidates, complete, isCurrent) {
    var stopped = false, active = null, timer = null, index = 0;
    function current() { return !stopped && (!isCurrent || isCurrent()); }
    function cleanup() {
      clearTimeout(timer);
      timer = null;
      if (active) {
        active.onload = active.onerror = null;
        if (active.removeAttribute) active.removeAttribute('src');
        active = null;
      }
    }
    function next() {
      cleanup();
      if (!current()) return;
      if (index >= Math.min(2, candidates.length)) { complete(false); return; }
      var url = candidates[index++];
      var request = active = new Image();
      request.onload = function () {
        if (!current() || active !== request) return;
        clearTimeout(timer); timer = null;
        request.onload = request.onerror = null;
        active = null;
        target.src = url;
        complete(true);
      };
      request.onerror = function () { if (current() && active === request) next(); };
      timer = setTimeout(function () { if (current() && active === request) next(); }, 5000);
      request.src = url;
    }
    next();
    return function () { stopped = true; cleanup(); };
  }

  // Infuse 8.4.7+: repeated url/position/filename/sub groups, once-encoded.
  // No guessed Lampa MX callback scheme and no undocumented playlist=.
  function buildInfuseUrl(play) {
    // Experimental HLS2 is one selected video, never a mixed/season playlist.
    var list = !play._kpInfuseHls2Test && Array.isArray(play.playlist) && play.playlist.length ? play.playlist : [play];
    var start = list.indexOf(play);
    if (start < 0) start = list.findIndex(function (p) { return p && p.url === play.url; });
    if (start < 0) list = [play];
    if (start > 0) list = list.slice(start);
    var query = [];
    var full = false;
    list.slice(0, 40).forEach(function (p, index) {
      if (full) return;
      if (!p || !p._kpInfuse || !!p._kpInfuseHls2Test !== !!play._kpInfuseHls2Test ||
          !(p._kpInfuseHls2Test ? infuseHls2TestUrl(p.url) : infuseFileUrl(p.url))) { full = true; return; }
      var position = p.timeline && Number(p.timeline.time);
      var part = 'url=' + encodeURIComponent(p.url) +
        '&position=' + (isFinite(position) && position > 0 ? Math.floor(position) : 0);
      if (p.filename || p.title) part += '&filename=' + encodeURIComponent(p.filename || p.title);
      var subs = p.subtitles || [];
      for (var i = 0; i < subs.length; i++) {
        if (mediaUrl(subs[i].url)) { part += '&sub=' + encodeURIComponent(subs[i].url); break; }
      }
      // Keep the selected item even if later episodes exceed the limit.
      if (query.join('&').length + part.length + 32 <= 65536) query.push(part);
      else full = true;
    });
    return query.length ? 'infuse://x-callback-url/play?' + query.join('&') : null;
  }

  function dispatchInfuse(play, trace) {
    var url = buildInfuseUrl(play);
    if (!url) { LaunchTrace.fail(trace, 'rejected'); Logger.warn('infuse', 'handoff rejected'); return false; }
    pendingVoice = null;
    currentVoiceLabel = '';
    // Same scheme dispatch used by Lampa's external adapter. Its current
    // normalizePlayData rewrites &preload, so it cannot preserve KP signatures.
    try {
      lastInfuseAttempt = { url: play.url, at: Date.now(), quality: play._kpQuality,
        delivery: play._kpInfuseHls2Test ? 'hls2-test' : 'http',
        prepareMs: play._kpPrepareMs,
        handoffMs: play._kpLinkReadyAt == null ? null : Math.max(0, Date.now() - play._kpLinkReadyAt) };
      LaunchTrace.sent(trace, 'window.location.assign', url.split('&url=').length);
      window.location.assign(url);
      Logger.info('infuse', 'handoff dispatched (playback unconfirmed)', {
        resource: resourceInfo(play.url), deliveryField: play._kpInfuseHls2Test ? 'hls2-test' : 'http', quality: play._kpQuality,
        entries: play._kpInfuseHls2Test ? 1 : (play.playlist || [play]).length, callbacks: false
      });
      return true;
    } catch (e) {
      LaunchTrace.fail(trace, 'dispatch-error');
      Logger.error('infuse', 'handoff failed', { error: String(e) });
      Lampa.Noty.show(Lampa.Lang.translate('kp_infuse_handoff_error'));
      return false;
    }
  }

  // Byte counts must not use numberValue's 32-bit episode/id limit.
  function probeNumber(value) {
    return /^\d+$/.test(String(value)) && Number(value) <= 9007199254740991 ? Number(value) : null;
  }

  function parseProbeRange(value) {
    var match = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i.exec(value || '');
    if (!match) return null;
    var total = match[3] === '*' ? null : probeNumber(match[3]);
    if (match[3] !== '*' && total === null) return null;
    if (!match[1]) return total === null ? null : { total: total, unsatisfied: true };
    var start = probeNumber(match[1]), end = probeNumber(match[2]);
    if (start === null || end === null || end < start || (total !== null && end >= total)) return null;
    return { start: start, end: end, total: total };
  }

  // "headers-match" is deliberately not a claim about received bytes/speed.
  function probeRangeVerdict(result, request, size) {
    if (result.status === 401 || result.status === 403) return 'authorization';
    if (result.status === 200) return 'range-ignored';
    var range = parseProbeRange(result.range);
    if (result.status === 416) {
      if (!range || !range.unsatisfied) return 'unknown-range';
      if (size !== null && range.total !== size) return 'size-changed';
      return range.total === 0 || (request.start != null && request.start >= range.total)
        ? 'unsatisfiable' : 'rejected-range';
    }
    if (result.status !== 206) return 'http-error';
    if (!result.range) return 'unknown-range'; // Missing OR CORS-hidden, never guess which.
    if (!range || range.unsatisfied) return 'invalid-range';
    if (size !== null && range.total !== null && size !== range.total) return 'size-changed';
    var total = range.total === null ? size : range.total;
    if (request.suffix && total === null) return 'unknown-range';
    var start = request.suffix ? Math.max(0, total - request.suffix) : request.start;
    var end = request.suffix || request.end == null ? (total === null ? null : total - 1) :
      (total === null ? request.end : Math.min(request.end, total - 1));
    if (range.start !== start || (end !== null && range.end > end)) return 'invalid-range';
    if (result.length != null && probeNumber(result.length) !== range.end - range.start + 1) return 'invalid-range';
    // RFC 9110 permits sending only a portion. Do not mislabel that as full
    // coverage, or as proof that the server cannot seek.
    return end === null || range.end < end ? 'headers-partial' : 'headers-match';
  }

  // Manual only: HEAD, start, middle, open-ended middle and suffix. At most
  // five fetches, six seconds each, no retries. Do NOT read any browser body:
  // stream chunk sizes are not controllable here. Abort even 200/error bodies.
  // The separate CLI probe can read at most 1 KiB per validated range.
  function probeInfuseResource(url, complete) {
    var stopped = false, controller = null, timer = null, results = [], size = null;
    var queue = [{ method: 'HEAD' }, { method: 'GET', start: 0, end: 1023 }];
    function cancel() {
      stopped = true;
      clearTimeout(timer);
      if (controller) controller.abort();
    }
    if (!infuseFileUrl(url) || !window.fetch || !window.AbortController) {
      complete([{ error: 'unsupported' }]);
      return cancel;
    }
    function run() {
      if (stopped) return;
      var request = queue.shift(), method = request.method;
      var requested = method === 'HEAD' ? null : 'bytes=' + (request.suffix ? '-' + request.suffix :
        request.start + '-' + (request.end == null ? '' : request.end));
      var started = Date.now(), settled = false;
      var current = controller = new window.AbortController();
      function finish(result) {
        if (settled || stopped) return;
        settled = true;
        clearTimeout(timer);
        current.abort();
        result.method = method;
        result.requested = requested;
        result.ms = Date.now() - started;
        result.bytesRead = 0;
        result.bodyChecked = false;
        if (!result.error && method === 'GET') result.verdict = probeRangeVerdict(result, request, size);
        results.push(result);
        var range = parseProbeRange(result.range);
        var encoded = result.encoding && result.encoding !== 'identity';
        var errorType = /^(text\/html|application\/(json|vnd\.apple\.mpegurl|x-mpegurl))$/i.test(result.type || '');
        if (!encoded && !errorType && method === 'HEAD' && result.status === 200) size = probeNumber(result.length);
        if (!encoded && method === 'GET' && request.start === 0 && result.status === 206 &&
            range && !range.unsatisfied && range.start === 0 && range.total !== null &&
            (result.verdict === 'headers-match' || result.verdict === 'headers-partial')) size = range.total;
        if (method === 'GET' && request.start === 0) {
          // The screenshot offset is NOT reused for a different file.
          if (size > 1 && !encoded && result.verdict !== 'size-changed') {
            var middle = Math.floor(size / 2);
            queue.push({ method: 'GET', start: middle, end: Math.min(size - 1, middle + 1023) });
            queue.push({ method: 'GET', start: middle });
          }
          queue.push({ method: 'GET', suffix: 1024 });
        }
        // Auth/error-page responses and a changed representation need a new
        // ordinary launch, not repeated requests to the same unusable link.
        // Some CDNs forbid HEAD while allowing GET. Always try the first
        // bounded GET before treating access denial as terminal.
        if (method === 'GET' && (result.status === 401 || result.status === 403 || result.status === 404 ||
            result.status === 410 || errorType || result.verdict === 'size-changed')) queue = [];
        if (queue.length) run();
        else { stopped = true; complete(results); }
      }
      timer = setTimeout(function () { finish({ error: 'timeout' }); }, 6000);
      var options = { method: method, credentials: 'omit', cache: 'no-store',
        redirect: 'follow', signal: current.signal };
      if (method === 'GET') options.headers = { Range: requested };
      try {
        window.fetch(url, options).then(function (response) {
          // Do not read a response body or log exception/response text.
          if (response.body && response.body.cancel) response.body.cancel().catch(function () {});
          if (stopped || settled) return;
          function header(name, pattern) {
            var value = response.headers.get(name);
            return !value ? null : pattern.test(value) ? value : 'invalid';
          }
          var type = (response.headers.get('Content-Type') || '').split(';')[0].trim();
          finish({ status: response.status, host: resourceInfo(response.url).host,
            redirected: !!response.redirected,
            type: /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : null,
            length: header('Content-Length', /^\d+$/),
            range: header('Content-Range', /^bytes (?:\d+-\d+|\*)\/(?:\d+|\*)$/i),
            acceptRanges: header('Accept-Ranges', /^(bytes|none)$/i),
            encoding: header('Content-Encoding', /^[a-z0-9-]{1,32}$/i) });
        }, function () { finish({ error: 'network-or-cors' }); });
      } catch (e) { finish({ error: 'unsupported' }); }
    }
    run();
    return cancel;
  }

  function showInfuseDiagnostic() {
    if (!lastInfuseAttempt) { Lampa.Noty.show(Lampa.Lang.translate('kp_infuse_check_empty')); return; }
    var attempt = lastInfuseAttempt;
    var enabled = Lampa.Controller.enabled().name;
    var body = $('<div></div>').css({ 'white-space': 'pre-wrap', 'font-size': '0.8em' });
    var summary = 'KinoPub ' + PLUGIN_VERSION + ' / Lampa ' + (Lampa.Manifest.app_digital || '?') +
      '\n' + resourceInfo(attempt.url).host + ' / ' + (attempt.quality || '?') + 'p' +
      '\nDelivery: ' + attempt.delivery +
      '\n' + Lampa.Lang.translate('kp_infuse_prepare') + ': ' + (attempt.prepareMs == null ? '?' : attempt.prepareMs) + ' ms' +
      '\n' + Lampa.Lang.translate('kp_infuse_dispatch_time') + ': ' + (attempt.handoffMs == null ? '?' : attempt.handoffMs) + ' ms' +
      '\n' + Lampa.Lang.translate('kp_infuse_link_age') + ': ' + Math.floor((Date.now() - attempt.at) / 1000) + ' s';
    var hlsTest = attempt.delivery === 'hls2-test';
    body.text(summary + '\n' + Lampa.Lang.translate(hlsTest ? 'kp_infuse_hls2_limits' : 'kp_infuse_check_running'));
    var stop = function () {};
    Lampa.Modal.open({ title: Lampa.Lang.translate('kp_infuse_check'), html: body, size: 'medium',
      onBack: function () { stop(); Lampa.Modal.close(); Lampa.Controller.toggle(enabled); } });
    // File Range/size diagnostics do not describe an HLS manifest or segments.
    if (hlsTest) return;
    stop = probeInfuseResource(attempt.url, function (results) {
      Lampa.Modal.close();
      var limits = Lampa.Lang.translate('kp_infuse_check_limits');
      var entries = results.map(function (r) {
        var title = (r.method || '') + (r.requested ? ' ' + r.requested : '') + ': ' +
          (r.error ? Lampa.Lang.translate('kp_infuse_probe_' + r.error) : 'HTTP ' + r.status);
        var verdict = r.verdict ? Lampa.Lang.translate('kp_infuse_range_' + r.verdict) : '';
        return { title: title, subtitle: verdict, detail: title + '\n' + verdict + '\n' +
          (r.host || '?') + (r.redirected ? ' (redirect)' : '') + '\n' +
          'Headers: ' + (r.ms == null ? '?' : r.ms) + ' ms / Body: 0 bytes\n' +
          'Content-Type: ' + (r.type || '?') + '\nContent-Length: ' + (r.length || '?') +
          '\nContent-Range: ' + (r.range || '?') + '\nAccept-Ranges: ' + (r.acceptRanges || '?') +
          '\nContent-Encoding: ' + (r.encoding || '?') };
      });
      entries.unshift({ title: Lampa.Lang.translate('kp_infuse_report'), subtitle: 'KinoPub ' + PLUGIN_VERSION,
        detail: summary + '\n\n' + entries.map(function (e) { return e.title + '\n' + e.subtitle; }).join('\n') });
      function report() {
        Lampa.Select.show({ title: Lampa.Lang.translate('kp_infuse_check'), items: entries,
          onBack: function () { Lampa.Controller.toggle(enabled); },
          onSelect: function (entry) {
            Lampa.Modal.open({ title: Lampa.Lang.translate('kp_infuse_check'), size: 'large',
              html: $('<div></div>').css({ 'white-space': 'pre-wrap', 'font-size': '0.8em' }).text(entry.detail + '\n\n' + limits),
              onBack: function () { Lampa.Modal.close(); report(); } });
          } });
      }
      report();
    });
  }

  /* ============================================================ *
   *  LOGGER                                                      *
   *  - prints to console with [KP:tag] prefix                    *
   *  - batches records and POSTs to remote log-server            *
   * ============================================================ */

  var Logger = (function () {
    var sessionId = (Lampa.Utils && Lampa.Utils.uid) ? Lampa.Utils.uid(8)
                                                     : Math.random().toString(36).slice(2, 10);
    var queue       = [];
    var maxQueue    = 500;
    var endpoint    = '';
    var flushing    = false;
    var flushTimer  = null;
    var FLUSH_DELAY = 250; // fast flush so we don't miss player error bursts

    function readEndpoint() {
      var v = Lampa.Storage.get(KEY_LOG_URL, '') || '';
      endpoint = String(v).replace(/\/+$/, '');
    }

    function platform() {
      try {
        if (Lampa.Platform.is('tizen'))   return 'tizen';
        if (Lampa.Platform.is('webos'))   return 'webos';
        if (Lampa.Platform.is('android')) return 'android';
        if (Lampa.Platform.is('apple_tv')) return 'apple_tv';
        if (Lampa.Platform.is('apple'))   return 'apple';
      } catch (e) {}
      return 'browser';
    }

    function safeData(v) {
      if (v === undefined) return undefined;
      try { return redactDiagnostic(JSON.parse(JSON.stringify(v))); }
      catch (e) { return '[unserializable]'; }
    }

    function consolePrint(level, tag, message, data) {
      try {
        var prefix = '[KP:' + tag + ']';
        var args   = data === undefined ? [prefix, message] : [prefix, message, data];
        if      (level === 'error' && console.error) console.error.apply(console, args);
        else if (level === 'warn'  && console.warn)  console.warn.apply(console, args);
        else                                          console.log.apply(console, args);
      } catch (e) { /* ignore */ }
    }

    function add(level, tag, message, data) {
      var rec = {
        session: sessionId,
        plat:    platform(),
        level:   level,
        ts:      Date.now(),
        tag:     tag,
        message: message
      };
      var safe = safeData(data);
      if (safe !== undefined) rec.data = safe;

      rec.message = redactDiagnostic(message);
      consolePrint(level, tag, rec.message, safe);

      if (!endpoint) return;
      queue.push(rec);
      if (queue.length > maxQueue) queue.splice(0, queue.length - maxQueue);
      schedule();
    }

    function schedule() {
      if (flushTimer || flushing || !endpoint) return;
      flushTimer = setTimeout(flush, FLUSH_DELAY);
    }

    function flush() {
      flushTimer = null;
      if (flushing || !endpoint || queue.length === 0) return;
      flushing = true;

      var batch = queue.slice();
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', endpoint + '/logs', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.timeout = 6000;
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return;
          flushing = false;
          if (xhr.status >= 200 && xhr.status < 300) {
            queue.splice(0, batch.length);
          }
          if (queue.length > 0 && endpoint) schedule();
        };
        xhr.ontimeout = function () { flushing = false; };
        xhr.onerror   = function () { flushing = false; };
        xhr.send(JSON.stringify(batch));
      } catch (e) {
        flushing = false;
      }
    }

    readEndpoint();

    return {
      debug:   function (tag, msg, data) { add('debug', tag, msg, data); },
      info:    function (tag, msg, data) { add('info',  tag, msg, data); },
      warn:    function (tag, msg, data) { add('warn',  tag, msg, data); },
      error:   function (tag, msg, data) { add('error', tag, msg, data); },
      reload:  readEndpoint,
      session: function () { return sessionId; },
      flush:   flush
    };
  })();

  // global error capture from anywhere in the plugin
  window.addEventListener('error', function (ev) {
    if (!ev || !ev.message) return;
    if (String(ev.message).indexOf('KP') === -1 &&
        String(ev.filename || '').indexOf('kp.js') === -1) return;
    Logger.error('window', ev.message, {
      file: ev.filename, line: ev.lineno, col: ev.colno
    });
  });

  // hook console.error/warn/log so HLS / video / network errors that bubble
  // through hls.js or Tizen AVPlayer get forwarded to our remote log.
  (function () {
    var origError = console.error;
    var origWarn  = console.warn;
    var origLog   = console.log;
    var KEEP = /hls|video|m3u8|cdn|player|tizen|avplay|networkerror|levelloaderror|fragloaderror|manifestloaderror|mediaerror|bufferappenderror|audiocodec|videocodec|fmp4|fragmented|track|src|fetch|xhr|ajax|cors|origin|kinopub|kp/i;
    function format(args) {
      try {
        return Array.prototype.slice.call(args).map(function (a) {
          if (a == null) return String(a);
          if (typeof a === 'string') return a;
          if (a instanceof Error) return a.name + ': ' + a.message;
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
      } catch (e) { return ''; }
    }
    // ALL console.error reports (no filter — errors are rare, want every one)
    console.error = function () {
      try {
        var m = format(arguments);
        // skip our own [KP:...] log echoes to avoid feedback
        if (m.indexOf('[KP:') !== 0) Logger.error('console', m.slice(0, 1000));
      } catch (e) {}
      return origError.apply(console, Array.prototype.map.call(arguments, redactConsole));
    };
    console.warn = function () {
      try {
        var m = format(arguments);
        if (m.indexOf('[KP:') !== 0 && KEEP.test(m)) {
          Logger.warn('console', m.slice(0, 1000));
        }
      } catch (e) {}
      return origWarn.apply(console, Array.prototype.map.call(arguments, redactConsole));
    };
    // log filter is strict — too noisy otherwise
    console.log = function () {
      try {
        var m = format(arguments);
        if (m.indexOf('[KP:') !== 0 && KEEP.test(m)) {
          Logger.debug('console', m.slice(0, 1000));
        }
      } catch (e) {}
      return origLog.apply(console, Array.prototype.map.call(arguments, redactConsole));
    };
  })();

  Logger.info('boot', 'kp.js v' + PLUGIN_VERSION + ' starting', {
    session: Logger.session(),
    app: Lampa.Manifest.app_digital,
    ua: navigator.userAgent
  });

  /* ============================================================ *
   *  KINOPUB API                                                 *
   * ============================================================ */

  var KP = (function () {

    function tokenAccess()  { return Lampa.Storage.get(KEY_TOKEN, ''); }
    function tokenRefresh() { return Lampa.Storage.get(KEY_REFRESH, ''); }

    function setTokens(access, refresh) {
      Lampa.Storage.set(KEY_TOKEN, access || '');
      if (refresh) Lampa.Storage.set(KEY_REFRESH, refresh);
    }
    function clearTokens() {
      Lampa.Storage.set(KEY_TOKEN, '');
      Lampa.Storage.set(KEY_REFRESH, '');
    }

    function proxify(url) {
      var p = (Lampa.Storage.get(KEY_PROXY, '') || '').replace(/\/+$/, '');
      if (!p) return url;
      // append URL — most CORS-proxies accept this format (cors.byskaz.ru/<full_url>)
      return p + '/' + url;
    }

    function commonForm(extra) {
      var s = 'client_id=' + encodeURIComponent(CLIENT_ID) +
              '&client_secret=' + encodeURIComponent(CLIENT_SECRET);
      if (extra) s += '&' + extra;
      return s;
    }

    /**
     * Use Lampa.Reguest if a network is supplied, so that network.clear() in the
     * source can cancel pending kinopub requests on destroy/back. Falls back to
     * a temporary network when none provided (e.g. background profile check).
     */
    function call(method, url, postData, headers, network, success, error, timeoutMs) {
      var net = network || new Lampa.Reguest();
      net.timeout(timeoutMs || 15000);

      var params = { headers: headers || {} };
      if (method === 'POST') {
        // Lampa.Reguest treats post_data argument as POST body and forces method=POST
      }

      var fullUrl = proxify(url);

      // .silent(url, complite, error, post_data?, params?) — params.headers supported.
      net.silent(fullUrl, function (json) {
        success(json);
      }, function (xhr, status) {
        error(xhr || {}, status);
      }, postData || false, params);
    }

    function deviceCode(network, success, error) {
      Logger.info('auth', 'POST /oauth2/device grant=device_code');
      call('POST', API_HOST + '/oauth2/device',
        commonForm('grant_type=device_code'),
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        network,
        function (json) {
          // Lampa.Reguest may already parse JSON; tolerate both
          if (typeof json === 'string') { try { json = JSON.parse(json); } catch (e) {} }
          if (json && json.code) {
            Logger.info('auth', 'device code received', {
              user_code: json.user_code, expires_in: json.expires_in, interval: json.interval
            });
            success(json);
          } else {
            Logger.error('auth', 'device code unexpected response', json);
            error({}, 'bad_response');
          }
        },
        function (xhr, status) {
          Logger.error('auth', 'device code error', { http: xhr && xhr.status, status: status });
          error(xhr, status);
        },
        15000
      );
    }

    function pollDeviceToken(network, code, success, pending, error) {
      call('POST', API_HOST + '/oauth2/device',
        commonForm('grant_type=device_token&code=' + encodeURIComponent(code)),
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        network,
        function (json) {
          if (typeof json === 'string') { try { json = JSON.parse(json); } catch (e) {} }
          if (json && json.access_token) {
            Logger.info('auth', 'access_token received');
            setTokens(json.access_token, json.refresh_token);
            success(json);
          } else if (json && (json.error === 'authorization_pending' || json.error === 'slow_down')) {
            pending();
          } else {
            Logger.warn('auth', 'unexpected device_token response', json);
            pending();
          }
        },
        function (xhr, status) {
          var resp = null;
          try { resp = JSON.parse(xhr && xhr.responseText || ''); } catch (e) {}
          if (resp && (resp.error === 'authorization_pending' || resp.error === 'slow_down')) {
            pending();
          } else {
            Logger.error('auth', 'device_token error', { http: xhr && xhr.status, status: status, body: resp });
            error(xhr, status);
          }
        },
        10000
      );
    }

    function refresh(network, success, error) {
      var rt = tokenRefresh();
      if (!rt) {
        Logger.warn('auth', 'no refresh token');
        if (error) error({}, 'no_refresh_token');
        return;
      }
      Logger.info('auth', 'POST /oauth2/token refresh');
      call('POST', API_HOST + '/oauth2/token',
        commonForm('grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt)),
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        network,
        function (json) {
          if (typeof json === 'string') { try { json = JSON.parse(json); } catch (e) {} }
          if (json && json.access_token) {
            setTokens(json.access_token, json.refresh_token);
            Logger.info('auth', 'token refreshed');
            success(json);
          } else {
            Logger.error('auth', 'refresh empty response', json);
            if (error) error({}, 'empty');
          }
        },
        function (xhr, status) {
          Logger.error('auth', 'refresh failed', { http: xhr && xhr.status, status: status });
          if (error) error(xhr, status);
        },
        10000
      );
    }

    /**
     * Authenticated GET against /v1/...
     * Auto-refreshes the token once on 401. The `_retried` flag prevents infinite
     * recursion if the refreshed token keeps getting rejected.
     */
    function api(network, path, params, success, error, _retried) {
      var qs = '';
      if (params) {
        var parts = [];
        for (var k in params) {
          if (params.hasOwnProperty(k) && params[k] !== undefined && params[k] !== null) {
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
          }
        }
        if (parts.length) qs = '?' + parts.join('&');
      }
      var url = API_HOST + '/v1' + path + qs;
      var t = tokenAccess();
      if (!t) {
        Logger.warn('api', 'no token', { path: path });
        if (error) error({ status: 401 }, 'no_token');
        return;
      }
      Logger.debug('api', 'GET ' + path, params);

      call('GET', url, false,
        { 'Authorization': 'Bearer ' + t },
        network,
        function (json) {
          Logger.debug('api', 'GET ' + path + ' ok');
          success(json);
        },
        function (xhr, status) {
          Logger.warn('api', 'GET ' + path + ' err', {
            http: xhr && xhr.status, status: status,
            body: (xhr && xhr.responseText || '').slice(0, 200)
          });
          if (xhr && xhr.status === 401 && !_retried) {
            refresh(network, function () {
              api(network, path, params, success, error, true);
            }, function () {
              clearTokens();
              if (error) error(xhr, status);
            });
          } else {
            if (error) error(xhr, status);
          }
        },
        20000
      );
    }

    /**
     * Authenticated POST against /v1/...
     * Used for settings updates. Body is x-www-form-urlencoded.
     */
    function apiPost(network, path, body, success, error, _retried) {
      var url = API_HOST + '/v1' + path;
      var t = tokenAccess();
      if (!t) {
        Logger.warn('api', 'no token', { path: path });
        if (error) error({ status: 401 }, 'no_token');
        return;
      }
      var bodyStr = '';
      if (body && typeof body === 'object') {
        var parts = [];
        for (var k in body) {
          if (body.hasOwnProperty(k) && body[k] !== undefined && body[k] !== null) {
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(body[k]));
          }
        }
        bodyStr = parts.join('&');
      } else {
        bodyStr = String(body || '');
      }
      Logger.debug('api', 'POST ' + path, body);

      call('POST', url, bodyStr,
        { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/x-www-form-urlencoded' },
        network,
        function (json) { Logger.debug('api', 'POST ' + path + ' ok'); success(json); },
        function (xhr, status) {
          Logger.warn('api', 'POST ' + path + ' err', { http: xhr && xhr.status, status: status });
          if (xhr && xhr.status === 401 && !_retried) {
            refresh(network, function () {
              apiPost(network, path, body, success, error, true);
            }, function () {
              clearTokens();
              if (error) error(xhr, status);
            });
          } else {
            if (error) error(xhr, status);
          }
        },
        15000
      );
    }

    return {
      tokenAccess:     tokenAccess,
      hasToken:        function () { return !!tokenAccess(); },
      clearTokens:     clearTokens,
      deviceCode:      deviceCode,
      pollDeviceToken: pollDeviceToken,
      refresh:         refresh,
      search: function (network, query, type, ok, err) {
        // /v1/items/search?q=&field=title is the proper endpoint per kinoapi.com.
        // /v1/items expects browsing-style filters (genre/year/etc), not a fulltext q.
        var params = { q: query, field: 'title', perpage: 50 };
        if (type) params.type = type;
        api(network, '/items/search', params, ok, err);
      },
      item: function (network, id, ok, err) {
        api(network, '/items/' + id, null, ok, err);
      },
      mediaVideoLink: function (network, file, ok, err, delivery) {
        // Official exact-file resolver. Do not derive a URL from a HLS path
        // or reuse a cached item link when this request fails.
        api(network, '/items/media-video-link', { file: file, type: delivery === 'hls2' ? 'hls2' : 'http' }, ok, err);
      },
      profile: function (network, ok, err) {
        api(network, '/user', null, ok, err);
      },
      deviceInfo: function (network, ok, err) {
        api(network, '/device/info', null, ok, err);
      },
      serverLocations: function (network, ok, err) {
        api(network, '/references/server-location', null, ok, err);
      },
      saveDeviceSettings: function (network, deviceId, settings, ok, err) {
        apiPost(network, '/device/' + deviceId + '/settings', settings, ok, err);
      },
      deviceNotify: function (network, info, ok, err) {
        // POST form-encoded title/hardware/software — kinoapi.com docs say
        // "call after auth and on every plugin start"
        apiPost(network, '/device/notify', info, ok, err);
      }
    };
  })();

  /* ============================================================ *
   *  HELPERS                                                     *
   * ============================================================ */

  /**
   * Build device identification fields for kinopub /v1/device/notify.
   * Without this call kinopub UI shows three "unknown" lines.
   */
  function detectDeviceInfo() {
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    var platform = 'browser';
    var hardware = 'Web Browser';
    var title    = 'Lampa';

    try {
      if (Lampa.Platform.is('tizen')) {
        platform = 'tizen';
        var mt = ua.match(/Tizen\s+([\d.]+)/i);
        hardware = 'Samsung Tizen' + (mt ? ' ' + mt[1] : '');
        title = 'Lampa (Samsung TV)';
      } else if (Lampa.Platform.is('webos')) {
        platform = 'webos';
        var mw = ua.match(/Web0?[Oo]s\D*(\d+(?:\.\d+)?)/i) || ua.match(/webOS\.TV-(\d+)/i);
        hardware = 'LG webOS' + (mw ? ' ' + mw[1] : '');
        title = 'Lampa (LG TV)';
      } else if (Lampa.Platform.is('android')) {
        platform = 'android';
        var ma = ua.match(/Android\s+([\d.]+)/i);
        hardware = 'Android' + (ma ? ' ' + ma[1] : '');
        title = 'Lampa (Android)';
      } else if (Lampa.Platform.is('apple_tv')) {
        platform = 'apple_tv';
        hardware = 'Apple TV';
        title = 'Lampa (Apple TV)';
      } else if (Lampa.Platform.is('apple')) {
        platform = 'ios';
        var mi = ua.match(/OS\s+([\d_]+)/i);
        hardware = 'iOS' + (mi ? ' ' + mi[1].replace(/_/g, '.') : '');
        title = 'Lampa (iOS)';
      } else {
        var br = ua.match(/(Edg|Chrome|Firefox|Safari|Opera)\/([\d.]+)/);
        hardware = br ? br[1].replace('Edg', 'Edge') + ' ' + br[2] : 'Web Browser';
        title = 'Lampa (' + hardware + ')';
      }
    } catch (e) { /* keep defaults */ }

    var lampaVer = (Lampa.Manifest && Lampa.Manifest.app_digital)
      ? 'Lampa ' + Lampa.Manifest.app_digital
      : 'Lampa';
    var software = 'kp.js ' + PLUGIN_VERSION + ' / ' + lampaVer;

    return { title: title, hardware: hardware, software: software, _platform: platform };
  }

  /**
   * Send identity to kinopub. Idempotent — fine to call on every startup.
   * Failures are logged but never blocked further work.
   */
  function notifyDeviceIdentity(network) {
    if (!KP.hasToken()) return;
    var info = detectDeviceInfo();
    Logger.info('identity', 'sending /device/notify', info);
    KP.deviceNotify(network, {
      title:    info.title,
      hardware: info.hardware,
      software: info.software
    }, function (resp) {
      Logger.info('identity', 'notify ok', resp);
    }, function (xhr, status) {
      Logger.warn('identity', 'notify failed', { http: xhr && xhr.status, status: status });
    });
  }

  function maxQuality() {
    var q = parseInt(Lampa.Storage.get(KEY_MAX_QUAL, '1080'), 10);
    return q > 0 ? q : 1080;
  }

  // Per-launch override (set from contextmenu "try in different format").
  // Null means: fall back to user's saved KEY_FORMAT setting.
  var formatOverride = null;
  var lastAutoFormatLogKey = null;

  // Voice/audio-track state. When kpapi builds a play-element it sets
  // pendingVoice = { idx, label }. The PlayerVideo.canplay hook below consumes
  // it and calls the underlying player API to switch to that audio track,
  // without restarting the stream. This is what makes voice selection (made in
  // the source filter) actually take effect on Tizen / hls.js.
  var pendingVoice = null;

  // The currently active voice label, kept fresh whenever toPlayElement runs.
  // Used by setupNextEpisodeLabelOverride() to repaint the
  // `.player-panel__next-episode-name` DOM with the voice instead of the
  // next-episode title (per user request — that hint is more useful here).
  var currentVoiceLabel = '';

  // v1.0.41: tracks whether the user changed voice via in-player UI during
  // the current player session. Set in buildVoiceSwapCallback, read on
  // Player/destroy to decide between full filter+chips rebuild (flashes the
  // season grid) vs lightweight chip-only refresh.
  var voiceChangedInPlayer = false;

  /**
   * Applies an audio-track switch on the currently active player. Idempotent —
   * safe to call multiple times. Returns true if a backend handled it.
   *
   * Tizen native: webapis.avplay.setSelectTrack('AUDIO', native_idx)
   * HTML5 + hls.js: hls.audioTrack = idx (Lampa might not expose hls instance,
   *   we try a few common attachment patterns)
   */
  /**
   * BARE-mode diagnostic — fetch the master.m3u8 of the stream we're about to
   * play and log its key lines (#EXT-X-STREAM-INF for video levels with codecs
   * and bitrates, #EXT-X-MEDIA for audio tracks). This adds a network request;
   * Apple delegated players skip it. Helps identify HEVC main10 vs AVC,
   * how many audio tracks, what bitrates, etc.
   */
  function dumpStreamManifest(url) {
    if (!url) return;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 5000;
      xhr.onload = function () {
        if (xhr.status < 200 || xhr.status >= 300) {
          Logger.warn('manifest', 'fetch non-2xx', { status: xhr.status, url: url });
          return;
        }
        var body = xhr.responseText || '';
        // Keep only the diagnostic-relevant lines so we don't flood the log
        // with thousands of segment URIs.
        var lines = body.split(/\r?\n/);
        var keep = [];
        for (var i = 0; i < lines.length && keep.length < 100; i++) {
          var l = lines[i];
          if (!l) continue;
          if (l.indexOf('#EXT-X-STREAM-INF') === 0 ||
              l.indexOf('#EXT-X-MEDIA') === 0 ||
              l.indexOf('#EXT-X-VERSION') === 0 ||
              l.indexOf('#EXT-X-INDEPENDENT-SEGMENTS') === 0 ||
              l.indexOf('#EXT-X-MAP') === 0 ||
              (l.indexOf('#EXTM3U') === 0)) {
            keep.push(l);
          } else if (l.indexOf('#EXT-X-STREAM-INF') >= 0 || (i > 0 && lines[i - 1].indexOf('#EXT-X-STREAM-INF') === 0)) {
            // capture variant playlist URL line right after STREAM-INF
            keep.push(l);
          }
        }
        Logger.info('manifest', 'master.m3u8', {
          url:      url,
          length:   body.length,
          lineCount: lines.length,
          keep:     keep
        });
      };
      xhr.onerror   = function () { Logger.warn('manifest', 'fetch error', { url: url }); };
      xhr.ontimeout = function () { Logger.warn('manifest', 'fetch timeout', { url: url }); };
      xhr.send();
    } catch (e) {
      Logger.warn('manifest', 'dump failed', String(e));
    }
  }

  /**
   * BARE-mode diagnostic — dumps Tizen AVPlayer's view of the stream once it
   * has parsed metadata. Shows actual codec strings, bitrate, resolution per
   * video/audio track that the hardware decoder picked up. Use to compare
   * stable vs crashing streams.
   */
  function dumpAvplayTracks(source) {
    try {
      if (!window.webapis || !window.webapis.avplay) return;
      var info  = (typeof window.webapis.avplay.getTotalTrackInfo === 'function')
                    ? (window.webapis.avplay.getTotalTrackInfo() || []) : [];
      var state = (typeof window.webapis.avplay.getState === 'function')
                    ? window.webapis.avplay.getState() : '?';
      // extra is JSON-encoded codec/bitrate/resolution per track
      var dump = info.map(function (t) {
        var ex = {};
        try { if (t.extra_info) ex = JSON.parse(t.extra_info); } catch (e) { ex = { _raw: t.extra_info }; }
        return { index: t.index, type: t.type, extra: ex };
      });
      Logger.info('avplay', source, { state: state, tracks: dump });
    } catch (e) {
      Logger.warn('avplay', 'dump failed', String(e));
    }
  }

  /**
   * Monkey-patch Lampa.PlayerVideo.url() to force change_quality=true for our
   * proxy URLs.
   *
   * Why: our proxy URL contains the kinopub master encoded inside ?master=...
   * The encoded URL still has the literal substring ".m3u8" because encodeURI-
   * Component doesn't encode dots. Lampa's url$4(src) sees that substring and
   * treats the URL as HLS, which on Tizen native player path triggers a
   * separate hls.js *parser* fork (hls_parser = new Hls(); loadSource(src))
   * just to extract audio-track names for the player-panel "translate" UI.
   *
   * That bundled hls.js is OLD and chokes on fMP4 segments (HEVC variant
   * playlists), AND it fetches kinopub variant URLs in parallel with AVPlayer,
   * starving the network. On HEVC 4K this race intermittently kills the
   * Tizen app (no PlayerVideo/error event — process just dies, log truncates).
   *
   * Setting change_quality=true skips the hls_parser fork entirely (Lampa
   * source url$4 line ~12865: `} else if (!change_quality && !PlayerIPTV...`).
   * AVPlayer gets the URL directly via load$4(src). Single fetch, no race.
   *
   * Safe because: (a) we set play.voiceovers ourselves so the missing
   * "translate" event doesn't matter for UI, (b) change_quality=true is
   * what Lampa's own quality picker uses on every quality switch, well-tested.
   */
  function setupKpPlayerPatch() {
    if (!window.Lampa || !Lampa.PlayerVideo) return;
    if (Lampa.PlayerVideo._kp_patched) return;
    if (typeof Lampa.PlayerVideo.url !== 'function') return;

    var origUrl = Lampa.PlayerVideo.url;
    Lampa.PlayerVideo.url = function (src, change_quality) {
      if (Lampa.Platform.is('tizen') && !change_quality && typeof src === 'string' &&
          KP_PROXY_URL && src.indexOf(KP_PROXY_URL) === 0) {
        Logger.info('player', 'forcing change_quality=true for proxy URL (skip hls.js parse)');
        return origUrl.call(this, src, true);
      }
      return origUrl.apply(this, arguments);
    };
    Lampa.PlayerVideo._kp_patched = true;
    Logger.info('player', 'PlayerVideo.url monkey-patched');
  }

  /**
   * Ping the manifest-proxy /health endpoint. Sets kpProxyAvailable on
   * completion. Idempotent.
   *
   * v1.0.68: increased timeout 3s → 10s (CF cold-start sometimes exceeds
   * 3s), and on first-attempt failure auto-retries every 30s up to a few
   * times. Without this, a transient blip at boot permanently flipped
   * plugin into HLS2 fallback (= no voice picker, no quality picker).
   *
   * Plugin remains functional during retry — falls back to HLS2 if proxy
   * isn't yet confirmed; switches to HLS4+proxy as soon as ping succeeds.
   * If user opens a card while still in HLS2 mode, they get the legacy
   * behaviour and can re-enter after kpProxyAvailable flips to true.
   */
  function checkProxyAvailability(attempt) {
    attempt = attempt || 1;
    var url = KP_PROXY_URL.replace(/\/+$/, '') + '/health';
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 10000;
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          kpProxyAvailable = true;
          var info = '';
          try {
            var j = JSON.parse(xhr.responseText || '{}');
            info = (j.service || '') + ' v' + (j.version || '?');
          } catch (e) {}
          Logger.info('proxy', 'available', { url: KP_PROXY_URL, info: info, attempt: attempt });
        } else {
          kpProxyAvailable = false;
          Logger.warn('proxy', 'health non-2xx, fallback to HLS2', { status: xhr.status, attempt: attempt });
          scheduleProxyRetry(attempt);
        }
      };
      xhr.onerror   = function () {
        kpProxyAvailable = false;
        Logger.warn('proxy', 'unreachable, fallback to HLS2', { attempt: attempt });
        scheduleProxyRetry(attempt);
      };
      xhr.ontimeout = function () {
        kpProxyAvailable = false;
        Logger.warn('proxy', 'timeout, fallback to HLS2', { attempt: attempt });
        scheduleProxyRetry(attempt);
      };
      xhr.send();
    } catch (e) {
      kpProxyAvailable = false;
      Logger.warn('proxy', 'check failed', { err: String(e), attempt: attempt });
      scheduleProxyRetry(attempt);
    }
  }

  function scheduleProxyRetry(prev) {
    if (prev >= 6) return; // give up after ~5 retries (30s intervals)
    setTimeout(function () {
      // Don't retry if proxy meanwhile became available (e.g. another caller)
      if (kpProxyAvailable === true) return;
      checkProxyAvailability(prev + 1);
    }, 30000);
  }

  /* ──────────────────────────────────────────────────────────────────── *
   *  v1.0.66 — Voice-sync (cross-device snapshot of voice prefs).        *
   *  Backend: same VPS as manifest-proxy, endpoints /voice-sync/<u>/<s>. *
   *  Storage: per (kinopub username, TMDB show id). No auth.             *
   * ──────────────────────────────────────────────────────────────────── */

  function kpVoiceSyncReady() {
    return kpProxyAvailable === true && !!kpUserId;
  }

  function kpVoiceSyncBaseUrl() {
    return KP_PROXY_URL.replace(/\/+$/, '') + '/voice-sync/' + encodeURIComponent(kpUserId);
  }

  function kpVoiceSyncPull(showId, cb) {
    if (!kpVoiceSyncReady()) { cb({ ok: false, error: 'not_ready' }); return; }
    var url = kpVoiceSyncBaseUrl() + '/' + encodeURIComponent(showId);
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 4000;
      xhr.onload = function () {
        if (xhr.status === 404) { cb({ ok: true, snapshot: null }); return; }
        if (xhr.status < 200 || xhr.status >= 300) { cb({ ok: false, status: xhr.status }); return; }
        try { cb({ ok: true, snapshot: JSON.parse(xhr.responseText || 'null') }); }
        catch (e) { cb({ ok: false, error: 'parse' }); }
      };
      xhr.onerror = xhr.ontimeout = function () { cb({ ok: false, error: 'network' }); };
      xhr.send();
    } catch (e) { cb({ ok: false, error: String(e) }); }
  }

  function kpVoiceSyncPushDebounced(showId, getSnapshotFn) {
    if (!kpVoiceSyncReady()) return;
    if (!showId) return;
    if (kpVoiceSyncDebounce[showId]) clearTimeout(kpVoiceSyncDebounce[showId]);
    kpVoiceSyncDebounce[showId] = setTimeout(function () {
      delete kpVoiceSyncDebounce[showId];
      var snap;
      try { snap = getSnapshotFn(); }
      catch (e) { Logger.warn('voicesync', 'snapshot build failed', String(e)); return; }
      if (!snap) return;
      snap.ts = Date.now();
      try { snap.device = (Lampa.Platform.get && Lampa.Platform.get()) || 'unknown'; } catch (e) {}
      var url = kpVoiceSyncBaseUrl() + '/' + encodeURIComponent(showId);
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', url, true);
        xhr.timeout = 4000;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            Logger.debug('voicesync', 'push ok', { show: showId, ts: snap.ts });
          } else {
            Logger.warn('voicesync', 'push non-2xx', { show: showId, status: xhr.status });
          }
        };
        xhr.onerror = xhr.ontimeout = function () {
          Logger.warn('voicesync', 'push failed', { show: showId });
        };
        xhr.send(JSON.stringify(snap));
      } catch (e) { Logger.warn('voicesync', 'push throw', String(e)); }
    }, KP_VOICE_SYNC_DEBOUNCE_MS);
  }

  function kpVoiceSyncBuildSnapshot(showId) {
    if (!showId) return null;
    var data = Lampa.Storage.cache('online_choice_kpapi', 3000, {});
    var choice = data[showId];
    if (!choice) return null;
    var snap = {
      show_id: showId,
      voice_key: choice.voice_key || '',
      voices_by_season: choice.voices_by_season || {},
      episodes: {}
    };
    try {
      var em = Lampa.Storage.cache('kp_episode_voice', 5000, {});
      snap.episodes = em || {};
    } catch (e) {}
    return snap;
  }

  function kpVoiceSyncApplySnapshot(showId, snap) {
    if (!snap || !showId) return;
    try {
      var data = Lampa.Storage.cache('online_choice_kpapi', 3000, {});
      if (!data[showId]) data[showId] = {};
      var c = data[showId];
      if (snap.voice_key)        c.voice_key = snap.voice_key;
      if (snap.voices_by_season) c.voices_by_season = snap.voices_by_season;
      Lampa.Storage.set('online_choice_kpapi', data);
    } catch (e) { Logger.warn('voicesync', 'apply choice failed', String(e)); }
    try {
      if (snap.episodes && typeof snap.episodes === 'object') {
        var em = Lampa.Storage.cache('kp_episode_voice', 5000, {});
        Object.keys(snap.episodes).forEach(function (h) { em[h] = snap.episodes[h]; });
        Lampa.Storage.set('kp_episode_voice', em);
      }
    } catch (e) { Logger.warn('voicesync', 'apply episodes failed', String(e)); }
    Logger.info('voicesync', 'snapshot applied', {
      show: showId,
      season_voices: Object.keys(snap.voices_by_season || {}).length,
      episodes: Object.keys(snap.episodes || {}).length
    });
  }

  function kpVoiceSyncOnFull(movieId) {
    if (!kpVoiceSyncReady()) return;
    if (!movieId) return;
    kpVoiceSyncPull(movieId, function (resp) {
      if (resp.ok && resp.snapshot) kpVoiceSyncApplySnapshot(movieId, resp.snapshot);
    });
  }

  function kpVoiceSyncOnChange(showId) {
    if (!kpVoiceSyncReady()) return;
    kpVoiceSyncPushDebounced(showId, function () {
      return kpVoiceSyncBuildSnapshot(showId);
    });
  }

  /**
   * Build the proxy URL for a kinopub HLS4 master + chosen voice index.
   * Returns null if proxy is not available.
   */
  // v1.0.73 rollback: quality picker removed. proxyUrlFor signature is
  // back to (master, voice) — no &quality= param sent. Plugin doesn't set
  // play.quality, so Lampa's native picker stays empty / disabled. To
  // bring it back, see [[project-kp-quality-picker]] memory note.
  function proxyUrlFor(masterUrl, voiceIndex, player) {
    if (!useManifestProxy(player) || !masterUrl) return null;
    var base = KP_PROXY_URL.replace(/\/+$/, '');
    return base + '/manifest-proxy?master=' +
           encodeURIComponent(masterUrl) +
           '&voice=' + voiceIndex;
  }

  /**
   * Build the onSelect callback fired by Lampa when user picks a voice in
   * the in-player track picker. Performs a Lampa-native soft URL swap —
   * same mechanism Lampa itself uses for quality switching:
   *
   *   1. Lampa.Player.playdata().url = newUrl       (sync work.url)
   *   2. Lampa.PlayerVideo.destroy(true)            (partial — keeps overlay)
   *   3. Lampa.PlayerVideo.url(newUrl, true)        (change_quality=true skips
   *                                                  hls audio-tracks parser)
   *   4. work.timeline.continued = false            (re-arm auto-resume)
   *
   * Lampa's own timeupdate listener will then seekTo the saved position on
   * the next tick. Player overlay (panel, controls, playlist popup) does
   * not get destroyed → no Player/destroy event → smooth transition.
   *
   * v1.0.32: also updates UI side-effects which Lampa misses on soft swap:
   *   • kp_episode_voice[timeline_hash] = key   (so card chips reflect new
   *                                              "watched-with-voice" state)
   *   • re-render .player-panel__next-episode-name DOM (we own this label)
   *   • mutate voiceoversRef[].selected so re-opening tracks list shows the
   *     correct current voice highlighted
   *   • Controller.toggle('player_panel') to restore focus on tracks button
   *
   * Closes over (label, key, url, element, choice, voiceoversRef).
   */
  function buildVoiceSwapCallback(label, key, url, element, choice, voiceoversRef, showId) {
    return function (item) {
      var swapUrl = (item && item.url) || url;
      Logger.info('voice', 'in-player switch', {
        label: label, key: key, url: (swapUrl || '').slice(0, 80) + '...'
      });

      // ── Persist voice choice per-(series, season) ──────────────────────
      try {
        if (choice) {
          choice.voice_key  = key;
          choice.voice_name = label;
          if (typeof choice.season !== 'undefined' && choice.season !== null) {
            if (!choice.voices_by_season) choice.voices_by_season = {};
            choice.voices_by_season[choice.season] = key;
          }
        }
      } catch (e) { Logger.warn('voice', 'persist choice failed', String(e)); }

      // ── Update kp_episode_voice (per-episode watched-voice memory) so the
      // chip on the card behind the player flips to reflect the new voice ─
      try {
        if (element && element.timeline_hash) {
          var watchedMap = Lampa.Storage.cache('kp_episode_voice', 5000, {});
          watchedMap[element.timeline_hash] = key;
          Lampa.Storage.set('kp_episode_voice', watchedMap);
        }
      } catch (e) { Logger.warn('voice', 'episode-voice persist failed', String(e)); }

      // v1.0.66: push voice-sync to VPS (debounced)
      try { if (showId) kpVoiceSyncOnChange(showId); } catch (vse) {}

      // ── Update the in-DOM next-episode-name label (we own this) ────────
      try { currentVoiceLabel = label; } catch (e) {}

      // ── Update .selected flag on voiceovers[] so re-opening the tracks
      // list shows the new voice as highlighted (Lampa Select.show reads
      // .selected from the tracks reference passed via setTracks).
      //
      // v1.0.33: match by URL ONLY. voice_key collides for codec-twins
      // (same lang|type|author|codec, different kinopub index) — picking
      // one would mark BOTH selected. URL is unique because the proxy
      // query string includes voice=<index>. ─────────────────────────────
      try {
        if (voiceoversRef && voiceoversRef.length) {
          for (var i = 0; i < voiceoversRef.length; i++) {
            var vo = voiceoversRef[i];
            var match = (vo.url === swapUrl);
            vo.selected = match;
            vo['default'] = match;
            vo.enabled = match;
          }
        }
      } catch (e) { Logger.warn('voice', 'voiceovers selected sync failed', String(e)); }

      // ── Soft swap (Lampa-native quality-change pattern) ────────────────
      // destroy(true) + url(newUrl, true) called synchronously — same as
      // the v1.0.31 working pattern. destroy(true) keeps the overlay but
      // closes AVPlayer; url(newUrl, true) reopens it with the new URL.
      // No setTimeout gap (was added in v1.0.35/36 for HEVC headroom but
      // caused visible flash on AVC; HEVC stability handled separately if
      // re-enabled).
      var work = null;
      try {
        work = (Lampa.Player && typeof Lampa.Player.playdata === 'function')
               ? Lampa.Player.playdata() : null;
        if (work) work.url = swapUrl;
        if (Lampa.PlayerVideo && typeof Lampa.PlayerVideo.destroy === 'function') {
          Lampa.PlayerVideo.destroy(true);
        }
        if (Lampa.PlayerVideo && typeof Lampa.PlayerVideo.url === 'function') {
          Lampa.PlayerVideo.url(swapUrl, true);
        }
        if (work && work.timeline) {
          work.timeline.continued = false;
          work.timeline.continued_bloc = false;
        }
        // v1.0.40: Suppress canplay-time setSelectTrack attempts after the
        // swap. The proxy already serves the chosen voice as the only audio
        // track, so applyVoiceTrack would only call avplay.setSelectTrack
        // with a stale/out-of-range index (3 times — on canplay, loadeddata,
        // tracks) — Tizen briefly re-inits audio path on each, producing a
        // second spinner cycle ~1 sec after canplay.
        pendingVoice = null;
        Logger.info('voice', 'soft-swap fired', { url: (swapUrl || '').slice(0, 80) + '...' });
      } catch (e) {
        Logger.warn('voice', 'soft-swap failed, falling back to full restart', String(e));
        try {
          Lampa.Player.play({ url: swapUrl, title: (work && work.title) || '' });
        } catch (ee) { Logger.warn('voice', 'fallback play failed', String(ee)); }
      }

      // ── Force-update the .player-panel__next-episode-name DOM. Lampa
      // doesn't re-render this on soft swap, and our MutationObserver only
      // fires on Lampa-driven changes, not on currentVoiceLabel changes ───
      try {
        var labelEl = document.querySelector('.player-panel__next-episode-name');
        if (labelEl && labelEl.textContent !== label) {
          labelEl.textContent = label;
          try { labelEl.classList.remove('hide'); } catch (ee) {}
        }
      } catch (e) {}

      // ── Restore focus to the tracks button on the player panel ─────────
      // v1.0.40: deferred to 100ms so AVPlayer.open() gets a clear runway
      // before any controller/DOM work — was setTimeout 0 which could
      // overlap with player UI re-show during the open() phase.
      try {
        if (Lampa.Controller && typeof Lampa.Controller.toggle === 'function') {
          setTimeout(function () { Lampa.Controller.toggle('player_panel'); }, 100);
        }
      } catch (e) {}

      // v1.0.41: mark that voice was changed in-player so the destroy
      // handler does a full filter+chips rebuild (we need the sidebar
      // label to reflect the new voice on next entry). Skipping the
      // chip refresh here — destroy handler covers both cases below.
      voiceChangedInPlayer = true;
    };
  }

  /**
   * BLOB-TEST: Parse a kinopub HLS4 master.m3u8 into structured pieces.
   * Returns { audioGroups: { groupId: [{name,lang,deflt,uri,attrs}] },
   *           subtitlesGroups: { groupId: [...] },
   *           streamInfs: [{attrs, audioGroup, subsGroup, videoUri}] }
   */
  function parseHls4Master(text) {
    var lines = text.split(/\r?\n/);
    var audioGroups = {};
    var subtitlesGroups = {};
    var streamInfs = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l) continue;
      if (l.indexOf('#EXT-X-MEDIA:') === 0) {
        var attrs = parseAttrs(l.substring('#EXT-X-MEDIA:'.length));
        var entry = {
          name: attrs.NAME || '',
          lang: attrs.LANGUAGE || '',
          deflt: attrs.DEFAULT === 'YES',
          uri: attrs.URI || '',
          attrs: attrs
        };
        if (attrs.TYPE === 'AUDIO') {
          var g = attrs['GROUP-ID'] || 'audio';
          (audioGroups[g] = audioGroups[g] || []).push(entry);
        } else if (attrs.TYPE === 'SUBTITLES') {
          var sg = attrs['GROUP-ID'] || 'sub';
          (subtitlesGroups[sg] = subtitlesGroups[sg] || []).push(entry);
        }
      } else if (l.indexOf('#EXT-X-STREAM-INF:') === 0) {
        var sattrs = parseAttrs(l.substring('#EXT-X-STREAM-INF:'.length));
        // next non-empty non-comment line is the variant URI
        var uri = '';
        for (var j = i + 1; j < lines.length; j++) {
          var n = (lines[j] || '').trim();
          if (n && n.charAt(0) !== '#') { uri = n; break; }
        }
        streamInfs.push({
          attrs: sattrs,
          audioGroup: sattrs.AUDIO || '',
          subsGroup: sattrs.SUBTITLES || '',
          videoUri: uri,
          resolution: sattrs.RESOLUTION || '',
          bandwidth: parseInt(sattrs.BANDWIDTH || '0', 10) || 0,
          codecs: sattrs.CODECS || ''
        });
      }
    }
    return {
      audioGroups: audioGroups,
      subtitlesGroups: subtitlesGroups,
      streamInfs: streamInfs
    };
  }

  /**
   * Parse a #EXT-X-MEDIA / #EXT-X-STREAM-INF attribute line:
   *   "TYPE=AUDIO,GROUP-ID=\"audio2160\",NAME=\"foo\",LANGUAGE=\"rus\",..."
   * into { TYPE: 'AUDIO', 'GROUP-ID': 'audio2160', NAME: 'foo', ... }.
   * Handles quoted strings (which may contain commas) correctly.
   */
  function parseAttrs(s) {
    var out = {};
    var i = 0;
    var n = s.length;
    while (i < n) {
      // read key
      var keyStart = i;
      while (i < n && s.charAt(i) !== '=') i++;
      var key = s.substring(keyStart, i).trim();
      if (i >= n) break;
      i++; // skip '='
      // read value (quoted or until comma)
      var valStart, valEnd;
      if (s.charAt(i) === '"') {
        i++;
        valStart = i;
        while (i < n && s.charAt(i) !== '"') i++;
        valEnd = i;
        if (i < n) i++; // skip closing "
      } else {
        valStart = i;
        while (i < n && s.charAt(i) !== ',') i++;
        valEnd = i;
      }
      out[key] = s.substring(valStart, valEnd);
      // skip ','
      while (i < n && (s.charAt(i) === ',' || s.charAt(i) === ' ')) i++;
    }
    return out;
  }

  /**
   * BLOB-TEST: Build a reduced master.m3u8 with just one audio per group
   * (the chosen voice) + all video stream-infs. No subtitles, no I-FRAME.
   * Returns text suitable for blob: or data: URL wrapping.
   *
   * v1.0.29-data-test: simpler variant — only 1 stream-inf for the highest
   * available resolution (no ABR), 1 audio MEDIA, ASCII-only NAME (no Cyrillic),
   * to rule out parser quirks in Tizen AVPlayer.
   *
   * @param {Object} parsed     - output of parseHls4Master
   * @param {Number} voiceIndex - 1-based voice number to keep (matches '01.', '02.' prefix in NAME)
   */
  function buildReducedMaster(parsed, voiceIndex) {
    var out = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-INDEPENDENT-SEGMENTS'];

    // Pick best (highest-bandwidth) stream-inf only — strip ABR.
    var bestStreamInf = null;
    parsed.streamInfs.forEach(function (s) {
      if (!s.videoUri) return;
      if (!bestStreamInf || s.bandwidth > bestStreamInf.bandwidth) bestStreamInf = s;
    });
    if (!bestStreamInf) return out.join('\n') + '\n'; // nothing to emit

    // Pick the audio entry from the matching audioGroup of the best stream-inf.
    var groupId = bestStreamInf.audioGroup;
    var entries = parsed.audioGroups[groupId] || [];
    var pickedEntry = null;
    var prefix = (voiceIndex < 10 ? '0' : '') + voiceIndex + '.';
    for (var k = 0; k < entries.length; k++) {
      if (entries[k].name && entries[k].name.indexOf(prefix) === 0) {
        pickedEntry = entries[k];
        break;
      }
    }
    if (!pickedEntry) {
      for (var k2 = 0; k2 < entries.length; k2++) {
        if (entries[k2].deflt) { pickedEntry = entries[k2]; break; }
      }
    }
    if (!pickedEntry && entries.length) pickedEntry = entries[0];
    if (!pickedEntry) return out.join('\n') + '\n';

    // Use ASCII-only constants for GROUP-ID/NAME/LANGUAGE to keep parser happy
    // (some Tizen AVPlayer revisions choke on non-ASCII attribute values).
    var simpleGroupId = 'aud';
    var simpleName    = 'Voice ' + voiceIndex;
    out.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="' + simpleGroupId +
             '",NAME="' + simpleName +
             '",LANGUAGE="' + (pickedEntry.lang || 'und') +
             '",DEFAULT=YES,AUTOSELECT=YES,URI="' + pickedEntry.uri + '"');

    // Single stream-inf referencing the audio group above.
    var parts = [];
    if (bestStreamInf.bandwidth)  parts.push('BANDWIDTH=' + bestStreamInf.bandwidth);
    if (bestStreamInf.resolution) parts.push('RESOLUTION=' + bestStreamInf.resolution);
    if (bestStreamInf.codecs)     parts.push('CODECS="' + bestStreamInf.codecs + '"');
    if (bestStreamInf.attrs['FRAME-RATE']) parts.push('FRAME-RATE=' + bestStreamInf.attrs['FRAME-RATE']);
    parts.push('AUDIO="' + simpleGroupId + '"');
    out.push('#EXT-X-STREAM-INF:' + parts.join(','));
    out.push(bestStreamInf.videoUri);

    return out.join('\n') + '\n';
  }

  /**
   * BLOB-TEST: Fetch master.m3u8, build reduced manifest, wrap in blob: URL.
   * Calls cb(blobUrl, dataUrl, reducedText) on success, cb(null, null, null) on failure.
   */
  function fetchAndReduceMaster(masterUrl, voiceIndex, cb) {
    Logger.info('blob-test', 'fetching master', { url: masterUrl, voiceIndex: voiceIndex });
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', masterUrl, true);
      xhr.timeout = 8000;
      xhr.onload = function () {
        if (xhr.status < 200 || xhr.status >= 300) {
          Logger.warn('blob-test', 'fetch non-2xx', { status: xhr.status });
          cb(null, null, null);
          return;
        }
        try {
          var parsed = parseHls4Master(xhr.responseText || '');
          var audioGroupCount = Object.keys(parsed.audioGroups).length;
          var firstGroupSize = audioGroupCount ? parsed.audioGroups[Object.keys(parsed.audioGroups)[0]].length : 0;
          Logger.info('blob-test', 'parsed master', {
            audioGroups: audioGroupCount,
            voicesPerGroup: firstGroupSize,
            streamInfs: parsed.streamInfs.length,
            subtitleGroups: Object.keys(parsed.subtitlesGroups).length
          });
          var reduced = buildReducedMaster(parsed, voiceIndex);
          // Log full reduced master content (it's small now — single stream-inf,
          // single audio rendition). Helps verify syntactic validity.
          Logger.info('blob-test', 'built reduced master', {
            length: reduced.length,
            full: reduced
          });
          var blobUrl = null;
          var dataUrl = null;
          try {
            var blob = new Blob([reduced], { type: 'application/vnd.apple.mpegurl' });
            blobUrl = URL.createObjectURL(blob);
            Logger.info('blob-test', 'blob URL created', { blobUrl: blobUrl });
          } catch (e) {
            Logger.warn('blob-test', 'blob creation failed', String(e));
          }
          try {
            // v1.0.29-data-test: try base64 form — some players are pickier.
            // Use unescape(encodeURIComponent(...)) → btoa to handle non-ASCII safely.
            var b64 = '';
            try { b64 = btoa(unescape(encodeURIComponent(reduced))); } catch (e) {}
            if (b64) {
              dataUrl = 'data:application/vnd.apple.mpegurl;base64,' + b64;
              Logger.info('blob-test', 'data URL ready (base64)', { length: dataUrl.length });
            } else {
              dataUrl = 'data:application/vnd.apple.mpegurl,' + encodeURIComponent(reduced);
              Logger.info('blob-test', 'data URL ready (urlencoded)', { length: dataUrl.length });
            }
          } catch (e) {
            Logger.warn('blob-test', 'data URL failed', String(e));
          }
          cb(blobUrl, dataUrl, reduced);
        } catch (e) {
          Logger.warn('blob-test', 'parse/build failed', String(e));
          cb(null, null, null);
        }
      };
      xhr.onerror   = function () { Logger.warn('blob-test', 'xhr error'); cb(null, null, null); };
      xhr.ontimeout = function () { Logger.warn('blob-test', 'xhr timeout'); cb(null, null, null); };
      xhr.send();
    } catch (e) {
      Logger.warn('blob-test', 'fetch setup failed', String(e));
      cb(null, null, null);
    }
  }

  function applyVoiceTrack(idx) {
    if (KP_BARE_MODE) {
      Logger.info('voice', 'BARE mode — skipping applyVoiceTrack');
      return false;
    }
    if (idx == null || idx < 0) return false;

    // ── Tizen native AVPlayer ─────────────────────────────────────────
    try {
      if (window.webapis && window.webapis.avplay && typeof window.webapis.avplay.getTotalTrackInfo === 'function') {
        var tracks = window.webapis.avplay.getTotalTrackInfo() || [];
        var audios = [];
        for (var i = 0; i < tracks.length; i++) {
          if (tracks[i] && (tracks[i].type === 'AUDIO' || tracks[i].type === 1)) {
            audios.push(tracks[i]);
          }
        }
        if (idx < audios.length) {
          var nativeIdx = (audios[idx].index != null) ? audios[idx].index : idx;
          window.webapis.avplay.setSelectTrack('AUDIO', nativeIdx);
          Logger.info('voice', 'switched via avplay', {
            idx: idx, nativeIdx: nativeIdx, total: audios.length
          });
          return true;
        }
        Logger.warn('voice', 'avplay: idx out of range', { idx: idx, total: audios.length });
      }
    } catch (e) {
      Logger.warn('voice', 'avplay setSelectTrack failed', String(e));
    }

    // ── HTML5 / hls.js ────────────────────────────────────────────────
    try {
      var video = document.querySelector('video');
      if (video) {
        // Try common attachment patterns. Lampa's bundle may not expose hls,
        // in which case this fails silently and the stream plays in default
        // audio track.
        var hls = video.__hls__ || video._hls || video.hls ||
                  (window.Lampa && window.Lampa.PlayerVideo && window.Lampa.PlayerVideo.hls);
        if (hls && typeof hls.audioTrack !== 'undefined') {
          hls.audioTrack = idx;
          Logger.info('voice', 'switched via hls.js', { idx: idx });
          return true;
        }
        // Native HTMLMediaElement.audioTracks (rare on TVs but spec'd)
        if (video.audioTracks && video.audioTracks.length > idx) {
          for (var t = 0; t < video.audioTracks.length; t++) {
            video.audioTracks[t].enabled = (t === idx);
          }
          Logger.info('voice', 'switched via HTMLMediaElement.audioTracks', { idx: idx });
          return true;
        }
      }
    } catch (e) {
      Logger.warn('voice', 'hls.js audioTrack failed', String(e));
    }

    Logger.warn('voice', 'no track switch backend available, stream stays on default audio');
    return false;
  }

  /**
   * Replaces the text of `.player-panel__next-episode-name` (where Lampa shows
   * "next episode title" hint near next/prev buttons) with the current voice
   * label. Per Eugene's request: that area is more useful for showing which
   * voice/dub is currently active than for previewing the next episode title
   * (which is already in the playlist popup).
   *
   * Implemented via MutationObserver because Lampa re-sets the text every time
   * PlayerPlaylist.set() fires — without observing we'd lose the override on
   * any playlist refresh / next-prev navigation.
   */
  var nextLabelObserver = null;
  function setupNextEpisodeLabelOverride() {
    if (KP_BARE_MODE) {
      Logger.info('player-ui', 'BARE mode — skipping next-episode-name override');
      return;
    }
    cleanupNextEpisodeLabelOverride(); // ensure single instance

    setTimeout(function () {
      var el = document.querySelector('.player-panel__next-episode-name');
      if (!el) {
        Logger.warn('player-ui', '.player-panel__next-episode-name not found in DOM (Lampa version may differ)');
        return;
      }

      function applyLabel() {
        if (!currentVoiceLabel) return;
        if (el.textContent === currentVoiceLabel) return;
        el.textContent = currentVoiceLabel;
        // ensure not hidden — Lampa hides this element when there's no next ep
        try { el.classList.remove('hide'); } catch (e) {}
      }

      applyLabel();

      try {
        nextLabelObserver = new MutationObserver(function () {
          // defer to let Lampa's update settle, then override
          setTimeout(applyLabel, 0);
        });
        nextLabelObserver.observe(el, {
          childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class']
        });
        Logger.info('player-ui', 'next-episode-name override active', { label: currentVoiceLabel });
      } catch (e) {
        Logger.warn('player-ui', 'MutationObserver setup failed', String(e));
      }
    }, 150);
  }

  function cleanupNextEpisodeLabelOverride() {
    if (nextLabelObserver) {
      try { nextLabelObserver.disconnect(); } catch (e) {}
      nextLabelObserver = null;
    }
  }

  /**
   * Returns the active Lampa player choice: 'tizen', 'lampa', 'inner', 'webos',
   * 'android', or '' if not set. Used by `auto` format resolution.
   */
  function detectActualPlayer(override) {
    if (override) return String(override).toLowerCase();
    try {
      var v = '';
      if (typeof Lampa.Storage.field === 'function') v = Lampa.Storage.field('player');
      if (!v) v = Lampa.Storage.get('player', '');
      return String(v || '').toLowerCase();
    } catch (e) { return ''; }
  }

  // Core 335 delegates these choices to the tvOS shell or another app.
  // Keep its registered adapters; web/Tizen recovery and track hooks do not
  // control these players. Infuse has its own signature-preserving path.
  function isAppleDelegatedPlayer(player) {
    return Lampa.Platform.is('apple_tv') &&
      ['tvospro', 'tvos', 'tvosl', 'tvosselect', 'vlc', 'senplayer', 'vidhub', 'svplayer']
        .indexOf(detectActualPlayer(player)) !== -1;
  }

  /**
   * Resolves the URL field key (http|hls|hls2|hls4) to use when picking a stream.
   *
   * Auto mode resolves to HLS2 universally as of v1.0.28, after diagnosis
   * showed HLS4 (fMP4 with multi-audio master playlists — 12 voices × 4
   * resolutions = 48 audio entries + subs) overloads the Tizen 9.0 AVPlayer
   * demuxer at 4K. Symptom was state=PLAYING with no video frames — looks
   * like a black screen with infinite loading. HLS2 (TS, single-audio per
   * stream → 2 tracks total) plays reliably including HEVC main10 4K.
   *
   * The Lampa built-in HTML5 player has always required HLS2 because Lampa
   * bundles an old hls.js that doesn't parse fMP4 segments.
   *
   * Both player paths therefore land on HLS2.
   */
  function useManifestProxy(player) {
    player = detectActualPlayer(player);
    var setting = formatOverride || Lampa.Storage.get(KEY_FORMAT, 'auto');
    return kpProxyAvailable === true && Lampa.Platform.is('tizen') &&
      ['tizen', 'lampa', 'inner', ''].indexOf(player) !== -1 &&
      (setting === 'auto' || setting === 'hls4');
  }

  function preferredFormat(player) {
    player = detectActualPlayer(player);
    if (player === 'infuse') return 'http';
    if (KP_BLOB_TEST) {
      // Legacy diagnostic — see KP_BLOB_TEST flag.
      return 'hls4';
    }
    if (useManifestProxy(player)) {
      // Proxy is up — request HLS4 from kinopub. Proxy will reduce it
      // to a single-audio master before player sees it.
      return 'hls4';
    }
    if (formatOverride) return formatOverride;
    var setting = Lampa.Storage.get(KEY_FORMAT, 'auto');
    if (setting && setting !== 'auto') return setting;

    // Auto: HLS2 for both Tizen native and Lampa-built-in.
    var resolved = 'hls2';
    var key = player + '|' + resolved;
    if (lastAutoFormatLogKey !== key) {
      Logger.info('format', 'auto resolved', { player: player || '(default)', format: resolved });
      lastAutoFormatLogKey = key;
    }
    return resolved;
  }

  function normalize(s) {
    s = String(s || '');
    // strip latin diacritics ("Léon" -> "Leon") if NFD is supported
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return s.toLowerCase().replace(/[^a-zЀ-ӿ0-9]/g, '');
  }

  /**
   * Pull a codec/format string from a kinopub audio entry. Different fields
   * have shown up across content: `codec`, `format.title`, `audio_codec`.
   */
  function audioCodec(a) {
    if (!a) return '';
    if (typeof a.codec === 'string') return a.codec;
    if (a.format && a.format.title)  return a.format.title;
    if (typeof a.audio_codec === 'string') return a.audio_codec;
    return '';
  }

  /**
   * Stable identifier for a kinopub audio track. Combines lang + type + author
   * + codec so that AC3 vs AAC variants of the same dub stay distinct.
   * Used as canonical "voice" handle in filter / storage.
   */
  function voiceKey(a) {
    if (!a) return '';
    var t  = (a.type   && a.type.title)   || '';
    var au = (a.author && a.author.title) || '';
    var c  = audioCodec(a);
    // v1.0.33-debug: include audio.index so codec-twins (same lang|type|
    // author|codec but different kinopub index — e.g. DOC s1e04 has audio
    // 03 and 04 both "Многоголосый 1W (RUS) AAC") stay DISTINCT in filter
    // sidebar + storage. When debug ends, restore production behaviour
    // (drop the index suffix → codec-twins collapse into a single entry).
    var idx = (typeof a.index === 'number') ? a.index : '';
    return (a.lang || '') + '|' + t + '|' + au + '|' + c + '|' + idx;
  }

  /**
   * "Chip-level" key — like voiceKey but WITHOUT codec. Used to dedupe chips
   * on episode cards: AAC and AC3 variants of the same dub collapse into one
   * chip (cleaner UI), and the chip is "active" if EITHER variant is the
   * current voice_key in storage.
   */
  function chipKey(a) {
    if (!a) return '';
    // v1.0.45: production dedup — codec-twins (same lang|type|author with
    // different codec or index) collapse into one chip per Eugene's spec.
    // voiceKey() retains codec+index so the filter sidebar / player tracks
    // list still show them separately.
    var t  = (a.type   && a.type.title)   || '';
    var au = (a.author && a.author.title) || '';
    return (a.lang || '') + '|' + t + '|' + au;
  }

  /**
   * Studios → short abbreviations for the chip badges on episode cards.
   * Unknown studios get an auto-fallback (first letters of words, then
   * first 4 chars).
   */
  var STUDIO_ABBR = {
    'AlexFilm':       'AF',
    'TVShows':        'TVS',
    'LostFilm':       'LF',
    'LE-Production':  'LE',
    'Red Head Sound': 'RHS',
    '1W':             '1W',
    'Кубик в Кубе':   'КвК',
    'Selena':         'SLN',
    'Fox Crime':      'FxC',
    'Foxlight':       'FxL'
  };

  /**
   * Voice TYPE → short label, used when there's no author and kinopub didn't
   * supply a `short_title` for the type.
   */
  var TYPE_SHORT = {
    'Многоголосый':       'MVO',
    'Двухголосый':        'DVO',
    'Одноголосый':        'AVO',
    'Дубляж':             'Дуб',
    'Оригинал':           'Orig',
    'Авторский':          'Авт',
    'Профессиональный':   'Pro'
  };

  /**
   * Voices matching ANY of these patterns are hidden from BOTH the source
   * filter sidebar AND the per-episode chips. Eugene's preference list.
   */
  var VOICE_HIDDEN_GLOBAL = [/UKR/i, /Пучков/i];

  /**
   * Hidden ONLY on episode cards (still pickable in sidebar filter — user can
   * select a "single-voice" / "auteur" / "original" track if they really want).
   */
  var VOICE_HIDDEN_CARDS = [/Одноголосый/i, /Авторский/i, /Оригинал/i];

  function audioCheckString(a) {
    if (!a) return '';
    return [
      a.lang || '',
      (a.type   && a.type.title)   || '',
      (a.author && a.author.title) || ''
    ].join(' ');
  }

  /**
   * Returns whether an audio track should appear in given context.
   * @param context 'sidebar' or 'card'
   *
   * v1.0.45: lang-based filter (per Eugene's spec).
   *   card    → lang === 'rus' only
   *   sidebar → lang === 'rus' OR type.short_title === 'Orig' (keep original
   *             so user can pick the source-language audio in the player)
   */
  function isVoiceVisible(a, context) {
    if (!a) return false;
    var lang = (a.lang || '').toLowerCase();
    var isRus = (lang === 'rus' || lang === 'ru');
    if (context === 'card')    return isRus;
    if (context === 'sidebar') return isRus || ((a.type && a.type.short_title) === 'Orig');
    return true;
  }

  /**
   * Short author/studio name. Uses STUDIO_ABBR map first, then auto-derives:
   *   "Red Head Sound" → "RHS" (initials, 2-4 words)
   *   "MyDubbingStudio" → "MyDu" (first 4 chars, single word)
   */
  function studioAbbr(name) {
    if (!name) return '';
    if (STUDIO_ABBR[name]) return STUDIO_ABBR[name];
    var words = String(name).split(/[\s\-.]+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 4) {
      return words.map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
    }
    return name.substring(0, 4);
  }

  /**
   * Build a single voice chip's textual content (just the inner label, no
   * HTML wrapper). Codec is INTENTIONALLY not appended — AAC and AC3 variants
   * of the same dub are grouped into a single chip (deduped by chipKey).
   *   <studio-or-type>[ <LANG>]
   * Examples: "AF", "AF EN", "MVO", "Orig EN".
   */
  function voiceChipText(a) {
    if (!a) return 'UNK';
    var author = (a.author && a.author.title) || '';
    var typeShort = (a.type && a.type.short_title) || '';
    var typeFull  = (a.type && a.type.title) || '';

    var primary;
    if (author) primary = studioAbbr(author);
    else if (typeShort) primary = typeShort;
    else if (typeFull)  primary = TYPE_SHORT[typeFull] || typeFull.substring(0, 3);
    else primary = 'UNK';

    // Cards already filter to lang === 'rus' (isVoiceVisible 'card'), so the
    // "non-rus suffix" branch below is effectively dead — kept for safety
    // if isVoiceVisible policy changes.
    var lang = (a.lang || '').toUpperCase();
    if (lang && lang !== 'RUS' && lang !== 'RU') {
      primary += ' ' + lang.substring(0, 3);
    }

    return primary;
  }

  /**
   * Build the voice-chips HTML for an episode card.
   *
   * Two indicator states (mutually exclusive, controlled by hasProgress):
   *   hasProgress === false  → chip with `is-active` class for activeKey
   *                            (soft green fill — "what plays if you click")
   *   hasProgress === true   → chip with `is-watched` class for watchedKey
   *                            (gray underline — "you watched this here")
   *
   * Dedupes by chipKey so AAC and AC3 variants of the same dub collapse into
   * one chip; the indicator triggers if EITHER variant matches the relevant
   * key. Card-level visibility filter applied (Оригинал/Одноголосый/Авторский
   * hidden on cards but visible in sidebar).
   */
  /**
   * v1.0.48: Air date formatter for episode info row.
   *   year === current  →  Lampa native "16 апреля"  (parseTime(...).full)
   *   year !== current  →  "d.mm.yyyy"
   * Falls back to original string on parse failure.
   */
  function formatAirDate(s) {
    if (!s) return '';
    var dt = new Date(s);
    if (isNaN(dt.getTime())) return String(s);
    var y = dt.getFullYear();
    var nowYear = new Date().getFullYear();
    if (y === nowYear) {
      try { return Lampa.Utils.parseTime(s).full; }
      catch (e) { return String(s); }
    }
    var d = dt.getDate();
    var m = dt.getMonth() + 1;
    var mm = m < 10 ? '0' + m : '' + m;
    return d + '.' + mm + '.' + y;
  }

  function voiceChipsHtml(audios, activeKey, watchedKey, hasProgress) {
    if (!audios || !audios.length) return '';

    // chipKey for codec-twin dedup is the first 3 fields of voiceKey
    // ("lang|type|author"). voiceKey is "lang|type|author|codec|index".
    function chipKeyFromVoiceKey(vk) {
      return String(vk || '').split('|').slice(0, 3).join('|');
    }

    // Pass 1: build visible chips deduped by chipKey. Active/watched flags
    // are set in Pass 2/3 at chipKey-level so codec-twins (same voice in
    // different codec/index) merge into one colored chip.
    var byChip = {};
    var order  = [];
    audios.forEach(function (a) {
      if (!isVoiceVisible(a, 'card')) return;
      var k = chipKey(a);
      if (!byChip[k]) {
        byChip[k] = { audio: a, isActive: false, isWatched: false, isForced: false };
        order.push(k);
      }
    });

    // Pass 2: mark watched chip — match at chipKey level so a chip stays
    // marked even when the user watched a codec-twin variant.
    if (watchedKey) {
      var wck = chipKeyFromVoiceKey(watchedKey);
      if (byChip[wck]) byChip[wck].isWatched = true;
    }

    // Pass 3: v1.0.49 — active voice handling at chipKey level, so green
    // marker survives codec/index drift across episodes.
    //   - Visible chip with same chipKey  → mark green active
    //   - Voice present in audios but filtered out (e.g. Orig hidden on
    //     cards) → do nothing (no red chip; filtered ≠ missing)
    //   - Voice not in audios at all      → force-add red "missing" chip
    //
    // v1.0.50: skip the red force-add entirely on episodes that already
    // show a gray "watched" chip. Per Eugene's spec, a watched episode's
    // gray chip is the frozen indicator — no green/red overlays change it
    // until that episode is replayed with a different voice.
    if (activeKey) {
      var ack = chipKeyFromVoiceKey(activeKey);
      if (byChip[ack]) {
        byChip[ack].isActive = true;
      } else {
        var hasGrayChip = hasProgress && order.some(function (k) { return byChip[k].isWatched; });
        if (!hasGrayChip) {
          var presentInEpisode = false;
          for (var ai = 0; ai < audios.length; ai++) {
            if (chipKey(audios[ai]) === ack) { presentInEpisode = true; break; }
          }
          if (!presentInEpisode) {
            var parts = String(activeKey).split('|');
            var fakeAudio = {
              lang:   parts[0] || '',
              type:   { title: parts[1] || '', short_title: '' },
              author: { title: parts[2] || '' },
              codec:  parts[3] || ''
            };
            byChip[ack] = { audio: fakeAudio, isActive: true, isWatched: false, isForced: true };
            order.push(ack);
          }
        }
      }
    }

    // Pass 4: v1.0.47 — sort so colored chips (active / watched / forced)
    // come first, default chips after. Stable for like-priority entries.
    function chipIndicatorClass(entry) {
      if (entry.isForced)                       return 'is-active-missing';
      if (hasProgress  && entry.isWatched)      return 'is-watched';
      if (!hasProgress && entry.isActive)       return 'is-active';
      return '';
    }
    order.sort(function (ka, kb) {
      var ac = chipIndicatorClass(byChip[ka]) ? 0 : 1;
      var bc = chipIndicatorClass(byChip[kb]) ? 0 : 1;
      return ac - bc;
    });

    return order.map(function (k) {
      var entry = byChip[k];
      var classes = ['kp-voice-chip'];
      var ind = chipIndicatorClass(entry);
      if (ind) classes.push(ind);
      return '<span class="' + classes.join(' ') + '">' + voiceChipText(entry.audio) + '</span>';
    }).join('');
  }

  /**
   * Re-renders voice chips for every visible episode card. Called on
   * Player/destroy so that episodes which just gained timeline.percent>0
   * switch from green sidebar-pick chip to faded "watched" chip without
   * waiting for the user to leave-and-reenter the source view.
   *
   * Each rendered card has `$(html).data('kp-card', {element, activeVoiceKey})`
   * stashed by component.draw() — we use it to know per-card context.
   */
  function refreshAllKpVoiceChips() {
    try {
      var watchedMap = Lampa.Storage.cache('kp_episode_voice', 5000, {});
      $('.online-prestige').each(function () {
        var $card = $(this);
        var data = $card.data('kp-card');
        if (!data || !data.element) return;
        var $voicesEl = $card.find('.kp-voices');
        if (!$voicesEl.length) return;
        var element = data.element;
        var hasProgress = !!(element.timeline && element.timeline.percent > 0);
        var watchedKey  = watchedMap[element.timeline_hash] || '';
        $voicesEl.html(voiceChipsHtml(
          (element.kp && element.kp.audios) || [],
          data.activeVoiceKey || '',
          watchedKey,
          hasProgress
        ));
      });
    } catch (e) { /* swallow — DOM-state-dependent */ }
  }

  /**
   * Pretty label for an audio track. Prefer kinopub's pre-formatted display
   * field if present (`name` / `title`) — those match the kinopub web UI
   * exactly. Otherwise construct from parts:
   *   "Многоголосый LostFilm [RUS]"
   *   "Многоголосый AlexFilm [RUS] (AC3)"
   *   "Оригинал [ENG]"
   */
  /**
   * v1.0.45: production voice label format (used in BOTH the filter sidebar
   * AND the in-player tracks list).
   *   "{NN} - {type.short_title|UNK} - {author.title|unknown}[ ({codec})]"
   *   - NN: audio.index padded to 2 digits with leading zero (or '??')
   *   - codec part: omitted when codec === 'aac' (it's the default)
   * Examples:
   *   "01 - AVO - Ю. Сербин"
   *   "12 - AVO - Ю. Сербин (ac3)"
   *   "11 - Orig - unknown"
   */
  function voiceLabel(a) {
    if (!a) return '';
    var idx = (typeof a.index === 'number' && a.index > 0)
              ? (a.index < 10 ? '0' + a.index : '' + a.index)
              : '??';
    var sht = (a.type && a.type.short_title) || 'UNK';
    var aut = (a.author && a.author.title) || 'unknown';
    var c   = audioCodec(a);
    var codecPart = (c && c.toLowerCase() !== 'aac') ? ' (' + c + ')' : '';
    return idx + ' - ' + sht + ' - ' + aut + codecPart;
  }

  /**
   * kinopub stores title as "Русское / Original" (single field, separator " / ").
   * Returns { rus, orig }; if no separator found, original is empty.
   */
  function splitKpTitle(t) {
    var s = String(t || '');
    var idx = s.indexOf(' / ');
    if (idx > 0) return { rus: s.slice(0, idx).trim(), orig: s.slice(idx + 3).trim() };
    return { rus: s, orig: '' };
  }

  function parseFiles(files) {
    if (!files || !files.length) return [];
    var arr = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var qs = f && (f.quality || f.q) || '';
      var qn = parseInt(String(qs).replace(/[^0-9]/g, ''), 10) || 0;
      if (!qn) continue;
      arr.push({
        quality: qn,
        label:   qs,
        urls:    f.urls || f.url || {},
        file:    typeof f.file === 'string' ? f.file : ''
      });
    }
    arr.sort(function (a, b) { return b.quality - a.quality; });
    return arr;
  }

  /**
   * Build a full quality dictionary {"720p": url, "1080p": url, ...}
   * usable by Lampa.Player.play({quality: ...})
   * Plus return the URL for the requested target quality (or the largest available <= maxQuality).
   */
  function pickStream(files, format, target, allowFileReference) {
    if (!files || !files.length) return null;
    // 'http' (progressive MP4) is intentionally NOT in any fallback list —
    // it freezes on Tizen players. Real auto resolution happens in
    // preferredFormat() before we get here, so 'auto' is just a defensive default.
    var fmtList = format === 'http' ? ['http'] : format === 'auto'
      ? ['hls4', 'hls2', 'hls']
      : [format, 'hls4', 'hls2', 'hls'];

    function pickUrl(u) {
      for (var i = 0; i < fmtList.length; i++) {
        var k = fmtList[i];
        if (u && (format === 'http' && allowFileReference ? infuseFileUrl(u[k]) : mediaUrl(u[k]))) return u[k];
      }
      return null;
    }

    var maxQ  = maxQuality();
    var avail = files.filter(function (f) {
      return f.quality <= maxQ && (pickUrl(f.urls) ||
        (format === 'http' && allowFileReference && f.file));
    });
    if (!avail.length && format !== 'http') avail = files.filter(function (f) { return pickUrl(f.urls); });
    if (!avail.length) return null;

    // sorted desc, so first is largest available
    var best = avail[0];
    if (target) {
      var tn = parseInt(String(target).replace(/[^0-9]/g, ''), 10);
      var pick = avail.find ? avail.find(function (f) { return f.quality === tn; })
                            : null;
      if (pick) best = pick;
      else if (format === 'http') return null;
    }

    var quality = {};
    avail.forEach(function (f) {
      var u = pickUrl(f.urls);
      if (u) quality[f.quality + 'p'] = u;
    });

    var url = pickUrl(best.urls);

    return {
      url: url,
      quality: quality,
      currentQuality: best.quality,
      label: best.label,
      file: best.file,
      delivery: url ? fmtList.find(function (fmt) { return best.urls[fmt] === url; }) : format
    };
  }

  // Offer only actual direct-file qualities, without resolving every file
  // or changing the saved quality limit/player. No speculative CDN probes.
  function infuseQualityOptions(files) {
    var seen = {};
    return (files || []).filter(function (file) {
      if (seen[file.quality] || !pickStream(files, 'http', file.quality + 'p', true)) return false;
      seen[file.quality] = true;
      return true;
    }).map(function (file) {
      return { title: file.quality + 'p', quality: file.quality + 'p' };
    });
  }

  function pickInfuseHls2Test(files, target) {
    // Select quality before checking delivery. No silent lower-quality,
    // HLS4 or HTTP fallback when HLS2 is absent from the selected file.
    var eligible = (files || []).filter(function (f) { return f.quality <= maxQuality(); });
    var selected = target ? eligible.find(function (f) {
      return f.quality === parseInt(String(target).replace(/[^0-9]/g, ''), 10);
    }) : eligible[0];
    if (!selected) return null;
    var url = infuseHls2TestUrl(selected.urls && selected.urls.hls2);
    if (!url && !selected.file) return null;
    return { url: url, file: selected.file, currentQuality: selected.quality, label: selected.label, delivery: 'hls2-test' };
  }

  function buildSubtitles(subs) {
    if (!subs || !subs.length) return [];
    return subs.map(function (s) {
      return {
        label: (s.lang || s.title || 'sub') + (s.shift ? ' (' + s.shift + 's)' : ''),
        url:   s.url
      };
    }).filter(function (s) { return !!s.url; });
  }

  function audioInfo(audios) {
    if (!audios || !audios.length) return '';
    var names = [];
    audios.forEach(function (a) {
      var t = (a.lang || '') + (a.type && a.type.title ? ' / ' + a.type.title : '');
      if (a.author && a.author.title) t += ' [' + a.author.title + ']';
      if (t.trim()) names.push(t.trim());
    });
    return names.slice(0, 3).join(', ');
  }

  /* ============================================================ *
   *  REGION SETUP                                                *
   *  kinopub bakes ?loc=<region> into stream URLs based on the   *
   *  device's serverLocation setting. Default for the xbmc       *
   *  client is NL → laggy CDN. We pick a fast region (RU/UA/BY)  *
   *  once after auth and write it back via POST /device/{id}/    *
   *  settings.                                                   *
   * ============================================================ */

  function pickPreferredLocation(items) {
    if (!items || !items.length) return null;
    // Prefer Russia → Ukraine → Belarus, but fall back to anything
    // whose name/location string suggests a CIS host.
    var order = [/^ru$/i, /^ua$/i, /^by$/i, /russ/i, /росс/i, /europe/i];
    for (var p = 0; p < order.length; p++) {
      var rx = order[p];
      for (var i = 0; i < items.length; i++) {
        var l = items[i];
        if (rx.test(l.location || '') || rx.test(l.name || '')) return l;
      }
    }
    return items[0];
  }

  /**
   * Run the full region-fixup pipeline. Idempotent.
   * cb(ok: bool, locationName: string).
   */
  function setupRegion(force, cb) {
    var done = function (ok, name) { try { cb && cb(!!ok, name || ''); } catch (e) {} };

    if (!force && Lampa.Storage.get('kp_region_set', '') === '1') {
      Logger.debug('region', 'already set, skipping');
      return done(true, Lampa.Storage.get('kp_region_name', ''));
    }
    if (!KP.hasToken()) {
      Logger.warn('region', 'no token, skipping');
      return done(false);
    }

    var net = new Lampa.Reguest();
    Logger.info('region', 'setup begin' + (force ? ' (forced)' : ''));

    KP.deviceInfo(net, function (info) {
      // server can return { device: {...} } OR flat { id, hardware, ... }
      var device = (info && info.device) ? info.device : info;
      var deviceId = device && (device.id || device.hardware);
      if (!deviceId) {
        Logger.error('region', 'no device id in /device/info', info);
        return done(false);
      }
      Logger.info('region', 'device id', { id: deviceId });

      KP.serverLocations(net, function (locs) {
        var items = (locs && (locs.items || locs.locations)) || (Array.isArray(locs) ? locs : []);
        if (!items.length) {
          Logger.warn('region', 'no server locations available', locs);
          return done(false);
        }
        Logger.debug('region', 'available locations', items.map(function (l) {
          return { id: l.id, location: l.location, name: l.name };
        }));

        var pick = pickPreferredLocation(items);
        if (!pick) return done(false);

        Logger.info('region', 'picking location', { id: pick.id, name: pick.name, location: pick.location });

        KP.saveDeviceSettings(net, deviceId, { serverLocation: pick.id }, function () {
          Lampa.Storage.set('kp_region_set', '1');
          Lampa.Storage.set('kp_region_name', pick.name || pick.location || '');
          Lampa.Storage.set('kp_region_id', String(pick.id));
          Logger.info('region', 'serverLocation applied', { id: pick.id });
          done(true, pick.name || pick.location || '');
        }, function (xhr, status) {
          Logger.error('region', 'saveDeviceSettings failed', { http: xhr && xhr.status, status: status });
          done(false);
        });
      }, function (xhr, status) {
        Logger.error('region', 'list locations failed', { http: xhr && xhr.status, status: status });
        done(false);
      });
    }, function (xhr, status) {
      Logger.error('region', 'deviceInfo failed', { http: xhr && xhr.status, status: status });
      done(false);
    });
  }

  /* ============================================================ *
   *  AUTH MODAL                                                  *
   * ============================================================ */

  var auth_state = { modalOpen: false, pingTimer: null, network: null };

  function closeAuthModal(reason) {
    if (auth_state.pingTimer) {
      clearInterval(auth_state.pingTimer);
      auth_state.pingTimer = null;
    }
    if (auth_state.network) {
      try { auth_state.network.clear(); } catch (e) {}
      auth_state.network = null;
    }
    if (auth_state.modalOpen) {
      auth_state.modalOpen = false;
      try { Lampa.Modal.close(); } catch (e) {}
    }
    Logger.info('auth', 'modal closed', { reason: reason || 'manual' });
  }

  function openAuthModal(onSuccess) {
    Logger.info('auth', 'starting device flow');
    auth_state.network = new Lampa.Reguest();

    var modal = $(
      '<div>' +
        '<div class="broadcast__text" style="text-align:center; line-height:1.4;">' +
          Lampa.Lang.translate('kp_auth_text') +
        '</div>' +
        '<div class="broadcast__device selector" ' +
            'style="text-align:center; margin-top: 1em; background-color: #333; color: #fff; padding: 0.6em 1em; font-size: 1.4em; letter-spacing: 0.2em;">' +
          Lampa.Lang.translate('kp_auth_wait') + '...' +
        '</div>' +
        '<div style="margin-top:1em; opacity:.7; text-align:center;">' +
          Lampa.Lang.translate('kp_auth_url') +
        '</div>' +
        '<br>' +
        '<div class="broadcast__scan"><div></div></div>' +
      '</div>'
    );

    var user_code = '';
    var device_code = '';

    // Show the Lampa.Modal only AFTER we receive user_code from kinopub.
    // Opening it synchronously here (during the kpapi constructor) makes
    // Lampa's activity-toggle close it as a side effect — same trick filmix uses.
    function showModal() {
      if ($('.modal').length) {
        Logger.warn('auth', 'modal already exists, skipping open');
        return;
      }
      var prevController = (Lampa.Controller.enabled() || {}).name || 'content';
      auth_state.modalOpen = true;
      Lampa.Modal.open({
        title: Lampa.Lang.translate('kp_auth_title'),
        html:  modal,
        size:  'medium',
        onBack: function () {
          closeAuthModal('back');
          Lampa.Controller.toggle(prevController);
        },
        onSelect: function () {
          if (!user_code) return;
          Lampa.Utils.copyTextToClipboard(user_code, function () {
            Lampa.Noty.show(Lampa.Lang.translate('kp_copied'));
          }, function () {
            Lampa.Noty.show(Lampa.Lang.translate('kp_copy_fail'));
          });
        }
      });
    }

    KP.deviceCode(auth_state.network, function (json) {
      device_code = json.code;
      user_code = json.user_code;
      var interval = (json.interval || 5) * 1000;
      modal.find('.selector').text(user_code);

      showModal();

      auth_state.pingTimer = setInterval(function () {
        if (!auth_state.modalOpen) return;
        KP.pollDeviceToken(auth_state.network, device_code, function () {
          closeAuthModal('ok');
          // Note: we do NOT touch device serverLocation here — kinopub has its
          // own per-device UI for that. Plugin only offers a manual trigger in
          // settings as a convenience.
          // Send device identity once we have token so kinopub UI shows
          // a friendly name instead of three "unknown".
          notifyDeviceIdentity(new Lampa.Reguest());
          if (onSuccess) {
            try { onSuccess(); } catch (e) { Logger.error('auth', 'onSuccess threw', String(e)); }
          } else {
            try {
              var active = Lampa.Activity.active();
              if (active) Lampa.Activity.replace(active);
            } catch (e) {
              Logger.warn('auth', 'activity replace failed after auth', String(e));
            }
          }
        }, function () {
          // pending - keep polling
        }, function () {
          closeAuthModal('error');
          Lampa.Noty.show(Lampa.Lang.translate('kp_auth_error'));
        });
      }, interval);
    }, function () {
      closeAuthModal('init_error');
      Lampa.Noty.show(Lampa.Lang.translate('kp_auth_error'));
    });
  }

  /* ============================================================ *
   *  SOURCE  kpapi                                               *
   * ============================================================ */

  function kpapi(component, _object) {
    var network = new Lampa.Reguest();
    var infuseNetwork = new Lampa.Reguest();
    var infuseGeneration = 0;
    var infuseLaunching = false;
    var infuseTrace = null;
    var infuseTimer = null;
    var sourceGeneration = 0, sourceTimer = null, destroyed = false;
    var object  = _object;

    var raw      = null;          // /v1/items/{id} response
    var extract  = null;          // normalized
    var choice   = { season: 0, voice: 0, voice_name: '' };
    var filterItems = {};
    var waitSimilars = false;
    var refreshHook = null;

    if (!KP.hasToken()) {
      Logger.info('source', 'no token, opening auth modal');
      openAuthModal(function () {
        // Re-trigger the activity so the new token is used.
        try {
          var active = Lampa.Activity.active();
          if (active) Lampa.Activity.replace(active);
        } catch (e) { Logger.warn('source', 'replace after auth failed', String(e)); }
      });
      component.loading(false);
      return;
    }

    /* ---------- public API expected by component ---------- */

    function beginSourceRequest() {
      cancelInfuseLaunch();
      network.clear();
      clearTimeout(sourceTimer);
      var generation = ++sourceGeneration, done = false;
      function settle() {
        if (destroyed || done || generation !== sourceGeneration) return false;
        done = true;
        clearTimeout(sourceTimer);
        return true;
      }
      sourceTimer = setTimeout(function () {
        if (!settle()) return;
        network.clear();
        component.doesNotAnswer();
      }, 18000);
      return settle;
    }

    this.search = function (_object_, similar) {
      Logger.info('source', 'search() with similar', similar && similar[0] && similar[0].id);
      object = _object_;
      if (similar && similar[0] && similar[0].id) this.find(similar[0].id);
    };

    this.searchByTitle = function (_object_, query) {
      if (destroyed) return;
      var self = this;
      object = _object_;

      var year = parseInt((object.movie.release_date || object.movie.first_air_date || '0000').slice(0, 4), 10);
      var orig = object.movie.original_name || object.movie.original_title || '';
      var rus  = object.movie.name || object.movie.title || '';
      // imdb id may live on the movie object itself or under external_ids
      var imdbRaw = object.movie.imdb_id ||
                    (object.movie.external_ids && object.movie.external_ids.imdb_id) ||
                    '';
      var imdbNum = imdbRaw ? parseInt(String(imdbRaw).replace(/^tt/i, ''), 10) : 0;
      // serial detection: TMDB tv-show carries `name` and `first_air_date`
      var isSerial = !!(object.movie.name || object.movie.first_air_date || object.movie.number_of_seasons);
      var typeFilter = isSerial ? 'serial' : 'movie';

      Logger.info('source', 'searchByTitle', {
        query: query, year: year, orig: orig, rus: rus,
        imdb: imdbRaw, imdbNum: imdbNum, type: typeFilter
      });

      var settle = beginSourceRequest();
      KP.search(network, query, typeFilter, function (json) {
        if (!settle()) return;
        var items = (json && json.items) || [];
        Logger.info('source', 'search ok', { count: items.length });

        if (items.length) {
          // log top-5 raw candidates so we can see what kinopub actually returned
          var preview = items.slice(0, 5).map(function (c) {
            return { id: c.id, title: c.title, year: c.year, type: c.type, imdb: c.imdb };
          });
          Logger.debug('source', 'top candidates', preview);
        }

        // Only a unique verified identity may open automatically. A lone
        // search hit, nearby year or another media type is not evidence.
        var matches = items.filter(function (c) {
          var candidateImdb = parseInt(c.imdb || 0, 10);
          var typeOk = isSerial ? /^(serial|docuserial|tvshow)$/i.test(c.type || '')
            : /^(movie|documovie|3d|concert)$/i.test(c.type || '');
          if (!typeOk) return false;
          if (imdbNum && candidateImdb) return imdbNum === candidateImdb;
          var t = splitKpTitle(c.title);
          var titleOk = (orig && normalize(t.orig) === normalize(orig)) ||
                        (rus && normalize(t.rus) === normalize(rus));
          return !!titleOk && year > 0 && parseInt(c.year || 0, 10) === year;
        });
        if (matches.length === 1) {
          self.find(matches[0].id);
        } else if (matches.length > 1) {
          // Multiple editions with the same identity need an explicit choice.
          waitSimilars = true;
          component.similars(matches.map(adaptSimilar));
          component.loading(false);
        } else {
          Lampa.Noty.show(Lampa.Lang.translate('kp_no_exact_match'));
          component.doesNotAnswer();
        }
      }, function (xhr, status) {
        if (!settle()) return;
        Logger.error('source', 'search error', { http: xhr && xhr.status, status: status });
        component.doesNotAnswer();
      });
    };

    this.find = function (id) {
      if (destroyed) return;
      var self = this;
      Logger.info('source', 'find() id=' + id);
      var settle = beginSourceRequest();
      KP.item(network, id, function (json) {
        if (!settle()) return;
        if (!json || !json.item || String(json.item.id) !== String(id)) {
          Logger.warn('source', 'item empty', json);
          component.doesNotAnswer();
          return;
        }
        try {
          success(json.item);
          component.loading(false);
        } catch (e) {
          Logger.error('source', 'parse error', { msg: String(e), stack: String(e && e.stack).slice(0, 600) });
          component.doesNotAnswer();
        }
      }, function (xhr, status) {
        if (!settle()) return;
        Logger.error('source', 'find error', { http: xhr && xhr.status, status: status });
        component.doesNotAnswer();
      });
    };

    this.extendChoice = function (saved) { Lampa.Arrays.extend(choice, saved, true); };

    this.reset = function () {
      cancelInfuseLaunch();
      Logger.debug('source', 'reset');
      component.reset();
      choice = { season: 0, voice: 0, voice_name: '' };
      if (raw) {
        extractData(raw);
        buildFilter();
        append(filtered());
      }
    };

    this.filter = function (type, a, b) {
      cancelInfuseLaunch();
      Logger.debug('source', 'filter change', { type: a.stype, index: b.index });
      choice[a.stype] = b.index;
      if (a.stype === 'voice') {
        choice.voice_name = filterItems.voice[b.index] || '';
        choice.voice_key  = (filterItems.voice_keys && filterItems.voice_keys[b.index]) || '';
        // Per-season-of-series memory of the picked voice. When the user
        // returns to this season later, it auto-restores. Other seasons of
        // the same series can have different defaults.
        if (choice.voice_key) {
          if (!choice.voices_by_season) choice.voices_by_season = {};
          if (typeof choice.season !== 'undefined' && choice.season !== null) {
            choice.voices_by_season[choice.season] = choice.voice_key;
          }
        }
        Logger.info('voice', 'user picked', { season: choice.season, name: choice.voice_name, key: choice.voice_key });
        // v1.0.66: push voice-sync to VPS (debounced)
        try { kpVoiceSyncOnChange(object.movie.id); } catch (e) {}
      }
      component.reset();
      buildFilter();
      append(filtered());
    };

    this.destroy = function () {
      destroyed = true;
      sourceGeneration++;
      clearTimeout(sourceTimer);
      cancelInfuseLaunch();
      if (window._kpRefreshFilterAndChips === refreshHook) window._kpRefreshFilterAndChips = null;
      refreshHook = null;
      Logger.debug('source', 'destroy');
      network.clear();
      raw = null;
      extract = null;
    };

    /* ---------- internal helpers ---------- */

    function cancelInfuseLaunch() {
      if (infuseLaunching) LaunchTrace.fail(infuseTrace, 'cancelled');
      infuseTrace = null;
      infuseGeneration++;
      infuseLaunching = false;
      clearTimeout(infuseTimer);
      infuseNetwork.clear();
    }

    function launchInfuse(item, items, targetQuality, delivery) {
      if (infuseLaunching || !raw || !raw.id) return;
      var hlsTest = delivery === 'hls2' && (Lampa.Platform.is('apple_tv') || Lampa.Platform.is('apple'));
      delivery = hlsTest ? 'hls2' : 'http';
      infuseLaunching = true;
      var trace = infuseTrace = LaunchTrace.start('infuse', item, raw);
      var generation = ++infuseGeneration;
      var kpId = raw.id;
      var stage = 'item';
      var started = Date.now();
      Logger.info('infuse', 'refreshing KinoPub links', { season: item.season, episode: item.episode });
      function fail(reason, status) {
        if (generation !== infuseGeneration || !infuseLaunching) return;
        infuseLaunching = false;
        clearTimeout(infuseTimer);
        LaunchTrace.fail(trace, reason === 'link refresh timed out' ? 'timeout' : 'prepare-error', status);
        Logger.warn('infuse', reason, { stage: stage, status: status });
        var code = stage === 'file' ? 'KP-I2' : 'KP-I1';
        Lampa.Noty.show(Lampa.Lang.translate(hlsTest ? 'kp_infuse_no_hls2' : 'kp_infuse_no_file') + ' [' + code +
          (numberValue(status) !== null ? ' HTTP ' + numberValue(status) : '') + ']');
      }
      // Bound each of the two API stages independently.
      function armTimeout() {
        clearTimeout(infuseTimer);
        infuseTimer = setTimeout(function () {
          fail('link refresh timed out');
          infuseNetwork.clear();
        }, 18000);
      }
      function submit(play) {
        stage = 'file';
        function handoff(url) {
          if (generation !== infuseGeneration || !infuseLaunching) return;
          if (!(hlsTest ? infuseHls2TestUrl(url) : infuseFileUrl(url))) { fail('resolver returned no suitable resource'); return; }
          play.url = url;
          play._kpLinkReadyAt = Date.now();
          play._kpPrepareMs = Date.now() - started;
          LaunchTrace.ready(trace, play);
          infuseLaunching = false;
          clearTimeout(infuseTimer);
          dispatchInfuse(play, trace);
        }
        if (play._kpFile) {
          Logger.info('infuse', 'resolving selected file', { quality: play._kpQuality });
          armTimeout();
          LaunchTrace.stage(trace, 'link');
          KP.mediaVideoLink(infuseNetwork, play._kpFile, function (result) {
            if (typeof result === 'string') { try { result = JSON.parse(result); } catch (e) {} }
            handoff(result && result.url);
          }, function (xhr) { fail('selected file resolution failed', xhr && xhr.status); }, delivery);
        } else handoff(play.url);
      }
      // The loaded card already identifies the selected movie file. Resolve
      // that exact file once, without fetching the same item a second time.
      // Episodes retain their item refresh for the upcoming playlist.
      // Freeze the actual choice before refreshing metadata. A reordered
      // list can contain another codec/file at the same resolution.
      var selectedPlay = toPlayElement(item, 'infuse', targetQuality, delivery, trace);
      if (!selectedPlay) { fail('no resource at selected quality'); return; }
      var playlistQuality = targetQuality;
      targetQuality = selectedPlay._kpQuality + 'p';
      if (item.kp.kind === 'movie') {
        var selectedMovie = selectedPlay;
        if (selectedMovie && selectedMovie._kpFile) { submit(selectedMovie); return; }
      }
      armTimeout();
      LaunchTrace.stage(trace, 'item');
      KP.item(infuseNetwork, kpId, function (json) {
        if (generation !== infuseGeneration || !infuseLaunching || stage !== 'item') return;
        LaunchTrace.stage(trace, 'build');
        var fresh = json && json.item;
        if (!fresh || String(fresh.id) !== String(kpId)) { fail('item identity mismatch'); return; }
        stage = 'file';
        function refreshed(element) {
          var video;
          if (element.kp.kind === 'episode') {
            var season = (fresh.seasons || []).find(function (s) {
              return numberValue(s.number) === numberValue(element.season);
            });
            video = season && (season.episodes || []).find(function (e, i) {
              var n = numberValue(e.number);
              return (n === null ? i + 1 : n) === numberValue(element.episode);
            });
          } else video = (fresh.videos || [])[0];
          if (!video) return null;
          var copy = {};
          Object.keys(element).forEach(function (key) { copy[key] = element[key]; });
          copy.kp = { kind: element.kp.kind, files: parseFiles(video.files),
            audios: video.audios || [], subtitles: video.subtitles || [] };
          if (element === item && selectedPlay._kpFile) {
            copy.kp.files = copy.kp.files.filter(function (f) { return f.file === selectedPlay._kpFile; });
          }
          return toPlayElement(copy, 'infuse', element === item ? targetQuality : playlistQuality, delivery);
        }
        var play = refreshed(item);
        if (!play) { fail('no resource at selected quality'); return; }
        if (hlsTest) { submit(play); return; }
        var playlist = [];
        var selected = items.indexOf(item);
        var incomplete = false;
        (item.kp.kind === 'episode' ? items.slice(Math.max(0, selected), Math.max(0, selected) + 40) : [item])
          .forEach(function (entry) {
            if (incomplete) return;
            var p = entry === item ? play : refreshed(entry);
            // Never jump across an episode with an unavailable link.
            if (p && (entry === item || infuseFileUrl(p.url))) playlist.push(p);
            else incomplete = true;
          });
        play.playlist = playlist;
        // Old URL-only movie responses still need the item refresh.
        submit(play);
        // Handoff is not a viewing event. No mark(), watched(), timeline
        // update or internal Lampa player hooks are run for Infuse.
      }, function (xhr) { fail('link refresh failed', xhr && xhr.status); });
    }

    function adaptSimilar(c) {
      // kinopub gives us `title` as "Русское / Original"; split for prettier display
      var t = splitKpTitle(c.title);
      return {
        id:           c.id,
        title:        t.rus || c.title,
        ru_title:     t.rus,
        en_title:     t.orig,
        orig_title:   t.orig,
        year:         c.year,
        start_date:   c.year,
        rating:       c.imdb_rating || c.kinopoisk_rating || c.rating,
        countries:    c.countries ? c.countries.map(function (x) { return typeof x === 'string' ? x : (x.title || x.name); }) : [],
        categories:   c.genres ? c.genres.map(function (x) { return typeof x === 'string' ? x : (x.title || x.name); }) : [],
        filmId:       c.id
      };
    }

    function success(item) {
      Logger.info('source', 'item loaded', {
        id: item.id, type: item.type,
        seasons: (item.seasons || []).length,
        videos:  (item.videos || []).length
      });
      // Dump first audio entry verbatim — helps diagnose missing label fields
      // (e.g. "(AC3)" suffix kinopub UI shows but our parser drops).
      try {
        var firstAudios = null;
        if (item.seasons && item.seasons.length && item.seasons[0].episodes && item.seasons[0].episodes.length) {
          firstAudios = item.seasons[0].episodes[0].audios;
        } else if (item.videos && item.videos.length) {
          firstAudios = item.videos[0].audios;
        }
        if (firstAudios && firstAudios.length) {
          Logger.debug('source', 'sample audio entry [0]', firstAudios[0]);
          if (firstAudios.length > 1) {
            Logger.debug('source', 'sample audio entry [1]', firstAudios[1]);
          }
        }
      } catch (e) { Logger.warn('source', 'audio sample dump failed', String(e)); }
      raw = item;
      extractData(item);
      buildFilter();
      append(filtered());
    }

    /**
     * Build a deduped, ordered voice list from a set of audio-track entries
     * (across one or more episodes). Returns [{ key, label }, ...] in
     * first-seen order. Applies sidebar visibility filter (UKR / Пучков
     * are hidden everywhere).
     */
    function voiceListFromAudios(audiosArrays) {
      var voiceMap = {};
      var order = [];
      (audiosArrays || []).forEach(function (audios) {
        (audios || []).forEach(function (a) {
          if (!isVoiceVisible(a, 'sidebar')) return;
          var key = voiceKey(a);
          if (voiceMap[key]) return;
          var label = voiceLabel(a) || ('Track ' + (order.length + 1));
          voiceMap[key] = { key: key, label: label };
          order.push(key);
        });
      });
      return order.map(function (k) { return voiceMap[k]; });
    }


    function extractData(item) {
      extract = { type: 'movie', seasons: [], movie: null };

      var hasSeasons = item.seasons && item.seasons.length;
      var hasVideos  = item.videos  && item.videos.length;

      if (hasSeasons) {
        extract.type = 'serial';
        extract.seasons = (item.seasons || []).map(function (s, seasonIndex) {
          var seasonNumber = numberValue(s.number);
          if (seasonNumber === null) seasonNumber = seasonIndex + 1;
          return {
            number:   seasonNumber,
            episodes: (s.episodes || []).map(function (ep, idx) {
              var episodeNumber = numberValue(ep.number);
              if (episodeNumber === null) episodeNumber = idx + 1;
              return {
                id:        ep.id || (seasonNumber + '_' + episodeNumber),
                number:    episodeNumber,
                title:     ep.title || '',
                thumb:     ep.thumbnail == null ? ep.thumb : ep.thumbnail,
                files:     parseFiles(ep.files),
                audios:    ep.audios || [],
                subtitles: ep.subtitles || []
              };
            })
          };
        });

        // Per-season voice count for diagnostics — actual filter list is
        // computed on demand in buildFilter() based on currently chosen season.
        var perSeasonVoices = extract.seasons.map(function (s) {
          return voiceListFromAudios(s.episodes.map(function (ep) { return ep.audios; })).length;
        });
        Logger.debug('source', 'extracted serial', {
          seasons: extract.seasons.length,
          totalEpisodes: extract.seasons.reduce(function (n, s) { return n + s.episodes.length; }, 0),
          voicesPerSeason: perSeasonVoices
        });
      } else if (hasVideos) {
        extract.type = 'movie';
        var v = item.videos[0];
        extract.movie = {
          files:     parseFiles(v.files),
          audios:    v.audios || [],
          subtitles: v.subtitles || []
        };

        Logger.debug('source', 'extracted movie', {
          files: extract.movie.files.length,
          audios: extract.movie.audios.length,
          subs: extract.movie.subtitles.length,
          voices: voiceListFromAudios([v.audios]).length
        });
      } else {
        Logger.warn('source', 'no playable structure in item', { id: item.id, type: item.type });
      }
    }

    function buildFilter() {
      filterItems = { season: [], voice: [], voice_keys: [] };

      // Voice list is built per-season for serials (matches kinopub web UI).
      // For movies it's based on the single video's audios.
      var voices = [];
      if (extract && extract.type === 'serial') {
        extract.seasons.forEach(function (s, i) {
          filterItems.season.push(Lampa.Lang.translate('torrent_serial_season') + ' ' + (s.number || i + 1));
        });
        var seasonIdx = (choice.season >= 0 && choice.season < extract.seasons.length) ? choice.season : 0;
        var season = extract.seasons[seasonIdx];
        if (season) {
          voices = voiceListFromAudios(season.episodes.map(function (ep) { return ep.audios; }));
        }
      } else if (extract && extract.type === 'movie' && extract.movie) {
        voices = voiceListFromAudios([extract.movie.audios]);
      }

      voices.forEach(function (v) {
        filterItems.voice.push(v.label);
        filterItems.voice_keys.push(v.key);
      });

      // Per-season-of-series voice memory. When user changes season, the
      // voice they had picked for THAT season takes priority over whatever
      // was saved as "current" voice_key (which was for the previous season).
      if (choice.voices_by_season && typeof choice.season !== 'undefined' && choice.season !== null) {
        var savedForSeason = choice.voices_by_season[choice.season];
        if (savedForSeason) {
          choice.voice_key = savedForSeason;
        }
      }

      // Restore the previously picked voice — priority order:
      //   1. per-(series+season) voice_key (already loaded into choice.voice_key above)
      //   2. legacy voice_name match (older saves)
      //   3. last-known index, then 0
      if (filterItems.voice_keys.length) {
        var inx = -1;
        if (choice.voice_key) {
          inx = filterItems.voice_keys.indexOf(choice.voice_key);
        }
        if (inx === -1 && choice.voice_name) {
          inx = filterItems.voice.map(function (v) { return v.toLowerCase(); })
                                 .indexOf(choice.voice_name.toLowerCase());
        }
        if (inx === -1) inx = (choice.voice >= 0 && choice.voice < filterItems.voice.length) ? choice.voice : 0;
        choice.voice      = inx;
        choice.voice_key  = filterItems.voice_keys[inx] || '';
        choice.voice_name = filterItems.voice[inx] || '';
      }

      component.filter(filterItems, choice);

      // v1.0.33: expose a refresh hook so Player/destroy listener can rebuild
      // the filter sidebar (and re-render episode chips) after an in-player
      // voice switch. Without this, the sidebar shows stale "Озвучка: ..."
      // because choice.voice_key was mutated externally by buildVoiceSwapCallback.
      refreshHook = window._kpRefreshFilterAndChips = function () {
        try { buildFilter(); } catch (e) { Logger.warn('voice', 'refresh buildFilter failed', String(e)); }
        try { append(filtered()); } catch (e) { Logger.warn('voice', 'refresh append failed', String(e)); }
        try { setTimeout(refreshAllKpVoiceChips, 50); } catch (e) {}
      };
    }

    function filtered() {
      if (!extract) return [];
      var fmt = preferredFormat();

      if (extract.type === 'serial') {
        var season = extract.seasons[choice.season];
        if (!season) return [];
        return season.episodes.map(function (ep) {
          var stream = pickStream(ep.files, fmt);
          return {
            kp:           { kind: 'episode', files: ep.files, audios: ep.audios, subtitles: ep.subtitles },
            episode:      ep.number,
            season:       season.number,
            thumb:        ep.thumb,
            tmdb_id:      sameSeries(raw, object.movie) ? tmdbSeriesId(object.movie, object.source) : null,
            // display title for the in-source episode list (filmix-style)
            title:        Lampa.Lang.translate('torrent_serial_episode') + ' ' + ep.number + (ep.title ? ' - ' + ep.title : ''),
            // raw episode name from kinopub — used by toPlayElement to build
            // clean player titles like "s1e3 Долгий день уходит в ночь"
            ep_title:     ep.title || '',
            quality:      stream ? (stream.currentQuality + 'p ') : '',
            _kpListedQuality: stream ? (stream.currentQuality + 'p ') : '',
            translation:  1,
            voice_name:   filterItems.voice[choice.voice] || '',
            // info row stays for rating/year (set in draw()). voices is built
            // in component.draw() because it depends on per-episode timeline
            // progress and the watched-voice memory.
            info:         '',
            voices:       ''
          };
        });
      } else if (extract.type === 'movie' && extract.movie) {
        var stream2 = pickStream(extract.movie.files, fmt);
        return [{
          kp:          { kind: 'movie', files: extract.movie.files, audios: extract.movie.audios, subtitles: extract.movie.subtitles },
          title:       (object.movie && (object.movie.title || object.movie.name)) || '',
          quality:     stream2 ? (stream2.currentQuality + 'p ') : '',
          _kpListedQuality: stream2 ? (stream2.currentQuality + 'p ') : '',
          translation: 1,
          voice_name:  filterItems.voice[choice.voice] || '',
          info:        '',
          voices:      ''
        }];
      }
      return [];
    }

    function streamForElement(element, target, player) {
      var fmt = preferredFormat(player);
      var stream = pickStream(element.kp.files, fmt, target, player === 'infuse');
      if (!stream) {
        Logger.warn('source', 'no stream picked', { kind: element.kp.kind, fmt: fmt });
        return null;
      }
      return stream;
    }

    /**
     * If the chosen format fails (fatal MediaError), fall through this chain
     * looking for any URL we haven't tried yet for the same file.
     */
    // 'http' is intentionally excluded — kinopub's progressive MP4 freezes on
    // every Tizen player tested. Falling back to it makes things worse, not better.
    var FALLBACK_CHAIN = ['hls4', 'hls2', 'hls'];

    function nextFallbackUrl(element, triedSet) {
      // pick best file <= maxQ
      var maxQ = maxQuality();
      var avail = (element.kp.files || []).filter(function (f) { return f.quality <= maxQ; });
      if (!avail.length) avail = element.kp.files || [];
      if (!avail.length) return null;
      var best = avail[0]; // already sorted desc
      for (var i = 0; i < FALLBACK_CHAIN.length; i++) {
        var fmt = FALLBACK_CHAIN[i];
        var url = best.urls && best.urls[fmt];
        if (url && !triedSet[url]) return { url: url, fmt: fmt, q: best.quality };
      }
      return null;
    }

    function toPlayElement(element, actualPlayer, targetQuality, delivery, trace) {
      actualPlayer = detectActualPlayer(actualPlayer);
      var delegated = isAppleDelegatedPlayer(actualPlayer);
      var hlsTest = actualPlayer === 'infuse' && delivery === 'hls2';
      // A label generated for HLS (or URL-only metadata) is not an explicit
      // quality choice. Resolve the maximum for the actual Apple destination.
      // Keep explicit context choices and legacy changed quality fields exact.
      var target = targetQuality;
      if (target == null && !((actualPlayer === 'infuse' || delegated) && element.quality === element._kpListedQuality)) target = element.quality;
      var stream = hlsTest ? pickInfuseHls2Test(element.kp.files, target) : streamForElement(element, target, actualPlayer);
      if (!stream) return null;
      if (delegated && (stream.currentQuality > maxQuality() ||
          (target && stream.currentQuality !== parseInt(String(target).replace(/[^0-9]/g, ''), 10)))) return null;
      LaunchTrace.selected(trace, stream);

      // Title formatting:
      //   serial episodes → "s1e03 - Долгий день уходит в ночь"  (used in
      //                                                            playlist popup)
      //   movies          → just the movie title
      // The MAIN player title gets a richer format (with series name) — that
      // override happens in the onEnter handler below, just before play().
      var displayTitle;
      if (element.season && element.episode) {
        var rawEpTitle = element.ep_title || '';
        var epPad = ('0' + element.episode).slice(-2);
        displayTitle = 's' + element.season + 'e' + epPad +
                       (rawEpTitle ? ' - ' + rawEpTitle : '');
      } else {
        displayTitle = element.title || '';
      }

      var play = {
        title:    displayTitle,
        url:      stream.url,
        quality:  stream.quality,
        timeline: element.timeline,
        callback: element.mark
      };

      if (delegated) {
        // Core Player.play otherwise replaces url from its remembered quality.
        // A successful app handoff is not evidence that the film was watched.
        delete play.quality;
        delete play.callback;
      }

      if (actualPlayer === 'infuse') {
        delete play.quality;
        delete play.callback;
        play._kpInfuse = true;
        play._kpInfuseHls2Test = hlsTest;
        play._kpQuality = stream.currentQuality;
        play._kpFile = stream.file;
        play.season = element.season;
        play.episode = element.episode;
        var seriesName = object.movie && (object.movie.name || object.movie.title) || '';
        var extension = !hlsTest && /\.(mp4|mkv|m4v|mov|ts)$/i.exec((stream.file || (stream.url || '').split('?')[0]).split('#')[0]);
        play.filename = (element.kp.kind === 'episode' ? seriesName + ' ' + displayTitle : displayTitle) +
          (extension ? '.' + extension[1] : '');
        if (Lampa.Storage.get(KEY_SUBS, false)) {
          // The documented interface accepts one subtitle URL per video,
          // but does not expose a timing-shift or audio-selection parameter.
          play.subtitles = buildSubtitles((element.kp.subtitles || []).filter(function (s) {
            return !s.shift && mediaUrl(s.url);
          }));
        }
        return play;
      }

      // ── Voice selection ────────────────────────────────────────────────
      // Filter is the canonical UI for picking voice (choice.voice_key).
      // For each episode we resolve which audio-track index in this episode's
      // `audios[]` corresponds to the chosen voice, then queue it via
      // pendingVoice for the PlayerVideo.canplay hook to apply via
      // setSelectTrack / hls.audioTrack — without restarting the stream.
      //
      // We still pass play.voiceovers but with ONE entry (the active voice).
      // Two reasons to keep at least one entry:
      //   1. Empty voiceovers on Tizen broke the player lifecycle in v1.0.12.
      //   2. Single entry keeps player UI showing the active voice as label.
      var player   = actualPlayer;
      var audios   = element.kp.audios || [];
      var voiceIdx = -1;
      var pickedLabel = '';
      if (choice && choice.voice_key) {
        for (var ai = 0; ai < audios.length; ai++) {
          if (voiceKey(audios[ai]) === choice.voice_key) {
            voiceIdx = ai;
            break;
          }
        }
      }
      if (voiceIdx === -1 && audios.length > 0) voiceIdx = 0;
      if (voiceIdx >= 0 && audios[voiceIdx]) {
        pickedLabel = voiceLabel(audios[voiceIdx]) || ('Track ' + (voiceIdx + 1));
      }
      // Stash voice index on play element so onEnter (which sees this play
      // before the playlist loop overwrites pendingVoice) can read the
      // CLICKED item's voice index without depending on pendingVoice.
      play._voiceIdx = voiceIdx;
      if (KP_BARE_MODE) {
        // BARE mode: do NOT set play.voiceovers, play.translate, pendingVoice
        // or currentVoiceLabel. Lampa receives a vanilla play-element. Voice
        // selection from the filter still affects WHICH stream URL we pass
        // (stream.url is built from choice.voice_key earlier), but no
        // post-play track manipulation happens.
        pendingVoice = null;
        currentVoiceLabel = '';
      } else {
        pendingVoice = (!delegated && voiceIdx >= 0)
          ? { idx: voiceIdx, label: pickedLabel, key: (choice && choice.voice_key) || '' }
          : null;

        // Keep the current-voice label fresh for the DOM override of
        // .player-panel__next-episode-name (see setupNextEpisodeLabelOverride).
        if (delegated) currentVoiceLabel = '';
        else if (pickedLabel) currentVoiceLabel = pickedLabel;

        if (voiceIdx >= 0) {
          if (useManifestProxy(player) && audios.length > 0) {
            // v1.0.31: Multi-entry voiceovers with onSelect callback.
            // Each voice is a different proxy URL (same kinopub master,
            // different voice query param). On click, Lampa runs onSelect
            // — we do a Lampa-native soft URL swap: destroy(true) +
            // url(newUrl, true) + reset timeline.continued. AVPlayer
            // reopens with the new audio rendition while the player
            // overlay persists. Brief flash, no full restart.
            //
            // v1.0.32: send kinopub `audio.index` to the proxy (matches the
            // NAME prefix "0N." in the master), NOT array position. kinopub
            // sometimes reorders audios[] (e.g. by user's account default
            // language) and array position drifts from master ordering.
            //
            // Two-pass build: first allocate plain entries, then attach
            // onSelect callbacks closing over the SHARED voiceovers array
            // ref so the callback can mutate .selected on all entries when
            // user picks a new voice in player UI.
            var vovers = audios.map(function (audio, idx) {
              var label    = voiceLabel(audio) || ('Track ' + (idx + 1));
              var kpIndex  = (typeof audio.index === 'number' && audio.index > 0) ? audio.index : (idx + 1);
              var proxyUrl = proxyUrlFor(stream.url, kpIndex, player);
              var akey     = voiceKey(audio);
              return {
                name:      label,
                url:       proxyUrl,
                index:     idx,
                voice_key: akey,
                'default': idx === voiceIdx,
                selected:  idx === voiceIdx,
                enabled:   idx === voiceIdx,
                _label:    label,
                _key:      akey
              };
            });
            // Second pass: attach onSelect closing over the array reference.
            // v1.0.66: pass object.movie.id so callback can push voice-sync.
            var _kpShowId = (object && object.movie && object.movie.id) || null;
            vovers.forEach(function (vo) {
              vo.onSelect = buildVoiceSwapCallback(vo._label, vo._key, vo.url, element, choice, vovers, _kpShowId);
              delete vo._label; delete vo._key;
            });
            play.voiceovers = vovers;
            play.translate = pickedLabel;
          } else {
            // Proxy unreachable (or no audios): fall back to single-entry
            // (legacy behaviour from v1.0.28). Voice picker shows just the
            // active voice as a static label, switching is via filter only.
            play.voiceovers = [{
              name:    pickedLabel,
              url:     stream.url,
              index:   voiceIdx,
              'default': true
            }];
            play.translate = pickedLabel;
          }
        }
      }

      var subsAttached = 0;
      var subsEnabled  = Lampa.Storage.get(KEY_SUBS, false);
      if (subsEnabled) {
        var subs = buildSubtitles(element.kp.subtitles);
        if (subs.length) {
          play.subtitles = subs;
          subsAttached = subs.length;
        }
      }

      // Lampa calls play.error(work, cb) on fatal MediaError. cb(reserveUrl)
      // makes the player retry with the new URL. We walk the format chain.
      var tried = {};
      tried[stream.url] = true;
      play.error = function (work, cb) {
        var nxt = nextFallbackUrl(element, tried);
        if (!nxt) {
          Logger.warn('player', 'no fallback URLs left', { tried: Object.keys(tried).length });
          if (cb) cb(false);
          return;
        }
        tried[nxt.url] = true;
        Logger.warn('player', 'falling back to ' + nxt.fmt, { url: nxt.url, q: nxt.q });
        Lampa.Noty.show(Lampa.Lang.translate('kp_fallback') + ': ' + nxt.fmt);
        if (cb) cb(nxt.url);
      };
      if (delegated) delete play.error;

      Logger.debug('player', 'play-element built', {
        title:    play.title,
        url:      play.url,
        q:        stream.currentQuality,
        voiceIdx: voiceIdx,
        voice:    pickedLabel,
        voicesAvailable: audios.length,
        player:   player || '(default)',
        subs:     subsAttached,
        subsAvailable: (element.kp.subtitles || []).length
      });
      return play;
    }

    function append(items) {
      Logger.debug('source', 'append items', { count: items.length });
      component.reset();
      component.draw(items, {
        similars: waitSimilars,
        onEnter: function (item, html, options) {
          var actualPlayer = detectActualPlayer(options && options.player);
          if (actualPlayer === 'infuse') { launchInfuse(item, items, options && options.quality, options && options.delivery); return; }
          cancelInfuseLaunch();
          var trace = LaunchTrace.start(actualPlayer, item, raw);
          var play = toPlayElement(item, actualPlayer, options && options.quality, undefined, trace);
          if (!play) {
            LaunchTrace.fail(trace, 'no-resource');
            Lampa.Noty.show(Lampa.Lang.translate('online_nolink'));
            return;
          }
          var playlist = [];
          var playlistSrc = []; // parallel array: source item per playlist entry
          if (item.season) {
            items.forEach(function (e) {
              var p = toPlayElement(e, actualPlayer, e === item && options ? options.quality : undefined);
              if (p) { playlist.push(p); playlistSrc.push(e); }
            });
          } else {
            playlist.push(play); playlistSrc.push(item);
          }

          // Override the MAIN player title with the rich format including the
          // series name. Playlist items keep the same "sNeMM - title" format
          // (built in toPlayElement) so the popup stays consistent.
          //   Main:     "Извне s1e03 - Долгий день уходит в ночь"
          //   Playlist: "s1e03 - Долгий день уходит в ночь"
          if (item.season && item.episode) {
            var seriesName = (object.movie &&
              (object.movie.name || object.movie.title || object.movie.original_name || object.movie.original_title)) || '';
            var rawEpTitle = item.ep_title || '';
            var epPad = ('0' + item.episode).slice(-2);
            play.title = (seriesName ? seriesName + ' ' : '') +
                         's' + item.season + 'e' + epPad +
                         (rawEpTitle ? ' - ' + rawEpTitle : '');
          }

          // Remember voice for this episode so the watched-indicator chip
          // can show on next visit. Saved per timeline_hash (set in draw()).
          if (item.season && pendingVoice && pendingVoice.key && item.timeline_hash) {
            try {
              var watchedMap = Lampa.Storage.cache('kp_episode_voice', 5000, {});
              watchedMap[item.timeline_hash] = pendingVoice.key;
              Lampa.Storage.set('kp_episode_voice', watchedMap);
              Logger.debug('voice', 'remembered for episode', {
                hash: item.timeline_hash, key: pendingVoice.key
              });
            } catch (e) { Logger.warn('voice', 'remember failed', String(e)); }
          }

          if (playlist.length > 1) play.playlist = playlist;
          Logger.info('player', 'launching', { url: play.url, playlist: playlist.length, title: play.title });
          if (isAppleDelegatedPlayer(actualPlayer)) {
            // The destination owns media requests. Do not fetch a manifest (or
            // an entire http video) in parallel just to populate a debug log.
            try {
              LaunchTrace.ready(trace, play);
              LaunchTrace.sent(trace, 'Lampa.Player.play', playlist.length);
              Lampa.Player.play(play);
              Lampa.Player.playlist(playlist);
            } catch (e) {
              LaunchTrace.fail(trace, 'dispatch-error');
              Logger.warn('player', 'Apple handoff failed', { stage: 'KP-A1', player: actualPlayer });
              Lampa.Noty.show(Lampa.Lang.translate('kp_player_handoff_error') + ' (KP-A1)');
            }
            return;
          }
          // Apple web playback also needs no parallel debug download. With
          // explicit http this unbounded text request can be the whole film.
          // Preserve the existing diagnostic behavior on other platforms.
          if (!Lampa.Platform.is('apple_tv')) dumpStreamManifest(play.url);

          if (useManifestProxy(actualPlayer)) {
            // Proxy is reachable — route the kinopub HLS4 master through it.
            // Proxy returns a reduced master (1 audio + best video stream-inf)
            // that Tizen AVPlayer demuxes in 2 tracks, no multi-audio crash.
            //
            // v1.0.32: send kinopub `audio.index` (1-based, matches master
            // NAME prefix "0N.") instead of array position + 1. Array order
            // may not match master order if kinopub returned audios[] sorted
            // by user's preferred language.
            var clickedVoiceIdx = (play && typeof play._voiceIdx === 'number') ? play._voiceIdx : -1;
            var clickedAudios   = (item && item.kp && item.kp.audios) || [];
            var clickedAudio    = (clickedVoiceIdx >= 0) ? clickedAudios[clickedVoiceIdx] : null;
            var voiceOneBased   =
                  (clickedAudio && typeof clickedAudio.index === 'number' && clickedAudio.index > 0)
                  ? clickedAudio.index
                  : (clickedVoiceIdx >= 0 ? (clickedVoiceIdx + 1) : 1);
            var originalUrl = play.url;

            // v1.0.73 rollback: no quality picker — just route through
            // proxy with voice index. play.quality is removed so Lampa
            // shows no picker (kinopub serves the same master for all
            // qualities anyway). To bring back picker, see memory
            // note [[project-kp-quality-picker]].
            var proxyUrl = proxyUrlFor(originalUrl, voiceOneBased, actualPlayer);
            delete play.quality;
            play.url = proxyUrl;
            Logger.info('proxy', 'launching via manifest-proxy', {
              voice: voiceOneBased,
              proxyHost: KP_PROXY_URL,
              originalHost: (function(){ try { return new URL(originalUrl).host; } catch(e){ return '?'; } })()
            });

            // ── v1.0.38: Wrap EVERY playlist entry, not just the clicked one ──
            // Lampa next/prev episode navigation in player picks the next
            // play-element from this playlist[] array as-is. If those still
            // hold ORIGINAL kinopub URLs, AVPlayer opens the full master with
            // 12 audio tracks → multi-audio Tizen demuxer crash (the v1.0.28
            // era bug). This was masked while user only entered episodes via
            // explicit click, but bites on auto-next and player-panel-next.
            //
            // Per-item: pick same voice (by audio.index match if present, else
            // same array position) and apply proxyUrlFor to its stream URL.
            try {
              for (var pi = 0; pi < playlist.length; pi++) {
                var ple = playlist[pi];
                if (!ple || ple === play) continue; // clicked already wrapped
                if (typeof ple.url !== 'string' || ple.url.indexOf(KP_PROXY_URL) === 0) continue;
                var srcItem  = playlistSrc[pi];
                var pleAudios = (srcItem && srcItem.kp && srcItem.kp.audios) || [];
                // Default to first audio (voice 1) for items without matching voice
                var pleVoiceOneBased = 1;
                if (clickedAudio) {
                  // Try to match by voice_key (lang|type|author|codec|index) → most stable.
                  // Falls back to clickedAudio.index, then to position-based.
                  var clickedKey = voiceKey(clickedAudio);
                  for (var ai = 0; ai < pleAudios.length; ai++) {
                    if (voiceKey(pleAudios[ai]) === clickedKey) {
                      pleVoiceOneBased = (typeof pleAudios[ai].index === 'number' && pleAudios[ai].index > 0)
                                         ? pleAudios[ai].index : (ai + 1);
                      break;
                    }
                  }
                  if (pleVoiceOneBased === 1 && typeof clickedAudio.index === 'number' && clickedAudio.index > 0) {
                    // No key match — fall back to clicked audio.index (may exist in this episode).
                    pleVoiceOneBased = clickedAudio.index;
                  }
                }
                // v1.0.73 rollback: drop quality picker for playlist items too.
                var pleProxyUrl = proxyUrlFor(ple.url, pleVoiceOneBased, actualPlayer);
                if (pleProxyUrl) {
                  delete ple.quality;
                  ple.url = pleProxyUrl;
                }
              }
              Logger.debug('proxy', 'playlist wrapped', { count: playlist.length, voice: voiceOneBased });
            } catch (ple_err) {
              Logger.warn('proxy', 'playlist wrap failed', String(ple_err));
            }

            Lampa.Player.play(play);
            Lampa.Player.playlist(playlist);
            if (item.mark) item.mark();
            return;
          }

          if (KP_BLOB_TEST) {
            // (Legacy diagnostic — see KP_BLOB_TEST flag above.)
            var clickedVoiceIdxBT = (play && typeof play._voiceIdx === 'number') ? play._voiceIdx : -1;
            var voiceOneBasedBT = (clickedVoiceIdxBT >= 0) ? (clickedVoiceIdxBT + 1) : 1;
            var originalUrlBT = play.url;
            fetchAndReduceMaster(originalUrlBT, voiceOneBasedBT, function (blobUrl, dataUrl) {
              delete play.quality;
              if (dataUrl) {
                play.url = dataUrl;
                Logger.info('blob-test', 'launching with data URL', { length: dataUrl.length });
              } else if (blobUrl) {
                play.url = blobUrl;
                Logger.info('blob-test', 'launching with blob URL', { blob: blobUrl });
              } else {
                play.url = originalUrlBT;
              }
              Lampa.Player.play(play);
              Lampa.Player.playlist(playlist);
              if (item.mark) item.mark();
            });
            return;
          }

          LaunchTrace.ready(trace, play);
          LaunchTrace.sent(trace, 'Lampa.Player.play', playlist.length);
          Lampa.Player.play(play);
          Lampa.Player.playlist(playlist);
          if (item.mark) item.mark();
        },
        onContextMenu: function (item, html, data, call) {
          var stream = streamForElement(item, item.quality);
          call({
            file:    stream ? stream.url : '',
            quality: stream ? stream.quality : null
          });
        }
      });
    }
  }

  /* ============================================================ *
   *  COMPONENT  online_kp                                        *
   *  (closely modelled on online_fxapi from filmix.js)           *
   * ============================================================ */

  function component(object) {
    var network = new Lampa.Reguest();
    var scroll  = new Lampa.Scroll({ mask: true, over: true });
    var files   = new Lampa.Explorer(object);
    var filter  = new Lampa.Filter(object);

    var sources = { kpapi: kpapi };
    var balanser = BALANSER;
    var source;
    var initialized;
    var last;
    var images = [];
    var imageJobs = [];
    var seasonJobs = [];
    var seasonCache = {};
    var renderGeneration = 0;
    var closed = false;
    var selected_id;
    var extended;

    var filter_translate = {
      season: Lampa.Lang.translate('torrent_serial_season'),
      voice:  Lampa.Lang.translate('torrent_parser_voice'),
      source: Lampa.Lang.translate('settings_rest_source')
    };

    this.initialize = function () {
      var self = this;
      source = this.createSource();
      if (!source) return;

      filter.onSearch = function (value) {
        Lampa.Activity.replace({ search: value, clarification: true });
      };
      filter.onBack = function () { self.start(); };
      filter.render().find('.selector').on('hover:enter', function () {});
      filter.onSelect = function (type, a, b) {
        if (type === 'filter') {
          if (a.reset) {
            if (extended) source.reset();
            else self.start();
          } else if (a.season_pick) {
            // v1.0.42: flat-list season entry (no submenu) — Lampa Filter
            // calls onSelect with just (type, a) and undefined b, so we
            // synthesize the b={index} expected by source.filter.
            source.filter(type, { stype: 'season' }, { index: a.season_idx });
          } else {
            source.filter(type, a, b);
          }
        } else if (type === 'sort') {
          Lampa.Select.close();
        }
      };

      if (filter.addButtonBack) filter.addButtonBack();
      filter.render().find('.filter--sort').remove();
      files.appendFiles(scroll.render());
      files.appendHead(filter.render());

      // v1.0.61: inline-style backstop with MutationObserver re-apply.
      // Lampa wraps the button text in an inner <div> that has its own
      // padding + semi-transparent white bg. With outer button having its
      // own bg/padding, focused state visually shows "pill within a pill".
      // Strip the inner div's own padding/margin/background so the OUTER
      // button is the only visible pill.
      try {
        function kpApplyBtnStyles(el) {
          var isFocus = el.classList.contains('focus');
          el.style.setProperty('margin', '0', 'important');
          el.style.setProperty('padding', '0.3em 1em', 'important');
          el.style.setProperty('font-size', '1.2em', 'important');
          el.style.setProperty('min-width', '0', 'important');
          el.style.setProperty('display', 'inline-flex', 'important');
          el.style.setProperty('align-items', 'center', 'important');
          el.style.setProperty('justify-content', 'center', 'important');
          el.style.setProperty('border-radius', '0.4em', 'important');
          el.style.setProperty('outline', 'none', 'important');
          el.style.setProperty('height', 'auto', 'important');
          el.style.setProperty('transform-origin', 'center center', 'important');
          if (el.classList.contains('filter--search')) {
            el.style.setProperty('margin-right', '0.8em', 'important');
          }
          if (isFocus) {
            // v1.0.63: explicit white bg — without it, the gray bg from a
            // previous unfocused render lingers (we never cleared it on
            // transition), giving a thin-halo-around-gray look instead of
            // a clean white pill.
            el.style.setProperty('background', '#fff', 'important');
            el.style.setProperty('box-shadow', '0 0 0 0.12em #fff', 'important');
            el.style.setProperty('transform', 'scale(1.04)', 'important');
          } else {
            // v1.0.62: explicit subtle gray fill for unfocused — Lampa's
            // default ".explorer__files .torrent-filter .simple-button:not(.focus) {
            // background: rgba(0,0,0,0.07) }" is barely visible on dark theme.
            el.style.setProperty('background', 'rgba(255,255,255,0.12)', 'important');
            el.style.setProperty('box-shadow', 'none', 'important');
            el.style.setProperty('transform', 'none', 'important');
          }
          // v1.0.61-63: kill inner element styling — Lampa adds padding +
          // semi-transparent bg to the text-holding child <div>, which
          // creates a visible "inner pill" inside our button. Also force
          // hide any svg (the search-button loupe) — its CSS display:none
          // rule loses to Lampa's specificity on some platforms.
          var children = el.children;
          for (var i = 0; i < children.length; i++) {
            var c = children[i];
            if (!c || !c.style) continue;
            if (c.tagName && c.tagName.toLowerCase() === 'svg') {
              c.style.setProperty('display', 'none', 'important');
              continue;
            }
            c.style.setProperty('padding', '0', 'important');
            c.style.setProperty('margin', '0', 'important');
            c.style.setProperty('background', 'transparent', 'important');
            c.style.setProperty('border', 'none', 'important');
            c.style.setProperty('box-shadow', 'none', 'important');
          }
        }
        var $btns = filter.render().find('.simple-button.filter--search,.simple-button.filter--filter');
        $btns.each(function () {
          var el = this;
          kpApplyBtnStyles(el);
          // Re-apply on any class/style mutation on the button OR its
          // children (Lampa may toggle inner div styling on focus too).
          var obs = new MutationObserver(function () {
            obs.disconnect();
            kpApplyBtnStyles(el);
            obs.observe(el, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
          });
          obs.observe(el, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
        });
        // Hide invisible back button (it leaves leading gap from its 1em margin)
        filter.render().find('.simple-button.filter--back').each(function () {
          this.style.setProperty('display', 'none', 'important');
        });
      } catch (e) { Logger.warn('filter-style', 'inline override failed', String(e)); }
      scroll.body().addClass('torrent-list');
      scroll.minus(files.render().find('.explorer__files-head'));
      this.search();
    };

    this.createSource = function () {
      try {
        return new sources[balanser](this, object);
      } catch (e) {
        Logger.error('component', 'createSource', String(e));
        return null;
      }
    };

    this.create = function () { return this.render(); };

    this.search = function () {
      this.activity.loader(true);
      this.find();
    };

    this.find = function () {
      if (source && source.searchByTitle) {
        this.extendChoice();
        var q = object.search || object.movie.original_title || object.movie.original_name ||
                object.movie.title || object.movie.name;
        Logger.info('component', 'find query=' + q);
        source.searchByTitle(object, q);
      }
    };

    this.getChoice = function (for_balanser) {
      var data = Lampa.Storage.cache('online_choice_' + (for_balanser || balanser), 3000, {});
      var save = data[selected_id || object.movie.id] || {};
      Lampa.Arrays.extend(save, {
        season: 0, voice: 0, voice_name: '', voice_key: '', voice_id: 0,
        voices_by_season: {},
        episodes_view: {}, movie_view: ''
      });
      return save;
    };

    this.extendChoice = function () {
      extended = true;
      if (source) source.extendChoice(this.getChoice());
    };

    this.saveChoice = function (choice, for_balanser) {
      var data = Lampa.Storage.cache('online_choice_' + (for_balanser || balanser), 3000, {});
      data[selected_id || object.movie.id] = choice;
      Lampa.Storage.set('online_choice_' + (for_balanser || balanser), data);
    };

    this.similars = function (json) {
      var self = this;
      json.forEach(function (elem) {
        var info = [];
        var year = ((elem.start_date || elem.year || '') + '').slice(0, 4);
        if (elem.rating && elem.rating !== 'null') info.push(Lampa.Template.get('online_prestige_rate', { rate: elem.rating }, true));
        if (year) info.push(year);
        if (elem.countries && elem.countries.length) info.push(elem.countries.join(', '));
        if (elem.categories && elem.categories.length) info.push(elem.categories.slice(0, 4).join(', '));
        var name = elem.title || elem.ru_title || elem.en_title;
        var orig = elem.orig_title || elem.en_title || '';
        elem.title = name + (orig && orig !== name ? ' / ' + orig : '');
        elem.time  = '';
        elem.info  = info.join('<span class="online-prestige-split">●</span>');
        var item = Lampa.Template.get('online_prestige_folder', elem);
        item.on('hover:enter', function () {
          self.activity.loader(true);
          self.reset();
          object.search_date = year;
          selected_id = elem.id;
          self.extendChoice();
          if (source && source.search) {
            source.search(object, [elem]);
          } else self.doesNotAnswer();
        }).on('hover:focus', function (e) {
          last = e.target;
          scroll.update($(e.target), true);
        });
        scroll.append(item);
      });
    };

    this.clearImages = function () {
      renderGeneration++;
      imageJobs.splice(0).forEach(function (cancel) { cancel(); });
      seasonJobs.splice(0).forEach(function (cancel) { cancel(); });
      images.forEach(function (img) {
        img.onerror = img.onload = null;
        if (img.removeAttribute) img.removeAttribute('src');
        else img.src = '';
      });
      images = [];
    };

    this.reset = function () {
      last = false;
      network.clear();
      this.clearImages();
      scroll.render().find('.empty').remove();
      scroll.clear();
    };

    this.loading = function (status) {
      if (status) this.activity.loader(true);
      else { this.activity.loader(false); this.activity.toggle(); }
    };

    this.filter = function (filter_items, choice) {
      var self = this;
      var select = [];
      // v1.0.42: removed "Сбросить фильтр" (was first entry).
      // v1.0.42: removed voice row from sidebar — voice selection happens
      // in player tracks list (soft-swap), not in the season sidebar.
      // v1.0.42: seasons flattened to one entry per season (no dropdown);
      // each is directly clickable; current season highlighted via selected.
      this.saveChoice(choice);
      if (filter_items.season && filter_items.season.length) {
        var need = self.getChoice();
        filter_items.season.forEach(function (name, i) {
          select.push({
            title:       name,
            season_pick: true,
            season_idx:  i,
            selected:    need.season === i
          });
        });
      }
      filter.set('filter', select);
      this.selected(filter_items);
    };

    this.selected = function (filter_items) {
      var need = this.getChoice(), select = [];
      // v1.0.51: minimalist filter button label — "Сезон 2 | MVO - LostFilm"
      //   - No "Сезон: " / "Перевод: " prefixes (icon-style implicit)
      //   - Voice strips leading "NN - " index prefix from the sidebar label
      //   - Two parts joined by " | "
      if (filter_items.season && filter_items.season.length >= 1) {
        select.push(filter_items.season[need.season]);
      }
      if (filter_items.voice && filter_items.voice.length >= 1 && need.voice >= 0 && need.voice < filter_items.voice.length) {
        var v = filter_items.voice[need.voice] || '';
        v = v.replace(/^\d{1,2}\s*-\s*/, ''); // strip "03 - " prefix
        select.push(v);
      }
      filter.chosen('filter', select);
      filter.chosen('sort', [balanser]);
      // v1.0.42: bypass Lampa's 25-char shortText truncation by writing the
      // full chosen text directly into the inner div of the filter button.
      try {
        var full = select.join(' | ');
        filter.render().find('.filter--filter > div').html(full || '').toggleClass('hide', !full);
      } catch (e) {}
    };

    this.getEpisodes = function (season, call, tmdbId) {
      season = numberValue(season);
      tmdbId = numberValue(tmdbId);
      if (tmdbId && season !== null && !closed) {
        var lang = Lampa.Storage.get('language', 'ru');
        var cacheKey = tmdbId + '|' + season + '|' + lang;
        var cached = seasonCache[cacheKey];
        if (cached && Date.now() - cached.at < 300000) { call(cached.episodes); return; }
        var finished = false;
        var timer = setTimeout(function () { done([]); }, 10000);
        function done(episodes) {
          if (finished || closed) return;
          finished = true;
          clearTimeout(timer);
          call(episodes);
        }
        seasonJobs.push(function () { finished = true; clearTimeout(timer); });
        var url = 'tv/' + tmdbId + '/season/' + season +
                  '?api_key=' + Lampa.TMDB.key() +
                  '&language=' + lang;
        var baseurl = Lampa.TMDB.api(url);
        network.timeout(10000);
        network['native'](baseurl, function (data) {
          if (finished || closed) return;
          if (!data || !Array.isArray(data.episodes) ||
              (data.season_number != null && numberValue(data.season_number) !== season)) { done([]); return; }
          seasonCache[cacheKey] = { at: Date.now(), episodes: data.episodes };
          done(data.episodes);
        }, function () { done([]); });
      } else call([]);
    };

    this.append = function (item) {
      item.on('hover:focus', function (e) { last = e.target; scroll.update($(e.target), true); });
      scroll.append(item);
    };

    this.watched = function (set) {
      var file_id = Lampa.Utils.hash(object.movie.number_of_seasons ? object.movie.original_name : object.movie.original_title);
      var watched = Lampa.Storage.cache('online_watched_last', 5000, {});
      if (set) {
        if (!watched[file_id]) watched[file_id] = {};
        Lampa.Arrays.extend(watched[file_id], set, true);
        Lampa.Storage.set('online_watched_last', watched);
      } else return watched[file_id];
    };

    this.draw = function (items, params) {
      var self = this;
      params = params || {};
      if (!items.length) return this.empty();

      if (closed) return;
      var generation = ++renderGeneration;
      var rows = [];
      var episodes = [];
      function current() { return !closed && generation === renderGeneration; }
        var viewed = Lampa.Storage.cache('online_view', 5000, []);
        var serial = object.movie.name ? true : false;
        var choice = self.getChoice();
        var fully  = window.innerWidth > 480;
        var scroll_to_element = false;
        var scroll_to_mark = false;
        // v1.0.44: collect each rendered html by index for the post-loop
        // focus algorithm (walk backwards to find the "current point").
        var htmlByIdx = [];
        var pctByIdx  = [];

        items.forEach(function (element, index) {
          var episode = serial && episodes.length && !params.similars
            ? findEpisode(episodes, element.season, element.episode)
            : false;
          var episode_num  = element.episode || index + 1;
          var episode_last = choice.episodes_view[element.season];
          Lampa.Arrays.extend(element, {
            info:    element.info || '',
            quality: element.quality || '',
            time:    Lampa.Utils.secondsToTime(((episode ? episode.runtime : object.movie.runtime) || 0) * 60, true)
          });

          var hash_timeline = Lampa.Utils.hash(element.season
            ? [element.season, element.episode, object.movie.original_title].join('')
            : object.movie.original_title);
          var hash_behold = Lampa.Utils.hash(element.season
            ? [element.season, element.episode, object.movie.original_title, element.voice_name].join('')
            : object.movie.original_title + element.voice_name);

          var info = [];
          element.timeline = Lampa.Timeline.view(hash_timeline);
          // Expose hash so onEnter can save remembered voice keyed by episode
          element.timeline_hash = hash_timeline;

          if (episode) {
            element.title = episode.name;
            if (episode.vote_average) info.push(Lampa.Template.get('online_prestige_rate', {
              rate: parseFloat(episode.vote_average + '').toFixed(1)
            }, true));
            // v1.0.48: wrap date in .kp-date so CSS can hold a stable column
            // width across episodes — chips block always starts at the same
            // x-offset regardless of how long any individual date renders.
            if (episode.air_date && fully) {
              info.push('<span class="kp-date">' + formatAirDate(episode.air_date) + '</span>');
            }
          } else if (object.movie.release_date && fully) {
            info.push('<span class="kp-date">' + formatAirDate(object.movie.release_date) + '</span>');
          }
          if (!serial && object.movie.tagline) info.push(object.movie.tagline);
          if (element.info) info.push(element.info);
          if (info.length) element.info = info.map(function (i) { return '<span>' + i + '</span>'; }).join('<span class="online-prestige-split">●</span>');

          // Build voice chips with full progress + watched-voice context.
          // Two indicator states (mutually exclusive):
          //   timeline.percent > 0 → show watched chip (gray underline)
          //   else                 → show active chip (soft green)
          var watchedMap   = Lampa.Storage.cache('kp_episode_voice', 5000, {});
          var watchedKey   = watchedMap[hash_timeline] || '';
          var hasProgress  = !!(element.timeline && element.timeline.percent > 0);
          element.voices = voiceChipsHtml(
            (element.kp && element.kp.audios) || [],
            (choice && choice.voice_key) || '',
            watchedKey,
            hasProgress
          );

          var html  = Lampa.Template.get('online_prestige_full', element);
          var loader = html.find('.online-prestige__loader');
          var image  = html.find('.online-prestige__img');

          if (!serial) {
            if (choice.movie_view === hash_behold) scroll_to_element = html;
          } else if (typeof episode_last !== 'undefined' && episode_last === episode_num) {
            scroll_to_element = html;
          }

          // v1.0.44: stash per-index html + progress pct for the post-loop
          // "current point" focus algorithm.
          if (serial) {
            htmlByIdx[index] = html;
            pctByIdx[index]  = (element.timeline && element.timeline.percent) || 0;
          }

          var img = html.find('img')[0];
          if (img) {
            images.push(img);
            var cancelImage = function () {};
            function updateImage(metadata) {
              cancelImage();
              var candidates = serial ? episodeImages(metadata, element.thumb) :
                [tmdbStillUrl(object.movie.backdrop_path)].filter(Boolean);
              image.removeClass('online-prestige__img--loaded');
              image.find('.online-prestige__episode-number').remove();
              cancelImage = loadImageCandidates(img, candidates, function (ok) {
                if (!current()) return;
                image.toggleClass('online-prestige__img--loaded', ok);
                loader.remove();
                if (!ok && serial) image.append('<div class="online-prestige__episode-number">' +
                  ('0' + episode_num).slice(-2) + '</div>');
              }, current);
              imageJobs.push(cancelImage);
            }
            updateImage(episode);
            rows.push({ element: element, html: html, updateImage: updateImage });
          }

          html.find('.online-prestige__timeline').append(Lampa.Timeline.render(element.timeline));

          if (viewed.indexOf(hash_behold) !== -1) {
            scroll_to_mark = html;
            html.find('.online-prestige__img').append('<div class="online-prestige__viewed">' + Lampa.Template.get('icon_viewed', {}, true) + '</div>');
          }

          element.mark = function () {
            viewed = Lampa.Storage.cache('online_view', 5000, []);
            if (viewed.indexOf(hash_behold) === -1) {
              viewed.push(hash_behold);
              Lampa.Storage.set('online_view', viewed);
              if (html.find('.online-prestige__viewed').length === 0) {
                html.find('.online-prestige__img').append('<div class="online-prestige__viewed">' + Lampa.Template.get('icon_viewed', {}, true) + '</div>');
              }
            }
            choice = self.getChoice();
            if (!serial) choice.movie_view = hash_behold;
            else choice.episodes_view[element.season] = episode_num;
            self.saveChoice(choice);
            self.watched({
              balanser: balanser,
              balanser_name: 'KinoPub',
              voice_id: choice.voice_id,
              voice_name: choice.voice_name || element.voice_name,
              episode: element.episode,
              season: element.season
            });
          };

          element.unmark = function () {
            viewed = Lampa.Storage.cache('online_view', 5000, []);
            if (viewed.indexOf(hash_behold) !== -1) {
              Lampa.Arrays.remove(viewed, hash_behold);
              Lampa.Storage.set('online_view', viewed);
              if (Lampa.Manifest.app_digital >= 177) Lampa.Storage.remove('online_view', hash_behold);
              html.find('.online-prestige__viewed').remove();
            }
          };

          element.timeclear = function () {
            element.timeline.percent = 0;
            element.timeline.time = 0;
            element.timeline.duration = 0;
            Lampa.Timeline.update(element.timeline);
            // Drop the remembered voice for this episode — episode is "fresh" now
            try {
              var wmap = Lampa.Storage.cache('kp_episode_voice', 5000, {});
              if (wmap[hash_timeline]) {
                delete wmap[hash_timeline];
                Lampa.Storage.set('kp_episode_voice', wmap);
              }
            } catch (e) {}
            // Repaint chips so the gray underline disappears and the green
            // sidebar-pick indicator takes over (now hasProgress = false).
            try {
              var voicesEl = html.find('.kp-voices');
              if (voicesEl.length) {
                var ch = self.getChoice();
                voicesEl.html(voiceChipsHtml(
                  (element.kp && element.kp.audios) || [],
                  (ch && ch.voice_key) || '',
                  '',
                  false
                ));
              }
            } catch (e) {}
          };

          // Stash element + active voice key on the DOM node so the global
          // refreshAllKpVoiceChips() (called on Player/destroy) can re-render
          // chips for cards that gained progress without a full source redraw.
          html.data('kp-card', { element: element, activeVoiceKey: choice.voice_key || '' });

          html.on('hover:enter', function () {
            if (object.movie.id) Lampa.Favorite.add('history', object.movie, 100);
            if (params.onEnter) params.onEnter(element, html, {});
          }).on('hover:focus', function (e) {
            last = e.target;
            if (params.onFocus) params.onFocus(element, html, {});
            scroll.update($(e.target), true);
          });

          if (params.onRender) params.onRender(element, html, {});

          self.contextMenu({
            html: html,
            element: element,
            onPlay: function (player, quality, delivery) {
              if (current() && params.onEnter) params.onEnter(element, html, { player: player, quality: quality, delivery: delivery });
            },
            onFile: function (call) {
              if (params.onContextMenu) params.onContextMenu(element, html, {}, call);
            },
            onClearAllMark: function () { items.forEach(function (e) { e.unmark(); }); },
            onClearAllTime: function () { items.forEach(function (e) { e.timeclear(); }); }
          });

          scroll.append(html);
        });

        // v1.0.44: "Current point" focus algorithm — walk backwards through
        // episodes to find the most recent one with progress, then decide
        // whether to focus there (in-progress, continue) or on the next
        // unwatched episode (last one fully done — start the next).
        // pct >= 90 ≈ effectively finished; 0 < pct < 90 = in-progress;
        // pct === 0 = not started ("непросмотренная").
        var focus_html = null;
        if (serial && htmlByIdx.length) {
          for (var bi = htmlByIdx.length - 1; bi >= 0; bi--) {
            var bp = pctByIdx[bi] || 0;
            if (bp >= 90) {
              // last fully-watched found → focus on the next unwatched if any.
              focus_html = htmlByIdx[bi + 1] || htmlByIdx[bi];
              break;
            } else if (bp > 0) {
              // last in-progress → continue watching here.
              focus_html = htmlByIdx[bi];
              break;
            }
            // pct === 0 keeps walking back.
          }
          // All zeros (nothing started yet) → focus on first episode.
          if (!focus_html) focus_html = htmlByIdx[0];
        }

        if (focus_html)             last = focus_html[0];
        else if (scroll_to_element) last = scroll_to_element[0];
        else if (scroll_to_mark)    last = scroll_to_mark[0];

        Lampa.Controller.enable('content');
      // Render immediately. One season request enriches all rows in place;
      // a timeout or error never blocks the episode list and is not cached.
      if (serial && !params.similars && items[0].tmdb_id) this.getEpisodes(items[0].season, function (data) {
        if (!current()) return;
        rows.forEach(function (row) {
          var metadata = findEpisode(data, row.element.season, row.element.episode);
          if (!metadata) return;
          if (metadata.name) row.html.find('.online-prestige__title').text(metadata.name);
          if (metadata.runtime) row.html.find('.online-prestige__time').text(Lampa.Utils.secondsToTime(metadata.runtime * 60, true));
          var info = [];
          if (metadata.vote_average) info.push(Lampa.Template.get('online_prestige_rate', {rate: Number(metadata.vote_average).toFixed(1)}, true));
          if (metadata.air_date && fully) info.push('<span class="kp-date">' + formatAirDate(metadata.air_date) + '</span>');
          if (row.element.info) info.push(row.element.info);
          row.html.find('.online-prestige__info').html(info.join('<span class="online-prestige-split">●</span>'));
          row.updateImage(metadata);
        });
      }, items[0].tmdb_id);
    };

    this.contextMenu = function (params) {
      params.html.on('hover:long', function () {
        function show(extra) {
          var enabled = Lampa.Controller.enabled().name;
          var menu = [];
          if (Lampa.Platform.is('webos'))   menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Webos',   player: 'webos' });
          if (Lampa.Platform.is('android')) menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Android', player: 'android' });
          if (Lampa.Platform.is('apple_tv') || Lampa.Platform.is('apple')) {
            menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Infuse', player: 'infuse' });
            menu.push({ title: Lampa.Lang.translate('kp_infuse_hls2_test'),
              subtitle: Lampa.Lang.translate('kp_infuse_hls2_hint'), infuseHls2Test: true });
            if (infuseQualityOptions(params.element.kp && params.element.kp.files).length) {
              menu.push({ title: Lampa.Lang.translate('kp_infuse_quality'), infuseQuality: true });
            }
          }
          menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Lampa', player: 'lampa' });
          menu.push({ title: Lampa.Lang.translate('online_video'), separator: true });
          menu.push({ title: Lampa.Lang.translate('kp_try_format'), kpformat: true });
          menu.push({ title: Lampa.Lang.translate('torrent_parser_label_title'),        mark: true });
          menu.push({ title: Lampa.Lang.translate('torrent_parser_label_cancel_title'), unmark: true });
          menu.push({ title: Lampa.Lang.translate('time_reset'),                         timeclear: true });
          if (extra) menu.push({ title: Lampa.Lang.translate('copy_link'), copylink: true });
          menu.push({ title: Lampa.Lang.translate('more'), separator: true });
          menu.push({ title: Lampa.Lang.translate('online_clear_all_marks'),     clearallmark: true });
          menu.push({ title: Lampa.Lang.translate('online_clear_all_timecodes'), timeclearall: true });
          Lampa.Select.show({
            title: Lampa.Lang.translate('title_action'),
            items: menu,
            onBack: function () { Lampa.Controller.toggle(enabled); },
            onSelect: function (a) {
              if (a.mark)         params.element.mark();
              if (a.unmark)       params.element.unmark();
              if (a.timeclear)    params.element.timeclear();
              if (a.clearallmark) params.onClearAllMark();
              if (a.timeclearall) params.onClearAllTime();
              Lampa.Controller.toggle(enabled);
              if (a.infuseHls2Test) {
                if (params.onPlay) params.onPlay('infuse', undefined, 'hls2');
                return;
              }
              if (a.infuseQuality) {
                Lampa.Select.show({
                  title: Lampa.Lang.translate('kp_infuse_quality'),
                  items: infuseQualityOptions(params.element.kp && params.element.kp.files),
                  onBack: function () { Lampa.Controller.toggle(enabled); },
                  onSelect: function (b) {
                    Lampa.Controller.toggle(enabled);
                    if (params.onPlay) params.onPlay('infuse', b.quality);
                  }
                });
                return;
              }
              if (a.player) {
                if (a.player !== 'infuse') Lampa.Player.runas(a.player);
                if (params.onPlay) params.onPlay(a.player);
                else params.html.trigger('hover:enter');
              }
              if (a.kpformat) {
                var formats = [
                  { title: 'HLS v4 (fMP4)', fmt: 'hls4' },
                  { title: 'HLS v2 (TS)',   fmt: 'hls2' },
                  { title: 'HLS',           fmt: 'hls' },
                  { title: Lampa.Lang.translate('kp_format_clear'), fmt: null }
                ];
                Lampa.Select.show({
                  title: Lampa.Lang.translate('kp_try_format'),
                  items: formats,
                  onBack: function () { Lampa.Controller.toggle(enabled); },
                  onSelect: function (b) {
                    formatOverride = b.fmt || null;
                    Logger.info('format', 'override set', { fmt: formatOverride });
                    Lampa.Controller.toggle(enabled);
                    params.html.trigger('hover:enter');
                  }
                });
                return;
              }
              if (a.copylink) {
                if (extra && extra.quality) {
                  var qual = [];
                  for (var k in extra.quality) qual.push({ title: k, file: extra.quality[k] });
                  Lampa.Select.show({
                    title: Lampa.Lang.translate('settings_server_links'),
                    items: qual,
                    onBack: function () { Lampa.Controller.toggle(enabled); },
                    onSelect: function (b) {
                      Lampa.Utils.copyTextToClipboard(b.file,
                        function () { Lampa.Noty.show(Lampa.Lang.translate('copy_secuses')); },
                        function () { Lampa.Noty.show(Lampa.Lang.translate('copy_error')); });
                    }
                  });
                } else if (extra && extra.file) {
                  Lampa.Utils.copyTextToClipboard(extra.file,
                    function () { Lampa.Noty.show(Lampa.Lang.translate('copy_secuses')); },
                    function () { Lampa.Noty.show(Lampa.Lang.translate('copy_error')); });
                }
              }
            }
          });
        }
        params.onFile(show);
      }).on('hover:focus', function () {
        if (Lampa.Helper) Lampa.Helper.show('online_file', Lampa.Lang.translate('helper_online_file'), params.html);
      });
    };

    this.empty = function () {
      var html = Lampa.Template.get('online_does_not_answer', {});
      html.find('.online-empty__buttons').remove();
      html.find('.online-empty__title').text(Lampa.Lang.translate('empty_title_two'));
      scroll.append(html);
      this.loading(false);
    };

    this.doesNotAnswer = function () {
      this.reset();
      var html = Lampa.Template.get('online_does_not_answer', { balanser: balanser });
      scroll.append(html);
      this.loading(false);
    };

    this.getLastEpisode = function (items) {
      var last_episode = 0;
      items.forEach(function (e) {
        if (typeof e.episode !== 'undefined') last_episode = Math.max(last_episode, parseInt(e.episode, 10));
      });
      return last_episode;
    };

    this.start = function () {
      if (Lampa.Activity.active().activity !== this.activity) return;
      if (!initialized) { initialized = true; this.initialize(); }
      Lampa.Background.immediately(Lampa.Utils.cardImgBackgroundBlur(object.movie));
      Lampa.Controller.add('content', {
        toggle: function () {
          Lampa.Controller.collectionSet(scroll.render(), files.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
        },
        up:    function () { if (Navigator.canmove('up'))    Navigator.move('up');    else Lampa.Controller.toggle('head'); },
        down:  function () { Navigator.move('down'); },
        right: function () { if (Navigator.canmove('right')) Navigator.move('right'); else filter.show(Lampa.Lang.translate('title_filter'), 'filter'); },
        left:  function () { if (Navigator.canmove('left'))  Navigator.move('left');  else Lampa.Controller.toggle('menu'); },
        gone:  function () {},
        back:  this.back
      });
      Lampa.Controller.toggle('content');
    };

    this.render  = function () { return files.render(); };
    this.back    = function () { Lampa.Activity.backward(); };
    this.pause   = function () {};
    this.stop    = function () {};
    this.destroy = function () {
      closed = true;
      network.clear();
      this.clearImages();
      files.destroy();
      scroll.destroy();
      if (source && source.destroy) source.destroy();
      // ensure no orphaned auth modal stays alive after activity closes
      if (auth_state.modalOpen) closeAuthModal('component_destroy');
    };
  }

  /* ============================================================ *
   *  TEMPLATES (CSS + DOM, copied from filmix style)             *
   * ============================================================ */

  function injectStyles() {
    Lampa.Template.add('online_prestige_css',
      "<style>" +
      ".online-prestige{position:relative;border-radius:.3em;background-color:rgba(0,0,0,0.3);display:flex;will-change:transform}" +
      ".online-prestige__body{padding:1.2em;line-height:1.3;flex-grow:1;position:relative}" +
      "@media screen and (max-width:480px){.online-prestige__body{padding:.8em 1.2em}}" +
      ".online-prestige__img{position:relative;width:13em;flex-shrink:0;min-height:8.2em}" +
      ".online-prestige__img>img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;border-radius:.3em;opacity:0;transition:opacity .3s}" +
      ".online-prestige__img--loaded>img{opacity:1}" +
      "@media screen and (max-width:480px){.online-prestige__img{width:7em;min-height:6em}}" +
      ".online-prestige__folder{padding:1em;flex-shrink:0}" +
      ".online-prestige__folder>svg{width:4.4em !important;height:4.4em !important}" +
      ".online-prestige__viewed{position:absolute;top:1em;left:1em;background:rgba(0,0,0,0.45);border-radius:100%;padding:.25em;font-size:.76em}" +
      ".online-prestige__viewed>svg{width:1.5em !important;height:1.5em !important}" +
      ".online-prestige__episode-number{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:2em}" +
      ".online-prestige__loader{position:absolute;top:50%;left:50%;width:2em;height:2em;margin-left:-1em;margin-top:-1em;background:url(./img/loader.svg) no-repeat center center;background-size:contain}" +
      ".online-prestige__head,.online-prestige__footer{display:flex;justify-content:space-between;align-items:center}" +
      ".online-prestige__timeline{margin:.8em 0}" +
      ".online-prestige__timeline>.time-line{display:block !important}" +
      ".online-prestige__title{font-size:1.7em;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}" +
      "@media screen and (max-width:480px){.online-prestige__title{font-size:1.4em}}" +
      ".online-prestige__time{padding-left:2em}" +
      ".online-prestige__info{display:flex;align-items:center}" +
      ".online-prestige__info>*{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}" +
      ".online-prestige__quality{padding-left:1em;white-space:nowrap}" +
      ".online-prestige .online-prestige-split{font-size:.8em;margin:0 1em;flex-shrink:0}" +
      ".online-prestige.focus::after{content:'';position:absolute;top:-0.6em;left:-0.6em;right:-0.6em;bottom:-0.6em;border-radius:.7em;border:solid .3em #fff;z-index:-1;pointer-events:none}" +
      ".online-prestige+.online-prestige{margin-top:1.5em}" +
      ".online-prestige--folder .online-prestige__footer{margin-top:.8em}" +
      ".online-prestige-rate{display:inline-flex;align-items:center}" +
      ".online-prestige-rate>svg{width:1.3em !important;height:1.3em !important}" +
      ".online-prestige-rate>span{font-weight:600;font-size:1.1em;padding-left:.7em}" +
      ".online-empty{line-height:1.4}" +
      ".online-empty__title{font-size:2em;margin-bottom:.9em}" +
      ".online-empty-template{background-color:rgba(255,255,255,0.3);padding:1em;display:flex;align-items:center;border-radius:.3em}" +
      ".online-empty-template>*{background:rgba(0,0,0,0.3);border-radius:.3em}" +
      ".online-empty-template__ico{width:4em;height:4em;margin-right:2.4em}" +
      ".online-empty-template__body{height:1.7em;width:70%}" +
      ".online-empty-template+.online-empty-template{margin-top:1em}" +
      ".online-empty__templates .online-empty-template:nth-child(2){opacity:.5}" +
      ".online-empty__templates .online-empty-template:nth-child(3){opacity:.2}" +
      // — voice chips inline in footer (kp.js v1.0.20) ————————————
      // v1.0.48: info shrinks to its content width; .kp-date inside info
      // gets a min-width that fits the longest reasonable date in either
      // language ("31 Сентября" — 11 chars; "31.12.2024" — 10 chars), so
      // chips block always starts at the same x-position across episodes.
      // Quality flush-right via margin-left:auto.
      ".online-prestige__footer{justify-content:flex-start}" +
      ".online-prestige__info{flex:0 1 auto;min-width:0;overflow:hidden}" +
      ".kp-date{display:inline-block;min-width:5.5em}" +
      ".kp-voices{display:flex;flex-wrap:wrap;justify-content:flex-start;gap:.3em;" +
        "margin:0 .8em 0 .8em;flex:1 1 auto;line-height:1.2}" +
      ".kp-voices:empty{display:none}" +
      ".online-prestige__quality{flex-shrink:0;padding-left:0;margin-left:auto}" +
      ".kp-voice-chip{display:inline-block;padding:.2em .55em;background:rgba(255,255,255,0.10);" +
        "border-radius:.3em;border:1px solid transparent;font-size:.78em;white-space:nowrap;" +
        "color:rgba(255,255,255,0.85)}" +
      // is-active = sidebar pick on a fresh (zero-progress) episode.
      // Soft green fill — "this is what plays if you click".
      ".kp-voice-chip.is-active{background:rgba(110,200,110,0.28);" +
        "border-color:rgba(110,200,110,0.6);color:#e6ffe6;font-weight:600}" +
      // v1.0.47: is-active-missing = forced chip for the active voice when
      // it's not naturally in the visible list (e.g. user picked Orig/non-rus
      // and card-level filter hid it). Pale red, parallels the green active.
      ".kp-voice-chip.is-active-missing{background:rgba(220,110,110,0.28);" +
        "border-color:rgba(220,110,110,0.6);color:#ffe6e6;font-weight:600}" +
      // is-watched = remembered voice for an in-progress / completed episode.
      // v1.0.47: match the filter button (.simple-button.filter--filter) look —
      // soft white translucent pill with light text — so watched stands quiet
      // next to the bright is-active green. Style follows the green/red shape.
      ".kp-voice-chip.is-watched{background:rgba(255,255,255,0.22);" +
        "border-color:rgba(255,255,255,0.40);" +
        "color:#fff;font-weight:600}" +
      // — v1.0.42: widen "Filter" button on the season page ~3× ─────────
      // Default Lampa filter-button is sized for short chosen text; with
      // longer "Сезон: Сезон N" labels it gets visibly truncated. We
      // increase min-width and lift the inner div's overflow so text fits.
      ".filter--filter{min-width:24em}" +
      ".filter--filter > div{max-width:none;overflow:visible;white-space:nowrap;text-overflow:clip}" +
      // — v1.0.51-56: minimalist top filter bar ──────────────────────────
      // Class chain selectors needed: Lampa stylesheet uses
      // `.simple-button.simple-button--filter` (specificity 0,2,0) plus
      // !important — must match or exceed that to override.
      ".filter--search > svg{display:none !important}" +
      ".filter--filter > span{display:none !important}" +
      ".simple-button.simple-button--filter.filter--search," +
      ".simple-button.simple-button--filter.filter--filter{" +
        "font-size:1.2em !important;" +
        "display:inline-flex !important;" +
        "align-items:center !important;" +
        "justify-content:center !important;" +
        "padding:.4em 1em !important;" +
        "margin:0 !important;" +
        "border-radius:.4em !important;" +
        "transform-origin:center center !important;" +
        "outline:none !important}" +
      // Inter-button gap (right-margin only on first; second has no margin)
      ".simple-button.simple-button--filter.filter--search{margin-right:.4em !important}" +
      ".simple-button.simple-button--filter.filter--search *," +
      ".simple-button.simple-button--filter.filter--filter *{" +
        "font-size:inherit !important;line-height:inherit !important}" +
      // v1.0.65: removed min-width on filter--filter — was making the
      // button visually wider than its content+padding, leaving more
      // space-around-text than the search button (which had no min-width).
      // Both buttons now size purely by content + padding (1em horizontal).
      // Focus: kill Lampa outline + scale 1.06 only (padding stays put)
      ".simple-button.simple-button--filter.filter--search.focus," +
      ".simple-button.simple-button--filter.filter--filter.focus{" +
        "padding:.4em 1em !important;" +
        "outline:none !important;" +
        "box-shadow:0 0 0 .12em #fff !important;" +
        "transform:scale(1.06) !important}" +
      ".simple-button.simple-button--filter.filter--search.focus::after," +
      ".simple-button.simple-button--filter.filter--filter.focus::after{display:none !important}" +
      // Back button (filter--back) — also reset margin in case it leaks gap
      ".simple-button.filter--back{margin:0 .4em 0 0 !important}" +
      "</style>");
    $('body').append(Lampa.Template.get('online_prestige_css', {}, true));
  }

  function resetTemplates() {
    Lampa.Template.add('online_prestige_full',
      '<div class="online-prestige online-prestige--full selector">' +
        '<div class="online-prestige__img"><img alt=""><div class="online-prestige__loader"></div></div>' +
        '<div class="online-prestige__body">' +
          '<div class="online-prestige__head">' +
            '<div class="online-prestige__title">{title}</div>' +
            '<div class="online-prestige__time">{time}</div>' +
          '</div>' +
          '<div class="online-prestige__timeline"></div>' +
          '<div class="online-prestige__footer">' +
            '<div class="online-prestige__info">{info}</div>' +
            '<div class="kp-voices">{voices}</div>' +
            '<div class="online-prestige__quality">{quality}</div>' +
          '</div>' +
        '</div>' +
      '</div>');
    Lampa.Template.add('online_does_not_answer',
      '<div class="online-empty">' +
        '<div class="online-empty__title" style="font-size: 2em; margin-bottom: .9em;">#{online_balanser_dont_work}</div>' +
        '<div class="online-empty__templates">' +
          '<div class="online-empty-template"><div class="online-empty-template__ico"></div><div class="online-empty-template__body"></div></div>' +
          '<div class="online-empty-template"><div class="online-empty-template__ico"></div><div class="online-empty-template__body"></div></div>' +
          '<div class="online-empty-template"><div class="online-empty-template__ico"></div><div class="online-empty-template__body"></div></div>' +
        '</div>' +
      '</div>');
    Lampa.Template.add('online_prestige_rate',
      '<div class="online-prestige-rate">' +
        '<svg width="17" height="16" viewBox="0 0 17 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
          '<path d="M8.39409 0.192139L10.99 5.30994L16.7882 6.20387L12.5475 10.4277L13.5819 15.9311L8.39409 13.2425L3.20626 15.9311L4.24065 10.4277L0 6.20387L5.79819 5.30994L8.39409 0.192139Z" fill="#fff"></path>' +
        '</svg><span>{rate}</span>' +
      '</div>');
    Lampa.Template.add('online_prestige_folder',
      '<div class="online-prestige online-prestige--folder selector">' +
        '<div class="online-prestige__folder">' +
          '<svg viewBox="0 0 128 112" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<rect y="20" width="128" height="92" rx="13" fill="white"/>' +
            '<path d="M29.9963 8H98.0037C96.0446 3.3021 91.4079 0 86 0H42C36.5921 0 31.9555 3.3021 29.9963 8Z" fill="white" fill-opacity="0.23"/>' +
            '<rect x="11" y="8" width="106" height="76" rx="13" fill="white" fill-opacity="0.51"/>' +
          '</svg>' +
        '</div>' +
        '<div class="online-prestige__body">' +
          '<div class="online-prestige__head">' +
            '<div class="online-prestige__title">{title}</div>' +
            '<div class="online-prestige__time">{time}</div>' +
          '</div>' +
          '<div class="online-prestige__footer">' +
            '<div class="online-prestige__info">{info}</div>' +
          '</div>' +
        '</div>' +
      '</div>');
  }

  /* ============================================================ *
   *  SETTINGS UI                                                 *
   * ============================================================ */

  function addSettings() {
    // ensure default values exist so they appear in storage
    if (Lampa.Storage.get(KEY_MAX_QUAL, '') === '') Lampa.Storage.set(KEY_MAX_QUAL, '1080');
    // Default migration history:
    //   v1: '' → no value
    //   v2: '' → 'http' (was wrong — laggy on Tizen)
    //   v3: → 'hls4' (still wrong — broken on Lampa-built-in player)
    //   v4: → 'auto'  (smart pick by player type: tizen → hls4, else → hls2)
    //   v5: → 'auto'  (auto now resolves to hls2 universally — see v1.0.28
    //         diagnosis. HLS4 multi-track demux overloads Tizen AVPlayer at 4K.)
    if (Lampa.Platform.is('tizen') && Lampa.Storage.get('kp_format_migrated_v4', '') !== '1') {
      if (!Lampa.Storage.get(KEY_FORMAT, '')) Lampa.Storage.set(KEY_FORMAT, 'auto');
      Lampa.Storage.set('kp_format_migrated_v4', '1');
    }
    if (Lampa.Platform.is('tizen') && Lampa.Storage.get('kp_format_migrated_v5', '') !== '1') {
      // Force-reset anyone explicitly on 'hls4' (or stuck on 'auto' which
      // previously meant hls4 on Tizen) back to 'auto'. The previous explicit
      // hls4 choice was based on plugin guidance that turned out to be wrong.
      if (Lampa.Storage.get(KEY_FORMAT, '') === 'hls4') {
        Lampa.Storage.set(KEY_FORMAT, 'auto');
      }
      Lampa.Storage.set('kp_format_migrated_v5', '1');
    }
    if (Lampa.Storage.get(KEY_FORMAT, '') === '') Lampa.Storage.set(KEY_FORMAT, 'auto');
    // 'http' option was removed in v1.0.11 — progressive MP4 freezes on Tizen.
    // Reset anyone explicitly stuck on it.
    if (Lampa.Platform.is('tizen') && Lampa.Storage.get(KEY_FORMAT, '') === 'http') Lampa.Storage.set(KEY_FORMAT, 'auto');

    if (!Lampa.SettingsApi) {
      Logger.warn('settings', 'Lampa.SettingsApi unavailable on this build, skipping settings');
      return;
    }

    Lampa.SettingsApi.addComponent({
      component: 'kp',
      name:      'KinoPub',
      icon: '<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<rect x="6" y="14" width="52" height="36" rx="4" stroke="currentColor" stroke-width="3"/>' +
            '<polygon points="27,24 27,40 41,32" fill="currentColor"/></svg>'
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: KEY_LOG_URL, type: 'input', values: '', "default": '' },
      field: { name: Lampa.Lang.translate('kp_set_log_url'),  description: Lampa.Lang.translate('kp_set_log_url_descr') },
      onChange: function () { Logger.reload(); }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: {
        name: KEY_MAX_QUAL, type: 'select',
        values: { '480': '480p', '720': '720p', '1080': '1080p', '1440': '1440p', '2160': '2160p' },
        "default": '1080'
      },
      field: { name: Lampa.Lang.translate('kp_set_max_quality'), description: Lampa.Lang.translate('kp_set_max_quality_descr') }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: {
        name: KEY_FORMAT, type: 'select',
        values: {
          'auto': Lampa.Lang.translate('kp_set_format_auto'),
          'hls4': 'HLS v4 (fMP4)',
          'hls2': 'HLS v2 (TS)',
          'hls':  'HLS'
        },
        "default": 'auto'
      },
      field: { name: Lampa.Lang.translate('kp_set_format'), description: Lampa.Lang.translate('kp_set_format_descr') }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: KEY_PROXY, type: 'input', values: '', "default": '' },
      field: { name: Lampa.Lang.translate('kp_set_proxy'), description: Lampa.Lang.translate('kp_set_proxy_descr') }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: KEY_SUBS, type: 'trigger', "default": false },
      field: { name: Lampa.Lang.translate('kp_set_subs'), description: Lampa.Lang.translate('kp_set_subs_descr') }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: 'kp_action_infuse_check', type: 'trigger', "default": false },
      field: { name: Lampa.Lang.translate('kp_infuse_check'), description: Lampa.Lang.translate('kp_infuse_check_descr') },
      onChange: showInfuseDiagnostic
    });

    if (Lampa.Platform.is('apple_tv') || Lampa.Platform.is('apple')) {
      Lampa.SettingsApi.addParam({
        component: 'kp',
        param: { name: KEY_LAUNCH_TRACE, type: 'trigger', "default": false },
        field: { name: Lampa.Lang.translate('kp_trace_enable'), description: Lampa.Lang.translate('kp_trace_descr') },
        onChange: LaunchTrace.clear
      });
      Lampa.SettingsApi.addParam({
        component: 'kp',
        param: { name: 'kp_action_launch_trace', type: 'trigger', "default": false },
        field: { name: Lampa.Lang.translate('kp_trace_report'), description: Lampa.Lang.translate('kp_trace_descr') },
        onChange: LaunchTrace.show
      });
    }

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: 'kp_action_logout', type: 'trigger', "default": false },
      field: { name: Lampa.Lang.translate('kp_set_logout'), description: Lampa.Lang.translate('kp_set_logout_descr') },
      onChange: function () {
        KP.clearTokens();
        Logger.info('settings', 'tokens cleared by user');
        Lampa.Noty.show(Lampa.Lang.translate('kp_logged_out'));
      }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: 'kp_action_login', type: 'trigger', "default": false },
      field: { name: Lampa.Lang.translate('kp_set_login'), description: Lampa.Lang.translate('kp_set_login_descr') },
      onChange: function () { openAuthModal(); }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp',
      param: { name: 'kp_action_region', type: 'trigger', "default": false },
      field: { name: Lampa.Lang.translate('kp_set_region'), description: Lampa.Lang.translate('kp_set_region_descr') },
      onChange: function () {
        Lampa.Noty.show(Lampa.Lang.translate('kp_region_running'));
        setupRegion(true, function (ok, name) {
          Lampa.Noty.show(ok
            ? Lampa.Lang.translate('kp_region_done') + ': ' + name
            : Lampa.Lang.translate('kp_region_fail'));
        });
      }
    });
  }

  /* ============================================================ *
   *  STARTUP                                                     *
   * ============================================================ */

  function launchActivity(movie) {
    var ruTitle = (movie && (movie.title || movie.name)) || '';
    var origTitle = (movie && (movie.original_title || movie.original_name)) || '';
    Logger.info('launch', 'open activity', { id: movie && movie.id, title: ruTitle, orig: origTitle });
    Lampa.Activity.push({
      url:        '',
      title:      Lampa.Lang.translate('kp_online_title'),
      component:  COMPONENT_NAME,
      search:     ruTitle,
      search_one: ruTitle,
      search_two: origTitle,
      movie:      movie,
      page:       1
    });
  }

  function kinoPubCardButton(extraClass) {
    // Lampa hashes the source markup to remember a pinned button. Keep the
    // version out of it: updating the plugin must not change that identity.
    return $('<div class="full-start__button selector ' + extraClass + '" data-subtitle="KinoPub">' +
      '<svg width="135" height="147" viewBox="0 0 135 147" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M121.5 96.8823C139.5 86.49 139.5 60.5092 121.5 50.1169L41.25 3.78454C23.25 -6.60776 0.750004 6.38265 0.750001 27.1673L0.75 51.9742C4.70314 35.7475 23.6209 26.8138 39.0547 35.7701L94.8534 68.1505C110.252 77.0864 111.909 97.8693 99.8725 109.369L121.5 96.8823Z" fill="currentColor"/>' +
        '<path d="M63 84.9836C80.3333 94.991 80.3333 120.01 63 130.017L39.75 143.44C22.4167 153.448 0.749999 140.938 0.75 120.924L0.750001 94.0769C0.750002 74.0621 22.4167 61.5528 39.75 71.5602L63 84.9836Z" fill="currentColor"/>' +
      '</svg><span>KinoPub</span></div>');
  }

  function mountKinoPubCard(e) {
    var movie = e && e.data && e.data.movie;
    if (!e) return;
    var holder = e.body || (e.object && e.object.activity && e.object.activity.render());
    if (!holder || !holder.find) return;
    var start = e.link && e.link.items && e.link.items[0];
    var previous = holder[0] && holder[0]._kpCardControls;
    if (previous) previous.onDestroy();
    holder.find('.view--kinopub, .kp-card-direct').remove();
    if (!movie) return;
    var alive = true, opening = false, observer = null, originalEmit = null, wrappedEmit = null;
    function open() {
      if (!alive || (originalEmit && opening)) return;
      opening = !!originalEmit;
      resetTemplates();
      Lampa.Component.add(COMPONENT_NAME, component);
      try { launchActivity(movie); } catch (err) { opening = false; throw err; }
    }
    var source = kinoPubCardButton('view--online view--kinopub').on('hover:enter', open);
    var sources = holder.find('.buttons--container').first();
    var visible = holder.find('.full-start-new__buttons, .full-start__buttons').first();
    var watch = holder.find('.button--play').first();
    var directWatch = Lampa.Platform.is('apple_tv') && (watch.length || sources.length);
    if (sources.length) {
      // Lampa 335 groups these direct children under Watch -> Sources.
      sources.append(source);
    } else if (!directWatch && visible.length) {
      // Layouts without a Watch button retain the original source entry.
      visible.append(source);
    } else if (!directWatch) {
      holder.find('.full-start__button').first().after(source);
    }
    if (directWatch) {
      var bindWatch = function () {
        if (!alive) return;
        // User requested Watch -> KinoPub, not an extra button or source menu.
        // Core rebinds hover:enter on each groupButtons (including return).
        // Replace only activation; preserve its focus and navigation handlers.
        var currentWatch = holder.find('.button--play').first();
        if (watch[0] !== currentWatch[0]) watch.off('.kpWatch');
        watch = currentWatch;
        watch.off('hover:enter').on('hover:enter.kpWatch', open).removeClass('hide');
        holder.find('.button--priority.view--kinopub, .kp-card-direct').remove();
      };
      var controls = {
        onDestroy: function () {
          if (!alive) return;
          alive = false;
          watch.off('.kpWatch');
          source.off('hover:enter');
          if (observer) observer.disconnect();
          if (start && wrappedEmit && start.emit === wrappedEmit) start.emit = originalEmit;
          if (start && typeof start.unuse === 'function') start.unuse(controls);
          if (holder[0] && holder[0]._kpCardControls === controls) delete holder[0]._kpCardControls;
          if (start && start._kpCardControls === controls) start._kpCardControls = null;
        }
      };
      if (start && typeof start.use === 'function' && typeof start.unuse === 'function') {
        start._kpCardControls = controls;
        start.use(controls);
        // Emit runs modules in registration order (including onlyEvent).
        // A later module can undo an onGroupButtons binding. Reconcile after
        // the entire instance event, without changing global core/prototypes.
        if (typeof start.emit === 'function') {
          originalEmit = start.emit;
          wrappedEmit = function (name) {
            if (name === 'destroy') controls.onDestroy();
            var result = originalEmit.apply(this, arguments);
            if (alive && (name === 'groupButtons' || name === 'priorityButton' || name === 'toggle')) {
              if (name !== 'priorityButton') opening = false;
              bindWatch();
            }
            return result;
          };
          start.emit = wrappedEmit;
        }
      }
      if (holder[0]) holder[0]._kpCardControls = controls;
      // Covers asynchronously replaced buttons in alternative card layouts.
      // childList only: our handler/class updates cannot feed an observer loop.
      if (window.MutationObserver && holder[0]) {
        observer = new window.MutationObserver(bindWatch);
        observer.observe(holder[0], {childList: true, subtree: true});
      }
      bindWatch();
    }
  }

  function startPlugin() {
    var manifest = {
      type:        'video',
      version:     PLUGIN_VERSION,
      name:        'KinoPub',
      description: 'Источник kinopub для Lampa (Tizen-friendly)',
      component:   COMPONENT_NAME,
      onContextMenu: function () {
        return { name: Lampa.Lang.translate('kp_watch'), description: '' };
      },
      onContextLauch: function (object) {
        resetTemplates();
        Lampa.Component.add(COMPONENT_NAME, component);
        launchActivity(object);
      }
    };
    Lampa.Manifest.plugins = manifest;

    Lampa.Lang.add({
      kp_watch: {
        ru: 'Смотреть на kinopub',
        en: 'Watch on kinopub',
        ua: 'Дивитися на kinopub'
      },
      kp_no_exact_match: { ru: 'Точное совпадение в KinoPub не найдено. Другой фильм или сериал не выбран.', en: 'No exact KinoPub match. No different title was selected.', ua: 'Точного збігу в KinoPub не знайдено.' },
      kp_online_title: { ru: 'KinoPub', en: 'KinoPub', ua: 'KinoPub' },
      kp_trace_enable: { ru: 'Запись этапов запуска', en: 'Record launch stages', ua: 'Запис етапів запуску' },
      kp_trace_report: { ru: 'Отчёт последних запусков', en: 'Recent launch report', ua: 'Звіт останніх запусків' },
      kp_trace_descr: { ru: 'Отключена по умолчанию. Последние 8 попыток только в памяти; без запросов к видео и отправки журнала. Выключение очищает запись.', en: 'Off by default. Last 8 attempts in memory only; no media requests or log upload. Disabling clears the record.', ua: 'Вимкнено типово. Останні 8 спроб лише в пам’яті; без запитів до відео й надсилання журналу. Вимкнення очищає запис.' },
      kp_trace_empty: { ru: 'Включите запись этапов, затем выберите видео и плеер. После возврата откройте этот отчёт.', en: 'Enable stage recording, then select a video and player. Open this report after returning.', ua: 'Увімкніть запис етапів, виберіть відео та плеєр. Після повернення відкрийте звіт.' },
      kp_trace_limits: { ru: 'Измеряется подготовка после выбора видео. Открытие приложения и первый кадр не измерены. Узел указан до перенаправлений. F и U сравнимы только в этом сеансе.', en: 'Measures preparation after selecting a video. App opening and first frame are not measured. Host precedes redirects. F and U are comparable only in this session.', ua: 'Вимірюється підготовка після вибору відео. Відкриття програми й перший кадр не виміряні. Вузол до перенаправлень. F та U порівнюються лише в цьому сеансі.' },
      kp_trace_fields: { ru: 'item_ms: обновление материала; link_ms: получение ссылки; build_ms: сборка списка; prepare_ms: вся подготовка; dispatch_ms: от готовой ссылки до вызова передачи. null: этап отсутствовал/не завершён. submitted: вызов передачи, не воспроизведение. file: метка файла; input/output: метки точных адресов до/после подготовки. Разные U не доказывают разные файлы. entries: число видео в переданном объекте/схеме. Расширение не подтверждает контейнер, кодек, HDR или звук.', en: 'item_ms: item refresh; link_ms: link resolution; build_ms: playlist preparation; prepare_ms: total preparation; dispatch_ms: ready link to dispatch call. null: absent/incomplete stage. submitted is not playback. file: file label; input/output: exact URL labels before/after preparation. Different U labels do not prove different files. entries counts videos in the passed object/scheme. Extension does not prove container, codec, HDR or audio.', ua: 'item_ms: оновлення матеріалу; link_ms: отримання адреси; build_ms: список; prepare_ms: уся підготовка; dispatch_ms: від готової адреси до виклику передачі. null: етап відсутній/незавершений. submitted не означає відтворення. file: мітка файлу; input/output: мітки точних адрес до/після підготовки. Різні U не доводять різні файли. entries: кількість відео в переданому об’єкті/схемі. Розширення не підтверджує контейнер, кодек, HDR чи звук.' },
      kp_player_handoff_error: { ru: 'Не удалось передать видео выбранному плееру.', en: 'Could not hand video to the selected player.', ua: 'Не вдалося передати відео вибраному плеєру.' },
      kp_infuse_quality: { ru: 'Infuse: выбрать качество', en: 'Infuse: choose quality', ua: 'Infuse: вибрати якість' },
      kp_infuse_hls2_test: { ru: 'Infuse: проверить HLS2', en: 'Infuse: test HLS2', ua: 'Infuse: перевірити HLS2' },
      kp_infuse_hls2_hint: { ru: 'Разовый тест одного видео. Совместимость не подтверждена.', en: 'One-off test of one video. Compatibility is unconfirmed.', ua: 'Разова перевірка одного відео. Сумісність не підтверджена.' },
      kp_infuse_no_hls2: { ru: 'Не удалось получить HLS2 выбранного качества. Другой формат не подставлен.', en: 'Could not get HLS2 at the selected quality. No format fallback.', ua: 'Не вдалося отримати HLS2 вибраної якості. Формат не замінено.' },
      kp_infuse_hls2_limits: {
        ru: 'Разовый тест HLS2. Проверка диапазонов видеофайла здесь не выполняется. Манифест и сегменты не проверены. Скорость, воспроизведение, дорожки и перемотку нужно проверить в Infuse. Ссылки и токены скрыты.',
        en: 'One-off HLS2 test. File range probes do not apply here. Manifest and segments are untested. Check speed, playback, tracks and seeking in Infuse. Links and tokens are hidden.',
        ua: 'Разова перевірка HLS2. Перевірка діапазонів відеофайлу тут не виконується. Маніфест і сегменти не перевірені. Швидкість, відтворення, доріжки та перемотку перевірте в Infuse. Посилання й токени приховані.'
      },
      kp_infuse_check: { ru: 'Диагностика Infuse', en: 'Infuse diagnostics', ua: 'Діагностика Infuse' },
      kp_infuse_check_descr: { ru: 'Проверить доступность последнего файла после ошибки. Показывает безопасный отчёт для снимка экрана.',
        en: 'Check the last file after an error. Shows a safe report for a screenshot.', ua: 'Перевірити останній файл після помилки.' },
      kp_infuse_check_empty: { ru: 'Сначала запустите фильм через Infuse в этой сессии Lampa.',
        en: 'First launch a movie through Infuse in this Lampa session.', ua: 'Спочатку запустіть фільм через Infuse.' },
      kp_infuse_prepare: { ru: 'Подготовка ссылки', en: 'Link preparation', ua: 'Підготовка посилання' },
      kp_infuse_dispatch_time: { ru: 'Готовая ссылка → передача Infuse', en: 'Link ready → Infuse handoff', ua: 'Посилання готове → передача Infuse' },
      kp_infuse_link_age: { ru: 'После передачи ссылки', en: 'Time since handoff', ua: 'Після передачі посилання' },
      kp_infuse_check_running: { ru: 'Проверка диапазонов (до 30 секунд)…', en: 'Checking ranges (up to 30 seconds)…', ua: 'Перевірка діапазонів (до 30 секунд)…' },
      kp_infuse_report: { ru: 'Сводка проверки', en: 'Probe summary', ua: 'Підсумок перевірки' },
      'kp_infuse_range_headers-match': { ru: 'Заголовки диапазона совпали; тело не проверено', en: 'Range headers match; body untested', ua: 'Заголовки збігаються; тіло не перевірене' },
      'kp_infuse_range_headers-partial': { ru: 'Заголовки части диапазона; покрытие не подтверждено', en: 'Partial range headers; coverage unconfirmed', ua: 'Заголовки частини діапазону' },
      'kp_infuse_range_unknown-range': { ru: 'Недостаточно заголовков: отсутствие или CORS', en: 'Insufficient headers: absent or CORS-hidden', ua: 'Недостатньо заголовків: відсутні або CORS' },
      'kp_infuse_range_range-ignored': { ru: 'Получен полный ответ 200 вместо диапазона', en: 'Full 200 response instead of a range', ua: 'Повна відповідь 200 замість діапазону' },
      'kp_infuse_range_invalid-range': { ru: 'Диапазон или длина не соответствуют запросу', en: 'Range or length does not match the request', ua: 'Діапазон або довжина не відповідає запиту' },
      'kp_infuse_range_size-changed': { ru: 'Размер изменился: прекратите проверку этой ссылки', en: 'Size changed: stop testing this link', ua: 'Розмір змінився: перевірку зупинено' },
      'kp_infuse_range_unsatisfiable': { ru: '416: диапазон вне текущего размера', en: '416: range outside current size', ua: '416: діапазон поза поточним розміром' },
      'kp_infuse_range_rejected-range': { ru: '416: отказ для допустимого диапазона', en: '416: satisfiable range rejected', ua: '416: відмова для допустимого діапазону' },
      'kp_infuse_range_http-error': { ru: 'Ошибка HTTP, диапазон не подтверждён', en: 'HTTP error; range unconfirmed', ua: 'Помилка HTTP; діапазон не підтверджено' },
      'kp_infuse_range_authorization': { ru: 'Доступ отклонён; истечение ссылки не доказано', en: 'Access denied; expiry not established', ua: 'Доступ відхилено; строк дії не встановлено' },
      kp_infuse_probe_timeout: { ru: 'нет ответа за 6 секунд из Lampa', en: 'no response in 6 seconds from Lampa', ua: 'немає відповіді за 6 секунд із Lampa' },
      'kp_infuse_probe_network-or-cors': { ru: 'сеть или запрет CORS в Lampa; результат для Infuse неизвестен',
        en: 'network or Lampa CORS restriction; Infuse result unknown', ua: 'мережа або CORS у Lampa; результат для Infuse невідомий' },
      kp_infuse_probe_unsupported: { ru: 'оболочка не поддерживает эту проверку', en: 'this shell cannot run the probe', ua: 'оболонка не підтримує перевірку' },
      kp_infuse_check_limits: { ru: 'Только заголовки из Lampa; тело не читается. ? — заголовок отсутствует или скрыт CORS. Середина вычислена по размеру этого файла, не по старой ошибке. Без размера — только начало и конец. Промежуточные редиректы браузер скрывает. Скорость и маршрут Infuse не проверены. Ссылки и токены скрыты.',
        en: 'Lampa headers only; body unread. ? means absent or CORS-hidden. Middle is based on this file size, not an earlier error. Without size: start and suffix only. Intermediate redirects are hidden by the browser. Speed and Infuse route untested. URLs and tokens hidden.',
        ua: 'Лише заголовки з Lampa; тіло не читається. ? — відсутнє або приховане CORS. Середина за розміром цього файлу; без розміру — початок і кінець. Редиректи приховані браузером. Швидкість і маршрут Infuse не перевірені.' },
      kp_infuse_no_file: {
        ru: 'Не удалось получить прямой файл KinoPub в выбранном качестве. Повторите запуск или выберите доступное качество.',
        en: 'No fresh direct KinoPub file at the selected quality. Retry or choose an available quality.',
        ua: 'Не вдалося отримати прямий файл KinoPub у вибраній якості.'
      },
      kp_infuse_handoff_error: {
        ru: 'Не удалось передать видео в Infuse. Проверьте установку приложения.',
        en: 'Could not hand off to Infuse. Check that the app is installed.',
        ua: 'Не вдалося передати відео в Infuse.'
      },
      kp_auth_title: {
        ru: 'Авторизация kinopub',
        en: 'kinopub authorization',
        ua: 'Авторизація kinopub'
      },
      kp_auth_text: {
        ru: 'Откройте на телефоне или ПК страницу kino.pub/device и введите код:',
        en: 'Open kino.pub/device on your phone or PC and enter the code:',
        ua: 'Відкрийте на телефоні чи ПК сторінку kino.pub/device та введіть код:'
      },
      kp_auth_url: {
        ru: 'https://kino.pub/device',
        en: 'https://kino.pub/device',
        ua: 'https://kino.pub/device'
      },
      kp_auth_wait: {
        ru: 'Получаем код',
        en: 'Getting code',
        ua: 'Отримуємо код'
      },
      kp_auth_error: {
        ru: 'Ошибка авторизации kinopub',
        en: 'kinopub auth error',
        ua: 'Помилка авторизації kinopub'
      },
      kp_copied: {
        ru: 'Код скопирован',
        en: 'Code copied',
        ua: 'Код скопійовано'
      },
      kp_copy_fail: {
        ru: 'Ошибка копирования',
        en: 'Copy error',
        ua: 'Помилка копіювання'
      },
      kp_logged_out: {
        ru: 'Сессия kinopub очищена',
        en: 'kinopub session cleared',
        ua: 'Сесію kinopub очищено'
      },
      kp_set_log_url: {
        ru: 'URL лог-сервера',
        en: 'Log server URL',
        ua: 'URL лог-серверу'
      },
      kp_set_log_url_descr: {
        ru: 'Адрес сервера для удалённого приёма логов плагина (например http://192.168.1.10:8088). Оставьте пустым чтобы выключить.',
        en: 'Address of remote log server (e.g. http://192.168.1.10:8088). Empty to disable.',
        ua: 'Адреса сервера для віддаленого приймання логів (наприклад http://192.168.1.10:8088). Порожнє - вимкнути.'
      },
      kp_set_max_quality: {
        ru: 'Макс. качество',
        en: 'Max quality',
        ua: 'Макс. якість'
      },
      kp_set_max_quality_descr: {
        ru: 'Верхняя граница качества при выборе потока',
        en: 'Upper limit of stream quality',
        ua: 'Верхня межа якості потоку'
      },
      kp_set_format: {
        ru: 'Формат потока',
        en: 'Stream format',
        ua: 'Формат потоку'
      },
      kp_set_format_descr: {
        ru: 'Авто = подбирать формат под текущий плеер: HLS4 для нативного Tizen-плеера (4K + полная поддержка озвучек), HLS2 для встроенного плеера Lampa (стабильно, без зависаний на fMP4). HLS4/HLS2/HLS — принудительно.',
        en: 'Auto = pick format by current player: HLS4 for Tizen native player (4K + full audio tracks), HLS2 for Lampa built-in (stable, no fMP4 hangs). HLS4/HLS2/HLS = forced.',
        ua: 'Авто = підбирати формат під плеєр: HLS4 для Tizen, HLS2 для вбудованого Lampa.'
      },
      kp_set_format_auto: {
        ru: 'Авто (по плееру)',
        en: 'Auto (by player)',
        ua: 'Авто (за плеєром)'
      },
      kp_set_proxy: {
        ru: 'CORS-прокси',
        en: 'CORS proxy',
        ua: 'CORS-проксі'
      },
      kp_set_proxy_descr: {
        ru: 'Опционально. Если api kinopub режут CORS - укажите http(s)-прокси, на который добавится URL запроса. Оставьте пустым на Tizen.',
        en: 'Optional. Address of CORS proxy if needed. Leave empty on Tizen.',
        ua: 'Не обовязково. Адреса CORS-проксі якщо потрібно.'
      },
      kp_set_subs: {
        ru: 'Внешние субтитры',
        en: 'External subtitles',
        ua: 'Зовнішні субтитри'
      },
      kp_try_format: {
        ru: 'Запустить в формате...',
        en: 'Launch in format...',
        ua: 'Запустити у форматі...'
      },
      kp_format_clear: {
        ru: 'Сбросить (использовать настройку)',
        en: 'Reset (use setting)',
        ua: 'Скинути (використати налаштування)'
      },
      kp_fallback: {
        ru: 'Откат на формат',
        en: 'Falling back to',
        ua: 'Відкат на формат'
      },
      kp_set_subs_descr: {
        ru: 'Передавать плееру URL .vtt-субтитров от kinopub. Если плеер виснет на старте — выключите.',
        en: 'Attach kinopub .vtt subtitle URLs to the player. If playback hangs — turn off.',
        ua: 'Передавати плеєру URL субтитрів kinopub. Якщо плеєр зависає - вимкніть.'
      },
      kp_set_logout: {
        ru: 'Выйти из аккаунта',
        en: 'Logout',
        ua: 'Вийти з акаунту'
      },
      kp_set_logout_descr: {
        ru: 'Удалить токены kinopub из памяти',
        en: 'Remove kinopub tokens from storage',
        ua: 'Видалити токени kinopub'
      },
      kp_set_login: {
        ru: 'Авторизоваться',
        en: 'Sign in',
        ua: 'Авторизуватися'
      },
      kp_set_login_descr: {
        ru: 'Открыть окно с кодом для kino.pub/device',
        en: 'Open the kino.pub/device code dialog',
        ua: 'Відкрити вікно з кодом для kino.pub/device'
      },
      kp_set_region: {
        ru: 'Авто-выбор региона CDN',
        en: 'Auto-pick CDN region',
        ua: 'Автовибір регіону CDN'
      },
      kp_set_region_descr: {
        ru: 'Опционально. Полноценное управление настройками устройства доступно на kino.pub в разделе устройств. Эта кнопка - быстрый способ переключить kinopub на ближайший CDN (RU/UA/BY) одним нажатием.',
        en: 'Optional shortcut. Full device-settings UI is available on kino.pub. This just switches the device to a CIS CDN (RU/UA/BY) in one tap.',
        ua: 'Опціонально. Повне керування налаштуваннями пристрою доступне на kino.pub. Ця кнопка - швидке перемикання на найближчий CDN (RU/UA/BY).'
      },
      kp_region_running: {
        ru: 'Перенастройка региона...',
        en: 'Re-configuring region...',
        ua: 'Переналаштування регіону...'
      },
      kp_region_done: {
        ru: 'Регион',
        en: 'Region',
        ua: 'Регіон'
      },
      kp_region_fail: {
        ru: 'Не удалось перенастроить регион (см. лог)',
        en: 'Failed to re-configure region (see log)',
        ua: 'Не вдалося переналаштувати регіон (див. лог)'
      },
      online_balanser_dont_work: {
        ru: 'Ничего не нашлось',
        en: 'Nothing found',
        ua: 'Нічого не знайдено'
      }
    });

    injectStyles();
    resetTemplates();

    Lampa.Component.add(COMPONENT_NAME, component);

    // settings
    addSettings();

    // Apple TV Watch opens the same KinoPub activity as the source entry.
    Lampa.Listener.follow('full', function (e) {
      if (e.type !== 'complite') return;
      // v1.0.66: pre-fetch voice-sync snapshot from VPS so Storage is
      // populated BEFORE user clicks the kinopub button.
      try {
        var mid = e.data && e.data.movie && e.data.movie.id;
        if (mid) kpVoiceSyncOnFull(mid);
      } catch (vse) {}
      try {
        mountKinoPubCard(e);
      } catch (err) {
        Logger.error('button', 'mount failed', String(err));
      }
    });

    // Background token health check
    if (KP.hasToken()) {
      var bg = new Lampa.Reguest();
      KP.profile(bg, function (j) {
        Logger.info('auth', 'profile ok', j && j.user && { name: j.user.username, subscribed: j.user.subscription });
        // v1.0.66: capture user identity for voice-sync namespace
        if (j && j.user && j.user.username) {
          kpUserId = String(j.user.username).toLowerCase().replace(/[^a-z0-9_.\-]/g, '');
          Logger.info('voicesync', 'user namespace ready', { userId: kpUserId });
        }
      }, function () {
        Logger.warn('auth', 'profile check failed');
      });
      // Refresh device identity on every startup — kinoapi.com docs recommend
      // this so kinopub UI keeps device record up-to-date with current OS/build.
      notifyDeviceIdentity(new Lampa.Reguest());
    } else {
      Logger.info('auth', 'no token at startup');
    }

    if (Lampa.Manifest.app_digital >= 177) {
      Lampa.Storage.sync('online_choice_' + BALANSER, 'object_object');
    }

    // Subscribe to GLOBAL Lampa.Listener channels (only app/activity/controller
    // actually fire here — `player` and `video` channels DON'T exist globally).
    var DENY_TYPES = { timeupdate: 1, progress: 1, time: 1, tick: 1 };
    function logEvt(channel, e) {
      if (!e || !e.type) return;
      if (DENY_TYPES[e.type]) return;
      var data = {};
      if (e.url)               data.url      = String(e.url).slice(0, 200);
      if (e.code != null)      data.code     = e.code;
      if (e.message)           data.message  = String(e.message).slice(0, 400);
      if (e.error)             data.error    = String(e.error).slice(0, 400);
      if (e.fatal != null)     data.fatal    = e.fatal;
      if (e.time != null)      data.time     = e.time;
      if (e.duration != null)  data.duration = e.duration;
      if (e.status != null)    data.status   = e.status;
      if (e.down)              data.down     = e.down;
      if (e.networkState != null) data.networkState = e.networkState;
      if (e.readyState != null)   data.readyState   = e.readyState;
      Logger.info('lampa-evt', channel + '/' + e.type, Object.keys(data).length ? data : undefined);
    }
    ['app', 'activity', 'controller'].forEach(function (ch) {
      try {
        Lampa.Listener.follow(ch, function (e) { logEvt(ch, e); });
      } catch (err) {
        Logger.warn('lampa-evt', 'cannot follow ' + ch, String(err));
      }
    });

    // Lampa keeps player events on LOCAL listeners on its modules, NOT global.
    // Player.listener: create / start / ready / destroy / external
    // PlayerVideo.listener: error / canplay / loadeddata / ended / tracks / levels / subs / translate
    //   error payload: { error: <string>, fatal: <bool> }  ← what we need
    try {
      if (Lampa.Player && Lampa.Player.listener) {
        ['create', 'start', 'ready', 'destroy', 'external'].forEach(function (evt) {
          Lampa.Player.listener.follow(evt, function (e) { logEvt('Player', { type: evt }); });
        });
        if (!KP_BARE_MODE) {
          // DOM injection for next-episode-name override
          Lampa.Player.listener.follow('start',   function () { setupNextEpisodeLabelOverride(); });
          Lampa.Player.listener.follow('destroy', function () { cleanupNextEpisodeLabelOverride(); });
        }
        // After the player closes, repaint chips on visible cards so episodes
        // that just gained timeline progress flip from green to faded immediately.
        // v1.0.33: also refresh the filter sidebar so the "Озвучка: ..." label
        // reflects the voice picked in-player. window._kpRefreshFilterAndChips
        // is exposed by the source's buildFilter() and rebuilds both filter
        // and chips together. Falls back to chips-only refresh if not present.
        Lampa.Player.listener.follow('destroy', function () {
          // v1.0.41: only do full filter+chips rebuild if voice was actually
          // changed via in-player UI during this session. Otherwise the
          // buildFilter+append cycle visibly flashes the season grid for no
          // reason — chip-only refresh covers the watched-progress case.
          var doFullRebuild = voiceChangedInPlayer;
          voiceChangedInPlayer = false;
          setTimeout(function () {
            if (doFullRebuild && typeof window._kpRefreshFilterAndChips === 'function') {
              try { window._kpRefreshFilterAndChips(); }
              catch (e) { Logger.warn('voice', 'refresh hook failed', String(e)); refreshAllKpVoiceChips(); }
            } else {
              refreshAllKpVoiceChips();
            }
          }, 100);
        });
      } else {
        Logger.warn('player-evt', 'Lampa.Player.listener unavailable');
      }
    } catch (err) {
      Logger.warn('player-evt', 'Player.listener failed', String(err));
    }
    try {
      if (Lampa.PlayerVideo && Lampa.PlayerVideo.listener) {
        // every event we care about — error first because that's the diagnosis goal
        ['error', 'canplay', 'loadeddata', 'ended', 'tracks', 'levels', 'subs', 'translate', 'play', 'pause', 'rewind']
          .forEach(function (evt) {
            Lampa.PlayerVideo.listener.follow(evt, function (e) {
              logEvt('PlayerVideo', { type: evt,
                error:   e && e.error,
                fatal:   e && e.fatal,
                tracks:  e && e.tracks && e.tracks.length,
                levels:  e && e.levels && e.levels.length,
                subs:    e && e.subs && e.subs.length
              });
            });
          });

        // v1.0.29-diag: always log AVPlayer track info on canplay.
        // Need to compare HLS2 vs HLS4 enumerated tracks to know whether
        // setSelectTrack can switch among kinopub's 12 audio renditions.
        var avplayDumped = false;
        Lampa.PlayerVideo.listener.follow('canplay', function () {
          if (avplayDumped) return;
          avplayDumped = true;
          dumpAvplayTracks('canplay');
        });
        Lampa.PlayerVideo.listener.follow('tracks', function () {
          if (avplayDumped) return;
          avplayDumped = true;
          dumpAvplayTracks('tracks-event');
        });
        Lampa.Player.listener.follow('destroy', function () { avplayDumped = false; });

        if (!KP_BARE_MODE) {
          // Voice track switching — fired when audio backend has read tracks
          // and the stream is ready. We try canplay first, then fall back to
          // tracks event (hls.js fires it after loading), whichever comes first.
          var voiceApplied = false;
          function tryApplyPendingVoice(source) {
            if (voiceApplied || !pendingVoice || pendingVoice.idx < 0) return;
            Logger.debug('voice', 'apply via ' + source, pendingVoice);
            if (applyVoiceTrack(pendingVoice.idx)) {
              voiceApplied = true;
            }
          }
          Lampa.PlayerVideo.listener.follow('canplay',    function () { tryApplyPendingVoice('canplay'); });
          Lampa.PlayerVideo.listener.follow('loadeddata', function () { tryApplyPendingVoice('loadeddata'); });
          Lampa.PlayerVideo.listener.follow('tracks',     function () { tryApplyPendingVoice('tracks'); });
          // reset the one-shot guard when player is destroyed so next launch can apply again
          Lampa.Player.listener.follow('destroy', function () {
            voiceApplied = false;
            pendingVoice = null;
          });
        }
      } else {
        Logger.warn('player-evt', 'Lampa.PlayerVideo.listener unavailable');
      }
    } catch (err) {
      Logger.warn('player-evt', 'PlayerVideo.listener failed', String(err));
    }

    // Direct delegate on any <video> element that gets created by Lampa.
    // Captures HTMLMediaElement errors which often don't reach console.
    try {
      $(document).on('error', 'video', function (e) {
        var v = e && e.target;
        var err = v && v.error;
        Logger.error('video-elem', 'native error', {
          code: err && err.code,
          message: err && err.message,
          src: v && (v.currentSrc || v.src || '').slice(0, 200),
          networkState: v && v.networkState,
          readyState: v && v.readyState
        });
      });
      $(document).on('stalled waiting abort', 'video', function (e) {
        var v = e && e.target;
        Logger.warn('video-elem', e.type, {
          src: v && (v.currentSrc || v.src || '').slice(0, 200),
          networkState: v && v.networkState,
          readyState: v && v.readyState
        });
      });
    } catch (err) {
      Logger.warn('video-elem', 'delegate error handler failed', String(err));
    }

    // v1.0.36: monkey-patch Lampa.PlayerVideo.url to skip Lampa's bundled
    // hls.js parser fork on our proxy URLs. Bundled hls.js chokes on fMP4
    // (HEVC) variants and races with AVPlayer fetch, causing intermittent
    // Tizen app crash on HEVC 4K initial play. See setupKpPlayerPatch().
    setupKpPlayerPatch();

    // Probe availability only; compatible Tizen launches may use the
    // reducer. Infuse always uses the service's direct-file URL.
    checkProxyAvailability();

    Logger.info('boot', 'kp.js initialized');
  }

  startPlugin();

})();
