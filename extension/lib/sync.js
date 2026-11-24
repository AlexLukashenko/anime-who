// Синхронизация субтитров со звуком без распознавания речи:
// сравниваем «где в звуке есть голос» (VAD) с «где на экране субтитр»
// и ищем сдвиг с наилучшим совпадением (идея ffsubsync / alass).

export const BIN = 0.1; // секунд на ячейку

export function makeSubMask(intervals, bin = BIN) {
  const maxEnd = intervals.reduce((m, iv) => Math.max(m, iv[1]), 0);
  const mask = new Uint8Array(Math.ceil(maxEnd / bin) + 2);
  for (const [s, e] of intervals) {
    const a = Math.max(0, Math.floor(s / bin));
    const b = Math.min(mask.length - 1, Math.ceil(e / bin));
    for (let i = a; i < b; i++) mask[i] = 1;
  }
  return mask;
}

export const DEFAULTS = {
  minOffset: -90, // видео раньше субтитров (редко)
  maxOffset: 300, // заставки и реклама студий озвучки — до 5 минут
  windowSec: 300, // оцениваем по последним 5 минутам просмотра
  minObserved: 40, // секунд звука, прежде чем пытаться
  rMin: 0.3, // корреляция в пике
  zMin: 4.6, // пик над средним, в σ
  marginMin: 1.5, // пик над вторым пиком (вне ±2 с), в σ
};

export class SyncEstimator {
  constructor(intervals, opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.bin = this.opts.bin || BIN;
    this.mask = makeSubMask(intervals, this.bin);
    // префиксные суммы маски — чтобы быстро считать среднее по окну
    this.obs = new Map(); // ячейка видео → [сумма вероятностей, число кадров]
    this.maxBin = -Infinity;
  }

  /** Отметить кадр VAD: videoTime — время видео начала кадра, prob — вероятность речи. */
  addFrame(videoTime, prob, dur = 0.032) {
    const i = Math.floor((videoTime + dur / 2) / this.bin);
    if (i < 0) return;
    const prev = this.obs.get(i);
    if (prev) { prev[0] += prob; prev[1] += 1; } else this.obs.set(i, [prob, 1]);
    if (i > this.maxBin) this.maxBin = i;
  }

  observedSeconds() {
    return this.obs.size * this.bin;
  }

  reset() {
    this.obs.clear();
    this.maxBin = -Infinity;
  }

  /**
   * Корреляция Пирсона между маской речи из звука и сдвинутой маской субтитров
   * для каждого сдвига d (видео = субтитры + d). Уверенность — насколько пик
   * выделяется над остальными сдвигами (z) и над вторым пиком (margin).
   */
  estimate() {
    const { minOffset, maxOffset, windowSec, minObserved } = this.opts;
    const bin = this.bin;
    const lo = this.maxBin - Math.round(windowSec / bin);
    const idx = [];
    const val = [];
    let sumA = 0;
    let speech = 0;
    for (const [i, [sum, cnt]] of this.obs) {
      if (i < lo) continue;
      const p = sum / cnt;
      idx.push(i);
      val.push(p);
      sumA += p;
      if (p >= 0.5) speech++;
    }
    const n = idx.length;
    if (n * bin < minObserved) return { ok: false, reason: 'мало звука', n };
    const frac = speech / n;
    if (frac < 0.05 || frac > 0.97) return { ok: false, reason: 'нет речи в звуке', n, frac };
    const meanA = sumA / n;
    let varA = 0;
    for (let k = 0; k < n; k++) { val[k] -= meanA; varA += val[k] * val[k]; }
    if (varA < 1e-6) return { ok: false, reason: 'ровный звук', n };
    const mask = this.mask;
    const dMin = Math.round(minOffset / bin);
    const dMax = Math.round(maxOffset / bin);
    const scores = new Float32Array(dMax - dMin + 1);
    for (let d = dMin; d <= dMax; d++) {
      let sAS = 0;
      let sS = 0;
      for (let k = 0; k < n; k++) {
        const j = idx[k] - d;
        if (j >= 0 && j < mask.length && mask[j] === 1) { sAS += val[k]; sS += 1; }
      }
      // Σ(a−ā)(s−s̄) = Σ(a−ā)s, т.к. Σ(a−ā)=0; дисперсия маски: sS(1 − sS/n)
      const varS = sS * (1 - sS / n);
      scores[d - dMin] = varS > 0 ? sAS / Math.sqrt(varA * varS) : 0;
    }
    let best = -Infinity;
    let bestI = 0;
    let sum = 0;
    for (let i = 0; i < scores.length; i++) {
      sum += scores[i];
      if (scores[i] > best) { best = scores[i]; bestI = i; }
    }
    const mean = sum / scores.length;
    let v = 0;
    for (let i = 0; i < scores.length; i++) v += (scores[i] - mean) ** 2;
    const std = Math.sqrt(v / scores.length) || 1e-6;
    const guard = Math.round(2 / bin);
    let second = -Infinity;
    for (let i = 0; i < scores.length; i++) {
      if (Math.abs(i - bestI) > guard && scores[i] > second) second = scores[i];
    }
    const z = (best - mean) / std;
    const margin = (best - second) / std;
    const offset = Math.round((bestI + dMin) * bin * 100) / 100;
    const ok = best >= this.opts.rMin && z >= this.opts.zMin && margin >= this.opts.marginMin;
    const strong = ok && z >= 6 && margin >= 2.5;
    return { ok, strong, offset, r: round(best), z: round(z), margin: round(margin), n, frac: round(frac) };
  }
}

/**
 * Принятие оценок. Первая фиксация — после двух согласных оценок подряд
 * (или одной очень уверенной); уточнения в пределах 1 с — сразу;
 * скачок (реклама посреди серии) — тоже только после подтверждения.
 */
export class OffsetTracker {
  constructor(initial = null) {
    this.current = initial;
    this.locked = false; // сдвиг подтверждён по звуку в этом просмотре
    this.pending = null;
  }

  push(est) {
    if (!est.ok) return null;
    const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;
    if (this.locked && near(this.current, est.offset, 1.0)) {
      this.current = est.offset;
      this.pending = null;
      return this.current;
    }
    if (est.strong || near(this.pending, est.offset, 0.6)) {
      this.current = est.offset;
      this.locked = true;
      this.pending = null;
      return this.current;
    }
    this.pending = est.offset;
    return null;
  }
}

function round(x) {
  return Math.round(x * 100) / 100;
}
