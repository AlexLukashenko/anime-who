// Детектор речи: Silero VAD v5 (ONNX) + запасной энергетический детектор.

export const SAMPLE_RATE = 16000;
export const FRAME = 512; // 32 мс
const CONTEXT = 64;

export class SileroVad {
  static async create(ort, modelBuffer) {
    const session = await ort.InferenceSession.create(modelBuffer);
    return new SileroVad(ort, session);
  }

  constructor(ort, session) {
    this.ort = ort;
    this.session = session;
    this.sr = new ort.Tensor('int64', [16000n]);
    this.reset();
  }

  reset() {
    this.state = new this.ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    this.context = new Float32Array(CONTEXT);
  }

  /** frame: Float32Array(512) @16 кГц → вероятность речи 0..1 */
  async process(frame) {
    const input = new Float32Array(CONTEXT + frame.length);
    input.set(this.context, 0);
    input.set(frame, CONTEXT);
    this.context = frame.slice(-CONTEXT);
    const out = await this.session.run({
      input: new this.ort.Tensor('float32', input, [1, input.length]),
      state: this.state,
      sr: this.sr,
    });
    this.state = out.stateN;
    return out.output.data[0];
  }
}

/** Простой детектор по энергии с адаптивным порогом — если ONNX не загрузился. */
export class EnergyVad {
  constructor() {
    this.noise = 1e-4;
    this.reset();
  }

  reset() {
    this.noise = 1e-4;
    this.prevSample = 0;
  }

  async process(frame) {
    // Предыскажение (подъём высоких частот), чтобы басы музыки меньше влияли.
    let e = 0;
    let prev = this.prevSample;
    for (let i = 0; i < frame.length; i++) {
      const x = frame[i] - 0.95 * prev;
      prev = frame[i];
      e += x * x;
    }
    this.prevSample = prev;
    e /= frame.length;
    this.noise = e < this.noise ? 0.9 * this.noise + 0.1 * e : 0.999 * this.noise + 0.001 * e;
    const ratio = e / (this.noise + 1e-9);
    return Math.max(0, Math.min(1, (Math.log10(ratio + 1e-9) - 0.3) / 0.7));
  }
}
