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