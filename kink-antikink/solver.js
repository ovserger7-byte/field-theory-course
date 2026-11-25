/* Classical phi^4 evolution. Shared by the browser worker and Node validation. */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({ eta: 1, lambda: 0.5, xK: -10, xA: 10, vK: 0.35, vA: -0.35 });
  const PRESETS = Object.freeze({
    escape: { ...DEFAULTS },
    capture: { ...DEFAULTS, vK: 0.213, vA: -0.213 },
    resonance: { ...DEFAULTS, vK: 0.1988, vA: -0.1988 }
  });

  function validate(p) {
    for (const key of Object.keys(DEFAULTS)) {
      if (!Number.isFinite(p[key])) throw new Error('Все шесть параметров должны быть конечными числами.');
    }
    if (p.eta < 0.25 || p.eta > 3) throw new Error('Выберите η от 0,25 до 3.');
    if (p.lambda < 0.125 || p.lambda > 4) throw new Error('Выберите λ от 0,125 до 4.');
    if (Math.abs(p.vK) > 0.8 || Math.abs(p.vA) > 0.8) throw new Error('Скорости должны лежать между −0,8 и 0,8 (c = 1).');
    if (Math.abs(p.xK) > 30 || Math.abs(p.xA) > 30) throw new Error('Начальные координаты должны лежать между −30 и 30 ширинами кинка.');
    if (p.xA - p.xK < 8) throw new Error('Антикинк должен быть правее кинка хотя бы на 8 ℓK: начальные профили должны быть хорошо разделены.');
    return p;
  }

  function force(u, i, c) {
    const z = u[i];
    return (-u[i + 2] + 16 * u[i + 1] - 30 * z + 16 * u[i - 1] - u[i - 2]) * c + 2 * z * (1 - z * z);
  }

  class Simulation {
    constructor(parameters = DEFAULTS, options = {}) {
      this.parameters = { ...validate(parameters) };
      this.dx = options.dx ?? 0.05;
      this.dt = options.dt ?? 0.01;
      this.end = options.end ?? 140;
      if (!(this.dx > 0 && this.dt > 0 && this.dt / this.dx <= 0.4 && this.end > 0)) {
        throw new Error('Некорректные шаги сетки или интервал времени.');
      }
      const p = this.parameters;
      this.ell = 1 / (p.eta * Math.sqrt(2 * p.lambda));
      // The boundary is farther than the complete light travel distance,
      // with another 20 kink widths of padding for the exponential tails.
      this.half = Math.ceil((Math.max(Math.abs(p.xK), Math.abs(p.xA)) + this.end + 20) / this.dx) * this.dx;
      this.n = Math.round(2 * this.half / this.dx) + 1;
      this.u = new Float64Array(this.n);
      this.p = new Float64Array(this.n);
      this.a = new Float64Array(this.n);
      this.stepNumber = 0;
      const gK = 1 / Math.sqrt(1 - p.vK * p.vK);
      const gA = 1 / Math.sqrt(1 - p.vA * p.vA);
      for (let i = 0; i < this.n; i++) {
        const x = i * this.dx - this.half;
        const k = Math.tanh(gK * (x - p.xK));
        const a = Math.tanh(gA * (x - p.xA));
        this.u[i] = k - a - 1;
        this.p[i] = -p.vK * gK * (1 - k * k) + p.vA * gA * (1 - a * a);
      }
      this.u[0] = this.u[1] = this.u[this.n - 2] = this.u[this.n - 1] = -1;
      this.p[0] = this.p[1] = this.p[this.n - 2] = this.p[this.n - 1] = 0;
      this.accelerate();
      this.initialEnergy = this.energy();
    }

    get time() { return this.stepNumber * this.dt; }

    accelerate() {
      const { u, a, n, dx } = this;
      const c = 1 / (12 * dx * dx);
      for (let i = 2; i < n - 2; i++) a[i] = force(u, i, c);
    }

    // Bounds include momenta and accelerations even if u has rounded to -1.
    activeRange() {
      const { u, p, a, n } = this;
      let first = 0, last = n - 1;
      while (first < last && u[first] === -1 && p[first] === 0 && a[first] === 0) first++;
      while (last > first && u[last] === -1 && p[last] === 0 && a[last] === 0) last--;
      return [first, last];
    }

    advance(count = 1) {
      const { u, p, a, n, dt, dx } = this;
      const c = 1 / (12 * dx * dx);
      // Start with a full step (also normalizes signed zero in the initial p).
      let [first, last] = this.stepNumber ? this.activeRange() : [2, n - 3];
      for (let s = 0; s < count; s++) {
        for (let i = Math.max(2, first); i <= Math.min(last, n - 3); i++) {
          p[i] += 0.5 * dt * a[i];
          u[i] += dt * p[i];
        }
        // The stencil can reach at most two more nodes in this force evaluation.
        first = Math.max(2, first - 2);
        last = Math.min(n - 3, last + 2);
        for (let i = first; i <= last; i++) {
          a[i] = force(u, i, c);
          p[i] += 0.5 * dt * a[i];
        }
        this.stepNumber++;
      }
    }

    energy() {
      const { u, p, n, dx } = this;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const q = u[i] * u[i] - 1;
        sum += 0.5 * (p[i] * p[i] + q * q);
        // Discrete Hamiltonian matching the fourth-order Laplacian.
        if (i + 1 < n) sum += (2 / 3) * ((u[i + 1] - u[i]) / dx) ** 2;
        if (i + 2 < n) sum -= (1 / 24) * ((u[i + 2] - u[i]) / dx) ** 2;
      }
      return sum * dx;
    }

    at(x) {
      const j = (x + this.half) / this.dx;
      const i = Math.floor(j);
      return this.u[i] + (j - i) * (this.u[i + 1] - this.u[i]);
    }

    zeroes() {
      const roots = [];
      for (let i = 1; i < this.n; i++) {
        if (this.u[i - 1] * this.u[i] < 0) {
          roots.push((i - 1 - this.u[i - 1] / (this.u[i] - this.u[i - 1])) * this.dx - this.half);
        }
      }
      return roots;
    }

    compactSnapshot(stride = 2) {
      const [first, last] = this.activeRange();
      // Keep the two-node halo needed by the displayed energy density.
      const offset = Math.max(0, Math.ceil((first - 2) / stride));
      const stop = Math.floor(Math.min(this.n - 1, last + 2) / stride);
      const frame = this.snapshot(stride, offset, stop - offset + 1);
      frame.offset = offset;
      frame.fullSize = Math.floor((this.n - 1) / stride) + 1;
      return frame;
    }

    snapshot(stride = 2, offset = 0, size = Math.floor((this.n - 1) / stride) + 1) {
      const { u, p, n, dx } = this;
      const field = new Float32Array(size);
      const density = new Float32Array(size);
      let peak = 0;
      let extent = 20;
      for (let j = 0; j < size; j++) {
        const i = (j + offset) * stride;
        field[j] = u[i];
        const ux = i >= 2 && i < n - 2 ? (-u[i + 2] + 8 * u[i + 1] - 8 * u[i - 1] + u[i - 2]) / (12 * dx) : 0;
        const q = u[i] * u[i] - 1;
        density[j] = 0.5 * (p[i] * p[i] + ux * ux + q * q);
        peak = Math.max(peak, density[j]);
        if (u[i] > -0.25) extent = Math.max(extent, Math.abs(i * dx - this.half) + 8);
      }
      const energy = this.energy();
      if (!Number.isFinite(energy) || peak > 1000) throw new Error('Расчёт потерял устойчивость. Уменьшите скорости и повторите.');
      return { time: this.time, field, density, peak, extent, energy, center: this.at(0) };
    }
  }

  const api = { DEFAULTS, PRESETS, validate, Simulation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KinkPhysics = api;
})(globalThis);
