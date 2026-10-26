// ============================================================================
// faceoff3d.ts — the face-off's figurines: each side's own board piece
// standing on the inner rim of its seal, turned to face the other across
// the VS, lit in its class colour. One small WebGL canvas over the face-off,
// one scissored viewport per side, rendered only while the face-off is up.
// ============================================================================

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { patchFigureMaterial } from "./figure-material.ts";

type Side = "L" | "R";
export interface FaceoffFigures {
  /** Show a class's figurine on a side (null clears it); `spin` turns it in. */
  set(side: Side, cls: string | null, color: string, spin: boolean): void;
  start(): void;
  stop(): void;
}

/** Figure height as a share of the medallion (--m); its base sits on the
 *  seal's inner rim. */
const FIG_OF_MEDAL = 0.66;

export function createFaceoffFigures(
  root: HTMLElement,
  geoFor: (cls: string, team: "red" | "blue") => THREE.BufferGeometry | null,
): FaceoffFigures {
  const canvas = document.createElement("canvas");
  canvas.className = "fo-figs";
  canvas.setAttribute("aria-hidden", "true");
  root.querySelector(".fo-in")!.appendChild(canvas);

  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 20);
  scene.add(new THREE.HemisphereLight(0xcdbcff, 0x1a0f14, 0.55));
  const key = new THREE.DirectionalLight(0xffe2b8, 2.1);
  key.position.set(0.8, 2.2, 2.4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 3.2);
  rim.position.set(-1.6, 1.4, -2.2);
  scene.add(rim);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.06 });
  patchFigureMaterial(material);

  // A soft glow under the base, in the side's colour.
  const glowTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,0.9)");
    r.addColorStop(0.45, "rgba(255,255,255,0.35)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();

  interface Fig {
    group: THREE.Group;
    mesh: THREE.Mesh | null;
    glow: THREE.Mesh;
    cls: string | null;
    color: THREE.Color;
    spinFrom: number;
    height: number;
  }
  const figs: Record<Side, Fig> = { L: makeFig(), R: makeFig() };
  function makeFig(): Fig {
    const group = new THREE.Group();
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.62, 0.62),
      new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.079;
    group.add(glow);
    group.visible = false;
    scene.add(group);
    return { group, mesh: null, glow, cls: null, color: new THREE.Color(), spinFrom: -1, height: 0.5 };
  }

  /** Build (or rebuild once the figurine file has loaded) a side's mesh. */
  function fill(side: Side): boolean {
    const f = figs[side];
    if (!f.cls) return false;
    if (f.mesh) return true;
    const geo = geoFor(f.cls, side === "L" ? "red" : "blue");
    if (!geo) return false;
    geo.computeBoundingBox();
    f.height = geo.boundingBox!.max.y - geo.boundingBox!.min.y;
    f.mesh = new THREE.Mesh(geo, material);
    f.group.add(f.mesh);
    return true;
  }

  let raf = 0;
  const start0 = performance.now();
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!renderer) {
      try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
      } catch {
        stop(); // no WebGL to spare: the medallions carry the screen alone
        return;
      }
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.setScissorTest(true);
      // something for the plate and gilt to reflect
      scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.16;
    }
    const box = root.getBoundingClientRect();
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    const W = Math.round(box.width), H = Math.round(box.height);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(W, H, false);
    }
    renderer.setScissor(0, 0, W, H);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    const t = (now - start0) / 1000;
    // the medallion as laid out (--m itself is an unresolved clamp())
    const medal = root.querySelector<HTMLElement>(".fo-medal")?.offsetWidth || 220;
    for (const side of ["L", "R"] as Side[]) {
      const f = figs[side];
      if (!fill(side)) continue;
      const disc = root.querySelector<HTMLElement>(`.fo-side[data-side="${side}"] .fo-disc`);
      if (!disc || disc.offsetParent === null) continue;
      const d = disc.getBoundingClientRect();
      // the viewport: a box whose bottom-centre is the seal's inner rim
      const vh = medal * FIG_OF_MEDAL * 1.5, vw = vh * 0.9;
      const bx = (side === "L" ? d.right - d.width * 0.06 : d.left + d.width * 0.06) - box.left;
      const by = d.top + d.height * 0.5 - box.top;
      const x = bx - vw / 2, y = H - (by + vh * 0.12);
      renderer.setViewport(x, y, vw, vh);
      renderer.setScissor(x, y, vw, vh);
      // camera framed so the figure fills 1/1.5 of the viewport (FIG_OF_MEDAL
      // of the medallion), seen from a little above like the table's camera;
      // aimed a touch above its middle so the base lands near the bottom
      camera.aspect = vw / vh;
      const dist = (1.5 * f.height) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      const mid = -0.08 + f.height * 0.5;
      camera.position.set(0, mid + dist * 0.36, dist);
      camera.lookAt(0, mid + f.height * 0.08, 0);
      camera.updateProjectionMatrix();
      // facing: turned toward the other side, swaying; a fresh pick spins in
      const toward = side === "L" ? 0.55 : -0.55;
      let yaw = toward + Math.sin(t * 0.7 + (side === "L" ? 0 : 1.7)) * 0.32;
      if (f.spinFrom >= 0) {
        const k = Math.min(1, (now - f.spinFrom) / 650);
        yaw += (1 - (1 - k) ** 3) * Math.PI * 2 - Math.PI * 2;
        if (k >= 1) f.spinFrom = -1;
      }
      f.group.rotation.y = yaw;
      f.group.position.y = Math.sin(t * 1.6 + (side === "L" ? 0 : 2)) * 0.006;
      rim.color.copy(f.color);
      (f.glow.material as THREE.MeshBasicMaterial).color.copy(f.color);
      figs.L.group.visible = side === "L";
      figs.R.group.visible = side === "R";
      renderer.render(scene, camera);
    }
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  return {
    set(side, cls, color, spin) {
      const f = figs[side];
      if (f.cls !== cls) {
        if (f.mesh) f.group.remove(f.mesh);
        f.mesh = null;
        f.cls = cls;
      }
      f.color.set(color);
      if (spin && cls) f.spinFrom = performance.now();
    },
    start() {
      if (!raf) raf = requestAnimationFrame(frame);
      canvas.style.display = "";
    },
    stop() {
      stop();
      canvas.style.display = "none";
    },
  };
}
