// stage-svg.js — the stage's static SVG art (ported from the prototype; ids are prefixed `tt-`). Markup only: no behaviour here.
//
//   bot : phone body, phone frame stroke, the platter (black circle) + the owner's "Runout" lettered mat (assets/mat.jpg)
//   top : tonearm slot + recessed track line, the controls, the dot-display tap target, the brushed-metal tonearm (BALIGA engraved
//         at the head end, concave dimple = the drag handle). No pin / cylinder; the stylus is invisible.
// The canvas (the disc, waveform spiral, label, dot display) sits between the two (stage.js).

export const MAT_URL = './assets/mat.jpg';

/** inner markup of the bottom SVG (viewBox set by the camera) */
export function botSvgInner() {
  return `  <defs><clipPath id="tt-vb"><rect x="222.5" y="-15" width="1241" height="561"/></clipPath><clipPath id="tt-matClip"><circle cx="278" cy="457" r="651"/></clipPath></defs>
  <g id="tt-botRot">
    <rect x="222.5" y="-15" width="1241" height="561" rx="60" fill="#000"/>
    <rect id="tt-phoneFrame" x="222.5" y="-15" width="1241" height="561" rx="60" fill="none" stroke="#3a3a42" stroke-width="3.5" opacity="0"/>
    <g id="tt-matG">
      <circle cx="278" cy="457" r="650" fill="#000"/>
      <image href="${MAT_URL}" x="-368" y="-189.86" width="1292" height="1293.72" clip-path="url(#tt-matClip)"/>
    </g>
  </g>`;
}

/** inner markup of the top SVG */
export function topSvgInner() {
  return `<defs>
  <clipPath id="tt-vb2"><rect x="222.5" y="-15" width="1241" height="561"/></clipPath>
  <linearGradient id="tt-armMetal" x1="0" y1="1" x2="0" y2="0">
    <stop offset="0" stop-color="#d9d9db"/><stop offset=".12" stop-color="#c9c9cb"/>
    <stop offset=".5" stop-color="#bbbbbd"/><stop offset=".88" stop-color="#adadb0"/><stop offset="1" stop-color="#8f8f92"/>
  </linearGradient>
  <linearGradient id="tt-armLong" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#000" stop-opacity=".08"/><stop offset=".3" stop-color="#000" stop-opacity="0"/>
    <stop offset=".7" stop-color="#fff" stop-opacity=".14"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <filter id="tt-brush" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.0035 0.95" numOctaves="2" seed="7" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 .55 -.12" result="g"/>
    <feComposite in="g" in2="SourceGraphic" operator="in"/>
  </filter>
  <filter id="tt-speck" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="3" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .9 -.42" result="g"/>
    <feComposite in="g" in2="SourceGraphic" operator="in"/>
  </filter>
  <filter id="tt-armShadow" x="-10%" y="-30%" width="120%" height="170%"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="tt-soft5" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4"/></filter>
  <radialGradient id="tt-dimple" cx=".66" cy=".7" r=".85">
    <stop offset="0" stop-color="#cfcfd2"/><stop offset=".55" stop-color="#b3b3b6"/><stop offset=".88" stop-color="#8d8d91"/><stop offset="1" stop-color="#76767a"/>
  </radialGradient>
  <linearGradient id="tt-lipG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset=".3" stop-color="#000" stop-opacity=".12"/><stop offset=".8" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".25"/></linearGradient>
  <linearGradient id="tt-recessG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1c1f"/><stop offset=".35" stop-color="#34343a"/><stop offset=".75" stop-color="#55555b"/><stop offset="1" stop-color="#6e6e74"/></linearGradient>
  <linearGradient id="tt-housOuter" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#d9d9da"/><stop offset=".5" stop-color="#bdbdbf"/><stop offset="1" stop-color="#8f8f92"/>
  </linearGradient>
  <linearGradient id="tt-housInner" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#7a7a7d"/><stop offset=".25" stop-color="#a8a8aa"/><stop offset=".55" stop-color="#c9c9ca"/><stop offset="1" stop-color="#b8b8ba"/>
  </linearGradient>
  <linearGradient id="tt-partWhite" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#f4f4f4"/><stop offset="1" stop-color="#cfcfd1"/>
  </linearGradient>
</defs>

<g id="tt-topRot"><g clip-path="url(#tt-vb2)">
<!-- the platter: scratch (the groove annulus) and palm brake (the label) -->
<circle id="tt-platterHit" cx="278" cy="457" r="644" fill="transparent"/>


<!-- tonearm-shaped slot: the arm nests flush inside it -->
<g id="tt-housing">
  <rect x="843" y="44" width="594" height="72" rx="36" fill="url(#tt-housOuter)"/>
  <rect x="843.6" y="44.6" width="592.8" height="70.8" rx="35.4" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1"/>
  <rect x="847" y="48" width="586" height="64" rx="32" fill="url(#tt-recessG)"/>
  <rect x="847.5" y="48.5" width="585" height="63" rx="31.5" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="1"/>
  <!-- carriage track: the arm's pivot rides this line -->
  <path id="tt-trackHi" d="M920 81.6H1340" stroke="#fff" stroke-opacity=".17" stroke-width="1.2" stroke-linecap="round"/>
  <path id="tt-trackLo" d="M920 80H1340" stroke="#040405" stroke-width="2.6" stroke-linecap="round"/>
  <text id="tt-parkLbl" x="1140" y="104" text-anchor="middle" fill="#fff" opacity=".3" style="font:600 14px system-ui,sans-serif;letter-spacing:3px" aria-hidden="true">TONEARM REST</text>
</g>

<!-- controls: a visible button (bg), a larger transparent hit area (hit) and the label; stage.js sizes the rects per orientation (>= 44 px hit areas) -->
<g id="tt-controls">
  <g id="tt-playBtn" class="hit pbtn" role="button" tabindex="0" aria-label="Play">
    <rect class="hit-area" x="1266" y="262" width="124" height="72" fill="transparent"/>
    <rect class="bg" x="1272" y="264" width="116" height="68" rx="22"/>
    <g id="tt-playFace" transform="translate(1330 298)">
      <path id="tt-playIcon" d="M-7 -9 L10 0 L-7 9 Z" transform="translate(0 -13)"/>
      <text id="tt-playLbl" class="lbl" x="0" y="23" text-anchor="middle">Play</text>
    </g>
  </g>
  <g class="ctl" id="tt-b78" role="button" tabindex="0" aria-label="78 rpm" aria-pressed="false"><rect class="hit-area" x="1180" y="262" width="70" height="52" fill="transparent"/><rect class="bg" x="1180" y="262" width="70" height="52" rx="16"/><text x="1215" y="308" text-anchor="middle">78</text></g>
  <g class="ctl on" id="tt-b33" role="button" tabindex="0" aria-label="33 rpm" aria-pressed="true"><rect class="hit-area" x="1180" y="352" width="70" height="52" fill="transparent"/><rect class="bg" x="1180" y="352" width="70" height="52" rx="16"/><text x="1215" y="388" text-anchor="middle">33</text></g>
  <g class="ctl" id="tt-b45" role="button" tabindex="0" aria-label="45 rpm" aria-pressed="false"><rect class="hit-area" x="1287" y="352" width="70" height="52" fill="transparent"/><rect class="bg" x="1287" y="352" width="70" height="52" rx="16"/><text x="1322" y="388" text-anchor="middle">45</text></g>
  <g class="ctl" id="tt-bm" role="button" tabindex="0" aria-label="Slower"><rect class="hit-area" x="1180" y="428" width="70" height="52" fill="transparent"/><rect class="bg" x="1180" y="428" width="70" height="52" rx="16"/><text x="1215" y="465" text-anchor="middle">−</text></g>
  <g class="ctl" id="tt-prev" role="button" tabindex="0" aria-label="Previous track"><rect class="hit-area" x="1180" y="192" width="70" height="52" fill="transparent"/><rect class="bg" x="1180" y="192" width="70" height="52" rx="16"/><path class="ico" d="M-16 -14H-11V14H-16ZM14 -14V14L-10 0Z"/></g>
  <g class="ctl" id="tt-next" role="button" tabindex="0" aria-label="Next track"><rect class="hit-area" x="1287" y="192" width="70" height="52" fill="transparent"/><rect class="bg" x="1287" y="192" width="70" height="52" rx="16"/><path class="ico" d="M16 -14H11V14H16ZM-14 -14V14L10 0Z"/></g>
  <g class="ctl" id="tt-bp" role="button" tabindex="0" aria-label="Faster"><rect class="hit-area" x="1287" y="428" width="70" height="52" fill="transparent"/><rect class="bg" x="1287" y="428" width="70" height="52" rx="16"/><text x="1322" y="465" text-anchor="middle">+</text></g>
</g>

<!-- dot-matrix display tap target (mode toggle) -->
<circle id="tt-dispHit" class="hit" role="button" tabindex="0" aria-label="Display: track name or equaliser" cx="1050" cy="355" r="108" fill="transparent"/>


<!-- tonearm: carriage rides the rail; local x runs from the carriage toward the head -->
<g id="tt-armClipG"><g id="tt-arm" transform="translate(1393 80) rotate(180)"><g id="tt-bar">
  <!-- bar -->
  <rect x="-36" y="-34" width="578" height="56" rx="28" fill="#000" opacity=".7" filter="url(#tt-armShadow)"/>
  <rect x="-36" y="-28" width="578" height="56" rx="28" fill="url(#tt-armMetal)"/>
  <rect x="-36" y="-28" width="578" height="56" rx="28" fill="url(#tt-armLong)"/>
  <rect x="-36" y="-28" width="578" height="56" rx="28" fill="#fff" filter="url(#tt-brush)" opacity=".7"/>
  <rect x="-36" y="-28" width="578" height="56" rx="28" fill="#fff" filter="url(#tt-speck)" opacity=".5"/>
  <rect x="-35" y="-27" width="576" height="54" rx="27" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.4"/>
  <path d="M-8 -27.5H514" stroke="#6f6f72" stroke-width="2" opacity=".6"/>
  <!-- engraving -->
  <g transform="translate(436 0) rotate(180)" font-family="'Helvetica Neue',Helvetica,Arial,sans-serif" font-size="25" font-weight="600" letter-spacing="3.5" text-anchor="middle">
    <text x="0.8" y="10.5" fill="#fff" opacity=".5">BALIGA</text>
    <text x="0" y="9.5" fill="#a2a2a5" opacity=".7">BALIGA</text>
  </g>
</g></g></g>

<!-- finger dimple (concave depression) — also the drag handle -->
<g id="tt-grab" role="slider" tabindex="0" aria-label="Tonearm: drag to seek" transform="translate(1063 80)">
  <circle r="22" fill="url(#tt-dimple)"/>
  <circle r="21.5" fill="none" stroke="#5d5d60" stroke-opacity=".55" stroke-width="1.6"/>
  <path d="M-17 8 A21.5 21.5 0 0 0 16 10" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round" transform="rotate(8)"/>
  <ellipse cx="-6" cy="-8" rx="10" ry="6" fill="#000" opacity=".12" filter="url(#tt-soft5)"/>
  <circle id="tt-grabHit" r="58" fill="transparent"/>
</g>

</g></g>`;
}

/** the label artwork, rasterised to an Image for the disc label (viewBox 61 50 434 434) */
export const LABEL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="61 50 434 434" width="868" height="868">
<defs>
  <radialGradient id="lblBase" cx="150" cy="110" r="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#76aef2"/><stop offset=".5" stop-color="#4a8fe3"/><stop offset="1" stop-color="#3d7fd8"/></radialGradient>
  <radialGradient id="pinkWash" cx="430" cy="430" r="230" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f08fc4" stop-opacity=".9"/><stop offset=".55" stop-color="#ee9ccd" stop-opacity=".55"/><stop offset="1" stop-color="#ee9ccd" stop-opacity="0"/></radialGradient>
  <radialGradient id="whiteFoot" cx="190" cy="440" r="190" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fbf1fb"/><stop offset=".7" stop-color="#f6dff3" stop-opacity=".85"/><stop offset="1" stop-color="#f6dff3" stop-opacity="0"/></radialGradient>
  <radialGradient id="eyeBlue" cx="250" cy="300" r="150" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2f6fcb"/><stop offset=".7" stop-color="#3b82d9"/><stop offset="1" stop-color="#5b9ae6"/></radialGradient>
  <radialGradient id="hubGrad" cx="278" cy="266" r="96" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff"/><stop offset=".62" stop-color="#ffffff"/><stop offset=".86" stop-color="#fbe3f2"/><stop offset="1" stop-color="#f3aed6"/></radialGradient>
  <radialGradient id="hubRim" cx="262" cy="248" r="118" gradientUnits="userSpaceOnUse"><stop offset=".6" stop-color="#ef8fc6" stop-opacity="0"/><stop offset=".85" stop-color="#ef8fc6" stop-opacity=".55"/><stop offset="1" stop-color="#ee86c0" stop-opacity=".9"/></radialGradient>
  <filter id="soft40" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="22"/></filter>
  <filter id="soft14" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
  <filter id="soft5" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4"/></filter>
  <clipPath id="lblClip"><circle cx="278" cy="267" r="217"/></clipPath>
</defs>
<g clip-path="url(#lblClip)">
  <rect x="40" y="30" width="480" height="480" fill="url(#lblBase)"/>
  <circle cx="430" cy="430" r="250" fill="url(#pinkWash)"/>
  <g filter="url(#soft14)"><ellipse cx="258" cy="282" rx="188" ry="112" transform="rotate(-36 258 282)" fill="none" stroke="#ffffff" stroke-width="46" opacity=".95"/></g>
  <ellipse cx="190" cy="430" rx="190" ry="95" fill="url(#whiteFoot)" filter="url(#soft14)"/>
  <ellipse cx="225" cy="105" rx="130" ry="50" transform="rotate(-18 225 105)" fill="#ffffff" opacity=".45" filter="url(#soft40)"/>
  <ellipse cx="248" cy="290" rx="142" ry="78" transform="rotate(-36 248 290)" fill="url(#eyeBlue)" filter="url(#soft5)"/>
  <ellipse cx="248" cy="290" rx="150" ry="86" transform="rotate(-36 248 290)" fill="none" stroke="#fff" stroke-width="7" opacity=".85" filter="url(#soft5)"/>
  <ellipse cx="420" cy="430" rx="110" ry="60" transform="rotate(-36 420 430)" fill="#ee94c8" opacity=".55" filter="url(#soft14)"/>
  <circle cx="278" cy="266" r="92" fill="url(#hubGrad)"/>
  <circle cx="278" cy="266" r="92" fill="url(#hubRim)"/>
  <circle cx="278" cy="266" r="92" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="2"/>
</g>
</svg>`;
