'use strict';
importScripts('solver.js');

self.onmessage = function ({ data }) {
  try {
    const sim = new KinkPhysics.Simulation(data.parameters, { end: data.end });
    const stride = 2;
    const frameSteps = 20;
    const totalSteps = Math.round(sim.end / sim.dt);
    self.postMessage({ type: 'start', half: sim.half, spacing: sim.dx * stride, ell: sim.ell, initialEnergy: sim.initialEnergy, end: sim.end, frameInterval: frameSteps * sim.dt });
    let batch = [];
    for (let step = 0; step <= totalSteps; step += frameSteps) {
      if (step) sim.advance(frameSteps);
      batch.push(sim.snapshot(stride));
      if (batch.length === 20 || step === totalSteps) {
        const buffers = batch.flatMap(f => [f.field.buffer, f.density.buffer]);
        self.postMessage({ type: 'frames', frames: batch, progress: step / totalSteps }, buffers);
        batch = [];
      }
    }
    self.postMessage({ type: 'complete' });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
