// ============================================================
// P2P Voice Chat на WebRTC с ручной сигнализацией
// Версия 4.0 — публичный TURN без регистрации (openrelay.metered.ca)
// + исправленный onconnectionstatechange с таймером
// + защита кнопки "Применить" от двойного клика
// ============================================================

import {
  buildSignal,
  parseSignal,
  detectSignalRole,
  checkBrowserSupport,
} from './signaling.js';

// ===== Состояние =====
const state = {
  pc: null,
  localStream: null,
  screenStream: null,
  remoteStream: null,
  isCaller: false,
  pendingCandidates: [],

  audioCtx: null,
  micGainNode: null,
  micSourceNode: null,
  mixerDest: null,
  screenAudioSource: null,
  screenAudioGain: null,

  audioSender: null,
  videoSender: null,
};

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const els = {
  createOfferBtn: $('createOfferBtn'),
  joinBtn: $('joinBtn'),
  hangupBtn: $('hangupBtn'),
  localSignal: $('localSignal'),
  remoteSignal: $('remoteSignal'),
  copyLocalBtn: $('copyLocalBtn'),
  applyRemoteBtn: $('applyRemoteBtn'),
  remoteVideo: $('remoteVideo'),
  remoteAudio: $('remoteAudio'),
  remotePlaceholder: $('remotePlaceholder'),
  micVolume: $('micVolume'),
  micMuted: $('micMuted'),
  deafen: $('deafen'),
  micLevelBar: $('micLevelBar'),
  shareScreenBtn: $('shareScreenBtn'),
  stopShareBtn: $('stopShareBtn'),
  shareAudio: $('shareAudio'),
  status: $('status'),
};

// ===== ICE: публичный TURN OpenRelay, БЕЗ РЕГИСТРАЦИИ =====
// Креды "openrelayproject" — общеизвестные публичные,
// используются в тестовых проектах по всему интернету.
// НЕ ГАРАНТИРУЕТ uptime. Для продакшена нужен свой coturn.
const iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:turn.evan-brass.net:3478',
      username: 'user',
      credential: 'password',
    },
    {
      urls: 'turn:turn.evan-brass.net:3478?transport=tcp',
      username: 'user',
      credential: 'password',
    },
  ],
};

// ===== Утилиты =====
function setStatus(text) {
  els.status.textContent = `Статус: ${text}`;
  console.log('[status]', text);
}
function log(...args) {
  console.log('[p2p]', ...args);
}

// ===== Проверка браузера =====
(function () {
  const s = checkBrowserSupport();
  log('Поддержка браузера:', s);
  if (!s.webRTC || !s.getUserMedia) {
    setStatus('браузер не поддерживает WebRTC/getUserMedia');
  }
})();

// ===== Ожидание ICE =====
function waitForIceGathering(pc, timeout = 3000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(resolve, timeout);
  });
}

// ===== Заглушка видео =====
function createPlaceholderVideoTrack() {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 2, 2);
  return canvas.captureStream(1).getVideoTracks()[0];
}

// ===== Создание PeerConnection =====
function createPeerConnection() {
  const pc = new RTCPeerConnection(iceConfig);

  pc.onnegotiationneeded = null;

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      log('ICE-кандидат:', event.candidate.type);
    } else {
      log('ICE-сбор завершён');
    }
  };

  pc.ontrack = (event) => {
    log('ontrack:', event.track.kind);
    const stream = event.streams[0];
    if (!stream) return;
    state.remoteStream = stream;

    if (event.track.kind === 'video') {
      if (els.remoteVideo.srcObject !== stream) {
        els.remoteVideo.srcObject = stream;
      }
      els.remoteVideo.classList.add('active');
      els.remotePlaceholder.style.display = 'none';
      els.remoteVideo.play().catch((e) => log('video play error:', e));
    } else if (event.track.kind === 'audio') {
      if (els.remoteAudio.srcObject !== stream) {
        els.remoteAudio.srcObject = stream;
      }
      els.remoteAudio.play().catch((e) => log('audio play error:', e));
    }
  };

  let disconnectTimer = null;

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    log('Состояние:', st);
    setStatus(st);

    if (st === 'connected') {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
    }

    if (st === 'disconnected') {
      if (!disconnectTimer) {
        disconnectTimer = setTimeout(() => {
          disconnectTimer = null;
          if (state.pc && state.pc.connectionState === 'disconnected') {
            setStatus('соединение потеряно');
            cleanup();
          }
        }, 5000);
      }
    }

    if (st === 'failed') {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
      setStatus('соединение не удалось');
      cleanup();
    }
  };

  return pc;
}

// ===== Микрофон =====
async function getLocalAudio() {
  if (state.localStream) return state.localStream;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  state.localStream = stream;
  setupMicLevelMeter(stream);
  log('Микрофон получен');
  return stream;
}

// ===== AudioContext =====
async function ensureAudioContext() {
  if (!state.audioCtx) {
    state.audioCtx = new AudioContext();
  }
  if (state.audioCtx.state === 'suspended') {
    await state.audioCtx.resume();
  }
  return state.audioCtx;
}

// ===== Исходящий аудио-поток (микшер) =====
async function createOutgoingAudio() {
  const micStream = await getLocalAudio();
  const ctx = await ensureAudioContext();

  const micSource = ctx.createMediaStreamSource(micStream);
  state.micSourceNode = micSource;

  state.micGainNode = ctx.createGain();
  state.micGainNode.gain.value = parseFloat(els.micVolume.value);

  state.mixerDest = ctx.createMediaStreamDestination();

  micSource.connect(state.micGainNode);
  state.micGainNode.connect(state.mixerDest);

  return state.mixerDest.stream;
}

// ===== Индикатор уровня =====
function setupMicLevelMeter(stream) {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  function draw() {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    els.micLevelBar.style.width = `${Math.min(100, (avg / 128) * 100)}%`;
    requestAnimationFrame(draw);
  }
  draw();
}

// ===== Инициализация участника =====
async function setupParticipant(isCaller) {
  if (state.pc) return;

  state.isCaller = isCaller;
  state.pc = createPeerConnection();

  const outgoingAudio = await createOutgoingAudio();
  const audioTrack = outgoingAudio.getAudioTracks()[0];
  state.audioSender = state.pc.addTrack(audioTrack, outgoingAudio);

  const placeholderVideo = createPlaceholderVideoTrack();
  state.videoSender = state.pc.addTrack(placeholderVideo, new MediaStream([placeholderVideo]));

  log('m-line созданы (audio + video placeholder)');

  els.hangupBtn.disabled = false;
  els.createOfferBtn.disabled = true;
  els.joinBtn.disabled = true;
}

// ===== Создание оффера =====
els.createOfferBtn.addEventListener('click', async () => {
  console.log('[click] createOffer');
  try {
    await setupParticipant(true);

    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    await waitForIceGathering(state.pc);

    els.localSignal.value = JSON.stringify(buildSignal(state.pc), null, 2);
    setStatus('оффер создан, отправь код собеседнику');
  } catch (err) {
    console.error('Ошибка создания оффера:', err);
    setStatus('ошибка создания оффера: ' + err.message);
  }
});

// ===== Принятие оффера =====
els.joinBtn.addEventListener('click', async () => {
  console.log('[click] join');
  try {
    await setupParticipant(false);
    setStatus('ожидание кода от собеседника...');
  } catch (err) {
    console.error('Ошибка инициализации:', err);
    setStatus('ошибка инициализации: ' + err.message);
  }
});

// ===== Применение кода собеседника =====
els.applyRemoteBtn.addEventListener('click', async () => {
  console.log('[click] applyRemote. pc =', state.pc);

  if (els.applyRemoteBtn.disabled) return;
  els.applyRemoteBtn.disabled = true;

  try {
    if (!state.pc) {
      setStatus('ОШИБКА: сначала нажми "Создать оффер" или "Принять оффер"');
      return;
    }

    const raw = els.remoteSignal.value.trim();
    if (!raw) {
      setStatus('ОШИБКА: поле "Код собеседника" пустое');
      return;
    }

    if (state.isCaller && !state.pc.localDescription) {
      setStatus('ОШИБКА: оффер ещё не создан');
      return;
    }

    const signal = parseSignal(raw);
    const role = detectSignalRole(signal, state.isCaller);
    log('Роль сигнала:', role);

    if (role === 'create-answer') {
      await state.pc.setRemoteDescription(signal.sdp);
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      await waitForIceGathering(state.pc);
      els.localSignal.value = JSON.stringify(buildSignal(state.pc), null, 2);
      setStatus('ансвер создан, отправь код обратно');
      return;
    }

    if (role === 'accept-answer') {
      await state.pc.setRemoteDescription(signal.sdp);
      setStatus('соединение устанавливается...');
      return;
    }

    if (role === 'already-caller') {
      setStatus('ОШИБКА: ты звонящий, этот код — оффер');
      return;
    }

    if (role === 'already-answerer') {
      setStatus('ОШИБКА: ты принимающий, этот код — ансвер');
      return;
    }

    setStatus('ОШИБКА: неизвестный тип сигнала');
  } catch (err) {
    console.error('Ошибка применения:', err);
    setStatus('ОШИБКА применения: ' + err.message);
  } finally {
    els.applyRemoteBtn.disabled = false;
  }
});

// ===== Копирование =====
els.copyLocalBtn.addEventListener('click', async () => {
  if (!els.localSignal.value) return;
  try {
    await navigator.clipboard.writeText(els.localSignal.value);
    els.copyLocalBtn.textContent = 'Скопировано!';
    setTimeout(() => (els.copyLocalBtn.textContent = 'Копировать'), 1500);
  } catch (err) {
    console.error(err);
  }
});

// ===== Отключение =====
els.hangupBtn.addEventListener('click', cleanup);

function cleanup() {
  if (state.pc) {
    try { state.pc.close(); } catch (e) {}
    state.pc = null;
  }
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  if (state.screenStream) {
    state.screenStream.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
  }
  if (state.screenAudioSource) {
    try { state.screenAudioSource.disconnect(); } catch (e) {}
    state.screenAudioSource = null;
  }
  if (state.screenAudioGain) {
    try { state.screenAudioGain.disconnect(); } catch (e) {}
    state.screenAudioGain = null;
  }

  state.remoteStream = null;
  state.audioSender = null;
  state.videoSender = null;

  els.remoteVideo.srcObject = null;
  els.remoteVideo.classList.remove('active');
  els.remotePlaceholder.style.display = 'flex';
  els.remoteAudio.srcObject = null;
  els.localSignal.value = '';
  els.remoteSignal.value = '';

  els.createOfferBtn.disabled = false;
  els.joinBtn.disabled = false;
  els.hangupBtn.disabled = true;
  els.stopShareBtn.disabled = true;
  els.shareScreenBtn.disabled = false;

  setStatus('отключено');
}

// ===== Демонстрация экрана =====
els.shareScreenBtn.addEventListener('click', async () => {
  if (!state.pc) {
    setStatus('сначала установи соединение');
    return;
  }

  try {
    const wantAudio = els.shareAudio.checked;

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: wantAudio
        ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            suppressLocalAudioPlayback: false,
          }
        : false,
    });

    state.screenStream = displayStream;

    const videoTrack = displayStream.getVideoTracks()[0];
    if (state.videoSender) {
      await state.videoSender.replaceTrack(videoTrack);
      log('Видео экрана заменило заглушку');
    }

    const screenAudioTrack = displayStream.getAudioTracks()[0];
    if (screenAudioTrack) {
      const ctx = await ensureAudioContext();
      const screenStream = new MediaStream([screenAudioTrack]);
      state.screenAudioSource = ctx.createMediaStreamSource(screenStream);
      state.screenAudioGain = ctx.createGain();
      state.screenAudioGain.gain.value = 1;

      state.screenAudioSource.connect(state.screenAudioGain);
      state.screenAudioGain.connect(state.mixerDest);
      log('Звук экрана подключён в микшер');
    } else if (wantAudio) {
      setStatus('экран без звука (выбери вкладку с галочкой)');
    }

    videoTrack.onended = () => stopScreenShare();

    els.shareScreenBtn.disabled = true;
    els.stopShareBtn.disabled = false;
    if (screenAudioTrack) {
      setStatus('демонстрация экрана со звуком');
    } else {
      setStatus('демонстрация экрана (без звука)');
    }
  } catch (err) {
    console.error('Ошибка захвата экрана:', err);
    if (err.name !== 'NotAllowedError') {
      setStatus('ошибка захвата: ' + err.message);
    }
  }
});

// ===== Остановка шаринга =====
els.stopShareBtn.addEventListener('click', stopScreenShare);

async function stopScreenShare() {
  if (state.screenStream) {
    state.screenStream.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
  }
  if (state.screenAudioSource) {
    try { state.screenAudioSource.disconnect(); } catch (e) {}
    state.screenAudioSource = null;
  }
  if (state.screenAudioGain) {
    try { state.screenAudioGain.disconnect(); } catch (e) {}
    state.screenAudioGain = null;
  }
  if (state.pc && state.videoSender) {
    try {
      await state.videoSender.replaceTrack(createPlaceholderVideoTrack());
    } catch (e) {}
  }
  els.shareScreenBtn.disabled = false;
  els.stopShareBtn.disabled = true;
  setStatus('экран остановлен');
}

// ===== Громкость / мьют / deafen =====
els.micVolume.addEventListener('input', (e) => {
  if (state.micGainNode) {
    state.micGainNode.gain.value = parseFloat(e.target.value);
  }
});

els.micMuted.addEventListener('change', (e) => {
  if (state.micGainNode) {
    if (e.target.checked) {
      state.micGainNode._prev = state.micGainNode.gain.value;
      state.micGainNode.gain.value = 0;
    } else {
      state.micGainNode.gain.value = state.micGainNode._prev ?? 1;
    }
  }
});

els.deafen.addEventListener('change', (e) => {
  els.remoteAudio.muted = e.target.checked;
});