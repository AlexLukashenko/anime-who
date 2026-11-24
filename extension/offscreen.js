// Offscreen-документ: детектор речи (Silero VAD) и подбор сдвига субтитров.
// Звук приходит либо из плеера (captureStream, PCM по порту),
// либо из захвата вкладки (tabCapture) — тогда время видео берём из «тиков» плеера.

import * as ort from './vendor/ort.wasm.min.mjs';
import { SileroVad, EnergyVad, FRAME, SAMPLE_RATE } from './lib/vad.js';
import { SyncEstimator, OffsetTracker } from './lib/sync.js';

ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

let modelSession = null;
let vadKind = 'silero';
const ready = (async () => {
  try {
    const buf = await (await fetch(chrome.runtime.getURL('vendor/silero_vad_v5.onnx'))).arrayBuffer();
    modelSession = await ort.InferenceSession.create(buf);
  } catch (e) {
    console.warn('Silero VAD не загрузился, используем энергетический детектор', e);
    vadKind = 'energy';
  }
})();

const ESTIMATE_EVERY = 10; // секунд нового звука между оценками
const sessions = new Set();

function decodePcm(b64) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 32768;
  }
  return out;
}

/** Ресемплинг в 16 кГц с усреднением (простая защита от наложения частот). */
function makeResampler(fromRate) {
  const ratio = fromRate / SAMPLE_RATE;
  let pos = 0; // дробная позиция внутри входа
  return (input) => {
    const out = [];
    while (pos + ratio <= input.length) {
      const a = Math.max(0, Math.floor(pos));
      const b = Math.min(input.length, Math.floor(pos + ratio));
      let s = 0;
      for (let i = a; i < b; i++) s += input[i];
      out.push(b > a ? s / (b - a) : input[a]);
      pos += ratio;
    }
    pos -= input.length;
    return Float32Array.from(out);
  };
}

class Session {
  constructor(port) {
    this.port = port;
    this.tabId = port.sender?.tab?.id ?? null;
    this.est = null;
    this.tracker = null;
    this.vad = null;
    this.buf = new Float32Array(0);
    this.bufT = 0;
    this.sinceEstimate = 0;
    this.chain = Promise.resolve();
    this.tick = null;
    this.capture = null; // tabCapture
  }

  async init(msg) {
    await ready;
    this.est = new SyncEstimator(msg.intervals || []);
    this.tracker = new OffsetTracker(msg.initialOffset ?? null);
    this.vad = modelSession ? new SileroVad(ort, modelSession) : new EnergyVad();
    this.port.postMessage({ type: 'ready', vad: vadKind });
  }

  enqueue(t0, samples) {
    this.chain = this.chain.then(() => this.pushPcm(t0, samples)).catch((e) => console.warn(e));
  }

  async pushPcm(t0, samples) {
    if (!this.est) return;
    const expected = this.bufT + this.buf.length / SAMPLE_RATE;
    if (Math.abs(t0 - expected) > 0.15) {
      // перемотка или пауза — начинаем заново с этого места
      this.buf = new Float32Array(0);
      this.bufT = t0;
      this.vad.reset();
    }
    const merged = new Float32Array(this.buf.length + samples.length);
    merged.set(this.buf, 0);
    merged.set(samples, this.buf.length);
    let i = 0;
    for (; i + FRAME <= merged.length; i += FRAME) {
      const p = await this.vad.process(merged.subarray(i, i + FRAME));
      this.est.addFrame(this.bufT + i / SAMPLE_RATE, p, FRAME / SAMPLE_RATE);
    }
    this.sinceEstimate += i / SAMPLE_RATE;
    this.bufT += i / SAMPLE_RATE;
    this.buf = merged.slice(i);
    if (this.sinceEstimate >= ESTIMATE_EVERY) {
      this.sinceEstimate = 0;
      const est = this.est.estimate();
      const accepted = this.tracker.push(est);
      this.port.postMessage({
        type: 'estimate',
        est,
        accepted,
        current: this.tracker.current,
        locked: this.tracker.locked,
        observed: Math.round(this.est.observedSeconds()),
        vad: vadKind,
      });
    }
  }

  /** Звук из tabCapture: переводим «настенное» время в время видео по последнему тику плеера. */
  onTabAudio(samples, wallStart) {
    const t = this.tick;
    if (!t || t.paused || wallStart - t.wall > 2000) return;
    const v = t.v + ((wallStart - t.wall) / 1000) * (t.rate || 1);
    this.enqueue(v, samples);
  }

  stopCapture() {
    if (!this.capture) return;
    this.capture.stream.getTracks().forEach((tr) => tr.stop());
    this.capture.ctx.close().catch(() => {});
    this.capture = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'vad') return;
  const s = new Session(port);
  sessions.add(s);
  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'init': s.init(msg); break;
      case 'pcm': s.enqueue(msg.t0, decodePcm(msg.data)); break;
      case 'tick': s.tick = msg; break;
      case 'reset':
        if (s.est) { s.est.reset(); s.tracker = new OffsetTracker(null); s.sinceEstimate = 0; }
        break;
      default: break;
    }
  });
  port.onDisconnect.addListener(() => {
    sessions.delete(s);
    // Захват вкладки передаём новой сессии той же вкладки (серия сменилась), иначе — стоп.
    if (s.capture) {
      const heir = [...sessions].find((x) => x.tabId === s.tabId && !x.capture);
      if (heir) { heir.capture = s.capture; heir.capture.owner = heir; } else s.stopCapture();
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'tab-capture') {
    startTabCapture(msg.tabId, msg.streamId).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e) }),
    );
    return true;
  }
  return false;
});

async function startTabCapture(tabId, streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  src.connect(ctx.destination); // захват глушит вкладку — возвращаем звук в колонки
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const resample = makeResampler(ctx.sampleRate);
  const capture = { stream, ctx, owner: null };
  proc.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const wallStart = Date.now() - (input.length / ctx.sampleRate) * 1000;
    const owner = capture.owner || [...sessions].find((x) => x.tabId === tabId);
    if (!owner) return;
    capture.owner = owner;
    owner.capture = capture;
    owner.onTabAudio(resample(input), wallStart);
  };
  src.connect(proc);
  proc.connect(ctx.destination);
  for (const s of sessions) if (s.tabId === tabId) { s.stopCapture(); s.capture = capture; capture.owner = s; }
}
