// Screen-share receiver for the TV dashboard.
// Connects to the signaling server on the Mac (screenshare/server.js) and shows the incoming WebRTC
// stream full-screen while a share is active.
//
//   TVShare.init({ host: '192.168.1.235:8090', key: '...', bufferMs: 0, onChange: function (active) {} })
//
// Latency choices: no STUN/TURN (LAN only), jitter buffer target 0 ms, audio played from a separate
// stream so video is never held back for lip-sync.
(function () {
  'use strict';

  var opts, ws, pc, overlay, video, audio, badge;
  var pendingCandidates = [];
  var retryMs = 1000;
  var statsTimer = null, dropTimer = null, watchdog = null;
  var lastBytes = 0, lastStatsAt = 0;

  var TVShare = { active: false, init: init };
  window.TVShare = TVShare;

  function init(o) {
    opts = o;
    if (!opts.host) return;
    buildOverlay();
    connect();
  }

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;background:#000;z-index:1000;display:none;';
    audio = document.createElement('audio');
    audio.autoplay = true;
    badge = document.createElement('div');
    badge.style.cssText = 'position:absolute;right:12px;bottom:10px;font:12px sans-serif;color:#666;';
    overlay.appendChild(audio);
    overlay.appendChild(badge);
    document.body.appendChild(overlay);
    newVideo();
  }

  // A new <video> per session, so nothing from the previous session keeps the TV's decoder busy.
  function newVideo() {
    if (video) video.remove();
    video = document.createElement('video');
    video.muted = true; // video carries no audio; muted keeps autoplay allowed everywhere
    video.autoplay = true;
    video.playsInline = true;
    video.disablePictureInPicture = true;
    video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;';
    // The first decoded frame is the signal to switch the dashboard over.
    video.addEventListener('playing', function () { setActive(true); });
    overlay.insertBefore(video, overlay.firstChild);
  }

  function connect() {
    var url = 'ws://' + opts.host + '/ws?role=receiver&k=' + encodeURIComponent(opts.key || '');
    try {
      ws = new WebSocket(url);
    } catch (e) {
      // Thrown synchronously when an https page may not open ws:// (Fully: Mixed Content Mode).
      console.warn('[share] websocket blocked:', e);
      return setTimeout(connect, 60000);
    }
    ws.onopen = function () { retryMs = 1000; console.log('[share] connected'); };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      handle(m);
    };
    ws.onclose = function () {
      // The P2P stream can outlive the signaling socket, so don't stop here; just reconnect.
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
  }

  function sendMsg(m) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  }

  function handle(m) {
    if (m.type === 'offer') {
      newPeer();
      var p = pc;
      p.setRemoteDescription({ type: 'offer', sdp: m.sdp })
        .then(function () { return p.createAnswer(); })
        .then(function (a) { return p.setLocalDescription(a); })
        .then(function () {
          sendMsg({ type: 'answer', sdp: p.localDescription.sdp });
          pendingCandidates.splice(0).forEach(function (c) { p.addIceCandidate(c).catch(function () {}); });
        })
        .catch(function (e) { console.warn('[share] negotiation failed', e); stop(); });
    } else if (m.type === 'candidate') {
      if (pc && pc.remoteDescription) pc.addIceCandidate(m.candidate).catch(function () {});
      else pendingCandidates.push(m.candidate);
    } else if (m.type === 'stop') {
      stop();
    }
  }

  function newPeer() {
    closePeer();
    pendingCandidates = [];
    var p = pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    p.onicecandidate = function (e) {
      if (e.candidate && p === pc) sendMsg({ type: 'candidate', candidate: e.candidate.toJSON() });
    };
    p.ontrack = function (e) {
      lowLatency(e.receiver);
      if (e.track.kind === 'video') {
        video.srcObject = new MediaStream([e.track]);
        video.play().catch(function () {});
      } else {
        audio.srcObject = new MediaStream([e.track]);
        audio.play().catch(function (err) { console.warn('[share] audio autoplay blocked', err); });
      }
    };
    p.onconnectionstatechange = function () {
      if (p !== pc) return;
      var s = p.connectionState;
      clearTimeout(dropTimer);
      if (s === 'failed' || s === 'closed') stop();
      else if (s === 'disconnected') dropTimer = setTimeout(stop, 4000); // Wi-Fi hiccup grace period
    };
    lastBytes = 0;
    statsTimer = setInterval(reportStats, 2000);
    watchdog = setInterval(checkDecoding.bind(null, p, Date.now()), 1000);
  }

  // This TV's hardware H.264 decoder is sometimes still held by the previous session, and then
  // frames arrive but none decode. Ask the sender for a fresh connection (it switches codec after
  // repeated failures).
  function checkDecoding(p, startedAt) {
    if (p !== pc) return;
    p.getStats().then(function (report) {
      if (p !== pc) return;
      report.forEach(function (s) {
        if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
        if (s.framesDecoded > 0) { clearInterval(watchdog); return; }
        if (s.bytesReceived > 50000 && Date.now() - startedAt > 2500) {
          console.warn('[share] no frames decoded, asking for a new session');
          clearInterval(watchdog);
          sendMsg({ type: 'retry', reason: 'no-decode', codec: s.codecId && report.get(s.codecId) && report.get(s.codecId).mimeType });
          closePeer();
        }
      });
    }).catch(function () {});
  }

  function lowLatency(receiver) {
    var ms = opts.bufferMs || 0;
    try {
      if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = ms;
      else receiver.playoutDelayHint = ms / 1000;
    } catch (e) {}
  }

  // Sent back to the sender page so latency can be tuned from the Mac.
  function reportStats() {
    if (!pc) return;
    pc.getStats().then(function (report) {
      var out = { type: 'stats' }, pair = null;
      report.forEach(function (s) {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          var now = s.timestamp, dt = (now - lastStatsAt) / 1000;
          out.kbps = lastBytes && dt > 0 ? Math.round((s.bytesReceived - lastBytes) * 8 / dt / 1000) : null;
          lastBytes = s.bytesReceived; lastStatsAt = now;
          out.fps = s.framesPerSecond;
          out.width = s.frameWidth; out.height = s.frameHeight;
          out.decoder = s.decoderImplementation;
          out.powerEfficientDecoder = s.powerEfficientDecoder;
          out.decodeMs = s.framesDecoded ? Math.round(s.totalDecodeTime / s.framesDecoded * 1000 * 10) / 10 : null;
          out.jitterBufferMs = s.jitterBufferEmittedCount ? Math.round(s.jitterBufferDelay / s.jitterBufferEmittedCount * 1000) : null;
          out.framesDropped = s.framesDropped;
          out.packetsLost = s.packetsLost;
          out.freezes = s.freezeCount;
          out.codecId = s.codecId;
        }
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
      });
      if (out.codecId) {
        var c = report.get(out.codecId);
        out.codec = c && c.mimeType;
        delete out.codecId;
      }
      if (pair) out.rttMs = Math.round((pair.currentRoundTripTime || 0) * 1000);
      out.showing = TVShare.active;
      out.video = { w: video.videoWidth, h: video.videoHeight, paused: video.paused, readyState: video.readyState };
      sendMsg(out);
      if (opts.debug) badge.textContent = (out.codec || '') + ' ' + out.width + 'x' + out.height + ' ' + out.fps + 'fps jb ' + out.jitterBufferMs + 'ms';
    }).catch(function () {});
  }

  function closePeer() {
    clearInterval(statsTimer);
    clearInterval(watchdog);
    clearTimeout(dropTimer);
    [video && video.srcObject, audio.srcObject].forEach(function (ms) {
      if (ms) ms.getTracks().forEach(function (t) { t.stop(); });
    });
    if (pc) { var p = pc; pc = null; p.close(); }
    if (video) { video.srcObject = null; newVideo(); }
    audio.srcObject = null;
  }

  function stop() {
    closePeer();
    setActive(false);
  }

  function setActive(on) {
    if (TVShare.active === on) return;
    TVShare.active = on;
    overlay.style.display = on ? 'block' : 'none';
    if (opts.onChange) opts.onChange(on);
  }
})();
