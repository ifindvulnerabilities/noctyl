// Noctyl dictation engine: local Whisper speech-to-text, run in an Electron utility process so the
// window never stalls while it transcribes. Audio arrives as 16 kHz mono Float32 PCM and never leaves
// this computer. The only network use is the one-time model download from Hugging Face.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pipeline, env } from '@huggingface/transformers';

const MODEL = 'onnx-community/whisper-base.en';
const DTYPE = 'q8';   // 8-bit quantised: ~80 MB, ~4× faster than real time on a laptop CPU
const FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];

const userData = process.argv[2];
const cacheDir = path.join(userData, 'models');
env.cacheDir = cacheDir;
env.allowLocalModels = false;

const port = process.parentPort;
let asr = null, loading = null;

const isCached = () => FILES.every(f => existsSync(path.join(cacheDir, ...MODEL.split('/'), ...f.split('/'))));

function load() {
  if (asr) return Promise.resolve(asr);
  return (loading ||= pipeline('automatic-speech-recognition', MODEL, {
    dtype: DTYPE,
    progress_callback: p => {
      if (p.status === 'progress' || p.status === 'done' || p.status === 'initiate')
        port.postMessage({ type: 'progress', status: p.status, file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
    },
  }).then(model => { asr = model; return model; }, err => { loading = null; throw err; }));
}

// Whisper sometimes "hears" tags or filler in near-silence; drop those
const clean = text => String(text || '')
  .replace(/\s*[\[(](?:blank[_ ]audio|silence|music|noise|inaudible|no speech)[^\])]*[\])]\s*/gi, ' ')
  .replace(/\s+/g, ' ').trim();

port.on('message', async ({ data }) => {
  const { id, type } = data || {};
  const reply = result => port.postMessage({ id, result });
  try {
    if (type === 'status') reply({ cached: isCached(), loaded: !!asr, loading: !!loading && !asr, model: MODEL, sizeMB: 80 });
    else if (type === 'load') { await load(); reply(true); }
    else if (type === 'transcribe') {
      const audio = data.audio;
      if (!(audio instanceof Float32Array) || !audio.length) return reply('');
      const model = await load();
      const out = await model(audio, { chunk_length_s: 30 });
      reply(clean(out?.text));
    } else port.postMessage({ id, error: 'Unknown request' });
  } catch (err) {
    port.postMessage({ id, error: err?.message || String(err) });
  }
});
