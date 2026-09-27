// signaling.js

/**
 * Собирает объект сигнала из RTCPeerConnection.
 */
export function buildSignal(pc) {
  if (!pc || !pc.localDescription) {
    throw new Error('RTCPeerConnection не инициализирован или нет localDescription');
  }
  return {
    sdp: {
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp,
    },
    candidates: [],
  };
}

/**
 * Парсит JSON-строку сигнала и валидирует структуру.
 */
export function parseSignal(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Пустой сигнал');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Некорректный JSON: ' + e.message);
  }

  if (!parsed.sdp || !parsed.sdp.type || !parsed.sdp.sdp) {
    throw new Error('В сигнале отсутствует поле sdp');
  }

  if (!['offer', 'answer'].includes(parsed.sdp.type)) {
    throw new Error('Неизвестный тип SDP: ' + parsed.sdp.type);
  }

  return parsed;
}

/**
 * Определяет роль в сигнализации на основе типа SDP.
 */
export function detectSignalRole(signal, isCaller) {
  const type = signal.sdp.type;
  if (isCaller && type === 'answer') return 'accept-answer';
  if (!isCaller && type === 'offer') return 'create-answer';
  if (isCaller && type === 'offer') return 'already-caller';
  if (!isCaller && type === 'answer') return 'already-answerer';
  return 'unknown';
}

/**
 * Проверяет, поддерживает ли браузер нужные API.
 */
export function checkBrowserSupport(win = window, nav = navigator) {
  return {
    webRTC: typeof win.RTCPeerConnection !== 'undefined',
    getUserMedia: !!(nav.mediaDevices && nav.mediaDevices.getUserMedia),
    getDisplayMedia: !!(nav.mediaDevices && nav.mediaDevices.getDisplayMedia),
    audioContext:
      typeof win.AudioContext !== 'undefined' ||
      typeof win.webkitAudioContext !== 'undefined',
    clipboard: !!(nav.clipboard && nav.clipboard.writeText),
  };
}