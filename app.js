// ============================================================
// P2P Voice Chat — клиент с WebSocket-сигнализацией
// Версия 5.1 — исправления:
//  - блокировка кнопок комнаты после клика
//  - сброс state.roomId при cleanup
//  - защита от двойного join
//  - разблокировка roomInput после cleanup
// ============================================================

import { checkBrowserSupport } from './signaling.js';

// ===== Состояние =====
const state = {
  // WebSocket
  ws: null,
  roomId: null,
  isInitiator: false,

  // WebRTC
  pc: null,
  localStream: null,
  screenStream: null,
  remoteStream: null,
  audioSender: null,
  videoSender: null,

  // Web Audio
  audioCtx: null,
  micGainNode: null,
  micSourceNode: null,
  mixerDest: null,
  screenAudioSource: null,
  screenAudioGain: null,
};
let pcInitPromise = null;
// ===== DOM =====
const $ = (id) => document.getElementById(id);
const els = {
  roomLabel: $('roomLabel'),
  createRoomBtn: $('createRoomBtn'),
  joinRoomBtn: $('joinRoomBtn'),
  roomInput: $('roomInput'),
  copyLinkBtn: $('copyLinkBtn'),
  hangupBtn: $('hangupBtn'),

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

// ===== ICE =====
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

// ============================================================
// WebSocket-сигнализация
// ============================================================
function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}`;
  log('Подключение к WS:', url);

  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    log('WebSocket открыт');
    setStatus('подключено к серверу');
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error('Некорректное сообщение WS:', event.data);
      return;
    }
    log('WS ←', msg.type, msg.payload || '');

    try {
      if (msg.type === 'joined') {
        state.isInitiator = msg.payload.isInitiator;
        state.roomId = msg.payload.roomId;
        els.roomLabel.textContent = state.roomId;
        setStatus(
          msg.payload.isInitiator
            ? 'ожидание собеседника...'
            : 'собеседник найден, соединяемся...'
        );
        await setupPeerConnection();
        return;
      }

      if (msg.type === 'peer-joined') {
        setStatus('собеседник подключился');
        if (state.isInitiator && state.pc && !state.pc.localDescription) {
          await createAndSendOffer();
        }
        return;
      }

      if (msg.type === 'offer') {
        await handleRemoteOffer(msg.payload.sdp);
        return;
      }

      if (msg.type === 'answer') {
        if (!state.pc) {
          log('Answer получен без pc — игнорируем');
          return;
        }
        await state.pc.setRemoteDescription(msg.payload.sdp);
        setStatus('соединение устанавливается...');
        return;
      }

      if (msg.type === 'ice-candidate') {
        if (state.pc && state.pc.remoteDescription) {
          await state.pc.addIceCandidate(msg.payload.candidate);
        }
        return;
      }

      if (msg.type === 'peer-left') {
        setStatus('собеседник отключился');
        cleanup(false);
        return;
      }
    } catch (err) {
      console.error('Ошибка обработки WS-сообщения:', err);
      setStatus('ошибка: ' + err.message);
    }
  };

  ws.onclose = () => {
    log('WebSocket закрыт');
    setStatus('отключено от сервера');
  };

  ws.onerror = (e) => {
    console.error('WebSocket error:', e);
    setStatus('ошибка WebSocket');
  };
}

async function createAndSendOffer() {
  await setupPeerConnection();
  if (!state.pc) return;
  const offer = await state.pc.createOffer();
  await state.pc.setLocalDescription(offer);
  state.ws.send(
    JSON.stringify({
      type: 'offer',
      payload: { sdp: offer },
    })
  );
  log('Оффер отправлен');
}

async function handleRemoteOffer(sdp) {
  await setupPeerConnection();
  await state.pc.setRemoteDescription(sdp);
  const answer = await state.pc.createAnswer();
  await state.pc.setLocalDescription(answer);
  state.ws.send(
    JSON.stringify({
      type: 'answer',
      payload: { sdp: answer },
    })
  );
  log('Ансвер отправлен');
}

// ===== Кнопки комнаты =====
els.createRoomBtn.addEventListener('click', () => {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    setStatus('нет соединения с сервером');
    return;
  }
  if (state.roomId) {
    setStatus('ты уже в комнате ' + state.roomId);
    return;
  }
  const roomId = Math.random().toString(36).slice(2, 8);
  state.roomId = roomId;
  els.roomLabel.textContent = roomId;

  // Блокируем кнопки, чтобы избежать двойного join
  els.createRoomBtn.disabled = true;
  els.joinRoomBtn.disabled = true;
  els.roomInput.disabled = true;

  state.ws.send(
    JSON.stringify({
      type: 'join',
      payload: { roomId },
    })
  );
  setStatus('создаём комнату ' + roomId + '...');
});

els.joinRoomBtn.addEventListener('click', () => {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    setStatus('нет соединения с сервером');
    return;
  }
  if (state.roomId) {
    setStatus('ты уже в комнате ' + state.roomId);
    return;
  }
  const roomId = els.roomInput.value.trim();
  if (!roomId) {
    setStatus('введи ID комнаты');
    return;
  }
  state.roomId = roomId;
  els.roomLabel.textContent = roomId;

  // Блокируем кнопки, чтобы избежать двойного join
  els.createRoomBtn.disabled = true;
  els.joinRoomBtn.disabled = true;
  els.roomInput.disabled = true;

  state.ws.send(
    JSON.stringify({
      type: 'join',
      payload: { roomId },
    })
  );
  setStatus('подключаемся к ' + roomId + '...');
});

els.copyLinkBtn.addEventListener('click', async () => {
  if (!state.roomId) {
    setStatus('сначала создай или подключись к комнате');
    return;
  }
  const link = `${location.origin}/?room=${state.roomId}`;
  try {
    await navigator.clipboard.writeText(link);
    els.copyLinkBtn.textContent = 'Скопировано!';
    setTimeout(() => (els.copyLinkBtn.textContent = 'Скопировать ссылку'), 1500);
  } catch (err) {
    console.error(err);
  }
});

// ============================================================
// WebRTC
// ============================================================

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

  // Отправляем ICE-кандидатов через WebSocket
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      log('ICE-кандидат:', event.candidate.type);
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(
          JSON.stringify({
            type: 'ice-candidate',
            payload: { candidate: event.candidate },
          })
        );
      }
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
      // Разблокируем кнопку шаринга экрана
      els.shareScreenBtn.disabled = false;
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

// ===== Индикатор уровня микрофона =====
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

// ===== Инициализация PeerConnection =====
async function setupPeerConnection() {
  if (pcInitPromise) return pcInitPromise;
  pcInitPromise = (async () => {
    state.pc = createPeerConnection();

    const outgoingAudio = await createOutgoingAudio();
    const audioTrack = outgoingAudio.getAudioTracks()[0];
    state.audioSender = state.pc.addTrack(audioTrack, outgoingAudio);

    const placeholderVideo = createPlaceholderVideoTrack();
    state.videoSender = state.pc.addTrack(
      placeholderVideo,
      new MediaStream([placeholderVideo])
    );

    log('m-line созданы (audio + video placeholder)');
    els.hangupBtn.disabled = false;
  })();
  return pcInitPromise;
}

// ===== Отключение =====
els.hangupBtn.addEventListener('click', () => cleanup(true));

function cleanup(sendLeave = true) {
  if (sendLeave && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'leave' }));
  }
  if (state.pc) {
    try {
      state.pc.close();
    } catch (e) {}
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
    try {
      state.screenAudioSource.disconnect();
    } catch (e) {}
    state.screenAudioSource = null;
  }
  if (state.screenAudioGain) {
    try {
      state.screenAudioGain.disconnect();
    } catch (e) {}
    state.screenAudioGain = null;
  }

  state.remoteStream = null;
  state.audioSender = null;
  state.videoSender = null;
  state.isInitiator = false;
  state.roomId = null;
  pcInitPromise = null;  

  els.remoteVideo.srcObject = null;
  els.remoteVideo.classList.remove('active');
  els.remotePlaceholder.style.display = 'flex';
  els.remoteAudio.srcObject = null;
  els.roomLabel.textContent = '—';

  // Возвращаем кнопки комнаты в исходное состояние
  els.createRoomBtn.disabled = false;
  els.joinRoomBtn.disabled = false;
  els.roomInput.disabled = false;

  els.hangupBtn.disabled = true;
  els.stopShareBtn.disabled = true;
  els.shareScreenBtn.disabled = true;

  setStatus('отключено');
}

// ===== Демонстрация экрана =====
els.shareScreenBtn.addEventListener('click', async () => {
  if (!state.pc || state.pc.connectionState !== 'connected') {
    setStatus('сначала дождись соединения');
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
    try {
      state.screenAudioSource.disconnect();
    } catch (e) {}
    state.screenAudioSource = null;
  }
  if (state.screenAudioGain) {
    try {
      state.screenAudioGain.disconnect();
    } catch (e) {}
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

// ===== Автоподключение по URL =====
(function autoJoinFromUrl() {
  // Кнопка "Показать экран" заблокирована, пока нет соединения
  els.shareScreenBtn.disabled = true;

  const params = new URLSearchParams(location.search);
  const roomFromUrl = params.get('room');
  if (roomFromUrl) {
    els.roomInput.value = roomFromUrl;
  }
  connectWebSocket();
})();