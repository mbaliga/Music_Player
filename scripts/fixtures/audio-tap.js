
;(() => {
  try { localStorage.setItem('runout.wtDone', '1'); } catch (e) {}
  const origConnect = AudioNode.prototype.connect;
  window.__tap = null; window.__raw = []; window.__blk = []; window.__ctxs = [];
  const WSRC = `class T extends AudioWorkletProcessor{constructor(){super();this.buf=[];this.raw=0;this.port.onmessage=(e)=>{this.raw=e.data}}process(i,o){const x=i[0];let pk=0,ss=0,l=0,dc=0,zc=0,mx=0;if(x&&x.length){const a=x[0];l=a.length;for(let k=0;k<l;k++){dc+=a[k];const v=Math.abs(a[k]);if(v>mx)mx=v;ss+=a[k]*a[k];if(k>0){const d=Math.abs(a[k]-a[k-1]);if(d>pk)pk=d;if((a[k]>=0)!==(a[k-1]>=0))zc++}}}
   this.buf.push([currentFrame,pk,Math.sqrt(ss/(l||1)),dc/(l||1),zc,mx]);if(this.raw&&x&&x.length){this.port.postMessage({raw:Array.from(x[0]),f:currentFrame})}if(this.buf.length>=64){this.port.postMessage(this.buf);this.buf=[]}return true}}registerProcessor('tapproc',T)`;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = origConnect.call(this, dest, ...rest);
    try {
      if (dest && dest === this.context.destination && !this.__mine) {
        if (!window.__tap || window.__tap.context !== this.context) {
          const ctx = this.context; window.__ctxs.push(ctx);
          const a = ctx.createAnalyser(); a.fftSize = 16384; a.smoothingTimeConstant = 0; window.__tap = a;
          const url = URL.createObjectURL(new Blob([WSRC], { type: 'text/javascript' }));
          ctx.audioWorklet.addModule(url).then(() => {
            const n = new AudioWorkletNode(ctx, 'tapproc', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
            n.__mine = true; window.__tapnode = n; window.__tapOn = true;
            n.port.onmessage = (e) => { if (e.data && e.data.raw) { window.__raw.push(e.data); return; } if (window.__rec) for (const b of e.data) window.__blk.push(b); window.__lastFrame = e.data[e.data.length-1][0]; };
            window.__tapIn = n;
            origConnect.call(n, ctx.destination);
            // feed every existing source into it: connect via the analyser chain
            window.__tapReady = true;
            if (window.__tapSrc) origConnect.call(window.__tapSrc, n);
          });
        }
        origConnect.call(this, window.__tap);
        // route the same node to the block recorder
        window.__tapSrc = this;
        if (window.__tapIn) origConnect.call(this, window.__tapIn);
      }
    } catch (e) { console.error('tap', e); }
    return r;
  };
  const spec = () => { const a = window.__tap; if (!a) return null; const buf = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(buf); return buf; };
  window.__dom = () => {
    const buf = spec(); if (!buf) return -1; const a = window.__tap;
    let bi = 2; for (let i = 2; i < buf.length; i++) if (buf[i] > buf[bi]) bi = i;
    if (!(buf[bi] > -70)) return 0;
    return bi * a.context.sampleRate / a.fftSize;
  };
  // all spectral peaks within 30 dB of the max (tones from simultaneous decks)
  window.__peaks = () => {
    const buf = spec(); if (!buf) return []; const a = window.__tap; let mx = -200; for (let i = 2; i < buf.length; i++) if (buf[i] > mx) mx = buf[i];
    if (mx < -70) return []; const out = [];
    for (let i = 3; i < buf.length - 3; i++) { if (buf[i] > mx - 30 && buf[i] >= buf[i-1] && buf[i] >= buf[i+1] && buf[i] >= buf[i-2] && buf[i] >= buf[i+2]) out.push([Math.round(i * a.context.sampleRate / a.fftSize), Math.round(buf[i])]); }
    return out.slice(0, 8);
  };
  window.__rms = () => { // time-domain rms from a fresh small analyser each call is wasteful; use the spectrum sum instead
    const a = window.__tap; if (!a) return -1; const b = new Float32Array(a.fftSize); a.getFloatTimeDomainData(b); let s = 0; for (const x of b) s += x*x; return Math.sqrt(s / b.length);
  };
  window.__recStart = () => { window.__blk = []; window.__rec = true; };
  window.__recStop = () => { window.__rec = false; return window.__blk; };
})();

