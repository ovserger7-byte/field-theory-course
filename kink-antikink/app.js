(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const keys = Object.keys(KinkPhysics.DEFAULTS);
  const descriptions = {
    escape: 'При v = 0,35 кинк и антикинк расходятся после первой встречи. За каждым можно проследить по максимуму плотности энергии.',
    capture: 'При v = 0,213 образуется бион. Поле колеблется в центре, а расходящиеся волны постепенно уносят энергию за пределы выделенной области.',
    resonance: 'При v = 0,1988 пара встречается дважды. Во время второй встречи часть энергии внутренних колебаний возвращается в движение, и пара расходится.',
    custom: 'Столкновение с выбранными начальными условиями.'
  };
  // Common normalized limits cover all three presets. Custom runs can
  // enlarge them once, before playback, to include the complete trajectory.
  const baseAxes = Object.freeze({ half: 36, bottom: -2, top: 1.5, energy: 2.5 });
  let axes = baseAxes;
  let showBion = false;
  const number = (v, digits = 3) => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: digits, useGrouping: false });
  let active = { ...KinkPhysics.DEFAULTS };
  let frames = [], metadata = null, worker = null, generation = 0;
  let time = 0, playing = false, busy = false, lastAnimation = 0, lastDraw = 0;
  const colors = { field: '#236454', energy: '#b96a36', grid: '#e1e4d8', text: '#687268', ink: '#183d36' };

  function readParameters() {
    return Object.fromEntries(keys.map(key => [key, $(key + '-number').valueAsNumber]));
  }

  function setParameters(parameters) {
    for (const key of keys) {
      $(key + '-number').value = parameters[key];
      $(key + '-range').value = parameters[key];
    }
    updateScale();
  }

  function updateScale() {
    const p = readParameters();
    const ell = 1 / (p.eta * Math.sqrt(2 * p.lambda));
    $('width-value').textContent = Number.isFinite(ell) && ell > 0 ? number(ell, 4) : '—';
  }

  function syncSymmetry() {
    const symmetric = $('symmetric').checked;
    for (const key of ['xA', 'vA']) {
      $(key + '-number').disabled = symmetric;
      $(key + '-range').disabled = symmetric;
    }
    if (symmetric) {
      for (const [a, b] of [['xK', 'xA'], ['vK', 'vA']]) {
        const value = -$(a + '-number').valueAsNumber;
        $(b + '-number').value = Number.isFinite(value) ? value : '';
        if (Number.isFinite(value)) $(b + '-range').value = value;
      }
    }
  }

  function validateForm() {
    let error = '';
    for (const key of keys) $(key + '-number').removeAttribute('aria-invalid');
    try { KinkPhysics.validate(readParameters()); } catch (e) { error = e.message; }
    $('form-error').hidden = !error;
    $('form-error').textContent = error;
    $('apply').disabled = !!error;
    return !error;
  }

  function markChanges() {
    syncSymmetry(); updateScale(); validateForm();
    const p = readParameters();
    const changed = keys.some(key => p[key] !== active[key]);
    $('pending').classList.toggle('changed', changed);
    $('pending').textContent = changed ? 'Параметры изменены. Примените их, чтобы обновить графики.' : 'Параметры соответствуют графикам.';
  }

  for (const key of keys) {
    $(key + '-range').addEventListener('input', event => {
      $(key + '-number').value = event.target.value;
      markChanges();
    });
    $(key + '-number').addEventListener('input', event => {
      const value = event.target.valueAsNumber;
      if (Number.isFinite(value)) $(key + '-range').value = value;
      markChanges();
    });
  }
  $('symmetric').addEventListener('change', markChanges);

  function setPlaying(value) {
    playing = value && !busy && frames.length > 1;
    $('play').textContent = playing ? 'Ⅱ Пауза' : '▶ Запустить';
  }

  function enablePlayback(enabled) {
    for (const id of ['play', 'restart', 'step', 'timeline']) $(id).disabled = !enabled;
  }

  function handleMessage(message, token) {
    if (token !== generation) return;
    if (message.type === 'start') {
      metadata = message; frames = [];
      $('timeline').max = message.end;
    } else if (message.type === 'frames') {
      // Cached workers can still send full-grid frames without bounds.
      for (const frame of message.frames) {
        frame.offset ??= 0;
        frame.fullSize ??= frame.field.length;
      }
      if (showBion) {
        // Integrate the displayed density by the trapezoidal rule on [-15,15].
        const { half, spacing, initialEnergy } = metadata;
        const first = Math.round((half - 15) / spacing);
        const last = Math.round((half + 15) / spacing);
        for (const frame of message.frames) {
          const d = frame.density;
          const lo = first - frame.offset, hi = last - frame.offset;
          let sum = ((d[lo] ?? 0) + (d[hi] ?? 0)) / 2;
          for (let i = Math.max(0, lo + 1); i < Math.min(hi, d.length); i++) sum += d[i];
          frame.centralShare = sum * spacing / initialEnergy;
        }
      }
      frames.push(...message.frames);
      $('progress').value = message.progress;
      // Avoid screen-reader announcements for every batch.
      if (frames.length === message.frames.length) draw();
    } else if (message.type === 'complete') {
      axes = { ...baseAxes };
      for (const frame of frames) {
        axes.half = Math.max(axes.half, Math.ceil(frame.extent / 4) * 4);
        axes.energy = Math.max(axes.energy, Math.ceil(frame.peak * 1.04 * 2) / 2);
        for (const u of frame.field) {
          if (u < axes.bottom) axes.bottom = Math.floor(2 * u) / 2;
          if (u > axes.top) axes.top = Math.ceil(2 * u) / 2;
        }
      }
      busy = false;
      $('progress').hidden = true;
      $('status').textContent = '';
      enablePlayback(true);
      draw();
    } else if (message.type === 'error') {
      busy = false; setPlaying(false); enablePlayback(false);
      $('progress').hidden = true;
      $('status').textContent = 'Не удалось завершить расчёт: ' + message.message;
    }
  }

  function runOnMainThread(parameters, token, end) {
    try {
      const sim = new KinkPhysics.Simulation(parameters, { end });
      handleMessage({ type: 'start', half: sim.half, spacing: sim.dx * 2, ell: sim.ell, initialEnergy: sim.initialEnergy, end: sim.end, frameInterval: 0.2 }, token);
      let initial = true;
      function chunk() {
        if (token !== generation) return;
        try {
          const batch = [];
          const started = performance.now();
          do {
            if (!initial) sim.advance(20);
            initial = false;
            batch.push(sim.compactSnapshot(2));
          } while (sim.time < sim.end - sim.dt / 2 && performance.now() - started < 12);
          handleMessage({ type: 'frames', frames: batch, progress: sim.time / sim.end }, token);
          if (sim.time < sim.end - sim.dt / 2) setTimeout(chunk, 0);
          else handleMessage({ type: 'complete' }, token);
        } catch (error) { handleMessage({ type: 'error', message: error.message }, token); }
      }
      setTimeout(chunk, 0);
    } catch (error) { handleMessage({ type: 'error', message: error.message }, token); }
  }

  function calculate(parameters, preset = 'custom') {
    KinkPhysics.validate(parameters);
    const token = ++generation;
    if (worker) { worker.terminate(); worker = null; }
    if (preset === 'custom') {
      preset = Object.keys(KinkPhysics.PRESETS).find(name =>
        keys.every(key => parameters[key] === KinkPhysics.PRESETS[name][key])) || 'custom';
    }
    active = { ...parameters };
    showBion = preset === 'capture';
    const end = showBion ? 300 : 140;
    $('bion-energy').hidden = !showBion;
    time = 0; frames = []; metadata = null; busy = true;
    setPlaying(false); enablePlayback(false);
    $('timeline').value = 0;
    axes = baseAxes;
    $('scenario-note').textContent = descriptions[preset];
    for (const button of document.querySelectorAll('[data-preset]')) {
      const selected = button.dataset.preset === preset;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    $('pending').classList.remove('changed');
    $('pending').textContent = 'Параметры соответствуют графикам.';
    $('progress').hidden = false; $('progress').value = 0;
    $('status').textContent = 'Вычисляем эволюцию поля…';
    // Immediately replace the previous run with the new initial profile.
    const initial = new KinkPhysics.Simulation(parameters, { end });
    handleMessage({ type: 'start', half: initial.half, spacing: initial.dx * 2, ell: initial.ell, initialEnergy: initial.initialEnergy, end: initial.end, frameInterval: 0.2 }, token);
    handleMessage({ type: 'frames', frames: [initial.compactSnapshot(2)], progress: 0 }, token);
    // file:// browsers may forbid workers. The same solver runs in short
    // main-thread chunks in that case; no server is required to open the file.
    if (location.protocol === 'file:' || typeof Worker === 'undefined') {
      runOnMainThread(parameters, token, end);
      return;
    }
    try {
      worker = new Worker('worker.js');
      worker.onmessage = event => handleMessage(event.data, token);
      worker.onerror = event => {
        event.preventDefault();
        if (token !== generation) return;
        worker.terminate(); worker = null;
        runOnMainThread(parameters, token, end);
      };
      worker.postMessage({ parameters, end });
    } catch (_) { runOnMainThread(parameters, token, end); }
  }

  document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
    const preset = button.dataset.preset;
    $('symmetric').checked = true;
    setParameters(KinkPhysics.PRESETS[preset]); syncSymmetry(); validateForm();
    calculate(readParameters(), preset);
  }));
  $('parameters-form').addEventListener('submit', event => {
    event.preventDefault();
    if (validateForm()) calculate(readParameters());
  });

  function currentFrame() {
    if (!frames.length || !metadata) return null;
    const position = Math.min(time / metadata.frameInterval, frames.length - 1);
    const index = Math.floor(position);
    return { a: frames[index], b: frames[Math.min(index + 1, frames.length - 1)], fraction: position - index };
  }

  function niceStep(span, target = 6) {
    const rough = span / target;
    const power = 10 ** Math.floor(Math.log10(rough));
    const f = rough / power;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * power;
  }

  function plot(canvas, frame, kind, normalized) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const w = rect.width, h = rect.height;
    if (canvas.width !== Math.round(w * pixelRatio) || canvas.height !== Math.round(h * pixelRatio)) {
      canvas.width = Math.round(w * pixelRatio); canvas.height = Math.round(h * pixelRatio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0); ctx.clearRect(0, 0, w, h);
    const { a, b, fraction } = frame;
    const field = kind === 'field';
    const scaleX = normalized ? 1 : metadata.ell;
    const scaleY = normalized ? 1 : field ? active.eta : active.eta ** 2 / metadata.ell ** 2;
    const half = axes.half;
    const ymin = field ? axes.bottom * scaleY : 0;
    const ymax = field ? axes.top * scaleY : axes.energy * scaleY;
    const left = w < 400 ? 42 : 52, right = 14, top = 10, bottom = 34;
    const pw = w - left - right, ph = h - top - bottom;
    const px = x => left + (x / scaleX + half) * pw / (2 * half);
    const py = y => top + (ymax - y) / (ymax - ymin) * ph;
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = colors.text; ctx.lineWidth = 1;
    if (showBion && !field) {
      ctx.fillStyle = '#b96a3617';
      ctx.fillRect(px(-15 * scaleX), top, px(15 * scaleX) - px(-15 * scaleX), ph);
      ctx.fillStyle = colors.text;
    }
    const ystep = field ? scaleY : niceStep(ymax - ymin, 3);
    for (let y = Math.ceil(ymin / ystep) * ystep; y <= ymax + ystep * 1e-8; y += ystep) {
      ctx.strokeStyle = colors.grid; ctx.beginPath(); ctx.moveTo(left, py(y)); ctx.lineTo(w - right, py(y)); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(number(Math.abs(y) < 1e-10 ? 0 : y, 3), left - 9, py(y));
    }
    const xstep = niceStep(2 * half * scaleX, w < 450 ? 4 : 6);
    for (let x = Math.ceil(-half * scaleX / xstep) * xstep; x <= half * scaleX + xstep * 1e-8; x += xstep) {
      ctx.strokeStyle = colors.grid; ctx.beginPath(); ctx.moveTo(px(x), top); ctx.lineTo(px(x), h - bottom); ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = colors.text;
      ctx.fillText(number(Math.abs(x) < 1e-10 ? 0 : x, 3), px(x), h - bottom + 7);
    }
    if (field) {
      ctx.setLineDash([4, 5]); ctx.strokeStyle = '#acb8a5';
      for (const vacuum of [-scaleY, scaleY]) { ctx.beginPath(); ctx.moveTo(left, py(vacuum)); ctx.lineTo(w - right, py(vacuum)); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = colors.text;
    ctx.fillText(normalized ? 'x / ℓK' : 'x', w - right, h);
    const valuesA = field ? a.field : a.density;
    const valuesB = field ? b.field : b.density;
    const start = Math.max(0, Math.floor((metadata.half - half) / metadata.spacing));
    const stop = Math.min(a.fullSize - 1, Math.ceil((metadata.half + half) / metadata.spacing));
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, pw, ph); ctx.clip();
    ctx.beginPath();
    const vacuum = field ? -1 : 0;
    for (let i = start; i <= stop; i++) {
      const x = (i * metadata.spacing - metadata.half) * scaleX;
      const va = valuesA[i - a.offset] ?? vacuum;
      const vb = valuesB[i - b.offset] ?? vacuum;
      const y = (va + fraction * (vb - va)) * scaleY;
      if (i === start) ctx.moveTo(px(x), py(y)); else ctx.lineTo(px(x), py(y));
    }
    ctx.strokeStyle = field ? colors.field : colors.energy; ctx.lineWidth = field ? 2.3 : 1.8; ctx.stroke();
    if (!field) {
      ctx.lineTo(px((stop * metadata.spacing - metadata.half) * scaleX), py(0));
      ctx.lineTo(px((start * metadata.spacing - metadata.half) * scaleX), py(0));
      ctx.closePath(); ctx.fillStyle = '#b96a361c'; ctx.fill();
    }
    ctx.restore();
  }

  function draw() {
    const frame = currentFrame();
    if (!frame) return;
    const normalized = $('units').value === 'normalized';
    plot($('field-plot'), frame, 'field', normalized);
    plot($('energy-plot'), frame, 'energy', normalized);
    $('field-label').textContent = normalized ? 'u = φ/η' : 'φ';
    $('density-label').textContent = normalized ? 'ℰ ℓK²/η²' : 'ℰ';
    document.querySelector('.plot-hint').textContent = normalized ? 'Пунктир — вакуумы ±1' : 'Пунктир — вакуумы ±η';
    if (showBion) {
      const share = frame.a.centralShare + frame.fraction * (frame.b.centralShare - frame.a.centralShare);
      $('bion-percent').textContent = number(100 * share, 1) + ' %';
      $('bion-bar').style.width = Math.min(100, 100 * share) + '%';
    }
    const tScale = normalized ? 1 : metadata.ell;
    $('time-label').textContent = (normalized ? 'τ = ' : 't = ') + number(time * tScale, 2);
    $('duration-label').textContent = 'до ' + (normalized ? 'τ' : 't') + ' = ' + number(metadata.end * tScale, 2);
    $('timeline').setAttribute('aria-valuetext', $('time-label').textContent);
    $('timeline').value = time;
    const energy = frame.a.energy + frame.fraction * (frame.b.energy - frame.a.energy);
    const energyScale = normalized ? 1 : active.eta ** 2 / metadata.ell;
    $('total-energy').textContent = number(energy * energyScale, 5) + (normalized ? ' · η²/ℓK' : '');
    const relative = Math.abs(energy / metadata.initialEnergy - 1) * 100;
    $('energy-error').textContent = relative === 0 ? '0%' : relative < 0.000001 ? '< 0,000001%' : number(relative, 6) + '%';
  }

  function togglePlay() {
    if (busy) return;
    if (time >= metadata.end) time = 0;
    setPlaying(!playing); draw();
    $('status').textContent = '';
  }
  $('play').addEventListener('click', togglePlay);
  $('restart').addEventListener('click', () => { setPlaying(false); time = 0; draw(); $('status').textContent = ''; });
  $('step').addEventListener('click', () => { setPlaying(false); time = Math.min(metadata.end, time + metadata.frameInterval); draw(); });
  $('timeline').addEventListener('input', event => { setPlaying(false); time = Number(event.target.value); draw(); });
  $('units').addEventListener('change', draw);
  document.addEventListener('keydown', event => {
    if (event.code === 'Space' && event.target === document.body && !busy) { event.preventDefault(); togglePlay(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPlaying(false); });
  new ResizeObserver(draw).observe($('field-plot'));
  function animate(now) {
    const elapsed = lastAnimation ? Math.min((now - lastAnimation) / 1000, 0.1) : 0;
    lastAnimation = now;
    if (playing && metadata) {
      time = Math.min(metadata.end, time + elapsed * 6 * Number($('speed').value));
      if (now - lastDraw > 25 || time >= metadata.end) { draw(); lastDraw = now; }
      if (time >= metadata.end) { setPlaying(false); $('status').textContent = 'Расчёт завершён.'; }
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
  setParameters(KinkPhysics.DEFAULTS); syncSymmetry();
  calculate(KinkPhysics.DEFAULTS, 'escape');
})();
