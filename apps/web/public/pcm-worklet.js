// Downsamples microphone audio to 16 kHz mono PCM16 and posts ~100 ms frames (1600 samples) to the main thread.
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0; this.sum = 0; this.count = 0;
    this.out = new Int16Array(1600); this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.count++; this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.count));
        this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.sum = 0; this.count = 0;
        if (this.n === this.out.length) {
          const buf = this.out.buffer;
          this.port.postMessage(buf, [buf]);
          this.out = new Int16Array(1600); this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
