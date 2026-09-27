class MicCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = new Float32Array(2048); this.offset = 0; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.samples[this.offset++] = channel[i];
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
