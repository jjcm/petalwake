#!/usr/bin/env python3
"""Process raw catbus.glb into Petalwake's runtime assets/models/catbus.{glb,json}.

Enhancements applied:
  1. Textures: despikes isolated bright UV-seam specks on Color (2048 WebP q88) and downsizes
     Normal + ORM to 1024 WebP q88 (MIME image/webp).
  2. Vertex attribute `_CAT` (normalized uint8 VEC4):
       r = fur mask (1 on ginger/cream coat, tapered on muzzle/paws, 0 on windows/frames/eyes/metal)
       g = HDR warm emissive mask (cabin window panes & brass lantern glass)
       b = left lantern pendulum weight (on catbus_lantern) / roof-rail sway weight (on catbus_roof_rail)
       a = right lantern pendulum weight (on catbus_lantern)
     Separates the two lantern brackets (weight 0) from the two hanging lantern bodies (weight 1)
     via connected components so brackets stay bolted to the body while lanterns swing freely.
  3. Watertight decimated fur-shell hull (`catbus_fur_hull`, ~11k tris, furry surfaces only,
     smooth welded normals across UV seams so shell extrusion never cracks) + decimated shadow/far
     LOD mesh (`catbus_lod`, ~13k tris).
  4. Animation cleanup & retiming (walk, sprint, fly, takeoff, land):
       - strips horizontal root (spine XZ) drift
       - removes studio capture vertical hover offset on fly/takeoff/land so world physics owns Y
       - clamps paw floor penetration on walk, sprint, takeoff crouch, and land impact squat
       - smooths minor two-view solve jitter in walk and closes loop seams on walk/sprint/fly
       - trims dead hover/settle tails on takeoff (~0.68s) and land (~0.60s)
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = "/cursor/stores/bot/petalwake-catbus-3d/catbus.glb"
DEFAULT_DST = os.path.join(ROOT, "assets", "models", "catbus.glb")

CT_DTYPE = {
    5120: np.int8,
    5121: np.uint8,
    5122: np.int16,
    5123: np.uint16,
    5125: np.uint32,
    5126: np.float32,
}
TYPE_CNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def smoothstep(edge0, edge1, x):
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def decode_jpeg(raw_bytes, w=2048, h=2048):
    out = subprocess.check_output(
        ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        input=raw_bytes,
    )
    return np.frombuffer(out, dtype=np.uint8).reshape(h, w, 3).copy()


def encode_webp(rgb_u8, target_size=None, quality=88):
    h, w, _ = rgb_u8.shape
    with tempfile.NamedTemporaryFile(suffix=".webp", delete=False) as tf:
        tmp_path = tf.name
    try:
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-i", "pipe:0",
        ]
        if target_size and (target_size != w or target_size != h):
            cmd += ["-vf", f"scale={target_size}:{target_size}:flags=lanczos"]
        cmd += ["-c:v", "libwebp", "-quality", str(quality), tmp_path]
        subprocess.run(cmd, input=rgb_u8.tobytes(), check=True)
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def despike_color(col_u8, orm_u8):
    """Clamp isolated single-texel bright seam specks on rough fur areas without touching windows/eyes."""
    col = col_u8.astype(np.float32)
    rough = orm_u8[:, :, 1].astype(np.float32) / 255.0
    luma = 0.2126 * col[:, :, 0] + 0.7152 * col[:, :, 1] + 0.0722 * col[:, :, 2]
    # 3x3 neighborhood average excluding center
    pad = np.pad(col, ((1, 1), (1, 1), (0, 0)), mode="edge")
    nb = (
        pad[:-2, :-2] + pad[:-2, 1:-1] + pad[:-2, 2:]
        + pad[1:-1, :-2] + pad[1:-1, 2:]
        + pad[2:, :-2] + pad[2:, 1:-1] + pad[2:, 2:]
    ) / 8.0
    nb_luma = 0.2126 * nb[:, :, 0] + 0.7152 * nb[:, :, 1] + 0.0722 * nb[:, :, 2]
    speck = (rough > 0.72) & ((luma - nb_luma) > 48.0)
    out = col_u8.copy()
    out[speck] = np.clip(np.round(nb[speck]), 0, 255).astype(np.uint8)
    return out, int(speck.sum())


def connected_components(pos, indices):
    n = len(pos)
    parent = np.arange(n, dtype=np.int32)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(int(a)), find(int(b))
        if ra != rb:
            parent[ra] = rb

    q = np.round(pos * 1000.0).astype(np.int64)
    _, inv = np.unique(q, axis=0, return_inverse=True)
    first = {}
    for vi, qi in enumerate(inv):
        qi = int(qi)
        if qi in first:
            union(vi, first[qi])
        else:
            first[qi] = vi
    for a, b, c in indices.reshape(-1, 3):
        union(a, b)
        union(b, c)
    comps = {}
    for vi in range(n):
        comps.setdefault(find(vi), []).append(vi)
    return list(comps.values())


def cluster_decimate(pos, nrm, uv, joints, weights, cat_attr, tri_indices, cell_size, only_furry=False):
    """Spatial vertex-clustering decimator that welds normals across UV seams (watertight shells!)
    while taking UV / skinning / _CAT from the nearest original vertex to each cluster centroid."""
    tris = tri_indices.reshape(-1, 3)
    if only_furry:
        tri_fur = cat_attr[tris, 0].mean(axis=1)
        tris = tris[tri_fur > 64]  # > 0.25 fur mask

    used_v = np.unique(tris)
    remap_in = np.full(len(pos), -1, dtype=np.int32)
    remap_in[used_v] = np.arange(len(used_v), dtype=np.int32)

    p = pos[used_v]
    n = nrm[used_v]
    t_uv = uv[used_v]
    j = joints[used_v]
    w = weights[used_v]
    ca = cat_attr[used_v]
    tris_local = remap_in[tris]

    # Quantize to spatial cells
    mins = p.min(axis=0)
    grid = np.floor((p - mins) / cell_size).astype(np.int64)
    _, inv, counts = np.unique(grid, axis=0, return_inverse=True, return_counts=True)
    k = int(counts.shape[0])

    # Average position and normal per cell (welded smooth normal!)
    new_pos = np.zeros((k, 3), dtype=np.float64)
    new_nrm = np.zeros((k, 3), dtype=np.float64)
    np.add.at(new_pos, inv, p)
    new_pos /= counts[:, None]

    # Weight normals by face area for smooth, crack-free shell extrusion
    v0, v1, v2 = p[tris_local[:, 0]], p[tris_local[:, 1]], p[tris_local[:, 2]]
    fn = np.cross(v1 - v0, v2 - v0)
    np.add.at(new_nrm, inv[tris_local[:, 0]], fn)
    np.add.at(new_nrm, inv[tris_local[:, 1]], fn)
    np.add.at(new_nrm, inv[tris_local[:, 2]], fn)
    nlen = np.linalg.norm(new_nrm, axis=1, keepdims=True)
    fallback = nlen[:, 0] < 1e-8
    if fallback.any():
        tmp_n = np.zeros((k, 3), dtype=np.float64)
        np.add.at(tmp_n, inv, n)
        new_nrm[fallback] = tmp_n[fallback]
        nlen = np.linalg.norm(new_nrm, axis=1, keepdims=True)
    new_nrm /= np.maximum(nlen, 1e-8)

    # Pick representative original vertex closest to each cell's centroid for crisp UV & skinning
    dist2 = np.sum((p - new_pos[inv]) ** 2, axis=1)
    order = np.argsort(dist2)
    rep = np.empty(k, dtype=np.int32)
    # Assign in reverse so smallest dist2 overwrites last
    rep[inv[order[::-1]]] = order[::-1]

    new_uv = t_uv[rep]
    new_joints = j[rep]
    new_weights = w[rep]
    wsum = new_weights.sum(axis=1, keepdims=True)
    new_weights = new_weights / np.maximum(wsum, 1e-6)
    new_cat = ca[rep]

    # Map triangles and drop degenerate / duplicate ones
    mapped = inv[tris_local]
    non_deg = (mapped[:, 0] != mapped[:, 1]) & (mapped[:, 1] != mapped[:, 2]) & (mapped[:, 2] != mapped[:, 0])
    mapped = mapped[non_deg]

    # Compact to vertices referenced by surviving triangles
    alive = np.unique(mapped)
    compact = np.full(k, -1, dtype=np.int32)
    compact[alive] = np.arange(len(alive), dtype=np.int32)
    final_tris = compact[mapped].astype(np.uint32 if len(alive) > 65535 else np.uint16)

    return (
        new_pos[alive].astype(np.float32),
        new_nrm[alive].astype(np.float32),
        new_uv[alive].astype(np.float32),
        new_joints[alive].astype(joints.dtype),
        new_weights[alive].astype(np.float32),
        new_cat[alive].astype(np.uint8),
        final_tris,
    )


def quat_nlerp(q0, q1, u):
    if np.dot(q0, q1) < 0.0:
        q1 = -q1
    q = q0 * (1.0 - u) + q1 * u
    return q / np.maximum(np.linalg.norm(q), 1e-8)


def quat_smooth_3tap(qs):
    out = qs.copy()
    # Ensure hemisphere continuity along track first
    for i in range(1, len(out)):
        if np.dot(out[i - 1], out[i]) < 0.0:
            out[i] = -out[i]
    sm = out.copy()
    for i in range(1, len(out) - 1):
        v = 0.20 * out[i - 1] + 0.60 * out[i] + 0.20 * out[i + 1]
        sm[i] = v / np.maximum(np.linalg.norm(v), 1e-8)
    return sm


def quat_to_mat(q):
    q = q / np.maximum(np.linalg.norm(q), 1e-8)
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], dtype=np.float64)


def process(src_path=DEFAULT_SRC, dst_path=DEFAULT_DST):
    raw = open(src_path, "rb").read()
    jlen = struct.unpack("<I", raw[12:16])[0]
    gltf = json.loads(raw[20:20 + jlen])
    bin0 = 20 + jlen + 8
    blob = raw[bin0:]

    def get_acc(idx):
        a = gltf["accessors"][idx]
        bv = gltf["bufferViews"][a["bufferView"]]
        off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        n = TYPE_CNT[a["type"]]
        dt = np.dtype(CT_DTYPE[a["componentType"]])
        stride = bv.get("byteStride", 0)
        if stride and stride != dt.itemsize * n:
            r = np.frombuffer(blob, np.uint8, count=stride * a["count"], offset=off).reshape(a["count"], stride)
            return r[:, :dt.itemsize * n].copy().view(dt).reshape(a["count"], n)
        return np.frombuffer(blob, dt, count=a["count"] * n, offset=off).reshape(a["count"], n).copy()

    # ---- 1. Decode & optimize textures
    print("Decoding and optimizing textures...")
    img_bvs = [gltf["bufferViews"][im["bufferView"]] for im in gltf["images"]]
    nrm_u8 = decode_jpeg(blob[img_bvs[0].get("byteOffset", 0):img_bvs[0].get("byteOffset", 0) + img_bvs[0]["byteLength"]])
    col_u8 = decode_jpeg(blob[img_bvs[1].get("byteOffset", 0):img_bvs[1].get("byteOffset", 0) + img_bvs[1]["byteLength"]])
    orm_u8 = decode_jpeg(blob[img_bvs[2].get("byteOffset", 0):img_bvs[2].get("byteOffset", 0) + img_bvs[2]["byteLength"]])

    col_clean, n_specks = despike_color(col_u8, orm_u8)
    print(f"  Despiked {n_specks} bright seam texels on Color map")

    webp_nrm = encode_webp(nrm_u8, target_size=1024, quality=88)
    webp_col = encode_webp(col_clean, target_size=2048, quality=88)
    webp_orm = encode_webp(orm_u8, target_size=1024, quality=88)
    print(f"  Encoded WebP: Color={len(webp_col)//1024}KB (2048), Normal={len(webp_nrm)//1024}KB (1024), ORM={len(webp_orm)//1024}KB (1024)")

    col_f = col_clean.astype(np.float32) / 255.0
    orm_f = orm_u8.astype(np.float32) / 255.0

    # ---- 2. Compute _CAT vertex attributes & secondary-motion pivots
    meshes_data = []
    for mi in range(3):
        pr = gltf["meshes"][mi]["primitives"][0]
        at = pr["attributes"]
        pos = get_acc(at["POSITION"]).astype(np.float32)
        nrm = get_acc(at["NORMAL"]).astype(np.float32)
        uv = get_acc(at["TEXCOORD_0"]).astype(np.float32)
        jts = get_acc(at["JOINTS_0"])
        wts = get_acc(at["WEIGHTS_0"]).astype(np.float32)
        idx = get_acc(pr["indices"]).reshape(-1)
        meshes_data.append({"pos": pos, "nrm": nrm, "uv": uv, "jts": jts, "wts": wts, "idx": idx})

    # 2a. catbus_body (mi=0): furMask in R, window/eye glow in G
    m0 = meshes_data[0]
    ix = np.clip((m0["uv"][:, 0] % 1.0) * 2048, 0, 2047).astype(int)
    iy = np.clip((m0["uv"][:, 1] % 1.0) * 2048, 0, 2047).astype(int)
    c0 = col_f[iy, ix]
    o0 = orm_f[iy, ix]

    fur0 = smoothstep(0.50, 0.78, o0[:, 1])
    # Shorter sleek fur on nose/muzzle front (z > 2.02) and paw soles (y < 0.09)
    muzzle_k = smoothstep(2.00, 2.22, m0["pos"][:, 2])
    fur0 *= 1.0 - 0.55 * muzzle_k
    sole_k = smoothstep(0.10, 0.02, m0["pos"][:, 1])
    fur0 *= 1.0 - 0.55 * sole_k

    # Smooth fur0 slightly over 2 mesh-edge rings so window borders transition cleanly
    tris0 = m0["idx"].reshape(-1, 3)
    edges = np.concatenate([tris0[:, [0, 1]], tris0[:, [1, 2]], tris0[:, [2, 0]]], axis=0)
    deg = np.zeros(len(fur0), dtype=np.float32)
    np.add.at(deg, edges[:, 0], 1)
    np.add.at(deg, edges[:, 1], 1)
    fur_hard_zero = o0[:, 1] < 0.46
    for _ in range(2):
        acc_f = np.zeros_like(fur0)
        np.add.at(acc_f, edges[:, 0], fur0[edges[:, 1]])
        np.add.at(acc_f, edges[:, 1], fur0[edges[:, 0]])
        fur0 = 0.5 * fur0 + 0.5 * (acc_f / np.maximum(deg, 1.0))
        fur0[fur_hard_zero] = 0.0

    # Cabin windows: glossy (rough < 0.55) + warm golden colour
    in_cabin = m0["pos"][:, 2] < 1.38
    win_glow = smoothstep(0.55, 0.30, o0[:, 1]) * smoothstep(0.52, 0.80, c0[:, 0]) * smoothstep(0.38, 0.65, c0[:, 1]) * in_cabin
    eye_glow = smoothstep(0.55, 0.25, o0[:, 1]) * smoothstep(0.55, 0.82, c0[:, 0]) * (1.0 - in_cabin) * 0.38
    glow0 = np.clip(np.maximum(win_glow, eye_glow), 0.0, 1.0)

    cat0 = np.zeros((len(fur0), 4), dtype=np.uint8)
    cat0[:, 0] = np.round(np.clip(fur0, 0.0, 1.0) * 255).astype(np.uint8)
    cat0[:, 1] = np.round(glow0 * 255).astype(np.uint8)
    m0["cat"] = cat0

    # 2b. catbus_lantern (mi=1): separate brackets (static) from hanging lantern bodies (L in B, R in A)
    m1 = meshes_data[1]
    ix1 = np.clip((m1["uv"][:, 0] % 1.0) * 2048, 0, 2047).astype(int)
    iy1 = np.clip((m1["uv"][:, 1] % 1.0) * 2048, 0, 2047).astype(int)
    c1 = col_f[iy1, ix1]
    cat1 = np.zeros((len(m1["pos"]), 4), dtype=np.uint8)
    glow1 = smoothstep(0.58, 0.82, c1[:, 0]) * smoothstep(0.45, 0.72, c1[:, 1]) * smoothstep(0.15, 0.40, c1[:, 0] - c1[:, 2] * 0.5)
    cat1[:, 1] = np.round(np.clip(glow1, 0.0, 1.0) * 255).astype(np.uint8)

    comps1 = connected_components(m1["pos"], m1["idx"])
    pivot_L = [0.755, 1.505, 1.199]
    pivot_R = [-0.755, 1.490, 1.445]
    for vis in comps1:
        pts = m1["pos"][vis]
        # The two larger components reaching down to y ~ 1.14 are the hanging lantern bodies;
        # the two upper components (min_y > 1.45) are the brackets mounted to the body!
        if pts[:, 1].min() < 1.30:
            top_band = pts[pts[:, 1] > pts[:, 1].max() - 0.04]
            piv = [float(top_band[:, 0].mean()), float(pts[:, 1].max()), float(top_band[:, 2].mean())]
            if pts[:, 0].mean() >= 0:
                cat1[vis, 2] = 255
                pivot_L = piv
            else:
                cat1[vis, 3] = 255
                pivot_R = piv
    m1["cat"] = cat1
    print(f"  Lantern pivots (glTF space): L={[round(v, 3) for v in pivot_L]}, R={[round(v, 3) for v in pivot_R]}")

    # 2c. catbus_roof_rail (mi=2): elastic rail & bell sway in B
    m2 = meshes_data[2]
    cat2 = np.zeros((len(m2["pos"]), 4), dtype=np.uint8)
    rail_sway = smoothstep(1.91, 2.16, m2["pos"][:, 1])
    cat2[:, 2] = np.round(rail_sway * 255).astype(np.uint8)
    m2["cat"] = cat2

    # ---- 3. Build watertight decimated fur hull (~10k tris) & shadow/far LOD mesh (~10k tris)
    print("Building watertight fur hull & shadow/far LOD mesh...")
    fh_pos, fh_nrm, fh_uv, fh_jts, fh_wts, fh_cat, fh_idx = cluster_decimate(
        m0["pos"], m0["nrm"], m0["uv"], m0["jts"], m0["wts"], m0["cat"], m0["idx"],
        cell_size=0.068, only_furry=True,
    )
    lod_pos, lod_nrm, lod_uv, lod_jts, lod_wts, lod_cat, lod_idx = cluster_decimate(
        m0["pos"], m0["nrm"], m0["uv"], m0["jts"], m0["wts"], m0["cat"], m0["idx"],
        cell_size=0.072, only_furry=False,
    )
    print(f"  catbus_fur_hull : {len(fh_pos)} verts, {len(fh_idx)} tris (down from 73,948)")
    print(f"  catbus_body_lod1: {len(lod_pos)} verts, {len(lod_idx)} tris")

    # ---- 4. Clean, floor-clamp, loop-close, and retime the 5 animations
    print("Cleaning and retiming animations...")
    nodes = gltf["nodes"]
    skin = gltf["skins"][0]
    joints = skin["joints"]
    spine_ni = joints[0]
    paw_nis = [ni for ni in joints if "paw" in nodes[ni].get("name", "")]
    parent_map = {c: ni for ni, n in enumerate(nodes) for c in n.get("children", [])}

    def unpack_anim(anim):
        # Resample every animated channel onto uniform 24fps frames 0..N-1
        dur = max(float(get_acc(s["input"]).reshape(-1)[-1]) for s in anim["samplers"])
        n_f = int(round(dur * 24)) + 1
        ts = np.linspace(0.0, dur, n_f, dtype=np.float32)
        tracks = {}
        for ch in anim["channels"]:
            ni = ch["target"]["node"]
            pk = ch["target"]["path"]
            s = anim["samplers"][ch["sampler"]]
            ta = get_acc(s["input"]).reshape(-1)
            va = get_acc(s["output"]).astype(np.float64)
            out = np.zeros((n_f, va.shape[1]), dtype=np.float64)
            for fi, t in enumerate(ts):
                k = int(np.clip(np.searchsorted(ta, t, side="right") - 1, 0, len(ta) - 1))
                if k >= len(ta) - 1:
                    out[fi] = va[-1]
                else:
                    dt_k = ta[k + 1] - ta[k]
                    u = (t - ta[k]) / dt_k if dt_k > 1e-8 else 0.0
                    if pk == "rotation":
                        out[fi] = quat_nlerp(va[k], va[k + 1], u)
                    else:
                        out[fi] = va[k] * (1.0 - u) + va[k + 1] * u
            tracks[(ni, pk)] = out
        return n_f, tracks

    def min_sole_per_frame(n_f, tracks):
        res = np.zeros(n_f, dtype=np.float64)
        for fi in range(n_f):
            memo = {}

            def wmat(ni):
                if ni in memo:
                    return memo[ni]
                nd = nodes[ni]
                tv = tracks[(ni, "translation")][fi] if (ni, "translation") in tracks else np.asarray(nd.get("translation", [0, 0, 0]), np.float64)
                qv = tracks[(ni, "rotation")][fi] if (ni, "rotation") in tracks else np.asarray(nd.get("rotation", [0, 0, 0, 1]), np.float64)
                sv = tracks[(ni, "scale")][fi] if (ni, "scale") in tracks else np.asarray(nd.get("scale", [1, 1, 1]), np.float64)
                M = np.eye(4)
                M[:3, :3] = quat_to_mat(qv) * sv
                M[:3, 3] = tv
                p = parent_map.get(ni)
                if p is not None and p != 46:
                    M = wmat(p) @ M
                memo[ni] = M
                return M

            res[fi] = min(wmat(pni)[1, 3] for pni in paw_nis) - 0.20
        return res

    def close_loop(tracks, n_f, blend_frames):
        """Smoothly blend the end of a cycle toward frame 0 and append explicit closure frame = frame 0."""
        closed = {}
        for (ni, pk), arr in tracks.items():
            a = arr.copy()
            for b in range(blend_frames):
                fi = n_f - blend_frames + b
                u = (b + 1) / (blend_frames + 1)
                u = u * u * (3.0 - 2.0 * u)
                if pk == "rotation":
                    a[fi] = quat_nlerp(a[fi], a[0], u)
                else:
                    a[fi] = a[fi] * (1.0 - u) + a[0] * u
            closed[(ni, pk)] = np.concatenate([a, a[0:1]], axis=0)
        return n_f + 1, closed

    cleaned_anims = {}
    for anim in gltf["animations"]:
        name = anim["name"]
        n_f, tr = unpack_anim(anim)

        # Strip horizontal root motion (spine X & Z = 0) on every clip
        if (spine_ni, "translation") in tr:
            tr[(spine_ni, "translation")][:, 0] = 0.0
            tr[(spine_ni, "translation")][:, 2] = 0.0

        if name == "walk":
            # Gentle 3-tap temporal smoothing on rotations to calm 2-view solve micro-jitter
            for (ni, pk) in list(tr.keys()):
                if pk == "rotation":
                    tr[(ni, pk)] = quat_smooth_3tap(tr[(ni, pk)])
            soles = min_sole_per_frame(n_f, tr)
            lift = np.maximum(0.0, -soles)
            # Smooth lift curve so vertical motion stays fluid
            lift = np.convolve(np.pad(lift, 2, mode="wrap"), [0.15, 0.2, 0.3, 0.2, 0.15], mode="valid")
            tr[(spine_ni, "translation")][:, 1] += lift
            n_f, tr = close_loop(tr, n_f, blend_frames=8)
            dur_out = (n_f - 1) / 24.0

        elif name == "sprint":
            soles = min_sole_per_frame(n_f, tr)
            lift = np.maximum(0.0, -soles)
            tr[(spine_ni, "translation")][:, 1] += lift
            n_f, tr = close_loop(tr, n_f, blend_frames=3)
            dur_out = (n_f - 1) / 24.0

        elif name == "fly":
            # Remove studio capture +0.685m hover height so airborne origin matches ground rig origin
            sy = tr[(spine_ni, "translation")][:, 1]
            tr[(spine_ni, "translation")][:, 1] = sy - (sy.mean() - 1.45)
            n_f, tr = close_loop(tr, n_f, blend_frames=6)
            dur_out = (n_f - 1) / 24.0

        elif name == "takeoff":
            # Trim frames 6..43 (crouch -> explosive lift -> airborne tuck), discarding 3s hover tail
            f0, f1 = 6, 44
            for k in list(tr.keys()):
                tr[k] = tr[k][f0:f1].copy()
            n_f = f1 - f0
            soles = min_sole_per_frame(n_f, tr)
            sy = tr[(spine_ni, "translation")][:, 1]
            # Ground phase (crouch & push): keep paws on/above y=0;
            # Airborne phase: remove studio climb so end spine.y == 1.45 (matches fly!)
            for fi in range(n_f):
                air_k = float(smoothstep(14, n_f - 1, fi))
                ground_y = sy[fi] + max(0.0, -soles[fi])
                blended = ground_y * (1.0 - air_k) + 1.45 * air_k
                # Never let extending push-off paws dip below y=0
                min_allowed = sy[fi] - soles[fi]
                sy[fi] = max(blended, min_allowed) if fi < 24 else blended
            dur_out = 0.68

        elif name == "land":
            # Take airborne reach + impact (frames 8..30) and blend smoothly into clean settled pose (frames 68..74)
            seg_a = {k: v[8:30].copy() for k, v in tr.items()}
            seg_b = {k: v[68:75].copy() for k, v in tr.items()}
            # Smoothly bridge the 6-frame transition between seg_a[-1] and seg_b[0]
            n_a, n_b = 22, 7
            merged = {}
            for k in tr.keys():
                pk = k[1]
                a, b = seg_a[k], seg_b[k]
                for bi in range(6):
                    idx_a = n_a - 6 + bi
                    u = (bi + 1) / 7.0
                    u = u * u * (3.0 - 2.0 * u)
                    if pk == "rotation":
                        a[idx_a] = quat_nlerp(a[idx_a], b[0], u)
                    else:
                        a[idx_a] = a[idx_a] * (1.0 - u) + b[0] * u
                merged[k] = np.concatenate([a, b], axis=0)
            tr = merged
            n_f = n_a + n_b

            # Remove +0.60m studio hover on initial airborne frames, soften deep squat, and clamp floor!
            sy = tr[(spine_ni, "translation")][:, 1]
            sy0 = float(sy[0])
            for fi in range(n_f):
                hover_rem = (1.0 - float(smoothstep(0, 9, fi))) * (sy0 - 1.48)
                sy[fi] -= hover_rem
                if sy[fi] < 1.44:
                    sy[fi] = 1.44 - (1.44 - sy[fi]) * 0.52
            soles = min_sole_per_frame(n_f, tr)
            for fi in range(n_f):
                if soles[fi] < 0.0:
                    sy[fi] += -soles[fi]
            dur_out = 0.60
        else:
            dur_out = (n_f - 1) / 24.0

        soles_after = min_sole_per_frame(n_f, tr)
        sy_after = tr[(spine_ni, "translation")][:, 1]
        print(f"  {name:8s}: {n_f:3d} frames, dur={dur_out:.2f}s, spineY=[{sy_after.min():.3f}, {sy_after.max():.3f}], minSoleY={soles_after.min():+.3f}")
        cleaned_anims[name] = (n_f, dur_out, tr)

    # ---- 5. Repack binary GLB cleanly (with EXT_texture_webp)
    out_bin = bytearray()
    views = []
    accs = []

    def add_view(data_bytes, target=None):
        while len(out_bin) % 4:
            out_bin.append(0)
        v = {"buffer": 0, "byteOffset": len(out_bin), "byteLength": len(data_bytes)}
        if target is not None:
            v["target"] = target
        out_bin.extend(data_bytes)
        views.append(v)
        return len(views) - 1

    def add_acc(arr, ctype, typ, normalized=False, minmax=False, target=None):
        a = np.ascontiguousarray(arr)
        bv = add_view(a.tobytes(), target=target)
        d = {"bufferView": bv, "componentType": ctype, "count": int(a.shape[0]), "type": typ}
        if normalized:
            d["normalized"] = True
        if minmax:
            if a.ndim == 1:
                d["min"] = [float(a.min()) if ctype == 5126 else int(a.min())]
                d["max"] = [float(a.max()) if ctype == 5126 else int(a.max())]
            else:
                d["min"] = [float(v) if ctype == 5126 else int(v) for v in a.min(axis=0)]
                d["max"] = [float(v) if ctype == 5126 else int(v) for v in a.max(axis=0)]
        accs.append(d)
        return len(accs) - 1

    def pack_prim(pos, nrm, uv, jts, wts, cat, idx):
        j_ctype = 5121 if jts.max() < 256 else 5123
        j_arr = jts.astype(np.uint8 if j_ctype == 5121 else np.uint16)
        # Pack skin weights into glTF-standard normalized uint8 summing to exactly 255
        w_sum = np.maximum(wts.sum(axis=1, keepdims=True), 1e-6)
        w_u8 = np.clip(np.round((wts / w_sum) * 255.0), 0, 255).astype(np.int32)
        diff = 255 - w_u8.sum(axis=1)
        max_col = np.argmax(w_u8, axis=1)
        w_u8[np.arange(len(w_u8)), max_col] = np.clip(w_u8[np.arange(len(w_u8)), max_col] + diff, 0, 255)
        w_arr = w_u8.astype(np.uint8)

        # Quantize normals (int8, 4-byte aligned) and UVs (uint16) via KHR_mesh_quantization
        n_len = np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-8)
        n_i8 = np.zeros((len(nrm), 4), dtype=np.int8)
        n_i8[:, :3] = np.clip(np.round((nrm / n_len) * 127.0), -127, 127).astype(np.int8)
        n_bv = add_view(n_i8.tobytes(), target=34962)
        views[n_bv]["byteStride"] = 4
        n_acc = len(accs)
        accs.append({"bufferView": n_bv, "componentType": 5120, "count": int(len(nrm)), "type": "VEC3", "normalized": True})

        uv_clamped = np.clip(uv % 1.0, 0.0, 1.0)
        uv_u16 = np.round(uv_clamped * 65535.0).astype(np.uint16)

        big_i = int(idx.max()) > 65535
        i_arr = idx.astype(np.uint32 if big_i else np.uint16).reshape(-1)
        return {
            "attributes": {
                "POSITION": add_acc(pos.astype(np.float32), 5126, "VEC3", minmax=True, target=34962),
                "NORMAL": n_acc,
                "TEXCOORD_0": add_acc(uv_u16, 5123, "VEC2", normalized=True, target=34962),
                "JOINTS_0": add_acc(j_arr, j_ctype, "VEC4", target=34962),
                "WEIGHTS_0": add_acc(w_arr, 5121, "VEC4", normalized=True, target=34962),
                "_CAT": add_acc(cat.astype(np.uint8), 5121, "VEC4", normalized=True, target=34962),
            },
            "indices": add_acc(i_arr, 5125 if big_i else 5123, "SCALAR", target=34963),
            "material": 0,
        }

    new_meshes = [
        {"name": "catbus_body", "primitives": [pack_prim(m0["pos"], m0["nrm"], m0["uv"], m0["jts"], m0["wts"], m0["cat"], m0["idx"])]},
        {"name": "catbus_lantern", "primitives": [pack_prim(m1["pos"], m1["nrm"], m1["uv"], m1["jts"], m1["wts"], m1["cat"], m1["idx"])]},
        {"name": "catbus_roof_rail", "primitives": [pack_prim(m2["pos"], m2["nrm"], m2["uv"], m2["jts"], m2["wts"], m2["cat"], m2["idx"])]},
        {"name": "catbus_fur_hull", "primitives": [pack_prim(fh_pos, fh_nrm, fh_uv, fh_jts, fh_wts, fh_cat, fh_idx)]},
        {"name": "catbus_body_lod1", "primitives": [pack_prim(lod_pos, lod_nrm, lod_uv, lod_jts, lod_wts, lod_cat, lod_idx)]},
    ]

    # Add nodes for catbus_fur_hull (47) and catbus_body_lod1 (48) under catbus_rig (46)
    new_nodes = [dict(n) for n in nodes]
    fur_node_idx = len(new_nodes)
    new_nodes.append({"name": "catbus_fur_hull", "mesh": 3, "skin": 0})
    lod_node_idx = len(new_nodes)
    new_nodes.append({"name": "catbus_body_lod1", "mesh": 4, "skin": 0})
    rig_node = new_nodes[46]
    rig_node["children"] = list(rig_node["children"]) + [fur_node_idx, lod_node_idx]

    # Skin inverseBindMatrices
    ibms = get_acc(skin["inverseBindMatrices"]).astype(np.float32)
    new_skins = [{"joints": list(skin["joints"]), "inverseBindMatrices": add_acc(ibms, 5126, "MAT4")}]

    # Animations
    new_anims = []
    for name in ["walk", "sprint", "fly", "takeoff", "land"]:
        if name not in cleaned_anims:
            continue
        n_f, dur_out, tr = cleaned_anims[name]
        t_arr = np.linspace(0.0, dur_out, n_f, dtype=np.float32)
        t_acc = add_acc(t_arr, 5126, "SCALAR", minmax=True)
        samplers = []
        channels = []
        for (ni, pk), vals in tr.items():
            # Compress constant tracks to 2 endpoints to save space
            if np.max(np.abs(vals - vals[0:1])) < 1e-5:
                t2 = add_acc(np.array([0.0, dur_out], dtype=np.float32), 5126, "SCALAR", minmax=True)
                v_acc = add_acc(vals[[0, -1]].astype(np.float32), 5126, "VEC4" if pk == "rotation" else "VEC3")
                samplers.append({"input": t2, "interpolation": "LINEAR", "output": v_acc})
            else:
                v_acc = add_acc(vals.astype(np.float32), 5126, "VEC4" if pk == "rotation" else "VEC3")
                samplers.append({"input": t_acc, "interpolation": "LINEAR", "output": v_acc})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": int(ni), "path": pk}})
        new_anims.append({"name": name, "samplers": samplers, "channels": channels})

    # Images (WebP)
    new_images = [
        {"name": "catbus_normal", "mimeType": "image/webp", "bufferView": add_view(webp_nrm)},
        {"name": "catbus_color", "mimeType": "image/webp", "bufferView": add_view(webp_col)},
        {"name": "catbus_orm", "mimeType": "image/webp", "bufferView": add_view(webp_orm)},
    ]
    new_textures = [
        {"sampler": 0, "source": 0, "extensions": {"EXT_texture_webp": {"source": 0}}},
        {"sampler": 0, "source": 1, "extensions": {"EXT_texture_webp": {"source": 1}}},
        {"sampler": 0, "source": 2, "extensions": {"EXT_texture_webp": {"source": 2}}},
    ]
    new_materials = [{
        "name": "catbus_coat",
        "pbrMetallicRoughness": {
            "baseColorTexture": {"index": 1},
            "metallicRoughnessTexture": {"index": 2},
        },
        "normalTexture": {"index": 0},
        "occlusionTexture": {"index": 2},
    }]

    out_gltf = {
        "asset": {"version": "2.0", "generator": "Petalwake catbus_process.py"},
        "extensionsUsed": ["EXT_texture_webp", "KHR_mesh_quantization"],
        "extensionsRequired": ["KHR_mesh_quantization"],
        "scene": 0,
        "scenes": gltf["scenes"],
        "nodes": new_nodes,
        "skins": new_skins,
        "meshes": new_meshes,
        "animations": new_anims,
        "materials": new_materials,
        "textures": new_textures,
        "images": new_images,
        "samplers": gltf.get("samplers", [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]),
        "bufferViews": views,
        "accessors": accs,
        "buffers": [{"byteLength": len(out_bin)}],
    }

    js = json.dumps(out_gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((-len(js)) % 4)
    while len(out_bin) % 4:
        out_bin.append(0)

    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    total = 12 + 8 + len(js) + 8 + len(out_bin)
    with open(dst_path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack("<II", len(out_bin), 0x004E4942))
        f.write(out_bin)

    info = {
        "name": "catbus",
        "yawOffset": 180,
        "scale": 1.22,
        "stripRootMotion": false_or_true(False),
        "furLength": 0.082,
        "furDensity": 48.0,
        "lanternPivotL": [round(v, 4) for v in pivot_L],
        "lanternPivotR": [round(v, 4) for v in pivot_R],
        "railBaseY": 1.90,
        "bounds": {
            "min": [round(float(v), 4) for v in m0["pos"].min(axis=0)],
            "max": [round(float(v), 4) for v in m0["pos"].max(axis=0)],
        },
        "tris": {
            "body": int(len(m0["idx"]) // 3),
            "lantern": int(len(m1["idx"]) // 3),
            "roof_rail": int(len(m2["idx"]) // 3),
            "fur_hull": int(len(fh_idx)),
            "body_lod1": int(len(lod_idx)),
        },
        "bytes": total,
    }
    json_path = os.path.splitext(dst_path)[0] + ".json"
    with open(json_path, "w") as f:
        json.dump(info, f, indent=2)

    print(f"\nWrote {dst_path}: {len(raw)/1e6:.2f} MB -> {total/1e6:.2f} MB")
    print(f"Wrote {json_path}: {json.dumps(info)}")


def false_or_true(v):
    return bool(v)


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    dst = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_DST
    process(src, dst)
