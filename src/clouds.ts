/**
 * "Tracing paper" overlay over the unexplored map, rendered with WebGL on a canvas above it.
 * Holes (places you've been) are painted into a low-res mask canvas each frame and sampled by the
 * shader, with ragged noise edges so the paper looks torn away there.
 */

export interface Hole {
  x: number; // CSS px
  y: number; // CSS px
  r: number; // CSS px
  a: number; // 0..1 reveal amount
}

export interface CloudView {
  /** Screen position (CSS px) of a fixed geographic anchor, so clouds move with the map. */
  anchorX: number;
  anchorY: number;
  /** Size of one paper-texture noise unit in CSS px. */
  scale: number;
}

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform vec2 uAnchor;
uniform float uScale;
uniform float uOpacity;
uniform sampler2D uMask;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = rot * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y); // y-down, like CSS
  vec2 w = frag - uAnchor; // pinned to the map, so the paper moves with it

  // Tracing paper: warm, slightly translucent, with long fibres and soft cloudy formation.
  float fibres = fbm(w / uScale * vec2(9.0, 2.2));
  float formation = fbm(w / uScale * 2.0);
  vec3 paper = vec3(0.985, 0.972, 0.945) - (fibres - 0.5) * 0.035 - (formation - 0.5) * 0.04;
  float alpha = 0.8 + (formation - 0.5) * 0.08;

  // Torn holes where you've been: a ragged edge (coarse + fine noise in screen px, so it stays
  // crisp at any zoom), a bright fibrous rim, and a faint shadow the paper casts on the map.
  float m = texture(uMask, vUv).r;
  float rag = (fbm(w / 34.0) - 0.5) * 0.55 + (noise(w / 6.0) - 0.5) * 0.18;
  float e = m * 1.3 + rag;
  float hole = smoothstep(0.49, 0.53, e);
  float rim = smoothstep(0.36, 0.49, e) * (1.0 - hole);
  float shade = smoothstep(0.53, 0.57, e) * (1.0 - smoothstep(0.57, 0.7, e));

  vec3 col = mix(paper, vec3(1.0), rim * 0.85);
  alpha = mix(alpha, 0.97, rim) * (1.0 - hole);
  vec4 sheet = vec4(col * alpha, alpha);
  float sa = shade * 0.16;
  vec4 shadow = vec4(vec3(0.24, 0.17, 0.1) * sa, sa);
  outColor = (sheet + shadow * (1.0 - sheet.a)) * uOpacity;
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed');
  }
  return sh;
}

export class Clouds {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null;
  private mask = document.createElement('canvas');
  private maskCtx = this.mask.getContext('2d')!;
  private program: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private opacity = 1;
  private targetOpacity = 1;
  private raf = 0;
  private readonly maskScale = 0.25;

  constructor(
    parent: HTMLElement,
    private getView: () => CloudView,
    private getHoles: () => Hole[],
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'clouds';
    parent.appendChild(this.canvas);
    this.gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false });
    if (!this.gl) {
      // No WebGL2: fall back to a static CSS fog so the app still works.
      this.canvas.classList.add('clouds--fallback');
      return;
    }
    this.init(this.gl);
    new ResizeObserver(() => this.resize()).observe(parent);
    this.resize();
    this.loop();
  }

  /** Thin the clouds (e.g. while choosing a location) or bring them back. */
  setOpacity(v: number) {
    this.targetOpacity = v;
    this.canvas.style.opacity = this.gl ? '' : String(v);
  }

  private init(gl: WebGL2RenderingContext) {
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? 'program link failed');
    }
    this.program = prog;
    for (const u of ['uRes', 'uAnchor', 'uScale', 'uOpacity', 'uMask']) {
      this.uniforms[u] = gl.getUniformLocation(prog, u);
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    // Clouds are soft; rendering at CSS resolution keeps the GPU cost low on retina screens.
    this.canvas.width = Math.max(1, Math.round(r.width));
    this.canvas.height = Math.max(1, Math.round(r.height));
    this.mask.width = Math.max(1, Math.round(r.width * this.maskScale));
    this.mask.height = Math.max(1, Math.round(r.height * this.maskScale));
  }

  private drawMask() {
    const ctx = this.maskCtx;
    const s = this.maskScale;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.mask.width, this.mask.height);
    ctx.globalCompositeOperation = 'lighter';
    for (const h of this.getHoles()) {
      if (h.a <= 0) continue;
      const r = h.r * s * (0.35 + 0.65 * h.a);
      const x = h.x * s;
      const y = h.y * s;
      if (x + r < 0 || y + r < 0 || x - r > this.mask.width || y - r > this.mask.height) continue;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const k = Math.min(1, h.a);
      g.addColorStop(0, `rgba(255,255,255,${k})`);
      g.addColorStop(0.55, `rgba(255,255,255,${0.85 * k})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const gl = this.gl;
    if (!gl || !this.program) return;
    if (document.hidden) return;

    this.opacity += (this.targetOpacity - this.opacity) * 0.08;
    this.drawMask();

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.mask);

    const v = this.getView();
    const sx = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const u = this.uniforms;
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uAnchor, v.anchorX * sx, v.anchorY * sx);
    gl.uniform1f(u.uScale, v.scale * sx);
    gl.uniform1f(u.uOpacity, this.opacity);
    gl.uniform1i(u.uMask, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  destroy() {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }
}
