// AudioWorklet: hands the page raw microphone samples in 100 ms blocks (at the AudioContext's rate,
// 16 kHz for dictation). Runs on the audio thread, so capture never stutters.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
