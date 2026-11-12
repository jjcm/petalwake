// Catbus model builder & GLB asset adapter.
//
// 1. buildPlaceholderCatbus(): constructs a rigged SkinnedMesh ginger-tabby living stagecoach
//    matching the design reference (ginger tabby coat, cream muzzle, small closed-mouth smile,
//    12 legs, lit cabin windows with wooden cross frames, hanging brass lantern, roof rail with
//    bells) plus real THREE.AnimationClips named walk / sprint / fly / takeoff / land.
// 2. prepareCatbusGLB(gltf, info): adapts a loaded rigged GLB to the exact same contract —
//    animation name resolution, horizontal root-motion cleanup, grounding & scale normalization,
//    material tuning, secondary-motion pivots (lantern, bells, rail), and wind-blown FurCoat.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shared } from '../core/ctx.js';
import { NOISE, CLOUD_SHADOW } from '../shaders/common.js';
import { SKY_UNIFORMS } from '../world/sky.js';
import { FurCoat, TABBY_COAT_GLSL } from './fur.js';

export const CLIP_NAMES = ['walk', 'sprint', 'fly', 'takeoff', 'land'];

// ---------------------------------------------------------------------------------------------
// Lofted tube helper for building smooth, welded, skinned organic cat parts
// ---------------------------------------------------------------------------------------------
function buildLoftedPart(stations, radialSegs, boneFn, furFn) {
  const rings = stations.length;
  const cols = radialSegs + 1;
  const vCount = rings * cols;
  const pos = new Float32Array(vCount * 3);
  const skinIdx = new Uint16Array(vCount * 4);
  const skinWgt = new Float32Array(vCount * 4);
  const fur = new Float32Array(vCount);
  const uvs = new Float32Array(vCount * 2);

  let vi = 0;
  for (let r = 0; r < rings; r++) {
    const st = stations[r];
    const u = r / Math.max(rings - 1, 1);
    const [bi, bw] = boneFn(u, st);
    for (let c = 0; c <= radialSegs; c++) {
      const v = c / radialSegs;
      const a = v * Math.PI * 2;
      const sn = Math.sin(a), cs = Math.cos(a);
      // Optional stagecoach squircle shaping (flat-ish roof/belly & plush sides)
      const sq = st.squircle ?? 0;
      const rx = st.rx * (sn >= 0 ? 1 : 1) * (sq > 0 ? Math.sign(sn) * Math.pow(Math.abs(sn), 1 - sq * 0.42) : sn);
      let ry = st.ry * (sq > 0 ? Math.sign(cs) * Math.pow(Math.abs(cs), 1 - sq * 0.48) : cs);
      if (st.flatBottom && ry < 0) ry *= st.flatBottom;

      const px = st.cx + rx;
      const py = st.cy + ry;
      const pz = st.cz + (st.tiltY ? ry * st.tiltY : 0);

      pos[vi * 3] = px;
      pos[vi * 3 + 1] = py;
      pos[vi * 3 + 2] = pz;

      skinIdx[vi * 4] = bi[0]; skinIdx[vi * 4 + 1] = bi[1]; skinIdx[vi * 4 + 2] = bi[2] || 0; skinIdx[vi * 4 + 3] = bi[3] || 0;
      skinWgt[vi * 4] = bw[0]; skinWgt[vi * 4 + 1] = bw[1]; skinWgt[vi * 4 + 2] = bw[2] || 0; skinWgt[vi * 4 + 3] = bw[3] || 0;

      fur[vi] = furFn ? furFn(u, a, px, py, pz) : 1.0;
      uvs[vi * 2] = v;
      uvs[vi * 2 + 1] = u;
      vi++;
    }
  }

  const idx = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let c = 0; c < radialSegs; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIdx, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWgt, 4));
  g.setAttribute('aFur', new THREE.Float32BufferAttribute(fur, 1));
  g.setIndex(idx);
  g.computeVertexNormals();

  // Stitch seam normals across c = 0 and c = radialSegs so tubes are perfectly smooth all round
  const nrm = g.attributes.normal;
  for (let r = 0; r < rings; r++) {
    const i0 = r * cols, i1 = r * cols + radialSegs;
    const nx = nrm.getX(i0) + nrm.getX(i1);
    const ny = nrm.getY(i0) + nrm.getY(i1);
    const nz = nrm.getZ(i0) + nrm.getZ(i1);
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(i0, nx / l, ny / l, nz / l);
    nrm.setXYZ(i1, nx / l, ny / l, nz / l);
  }
  return g;
}

// Base coat material matching FurCoat's tabby pattern & Petalwake sun/sky lighting
function makePlaceholderCoatMaterial(sunVisUniform) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared(...SKY_UNIFORMS, 'uTime', 'uNoiseTex'),
      uSunVis: sunVisUniform,
    },
    vertexShader: /* glsl */`
      precision highp float;
      #include <skinning_pars_vertex>
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying vec3 vRestPos;
      varying vec3 vRestN;
      void main() {
        vRestPos = position;
        vRestN = normalize(normal);
        vec3 objectNormal = normal;
        vec3 transformed = position;
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <skinning_vertex>
        vec4 wp = modelMatrix * vec4(transformed, 1.0);
        vWorld = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * objectNormal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime;
      uniform float uSunVis;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying vec3 vRestPos;
      varying vec3 vRestN;
      ${NOISE}
      ${CLOUD_SHADOW}
      ${TABBY_COAT_GLSL}
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uAmbSky;
      uniform vec3 uAmbGround;
      uniform vec3 uCamPos;
      void main() {
        float furMask;
        vec3 alb = catbusCoatColor(vRestPos, normalize(vRestN), furMask);
        // Slightly darker undercoat where fur shells sit on top so roots have natural depth
        alb *= mix(1.0, 0.76, furMask);
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(uCamPos - vWorld);
        float sh = uSunVis * cloudShadow(vWorld.xz, uTime);
        float dif = clamp(dot(N, uSunDir) * 0.56 + 0.44, 0.0, 1.0);
        vec3 amb = mix(uAmbGround * 1.35, uAmbSky, N.y * 0.5 + 0.5) * 0.90;
        vec3 col = alb * (uSunColor * dif * sh + amb);
        float rim = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 2.8);
        col += alb * uSunColor * rim * 0.14 * (0.3 + 0.7 * sh);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------------------------------
// Build the procedural rigged ginger-tabby stagecoach placeholder + 5 named AnimationClips
// ---------------------------------------------------------------------------------------------
export function buildPlaceholderCatbus() {
  const scene = new THREE.Group();
  scene.name = 'CatbusPlaceholder';

  // ---- 1. Skeleton (33 bones)
  // Indices:
  // 0: root (0, 1.25, 0)
  // 1: spineFront (0, 0, -0.95)
  // 2: head (0, 0.18, -1.05) -> world (0, 1.43, -2.00)
  // 3: earL (-0.42, 0.54, -0.02) -> world (-0.42, 1.97, -2.02)
  // 4: earR (+0.42, 0.54, -0.02) -> world (+0.42, 1.97, -2.02)
  // 5: spineRear (0, 0, +0.95)
  // 6: tail1 (0, 0.20, +0.95) -> world (0, 1.45, +1.90)
  // 7: tail2 (0, 0.15, +0.62)
  // 8: tail3 (0, 0.12, +0.62)
  // 9..32: 6 leg pairs (left/right upper + lower)
  const bones = [];
  const mkBone = (name, parent, x, y, z) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    if (parent) parent.add(b);
    const idx = bones.length;
    bones.push(b);
    return { b, idx };
  };

  const bRoot = mkBone('root', null, 0, 1.25, 0);
  const bSpineF = mkBone('spineFront', bRoot.b, 0, 0, -0.95);
  const bHead = mkBone('head', bSpineF.b, 0, 0.18, -1.05);
  const bEarL = mkBone('earL', bHead.b, -0.42, 0.54, -0.02);
  const bEarR = mkBone('earR', bHead.b, 0.42, 0.54, -0.02);
  const bSpineR = mkBone('spineRear', bRoot.b, 0, 0, 0.95);
  const bTail1 = mkBone('tail1', bSpineR.b, 0, 0.20, 0.95);
  const bTail2 = mkBone('tail2', bTail1.b, 0, 0.15, 0.62);
  const bTail3 = mkBone('tail3', bTail2.b, 0, 0.12, 0.62);

  const legZ = [-1.56, -0.94, -0.31, 0.31, 0.94, 1.56];
  const legs = [];
  for (let p = 0; p < 6; p++) {
    const zWorld = legZ[p];
    const parent = p < 2 ? bSpineF : p > 3 ? bSpineR : bRoot;
    const pz = zWorld - (parent === bSpineF ? -0.95 : parent === bSpineR ? 0.95 : 0);
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const tag = `${p}${s === 0 ? 'L' : 'R'}`;
      const hip = mkBone(`legUp_${tag}`, parent.b, side * 0.76, -0.39, pz); // world y = 0.86
      const knee = mkBone(`legLo_${tag}`, hip.b, side * 0.04, -0.43, 0);   // world y = 0.43
      legs.push({ pair: p, side, tag, hip, knee, x: side * 0.78, z: zWorld });
    }
  }

  scene.add(bRoot.b);
  scene.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  // ---- 2. Lofted Skinned Furry Body Geometry
  const parts = [];

  // 2a. Arched stagecoach torso (z = -1.98 .. +1.98)
  const torsoStations = [
    { cx: 0, cy: 1.34, cz: -1.98, rx: 0.04, ry: 0.04, squircle: 0.2 },
    { cx: 0, cy: 1.36, cz: -1.90, rx: 0.62, ry: 0.56, squircle: 0.45, flatBottom: 0.78 },
    { cx: 0, cy: 1.42, cz: -1.62, rx: 0.88, ry: 0.72, squircle: 0.68, flatBottom: 0.74 },
    { cx: 0, cy: 1.44, cz: -1.10, rx: 0.94, ry: 0.76, squircle: 0.74, flatBottom: 0.72 },
    { cx: 0, cy: 1.45, cz: -0.50, rx: 0.95, ry: 0.77, squircle: 0.76, flatBottom: 0.72 },
    { cx: 0, cy: 1.45, cz: 0.00, rx: 0.95, ry: 0.77, squircle: 0.76, flatBottom: 0.72 },
    { cx: 0, cy: 1.45, cz: 0.50, rx: 0.95, ry: 0.77, squircle: 0.76, flatBottom: 0.72 },
    { cx: 0, cy: 1.44, cz: 1.10, rx: 0.93, ry: 0.75, squircle: 0.72, flatBottom: 0.72 },
    { cx: 0, cy: 1.42, cz: 1.62, rx: 0.85, ry: 0.70, squircle: 0.62, flatBottom: 0.76 },
    { cx: 0, cy: 1.38, cz: 1.90, rx: 0.56, ry: 0.50, squircle: 0.40, flatBottom: 0.82 },
    { cx: 0, cy: 1.38, cz: 2.00, rx: 0.04, ry: 0.04, squircle: 0.2 },
  ];
  parts.push(buildLoftedPart(
    torsoStations,
    24,
    (_u, st) => {
      const z = st.cz;
      if (z < -0.5) {
        const wf = THREE.MathUtils.smoothstep(-z, 0.5, 1.45);
        return [[bSpineF.idx, bRoot.idx, 0, 0], [wf, 1 - wf, 0, 0]];
      }
      if (z > 0.5) {
        const wr = THREE.MathUtils.smoothstep(z, 0.5, 1.45);
        return [[bSpineR.idx, bRoot.idx, 0, 0], [wr, 1 - wr, 0, 0]];
      }
      return [[bRoot.idx, 0, 0, 0], [1, 0, 0, 0]];
    },
    (_u, _a, px, py, pz) => {
      // Mask fur out cleanly inside the recessed cabin window bays so glass & cross-frames stay crisp
      if (Math.abs(px) > 0.80 && py > 1.28 && py < 1.88 && Math.abs(pz) < 1.48) {
        const bay = Math.abs(((pz + 1.44) % 0.72 + 0.72) % 0.72 - 0.36);
        if (bay < 0.23) return 0.0;
      }
      return 1.05;
    },
  ));

  // 2b. Friendly broad cat head & plump cream muzzle (z = -1.72 .. -2.56)
  const headStations = [
    { cx: 0, cy: 1.48, cz: -1.68, rx: 0.55, ry: 0.48, squircle: 0.2 },
    { cx: 0, cy: 1.52, cz: -1.94, rx: 0.68, ry: 0.56, squircle: 0.28 },
    { cx: 0, cy: 1.48, cz: -2.18, rx: 0.66, ry: 0.52, squircle: 0.25 },
    { cx: 0, cy: 1.32, cz: -2.38, rx: 0.52, ry: 0.38, squircle: 0.30 }, // whisker cheeks + muzzle
    { cx: 0, cy: 1.22, cz: -2.51, rx: 0.34, ry: 0.25, squircle: 0.25 },
    { cx: 0, cy: 1.20, cz: -2.56, rx: 0.04, ry: 0.03, squircle: 0.1 },
  ];
  parts.push(buildLoftedPart(
    headStations,
    20,
    (u) => {
      const wh = THREE.MathUtils.smoothstep(u, 0.0, 0.35);
      return [[bHead.idx, bSpineF.idx, 0, 0], [wh, 1 - wh, 0, 0]];
    },
    (u, _a, px, _py, pz) => {
      // Shorter velvety fur on the nose/muzzle tip, extra fluffy cheek ruffs!
      if (pz < -2.38 && Math.abs(px) < 0.30) return 0.32;
      if (Math.abs(px) > 0.48 && u > 0.2 && u < 0.7) return 1.25;
      return 0.85;
    },
  ));

  // 2c. Pointed feline ears
  for (const [earBone, side] of [[bEarL, -1], [bEarR, 1]]) {
    const ex = side * 0.42, ez = -2.02;
    const earStations = [
      { cx: ex * 0.92, cy: 1.90, cz: ez + 0.04, rx: 0.19, ry: 0.14, tiltY: 0.15 },
      { cx: ex * 1.04, cy: 2.12, cz: ez + 0.01, rx: 0.15, ry: 0.10, tiltY: 0.15 },
      { cx: ex * 1.14, cy: 2.34, cz: ez - 0.02, rx: 0.09, ry: 0.06, tiltY: 0.15 },
      { cx: ex * 1.20, cy: 2.50, cz: ez - 0.04, rx: 0.02, ry: 0.02, tiltY: 0.15 },
    ];
    parts.push(buildLoftedPart(
      earStations,
      10,
      (u) => {
        const we = THREE.MathUtils.smoothstep(u, 0.0, 0.4);
        return [[earBone.idx, bHead.idx, 0, 0], [we, 1 - we, 0, 0]];
      },
      (u) => 0.55 + 0.35 * (1 - u),
    ));
  }

  // 2d. Fluffy ringed tabby tail (z = +1.85 .. +3.74)
  const tailStations = [
    { cx: 0, cy: 1.44, cz: 1.85, rx: 0.21, ry: 0.21 },
    { cx: 0, cy: 1.50, cz: 2.18, rx: 0.24, ry: 0.24 },
    { cx: 0, cy: 1.60, cz: 2.56, rx: 0.26, ry: 0.26 },
    { cx: 0, cy: 1.72, cz: 2.96, rx: 0.25, ry: 0.25 },
    { cx: 0, cy: 1.83, cz: 3.36, rx: 0.21, ry: 0.21 },
    { cx: 0, cy: 1.91, cz: 3.64, rx: 0.13, ry: 0.13 },
    { cx: 0, cy: 1.94, cz: 3.75, rx: 0.03, ry: 0.03 },
  ];
  parts.push(buildLoftedPart(
    tailStations,
    12,
    (u) => {
      if (u < 0.35) {
        const t = u / 0.35;
        return [[bTail1.idx, bSpineR.idx, 0, 0], [t, 1 - t, 0, 0]];
      }
      if (u < 0.68) {
        const t = (u - 0.35) / 0.33;
        return [[bTail2.idx, bTail1.idx, 0, 0], [t, 1 - t, 0, 0]];
      }
      const t = (u - 0.68) / 0.32;
      return [[bTail3.idx, bTail2.idx, 0, 0], [t, 1 - t, 0, 0]];
    },
    () => 1.32,
  ));

  // 2e. 12 scampering legs with plump cream paws resting on y = 0
  for (const leg of legs) {
    const x0 = leg.side * 0.76, x1 = leg.side * 0.82, z0 = leg.z;
    const legStations = [
      { cx: x0 * 0.92, cy: 1.02, cz: z0, rx: 0.22, ry: 0.24 },
      { cx: x0, cy: 0.76, cz: z0, rx: 0.18, ry: 0.19 },
      { cx: x1, cy: 0.45, cz: z0 + 0.02, rx: 0.14, ry: 0.15 },
      { cx: x1, cy: 0.19, cz: z0 - 0.02, rx: 0.13, ry: 0.14 },
      { cx: x1, cy: 0.07, cz: z0 - 0.08, rx: 0.16, ry: 0.19, flatBottom: 0.35 },
      { cx: x1, cy: 0.01, cz: z0 - 0.09, rx: 0.13, ry: 0.02, flatBottom: 0.1 },
      { cx: x1, cy: 0.00, cz: z0 - 0.09, rx: 0.02, ry: 0.01 },
    ];
    parts.push(buildLoftedPart(
      legStations,
      10,
      (u) => {
        if (u < 0.42) return [[leg.hip.idx, 0, 0, 0], [1, 0, 0, 0]];
        if (u < 0.58) {
          const k = (u - 0.42) / 0.16;
          return [[leg.knee.idx, leg.hip.idx, 0, 0], [k, 1 - k, 0, 0]];
        }
        return [[leg.knee.idx, 0, 0, 0], [1, 0, 0, 0]];
      },
      (u) => (u > 0.72 ? 0.42 : 0.82),
    ));
  }

  const coatGeo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();

  const sunVisUniform = { value: 1.0 };
  const coatMat = makePlaceholderCoatMaterial(sunVisUniform);
  const coatMesh = new THREE.SkinnedMesh(coatGeo, coatMat);
  coatMesh.name = 'catbus_coat';
  coatMesh.frustumCulled = false;
  coatMesh.castShadow = true;
  coatMesh.receiveShadow = true;
  coatMesh.userData.furry = true;
  scene.add(coatMesh);
  coatMesh.bind(skeleton);

  // ---- 3. Non-furry architectural stagecoach details (eyes, lit windows + wooden cross frames,
  //         hanging brass lantern, roof rail + bells)
  const woodMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.16, 0.075, 0.032),
    roughness: 0.78,
    metalness: 0.05,
    name: 'catbus_wood_frame',
  });
  const brassMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.76, 0.55, 0.20),
    roughness: 0.30,
    metalness: 0.88,
    name: 'catbus_brass',
  });
  const windowGlowMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(1.0, 0.78, 0.42),
    emissive: new THREE.Color(2.25, 1.42, 0.50),
    emissiveIntensity: 1.0,
    roughness: 0.18,
    metalness: 0.0,
    name: 'catbus_window_glass',
  });
  const lanternGlowMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(1.0, 0.86, 0.55),
    emissive: new THREE.Color(3.4, 2.15, 0.72),
    emissiveIntensity: 1.0,
    roughness: 0.12,
    metalness: 0.0,
    name: 'catbus_lantern_glass',
  });
  const eyeAmberMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.95, 0.68, 0.10),
    emissive: new THREE.Color(0.55, 0.34, 0.04),
    roughness: 0.14,
    metalness: 0.0,
    name: 'catbus_eye',
  });
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x120904, name: 'catbus_pupil' });
  const glintMat = new THREE.MeshBasicMaterial({ color: 0xfff8ea, name: 'catbus_eye_glint' });
  const whiskerMat = new THREE.MeshStandardMaterial({ color: 0xf4ead5, roughness: 0.6, name: 'catbus_whisker' });

  // 3a. Friendly golden cat eyes & whiskers (parented to bHead.b; bHead world origin is (0, 1.43, -2.00))
  const eyeGeo = new THREE.SphereGeometry(0.135, 14, 12);
  eyeGeo.scale(0.95, 1.05, 0.58);
  const pupilGeo = new THREE.BoxGeometry(0.036, 0.16, 0.03);
  const glintGeo = new THREE.SphereGeometry(0.024, 8, 6);
  const whiskerGeo = new THREE.CylinderGeometry(0.005, 0.002, 0.52, 5);
  whiskerGeo.rotateZ(Math.PI / 2);

  for (const side of [-1, 1]) {
    const eyeGroup = new THREE.Group();
    eyeGroup.position.set(side * 0.29, 0.06, -0.36);
    eyeGroup.rotation.y = -side * 0.28;
    eyeGroup.rotation.x = 0.08;
    const iris = new THREE.Mesh(eyeGeo, eyeAmberMat);
    const pupil = new THREE.Mesh(pupilGeo, pupilMat);
    pupil.position.set(0, 0, -0.072);
    const glint = new THREE.Mesh(glintGeo, glintMat);
    glint.position.set(side * 0.035, 0.045, -0.078);
    eyeGroup.add(iris, pupil, glint);
    bHead.b.add(eyeGroup);

    for (let w = -1; w <= 1; w++) {
      const wk = new THREE.Mesh(whiskerGeo, whiskerMat);
      wk.position.set(side * 0.54, -0.17 + w * 0.045, -0.40);
      wk.rotation.z = side * (-0.08 + w * 0.11);
      wk.rotation.y = side * 0.22;
      bHead.b.add(wk);
    }
  }

  // 3b. Lit cabin windows with wooden cross frames (+ mullions) along both sides of the stagecoach
  const winW = 0.44, winH = 0.48;
  const paneGeo = new THREE.BoxGeometry(0.05, winH, winW);
  const frameHGeo = new THREE.BoxGeometry(0.085, 0.048, winW + 0.08);
  const frameVGeo = new THREE.BoxGeometry(0.085, winH + 0.08, 0.048);
  const mullionHGeo = new THREE.BoxGeometry(0.078, 0.030, winW);
  const mullionVGeo = new THREE.BoxGeometry(0.078, winH, 0.030);
  const sillGeo = new THREE.BoxGeometry(0.12, 0.052, winW + 0.13);

  const winZOffsets = [-1.08, -0.36, 0.36, 1.08];
  for (const wz of winZOffsets) {
    const ownerBone = wz < -0.6 ? bSpineF.b : wz > 0.6 ? bSpineR.b : bRoot.b;
    const localZ = wz - (wz < -0.6 ? -0.95 : wz > 0.6 ? 0.95 : 0);
    const localY = 0.33; // world y = 1.58
    for (const side of [-1, 1]) {
      const wg = new THREE.Group();
      wg.name = 'catbus_window';
      wg.position.set(side * 0.90, localY, localZ);
      wg.rotation.z = -side * 0.06;

      const pane = new THREE.Mesh(paneGeo, windowGlowMat);
      const topBar = new THREE.Mesh(frameHGeo, woodMat);
      topBar.position.y = winH * 0.5 + 0.015;
      const botSill = new THREE.Mesh(sillGeo, woodMat);
      botSill.position.set(side * 0.015, -winH * 0.5 - 0.018, 0);
      const leftPost = new THREE.Mesh(frameVGeo, woodMat);
      leftPost.position.z = -winW * 0.5 - 0.015;
      const rightPost = new THREE.Mesh(frameVGeo, woodMat);
      rightPost.position.z = winW * 0.5 + 0.015;
      // Wooden cross frame (+ muntins)
      const crossH = new THREE.Mesh(mullionHGeo, woodMat);
      crossH.position.y = 0.02;
      const crossV = new THREE.Mesh(mullionVGeo, woodMat);

      wg.add(pane, topBar, botSill, leftPost, rightPost, crossH, crossV);
      ownerBone.add(wg);
    }
  }

  // 3c. Hanging brass lantern on a front wrought-brass bracket (secondary motion pendulum pivot!)
  // Attached to spineFront so it rides with the prow of the stagecoach cabin
  const bracketMount = new THREE.Group();
  bracketMount.name = 'catbus_lantern_mount';
  bracketMount.position.set(0.68, 0.78, -0.82); // world (0.68, 2.03, -1.77), right beside the front brow
  bSpineF.b.add(bracketMount);

  const armGeo = new THREE.CylinderGeometry(0.018, 0.022, 0.36, 8);
  armGeo.rotateZ(Math.PI * 0.38);
  const arm = new THREE.Mesh(armGeo, brassMat);
  arm.position.set(0.14, 0.06, -0.06);
  const curlGeo = new THREE.TorusGeometry(0.055, 0.014, 6, 12, Math.PI * 1.25);
  const curl = new THREE.Mesh(curlGeo, brassMat);
  curl.position.set(0.28, 0.11, -0.08);
  bracketMount.add(arm, curl);

  const lanternPivot = new THREE.Group();
  lanternPivot.name = 'lantern_pivot';
  lanternPivot.position.set(0.30, 0.08, -0.08);
  bracketMount.add(lanternPivot);

  const baleGeo = new THREE.TorusGeometry(0.05, 0.010, 6, 10, Math.PI);
  const bale = new THREE.Mesh(baleGeo, brassMat);
  bale.position.y = -0.04;
  const capGeo = new THREE.ConeGeometry(0.115, 0.09, 6);
  const cap = new THREE.Mesh(capGeo, brassMat);
  cap.position.y = -0.09;
  const glassGeo = new THREE.CylinderGeometry(0.085, 0.072, 0.18, 6);
  const glass = new THREE.Mesh(glassGeo, lanternGlowMat);
  glass.position.y = -0.21;
  const baseGeo = new THREE.CylinderGeometry(0.09, 0.06, 0.05, 6);
  const base = new THREE.Mesh(baseGeo, brassMat);
  base.position.y = -0.31;
  lanternPivot.add(bale, cap, glass, base);

  // 3d. Roof rail with hanging brass bells (secondary motion on rail & individual bells!)
  const railGroup = new THREE.Group();
  railGroup.name = 'roof_rail';
  railGroup.position.set(0, 0.89, 0); // world y = 2.14 on root
  bRoot.b.add(railGroup);

  const railLen = 2.88, railX = 0.72, railH = 0.19;
  const sideBarGeo = new THREE.CylinderGeometry(0.022, 0.022, railLen, 8);
  sideBarGeo.rotateX(Math.PI / 2);
  const backBarGeo = new THREE.CylinderGeometry(0.022, 0.022, railX * 2, 8);
  backBarGeo.rotateZ(Math.PI / 2);
  const stanchionGeo = new THREE.CylinderGeometry(0.018, 0.022, railH, 7);
  const finialGeo = new THREE.SphereGeometry(0.032, 8, 6);
  const bellCupGeo = new THREE.ConeGeometry(0.048, 0.072, 8, 1, true);
  const clapperGeo = new THREE.SphereGeometry(0.018, 6, 6);

  for (const side of [-1, 1]) {
    const bar = new THREE.Mesh(sideBarGeo, brassMat);
    bar.position.set(side * railX, railH, 0.08);
    railGroup.add(bar);
  }
  const backBar = new THREE.Mesh(backBarGeo, brassMat);
  backBar.position.set(0, railH, 0.08 + railLen * 0.5);
  const frontBar = new THREE.Mesh(backBarGeo, brassMat);
  frontBar.position.set(0, railH, 0.08 - railLen * 0.5);
  railGroup.add(backBar, frontBar);

  const bellPivots = [];
  const postZ = [-1.36, -0.64, 0.08, 0.80, 1.52];
  for (let i = 0; i < postZ.length; i++) {
    const pz = postZ[i];
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(stanchionGeo, woodMat);
      post.position.set(side * railX, railH * 0.5 - 0.02, pz);
      const finial = new THREE.Mesh(finialGeo, brassMat);
      finial.position.set(side * railX, railH + 0.02, pz);
      railGroup.add(post, finial);

      // Hang a brass bell midway between each span along the side rails
      if (i < postZ.length - 1) {
        const bz = 0.5 * (pz + postZ[i + 1]);
        const bp = new THREE.Group();
        bp.name = `bell_pivot_${i}_${side > 0 ? 'R' : 'L'}`;
        bp.position.set(side * (railX + 0.02), railH - 0.005, bz);
        const cup = new THREE.Mesh(bellCupGeo, brassMat);
        cup.material = brassMat;
        cup.position.y = -0.042;
        const clap = new THREE.Mesh(clapperGeo, brassMat);
        clap.position.y = -0.075;
        bp.add(cup, clap);
        railGroup.add(bp);
        bellPivots.push({ group: bp, phase: i * 1.7 + (side > 0 ? 0.9 : 0) });
      }
    }
  }

  scene.traverse((o) => {
    if (o.isMesh && o !== coatMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
    }
  });

  // ---- 4. Build the 5 named AnimationClips: walk, sprint, fly, takeoff, land
  const animations = buildPlaceholderClips(bones, legs, { bRoot, bSpineF, bHead, bEarL, bEarR, bSpineR, bTail1, bTail2, bTail3 });

  return { scene, animations };
}

function sampleTrackEuler(boneName, dur, samples, eulerFn) {
  const times = new Float32Array(samples + 1);
  const vals = new Float32Array((samples + 1) * 4);
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    times[i] = u * dur;
    const [rx, ry, rz] = eulerFn(u);
    q.setFromEuler(e.set(rx, ry, rz, 'XYZ'));
    vals[i * 4] = q.x; vals[i * 4 + 1] = q.y; vals[i * 4 + 2] = q.z; vals[i * 4 + 3] = q.w;
  }
  return new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, vals);
}

function sampleTrackPos(boneName, basePos, dur, samples, offsetFn) {
  const times = new Float32Array(samples + 1);
  const vals = new Float32Array((samples + 1) * 3);
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    times[i] = u * dur;
    const [dx, dy, dz] = offsetFn(u);
    vals[i * 3] = basePos.x + dx;
    vals[i * 3 + 1] = basePos.y + dy;
    vals[i * 3 + 2] = basePos.z + dz;
  }
  return new THREE.VectorKeyframeTrack(`${boneName}.position`, times, vals);
}

function buildPlaceholderClips(bones, legs, B) {
  const TAU = Math.PI * 2;
  const clips = [];

  // 1. WALK: smooth 12-legged metachronal wave
  {
    const dur = 0.84, S = 24, tracks = [];
    tracks.push(sampleTrackPos('root', B.bRoot.b.position, dur, S, (u) => [
      Math.sin(u * TAU) * 0.02,
      Math.sin(u * TAU * 2) * 0.038,
      0,
    ]));
    tracks.push(sampleTrackEuler('root', dur, S, (u) => [
      Math.sin(u * TAU * 2 + 0.6) * 0.018,
      Math.sin(u * TAU) * 0.022,
      Math.cos(u * TAU) * 0.024,
    ]));
    tracks.push(sampleTrackEuler('spineFront', dur, S, (u) => [Math.sin(u * TAU * 2) * 0.025, Math.sin(u * TAU + 0.5) * 0.02, 0]));
    tracks.push(sampleTrackEuler('spineRear', dur, S, (u) => [-Math.sin(u * TAU * 2) * 0.025, -Math.sin(u * TAU + 0.5) * 0.02, 0]));
    tracks.push(sampleTrackEuler('head', dur, S, (u) => [Math.sin(u * TAU * 2 - 0.5) * 0.035, 0, Math.sin(u * TAU) * 0.02]));
    tracks.push(sampleTrackEuler('earL', dur, S, (u) => [Math.sin(u * TAU * 2) * 0.06, 0, 0.05]));
    tracks.push(sampleTrackEuler('earR', dur, S, (u) => [Math.sin(u * TAU * 2 + 0.8) * 0.06, 0, -0.05]));
    tracks.push(sampleTrackEuler('tail1', dur, S, (u) => [0.16 + Math.sin(u * TAU * 2) * 0.05, Math.sin(u * TAU) * 0.18, 0]));
    tracks.push(sampleTrackEuler('tail2', dur, S, (u) => [0.14, Math.sin(u * TAU - 0.7) * 0.22, 0]));
    tracks.push(sampleTrackEuler('tail3', dur, S, (u) => [0.10, Math.sin(u * TAU - 1.4) * 0.26, 0]));

    for (const leg of legs) {
      const ph = leg.pair * 1.05 + (leg.side > 0 ? Math.PI : 0);
      tracks.push(sampleTrackEuler(leg.hip.b.name, dur, S, (u) => {
        const a = u * TAU + ph;
        const swing = Math.sin(a) * 0.44;
        const lift = Math.max(0, Math.cos(a)) * 0.16;
        return [swing - lift, 0, leg.side * 0.04 * Math.cos(a)];
      }));
      tracks.push(sampleTrackEuler(leg.knee.b.name, dur, S, (u) => {
        const a = u * TAU + ph;
        const bend = Math.max(0, Math.cos(a)) * 0.58 + 0.08;
        return [-bend, 0, 0];
      }));
    }
    clips.push(new THREE.AnimationClip('walk', dur, tracks));
  }

  // 2. SPRINT: athletic bounding gallop across all 6 leg pairs
  {
    const dur = 0.48, S = 24, tracks = [];
    tracks.push(sampleTrackPos('root', B.bRoot.b.position, dur, S, (u) => [
      0,
      Math.sin(u * TAU) * 0.11 + 0.03,
      0,
    ]));
    tracks.push(sampleTrackEuler('root', dur, S, (u) => [
      Math.cos(u * TAU) * 0.085,
      0,
      Math.sin(u * TAU) * 0.02,
    ]));
    tracks.push(sampleTrackEuler('spineFront', dur, S, (u) => [Math.sin(u * TAU + 0.4) * 0.11, 0, 0]));
    tracks.push(sampleTrackEuler('spineRear', dur, S, (u) => [-Math.sin(u * TAU + 0.4) * 0.12, 0, 0]));
    tracks.push(sampleTrackEuler('head', dur, S, (u) => [-Math.cos(u * TAU) * 0.07 - 0.05, 0, 0]));
    tracks.push(sampleTrackEuler('earL', dur, S, (u) => [-0.24 + Math.sin(u * TAU) * 0.08, 0, 0.10]));
    tracks.push(sampleTrackEuler('earR', dur, S, (u) => [-0.24 + Math.sin(u * TAU + 0.4) * 0.08, 0, -0.10]));
    tracks.push(sampleTrackEuler('tail1', dur, S, (u) => [-0.14 + Math.sin(u * TAU) * 0.12, Math.sin(u * TAU * 0.5) * 0.08, 0]));
    tracks.push(sampleTrackEuler('tail2', dur, S, (u) => [0.06 + Math.sin(u * TAU - 0.6) * 0.16, 0, 0]));
    tracks.push(sampleTrackEuler('tail3', dur, S, (u) => [0.08 + Math.sin(u * TAU - 1.2) * 0.20, 0, 0]));

    for (const leg of legs) {
      // Gallop wave: front pairs reach forward together while rear pairs drive backward
      const ph = leg.pair * 0.52 + (leg.side > 0 ? 0.32 : 0);
      tracks.push(sampleTrackEuler(leg.hip.b.name, dur, S, (u) => {
        const a = u * TAU - ph;
        return [Math.sin(a) * 0.72, 0, leg.side * 0.06];
      }));
      tracks.push(sampleTrackEuler(leg.knee.b.name, dur, S, (u) => {
        const a = u * TAU - ph;
        return [-(Math.max(0, Math.cos(a)) * 0.82 + 0.12), 0, 0];
      }));
    }
    clips.push(new THREE.AnimationClip('sprint', dur, tracks));
  }

  // 3. FLY: buoyant sky-bounding / wind-striding glide
  {
    const dur = 0.92, S = 24, tracks = [];
    tracks.push(sampleTrackPos('root', B.bRoot.b.position, dur, S, (u) => [
      0,
      Math.sin(u * TAU) * 0.075,
      0,
    ]));
    tracks.push(sampleTrackEuler('root', dur, S, (u) => [
      Math.cos(u * TAU) * 0.045,
      0,
      Math.sin(u * TAU) * 0.025,
    ]));
    tracks.push(sampleTrackEuler('spineFront', dur, S, (u) => [Math.sin(u * TAU + 0.5) * 0.06, 0, 0]));
    tracks.push(sampleTrackEuler('spineRear', dur, S, (u) => [-Math.sin(u * TAU + 0.5) * 0.07, 0, 0]));
    tracks.push(sampleTrackEuler('head', dur, S, (u) => [-0.06 + Math.sin(u * TAU - 0.6) * 0.04, 0, 0]));
    tracks.push(sampleTrackEuler('earL', dur, S, (u) => [-0.18 + Math.sin(u * TAU * 2) * 0.05, 0, 0.12]));
    tracks.push(sampleTrackEuler('earR', dur, S, (u) => [-0.18 + Math.cos(u * TAU * 2) * 0.05, 0, -0.12]));
    tracks.push(sampleTrackEuler('tail1', dur, S, (u) => [-0.10 + Math.sin(u * TAU) * 0.14, Math.cos(u * TAU) * 0.12, 0]));
    tracks.push(sampleTrackEuler('tail2', dur, S, (u) => [Math.sin(u * TAU - 0.8) * 0.20, Math.cos(u * TAU - 0.8) * 0.16, 0]));
    tracks.push(sampleTrackEuler('tail3', dur, S, (u) => [Math.sin(u * TAU - 1.6) * 0.25, Math.cos(u * TAU - 1.6) * 0.20, 0]));

    for (const leg of legs) {
      // Tucked sky-stride: legs swept gracefully back in the slipstream with gentle air-paddling wave
      const ph = leg.pair * 0.72 + (leg.side > 0 ? 0.5 : 0);
      const baseSweep = leg.pair < 2 ? 0.38 : -0.56;
      tracks.push(sampleTrackEuler(leg.hip.b.name, dur, S, (u) => {
        const a = u * TAU - ph;
        return [baseSweep + Math.sin(a) * 0.26, 0, leg.side * 0.10];
      }));
      tracks.push(sampleTrackEuler(leg.knee.b.name, dur, S, (u) => {
        const a = u * TAU - ph;
        return [-(0.62 + 0.22 * Math.cos(a)), 0, 0];
      }));
    }
    clips.push(new THREE.AnimationClip('fly', dur, tracks));
  }

  // 4. TAKEOFF: coiled crouch -> powerful spring skyward -> airborne tuck
  {
    const dur = 0.62, S = 20, tracks = [];
    const crouchCurve = (u) => (u < 0.28 ? -Math.sin((u / 0.28) * Math.PI * 0.5) * 0.26 : Math.sin(((u - 0.28) / 0.72) * Math.PI) * 0.16);
    tracks.push(sampleTrackPos('root', B.bRoot.b.position, dur, S, (u) => [0, crouchCurve(u), 0]));
    tracks.push(sampleTrackEuler('root', dur, S, (u) => {
      const pitch = u < 0.25 ? -0.06 * (u / 0.25) : 0.22 * Math.sin(((u - 0.25) / 0.75) * Math.PI);
      return [pitch, 0, 0];
    }));
    tracks.push(sampleTrackEuler('spineFront', dur, S, (u) => [u < 0.28 ? -0.08 : 0.12 * (1 - (u - 0.28) / 0.72), 0, 0]));
    tracks.push(sampleTrackEuler('spineRear', dur, S, (u) => [u < 0.28 ? 0.08 : -0.14 * Math.sin(((u - 0.28) / 0.72) * Math.PI), 0, 0]));
    tracks.push(sampleTrackEuler('head', dur, S, (u) => [u < 0.25 ? 0.08 : -0.10, 0, 0]));
    tracks.push(sampleTrackEuler('tail1', dur, S, (u) => [0.22 * (1 - u) - 0.10 * u, 0, 0]));
    tracks.push(sampleTrackEuler('tail2', dur, S, (u) => [0.18 * Math.cos(u * Math.PI), 0, 0]));

    for (const leg of legs) {
      const flyHip = leg.pair < 2 ? 0.38 : -0.56;
      tracks.push(sampleTrackEuler(leg.hip.b.name, dur, S, (u) => {
        if (u < 0.28) return [0.32 * (u / 0.28), 0, leg.side * 0.08];
        if (u < 0.62) {
          const k = (u - 0.28) / 0.34;
          return [THREE.MathUtils.lerp(0.32, -0.68, k), 0, leg.side * 0.06];
        }
        const k = (u - 0.62) / 0.38;
        return [THREE.MathUtils.lerp(-0.68, flyHip, k), 0, leg.side * 0.10];
      }));
      tracks.push(sampleTrackEuler(leg.knee.b.name, dur, S, (u) => {
        if (u < 0.28) return [-0.75 * (u / 0.28), 0, 0];
        if (u < 0.62) return [-0.75 * (1 - (u - 0.28) / 0.34), 0, 0];
        return [-0.62 * ((u - 0.62) / 0.38), 0, 0];
      }));
    }
    clips.push(new THREE.AnimationClip('takeoff', dur, tracks));
  }

  // 5. LAND: paws reach forward -> cushioned touchdown compression -> clean settle
  {
    const dur = 0.52, S = 20, tracks = [];
    tracks.push(sampleTrackPos('root', B.bRoot.b.position, dur, S, (u) => {
      if (u < 0.22) return [0, 0.08 * (1 - u / 0.22), 0];
      const w = (u - 0.22) / 0.78;
      return [0, -0.20 * Math.sin(Math.pow(w, 0.65) * Math.PI) * (1 - 0.3 * w), 0];
    }));
    tracks.push(sampleTrackEuler('root', dur, S, (u) => [
      u < 0.3 ? 0.14 * (1 - u / 0.3) : -0.05 * Math.sin(((u - 0.3) / 0.7) * Math.PI),
      0,
      0,
    ]));
    tracks.push(sampleTrackEuler('spineFront', dur, S, (u) => [-0.08 * Math.sin(u * Math.PI), 0, 0]));
    tracks.push(sampleTrackEuler('spineRear', dur, S, (u) => [0.08 * Math.sin(u * Math.PI), 0, 0]));
    tracks.push(sampleTrackEuler('head', dur, S, (u) => [0.06 * Math.sin(u * Math.PI), 0, 0]));
    tracks.push(sampleTrackEuler('tail1', dur, S, (u) => [0.25 * Math.sin(u * Math.PI) + 0.12 * u, 0, 0]));
    tracks.push(sampleTrackEuler('tail2', dur, S, (u) => [0.20 * Math.sin(u * Math.PI), 0, 0]));

    for (const leg of legs) {
      tracks.push(sampleTrackEuler(leg.hip.b.name, dur, S, (u) => {
        if (u < 0.25) return [0.46 * (1 - 0.2 * u), 0, leg.side * 0.08];
        const w = (u - 0.25) / 0.75;
        return [0.36 * (1 - w * w * (3 - 2 * w)), 0, leg.side * 0.04 * (1 - w)];
      }));
      tracks.push(sampleTrackEuler(leg.knee.b.name, dur, S, (u) => {
        if (u < 0.22) return [-0.15, 0, 0];
        const w = (u - 0.22) / 0.78;
        return [-(0.65 * Math.sin(Math.pow(w, 0.65) * Math.PI) + 0.06), 0, 0];
      }));
    }
    clips.push(new THREE.AnimationClip('land', dur, tracks));
  }

  return clips;
}

// ---------------------------------------------------------------------------------------------
// GLB Adapter: normalizes any rigged Catbus GLB (or the placeholder) into a unified rig object
// ---------------------------------------------------------------------------------------------
const ALIASES = {
  walk: [/^walk$/i, /\bwalk/i, /\btrot/i, /\bstroll/i],
  sprint: [/^sprint$/i, /\bsprint/i, /\brun\b/i, /\bgallop/i, /\bdash/i],
  fly: [/^fly$/i, /\bfly/i, /\bflight/i, /\bglide/i, /\bsoar/i],
  takeoff: [/^takeoff$/i, /take[_ -]?off/i, /\blaunch/i, /\bjump/i, /\bleap/i],
  land: [/^land$/i, /\bland/i, /touch[_ -]?down/i, /\bsettle/i],
};

function resolveClips(animations = [], stripRoot = true, rootBoneNames = new Set()) {
  const map = {};
  for (const key of CLIP_NAMES) {
    let found = null;
    for (const re of ALIASES[key]) {
      found = animations.find((c) => re.test(c.name));
      if (found) break;
    }
    if (found) {
      map[key] = stripRoot ? cleanRootMotion(found, rootBoneNames) : found;
    }
  }
  // Sensible fallbacks if an external GLB omits one of the 5 clips
  if (!map.sprint && map.walk) map.sprint = map.walk;
  if (!map.walk && map.sprint) map.walk = map.sprint;
  if (!map.fly && map.sprint) map.fly = map.sprint;
  return map;
}

/**
 * Remove horizontal (X/Z) root-bone drift from an AnimationClip so world-space movement never
 * double-translates or snaps at loop boundaries, while keeping vertical Y bounce intact.
 */
export function cleanRootMotion(clip, rootBoneNames) {
  const tracks = clip.tracks.map((tr) => {
    if (!tr.name.endsWith('.position')) return tr;
    const nodeName = tr.name.slice(0, -'.position'.length);
    const isRoot = rootBoneNames.has(nodeName) || /^(root|hips|pelvis|armature|body|cog|center)$/i.test(nodeName);
    if (!isRoot) return tr;
    const v = tr.values.slice();
    const x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) {
      v[i] = x0;
      v[i + 2] = z0;
    }
    const Cls = tr.constructor;
    return new Cls(tr.name, tr.times.slice(), v, tr.getInterpolation());
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
}

const NON_FUR_NAME = /window|glass|pane|frame|mullion|wood|lantern|lamp|light|rail|rack|bell|eye|pupil|glint|whisker|tooth|claw|collar|brass|metal/i;

/**
 * Patch a GLB MeshStandardMaterial that carries `_cat` = (furMask, glowMask, secA, secB):
 *   - 'body'    : warm golden interior bloom on cabin windows & subtle root shading under fur
 *   - 'lantern' : dual rigid 2-axis pendulum swing around left/right bracket hooks + warm glass glow
 *   - 'rail'    : elastic roof-rail sway & bell jingle anchored at the roof posts
 */
function patchCatbusMaterial(baseMat, kind, secUniforms) {
  const mat = baseMat.clone();
  mat.envMapIntensity = 1.05;
  if (mat.map) mat.map.anisotropy = 8;
  if (mat.normalMap) mat.normalMap.anisotropy = 8;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, secUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`#include <common>
        attribute vec4 _cat;
        varying vec2 vCatGlowFur;
        uniform float uCatTime;
        uniform vec3 uLanternPivotL;
        uniform vec3 uLanternPivotR;
        uniform vec2 uLanternRotL;
        uniform vec2 uLanternRotR;
        uniform vec3 uRailSway;
      `)
      .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
        vCatGlowFur = _cat.rg;
        ${kind === 'lantern' ? /* glsl */`
        {
          // Swing left (_cat.b) and right (_cat.a) hanging lanterns around their bracket hooks in bind space
          // before skinning carries them with spine/neck/head
          float wL = _cat.b, wR = _cat.a;
          if (wL > 0.01) {
            vec3 lp = transformed - uLanternPivotL;
            float cx = cos(uLanternRotL.x), sx = sin(uLanternRotL.x);
            float cz = cos(uLanternRotL.y), sz = sin(uLanternRotL.y);
            lp = vec3(lp.x * cz - lp.y * sz, lp.x * sz + lp.y * cz, lp.z);
            lp = vec3(lp.x, lp.y * cx - lp.z * sx, lp.y * sx + lp.z * cx);
            transformed = mix(transformed, uLanternPivotL + lp, wL);
          }
          if (wR > 0.01) {
            vec3 rp = transformed - uLanternPivotR;
            float cx = cos(uLanternRotR.x), sx = sin(uLanternRotR.x);
            float cz = cos(uLanternRotR.y), sz = sin(uLanternRotR.y);
            rp = vec3(rp.x * cz - rp.y * sz, rp.x * sz + rp.y * cz, rp.z);
            rp = vec3(rp.x, rp.y * cx - rp.z * sx, rp.y * sx + rp.z * cx);
            transformed = mix(transformed, uLanternPivotR + rp, wR);
          }
        }
        ` : kind === 'rail' ? /* glsl */`
        {
          float rw = _cat.b;
          if (rw > 0.01) {
            float jingle = sin(uCatTime * 15.0 + position.z * 7.5 + position.x * 5.0) * uRailSway.z;
            transformed.x += (uRailSway.x + jingle * 0.014) * rw;
            transformed.z += (uRailSway.y + cos(uCatTime * 12.3 + position.x * 9.0) * uRailSway.z * 0.010) * rw;
          }
        }
        ` : ''}
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        varying vec2 vCatGlowFur;
      `)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
        // Subtle undercoat root shading where fur shells sit above the skin
        diffuseColor.rgb *= mix(1.0, 0.84, vCatGlowFur.x);
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
        // Warm golden stagecoach cabin windows & glowing brass lanterns (blooms softly above 0.85)
        totalEmissiveRadiance += diffuseColor.rgb * vec3(2.55, 1.62, 0.58) * vCatGlowFur.y;
      `);
  };
  mat.customProgramCacheKey = () => `catbus-std-${kind}`;
  mat.needsUpdate = true;
  return mat;
}

export function prepareCatbusAsset(gltf, info = {}, isPlaceholder = false) {
  const root = new THREE.Group();
  root.name = 'catbus_rig';
  const model = gltf.scene;
  root.add(model);

  if (typeof info.yawOffset === 'number') {
    model.rotation.y += (info.yawOffset * Math.PI) / 180;
  }

  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const rawLength = Math.max(size.z, size.x, 0.01);
  const targetLength = info.length ?? 5.5;
  const scale = typeof info.scale === 'number'
    ? info.scale
    : isPlaceholder ? 1.0 : targetLength / rawLength;

  if (scale !== 1.0) {
    model.scale.multiplyScalar(scale);
    model.updateMatrixWorld(true);
    box.setFromObject(model);
    box.getSize(size);
  }

  if (!isPlaceholder) {
    const cx = 0.5 * (box.min.x + box.max.x);
    const cz = 0.5 * (box.min.z + box.max.z);
    model.position.x -= cx;
    model.position.y -= box.min.y;
    model.position.z -= cz;
    model.updateMatrixWorld(true);
    box.setFromObject(model);
  }

  const secUniforms = {
    uCatTime: { value: 0 },
    uLanternPivotL: { value: new THREE.Vector3().fromArray(info.lanternPivotL || [0.764, 1.507, 1.200]) },
    uLanternPivotR: { value: new THREE.Vector3().fromArray(info.lanternPivotR || [-0.752, 1.489, 1.446]) },
    uLanternRotL: { value: new THREE.Vector2() },
    uLanternRotR: { value: new THREE.Vector2() },
    uRailSway: { value: new THREE.Vector3() },
  };

  const rootBoneNames = new Set();
  const furryMeshes = [];
  const allMeshes = [];
  let bodyMesh = null;
  let bodyLod1 = null;
  let furHullMesh = null;
  let lanternPivot = null;
  let railGroup = null;
  const bellPivots = [];
  let sunVisUniform = null;

  model.traverse((o) => {
    if (o.isBone && (!o.parent || !o.parent.isBone)) {
      rootBoneNames.add(o.name);
    }
    if (o.name === 'lantern_pivot') lanternPivot = o;
    if (o.name === 'roof_rail') railGroup = o;
    if (/^bell_pivot/i.test(o.name) && o.isObject3D && !o.isMesh) {
      bellPivots.push({ group: o, phase: bellPivots.length * 1.3 });
    }
    if (!o.isMesh) return;

    const nm = o.name || '';
    o.frustumCulled = false;

    if (nm === 'catbus_fur_hull') {
      furHullMesh = o;
      o.visible = false;
      o.castShadow = false;
      o.receiveShadow = false;
      o.userData.templateHull = true;
      return;
    }

    if (nm === 'catbus_body_lod1') {
      bodyLod1 = o;
      o.visible = false;
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.geometry.attributes._cat && o.material?.isMeshStandardMaterial) {
        o.material = patchCatbusMaterial(o.material, 'body', secUniforms);
      }
      return;
    }

    allMeshes.push(o);
    o.castShadow = true;
    o.receiveShadow = true;

    if (nm === 'catbus_body') bodyMesh = o;

    if (o.geometry.attributes._cat && o.material?.isMeshStandardMaterial) {
      const kind = /lantern/i.test(nm) ? 'lantern' : /rail/i.test(nm) ? 'rail' : 'body';
      o.material = patchCatbusMaterial(o.material, kind, secUniforms);
    } else {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.uniforms && m.uniforms.uSunVis) sunVisUniform = m.uniforms.uSunVis;
        if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
          m.envMapIntensity = 1.05;
          if (m.map) m.map.anisotropy = 8;
          if (m.normalMap) m.normalMap.anisotropy = 8;
        }
      }
    }

    const mat0 = Array.isArray(o.material) ? o.material[0] : o.material;
    const isNonFur = NON_FUR_NAME.test(nm)
      || NON_FUR_NAME.test(mat0?.name || '')
      || (mat0 && (mat0.transparent || (mat0.metalness ?? 0) > 0.45));

    if (o.userData.furry === true || (!isPlaceholder && !isNonFur)) {
      furryMeshes.push(o);
    }
  });

  // Prefer the dedicated watertight 15k-tri fur hull when present!
  const furTargets = furHullMesh ? [furHullMesh] : furryMeshes;
  if (!furTargets.length && allMeshes.length) furTargets.push(allMeshes[0]);

  const worldScale = new THREE.Vector3();
  furTargets[0].getWorldScale(worldScale);
  const restScale = Math.max(worldScale.x, worldScale.y, worldScale.z, 1e-3);

  const fur = new FurCoat(furTargets, {
    length: (info.furLength ?? 0.082) / restScale,
    density: info.furDensity ?? 48.0,
    restScale,
    proceduralCoat: isPlaceholder,
    materialSource: bodyMesh ? bodyMesh.material : null,
  });

  const clips = resolveClips(gltf.animations || [], info.stripRootMotion !== false, rootBoneNames);

  let _savedBodyVis = true;
  let _savedLodVis = false;
  let _savedFurVis = null;
  return {
    root,
    model,
    clips,
    fur,
    lanternPivot,
    railGroup,
    bellPivots,
    secUniforms,
    sunVisUniform,
    bounds: box,
    size,
    isPlaceholder,
    updateLOD(camDist) {
      if (bodyMesh && bodyLod1) {
        const useLod1 = camDist >= 36;
        bodyMesh.visible = !useLod1;
        bodyLod1.visible = useLod1;
      }
    },
    setShadowMode(on) {
      if (on) {
        _savedFurVis = fur.shells.map((s) => s.mesh.visible);
        for (const s of fur.shells) s.mesh.visible = false;
        if (bodyMesh && bodyLod1) {
          _savedBodyVis = bodyMesh.visible;
          _savedLodVis = bodyLod1.visible;
          bodyMesh.visible = false;
          bodyLod1.visible = true;
        }
      } else {
        if (_savedFurVis) {
          fur.shells.forEach((s, i) => { s.mesh.visible = _savedFurVis[i]; });
          _savedFurVis = null;
        }
        if (bodyMesh && bodyLod1) {
          bodyMesh.visible = _savedBodyVis;
          bodyLod1.visible = _savedLodVis;
        }
      }
    },
  };
}
