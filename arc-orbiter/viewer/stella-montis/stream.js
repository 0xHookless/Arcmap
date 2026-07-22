// stream.js — Live player-stream subscriber for the Arc Orbiter free-cam viewer.
// Connects to a WebSocket published by the Telementry memory reader (see
// plan: wss://<random>.trycloudflare.com) and overlays each remote player as
// a 34-bone skeleton on the existing static map. Two phases:
//
//   1. transport (this file, step 3): connect, parse, store latest frame,
//      update HUD, reconnect on failure.
//   2. render (step 4): expose window.renderLiveStreamOverlay(gl, mvp, opts)
//      which the existing app.js invokes once per frame after the scene depth
//      write, before postFX.

(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const wsUrl = params.get("ws");
  const xrayDefault = params.get("xray") === "1";

  // 21-pair skeleton topology, mirroring Bones.h::BoneConnections[]. The
  // publisher sends 34 bones per frame in NEEDED_BONES order; we draw the
  // skeleton by indexing into that flat array using the indices in
  // BONE_INDEX below.
  const BONE_INDEX = {
    Root: 0, Pelvis: 1, Spine01: 2, Spine02: 3, Spine03: 4, Chest: 5,
    Neck: 6, Head: 7, ClavicleL: 8, UpperArmL: 9, LowerArmL: 10, HandL: 11,
    ClavicleR: 12, UpperArmR: 13, LowerArmR: 14, HandR: 15,
    PinkyL02: 16, PinkyL03: 17, MiddleL01: 18, RingL02: 19,
    PinkyR02: 20, RingR03: 21,
    ThighL: 22, CalfL: 23, FootL: 24,
    ThighR: 25, CalfR: 26, FootR: 27,
    ThumbR03: 28, RingR01: 29, RingR02: 30,
    MiddleL02: 31, MiddleL03: 32, RingL03: 33,
  };
  const BONE_CONNECTIONS = [
    ["Root", "Pelvis"], ["Pelvis", "Spine01"], ["Spine01", "Spine02"],
    ["Spine02", "Spine03"], ["Spine03", "Chest"], ["Chest", "Neck"],
    ["Neck", "Head"], ["Chest", "ClavicleL"], ["ClavicleL", "UpperArmL"],
    ["UpperArmL", "LowerArmL"], ["LowerArmL", "HandL"],
    ["Chest", "ClavicleR"], ["ClavicleR", "UpperArmR"],
    ["UpperArmR", "LowerArmR"], ["LowerArmR", "HandR"],
    ["Pelvis", "ThighL"], ["ThighL", "CalfL"], ["CalfL", "FootL"],
    ["Pelvis", "ThighR"], ["ThighR", "CalfR"], ["CalfR", "FootR"],
  ];

  // --- State --------------------------------------------------------------
  const players = new Map();      // id -> player record
  let latestTick = -1;
  let lastFrameAt = 0;
  let connState = "disabled";     // disabled / connecting / connected /
                                  // stale / reconnecting / error
  let socket = null;
  let backoffMs = 1000;
  let lastConnectAttempt = 0;
  let hidden = false;
  let frameCount = 0;

  function setConnState(s) {
    if (s === connState) return;
    connState = s;
    updateHud();
  }

  function teamColor(team) {
    // Deterministic HSL hash so the same team id always maps to the same
    // color across reconnects.
    const h = ((team | 0) * 137) % 360;
    return `hsl(${h},70%,60%)`;
  }

  function statusColor(status) {
    if (status === 3 || status === 4) return "#888"; // Dead / Defeated
    if (status === 1) return "#f1c40f";               // DBNO
    return "#ffffff";
  }

  function updateHud() {
    const tele = document.querySelector("#telemetry");
    const stat = document.querySelector("#status");
    if (!tele || !stat) return;

    const now = performance.now();
    const sinceFrame = lastFrameAt > 0 ? Math.max(0, Math.round(now - lastFrameAt)) : -1;
    const liveLine = lastFrameAt > 0
      ? `Live: ${players.size} players · tick ${latestTick} · last frame ${sinceFrame} ms ago`
      : `Live: waiting for stream…`;

    // Append rather than replace — the viewer fills telemetry / status with
    // scene stats already. We add a newline + our line.
    appendLine(tele, liveLine);
    appendLine(stat, `WS: ${connState} · frames received: ${frameCount}`);
  }

  function appendLine(el, line) {
    const tag = `__stream_line__`;
    let node = el.querySelector(`.${tag}`);
    if (!node) {
      node = document.createElement("div");
      node.className = tag;
      // De-emphasize slightly so the scene stats stay primary.
      node.style.opacity = "0.85";
      el.appendChild(node);
    }
    node.textContent = line;
  }

  // --- WebSocket lifecycle ------------------------------------------------
  function connect() {
    if (hidden) return;
    if (!wsUrl) return;
    setConnState("connecting");
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      console.warn("[stream] WebSocket ctor failed", err);
      setConnState("error");
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      backoffMs = 1000;
      setConnState("connected");
    };
    socket.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        ingest(payload);
      } catch (err) {
        console.warn("[stream] parse failed", err);
      }
    };
    socket.onerror = () => setConnState("error");
    socket.onclose = () => {
      socket = null;
      scheduleReconnect();
    };
    lastConnectAttempt = performance.now();
  }

  function scheduleReconnect() {
    setConnState("reconnecting");
    setTimeout(() => {
      if (hidden) return;
      connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30000);
  }

  document.addEventListener("visibilitychange", () => {
    hidden = document.hidden;
    if (hidden) {
      if (socket) {
        try { socket.close(); } catch (_) {}
        socket = null;
      }
    } else if (connState === "reconnecting" || connState === "error") {
      backoffMs = 1000;
      connect();
    }
  });

  // --- Ingest -------------------------------------------------------------
  function ingest(payload) {
    if (!payload || payload.v !== 1) return;
    if (typeof payload.tick !== "number" || payload.tick <= latestTick) return;
    latestTick = payload.tick;
    lastFrameAt = performance.now();
    frameCount++;

    players.clear();
    const list = Array.isArray(payload.players) ? payload.players : [];
    for (const p of list) {
      if (!p || typeof p.id !== "number") continue;
      const bonesRaw = Array.isArray(p.bones) ? p.bones : [];
      // Flatten [[x,y,z]…] into a Float32Array for fast per-frame upload.
      const flat = new Float32Array(bonesRaw.length * 3);
      for (let i = 0; i < bonesRaw.length; i++) {
        const b = bonesRaw[i];
        if (!b || b.length < 3) continue;
        flat[i * 3 + 0] = b[0];
        flat[i * 3 + 1] = b[1];
        flat[i * 3 + 2] = b[2];
      }
      players.set(p.id, {
        id: p.id,
        team: p.team | 0,
        name: typeof p.name === "string" ? p.name : "Player",
        status: (p.status | 0),
        hp: +p.hp || 0,
        max: +p.max || 100,
        armor: +p.armor || 0,
        weapon: typeof p.weapon === "string" ? p.weapon : "",
        bot: !!p.bot,
        visible: !!p.visible,
        distance: +p.distance || 0,
        boneCount: bonesRaw.length,
        bones: flat,
        receivedAt: lastFrameAt,
      });
    }
    // Don't spam DOM updates on every frame — throttle to ~5 Hz.
    if (!updateHud._t || (lastFrameAt - updateHud._t) > 200) {
      updateHud();
      updateHud._t = lastFrameAt;
    }
  }

  // --- Stale reaper -------------------------------------------------------
  // A player is considered stale after 1 s of silence and is removed after
  // ~2 s. Cheaper than diffing each frame.
  setInterval(() => {
    if (players.size === 0) return;
    const now = performance.now();
    let removed = 0;
    for (const [id, p] of players) {
      const age = now - p.receivedAt;
      if (age > 2500) {
        players.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      updateHud();
    } else if (lastFrameAt > 0 && now - lastFrameAt > 1500) {
      // Frames are arriving but viewer has lost the latest — mark stale so
      // the user knows.
      if (connState === "connected") setConnState("stale");
    } else if (connState === "stale" && now - lastFrameAt < 800) {
      setConnState("connected");
    }
  }, 500);

  // --- Exposed to the existing app.js render pass -------------------------
  // Coordinates arrive in UE-cm world space. The viewer's packedPositionScale
  // expects canonical UE-world coordinates too — same convention. We apply
  // the same per-axis flip that scene.positionScale carries, so a bone at
  // (100000, 200000, 3000) in the game world lines up with the same world
  // point rendered in the viewer.
  let gl = null;
  let program = null;
  let vao = null;
  let vbo = null;
  let uMvp = null;
  let uWorldTransform = null;
  let uPointSize = null;
  let bufferCapacity = 0;

  const VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uMvp;             // projection * view (from scene pass)
uniform mat4 uWorldTransform;  // ((p * uPositionScale) - uCenter) * uScale
                                // baked into a mat4 on the JS side so we
                                // match the existing scene shader exactly.
uniform float uPointSize;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uMvp * uWorldTransform * vec4(aPos, 1.0);
  gl_PointSize = uPointSize;
}`;
  const FRAG = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 outColor;
void main() {
  if (gl_PointCoord.x < 0.05 || gl_PointCoord.x > 0.95 ||
      gl_PointCoord.y < 0.05 || gl_PointCoord.y > 0.95) {
    outColor = vec4(0.0);
    return;
  }
  outColor = vec4(vColor, 1.0);
}`;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || "shader compile");
    }
    return sh;
  }
  function linkProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, "aPos");
    gl.bindAttribLocation(p, 1, "aColor");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || "program link");
    }
    return p;
  }

  function ensureResources() {
    if (program) return true;
    if (!gl) return false;
    try {
      const vs = compile(gl.VERTEX_SHADER, VERT);
      const fs = compile(gl.FRAGMENT_SHADER, FRAG);
      program = linkProgram(vs, fs);
      vao = gl.createVertexArray();
      vbo = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      const stride = (3 + 3) * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
      gl.bindVertexArray(null);
      uMvp = gl.getUniformLocation(program, "uMvp");
      uWorldTransform = gl.getUniformLocation(program, "uWorldTransform");
      uPointSize = gl.getUniformLocation(program, "uPointSize");
      return true;
    } catch (err) {
      console.warn("[stream] GL init failed", err);
      program = null;
      return false;
    }
  }

  // Compose the world transform that maps UE-cm canonical world positions
  // (what the publisher sends) into the same centered/scaled frame the scene
  // shader uses. Equivalent to: ((p * positionScale) - center) * worldScale.
  function buildWorldTransform(positionScale, center, worldScale) {
    const ps = positionScale || [1, 1, 1];
    const c  = center || [0, 0, 0];
    const s  = (typeof worldScale === "number") ? worldScale : 1;
    return new Float32Array([
      ps[0] * s, 0,            0,            0,
      0,         ps[1] * s,    0,            0,
      0,         0,            ps[2] * s,    0,
      -c[0] * s, -c[1] * s,    -c[2] * s,    1,
    ]);
  }

  // Color helper matching the rule documented in the plan.
  function playerRgb(p) {
    const base = hexToRgb(statusColor(p.status));
    const dim = p.visible ? 1.0 : 0.55;
    return [base[0] * dim, base[1] * dim, base[2] * dim];
  }
  function hexToRgb(hex) {
    if (hex.startsWith("hsl")) {
      // Quick HSL → RGB for the team color path. We're not aiming for
      // colorimetric accuracy, just consistent hues.
      const m = /hsl\((\d+),(\d+)%,(\d+)%\)/.exec(hex);
      if (!m) return [1, 1, 1];
      let h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
    }
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  }

  // Build interleaved [pos, color] arrays for skeleton lines + bone points.
  // Caller passes the axis-flip function (we export a default that matches
  // packedPositionScale's UE → viewer transform).
  let pendingAxisFlip = null;
  let pendingViewProj = null;
  let pendingSceneState = null;
  let pendingOpts = { depthTest: true };

  // Public hook called by app.js after the scene depth write.
  window.renderLiveStreamOverlay = function (glContext, viewProj, opts, sceneState) {
    if (!wsUrl || players.size === 0) return;
    gl = glContext;
    if (!ensureResources()) return;

    // Choose a per-frame transform: the publisher sends canonical UE cm,
    // and the viewer applies the same axis flip it uses for manifest
    // positions. The app.js caller is expected to pass us the already-
    // flipped `viewProj`, plus the scene's positionScale/center/worldScale
    // so we can build the matching world transform.
    pendingViewProj = viewProj;
    pendingOpts = opts || pendingOpts;
    pendingSceneState = sceneState || pendingSceneState;

    // Build interleaved arrays.
    let lineCount = 0;
    let pointCount = 0;
    for (const p of players.values()) {
      lineCount += BONE_CONNECTIONS.length * 2;
      pointCount += p.boneCount;
    }
    const totalVerts = (lineCount + pointCount);
    if (totalVerts === 0) return;
    const needed = totalVerts * 6; // 3 floats pos + 3 floats color per vertex
    if (needed > bufferCapacity) {
      bufferCapacity = Math.max(needed, 4096);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, bufferCapacity * 4, gl.DYNAMIC_DRAW);
    }
    const arr = new Float32Array(needed);
    let cursor = 0;

    for (const p of players.values()) {
      const colorBase = statusColor(p.status);
      const teamRgb = hexToRgb(teamColor(p.team));
      const dim = p.visible ? 1.0 : 0.55;
      const cr = teamRgb[0] * dim;
      const cg = teamRgb[1] * dim;
      const cb = teamRgb[2] * dim;
      // Skeleton lines use team color; dimmed when not visible. Dead players
      // (status 3/4) override to grey.
      const isDead = p.status === 3 || p.status === 4;
      const lr = isDead ? 0.55 : cr;
      const lg = isDead ? 0.55 : cg;
      const lb = isDead ? 0.55 : cb;

      for (const [a, b] of BONE_CONNECTIONS) {
        const ia = BONE_INDEX[a];
        const ib = BONE_INDEX[b];
        const ax = p.bones[ia * 3 + 0], ay = p.bones[ia * 3 + 1], az = p.bones[ia * 3 + 2];
        const bx = p.bones[ib * 3 + 0], by = p.bones[ib * 3 + 1], bz = p.bones[ib * 3 + 2];
        if (!isFinite(ax) || !isFinite(bx)) continue;
        arr[cursor++] = ax; arr[cursor++] = ay; arr[cursor++] = az;
        arr[cursor++] = lr;  arr[cursor++] = lg;  arr[cursor++] = lb;
        arr[cursor++] = bx; arr[cursor++] = by; arr[cursor++] = bz;
        arr[cursor++] = lr;  arr[cursor++] = lg;  arr[cursor++] = lb;
      }

      // Bone points: bright white-ish head + colored body.
      const pr = isDead ? 0.65 : 1.0;
      const pg = isDead ? 0.65 : 1.0;
      const pb = isDead ? 0.65 : 1.0;
      for (let i = 0; i < p.boneCount; i++) {
        const x = p.bones[i * 3 + 0];
        const y = p.bones[i * 3 + 1];
        const z = p.bones[i * 3 + 2];
        if (!isFinite(x)) continue;
        arr[cursor++] = x; arr[cursor++] = y; arr[cursor++] = z;
        arr[cursor++] = pr; arr[cursor++] = pg; arr[cursor++] = pb;
      }
    }

    if (cursor === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, arr.subarray(0, cursor));

    // Save & restore GL state so postFX is unaffected.
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const prevDepth = gl.getParameter(gl.DEPTH_TEST);
    const prevBlend = gl.getParameter(gl.BLEND);
    const prevCull = gl.getParameter(gl.CULL_FACE);

    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.uniformMatrix4fv(uMvp, false, pendingViewProj);
    if (uWorldTransform && pendingSceneState) {
      const wt = buildWorldTransform(
        pendingSceneState.positionScale,
        pendingSceneState.center,
        pendingSceneState.scale
      );
      gl.uniformMatrix4fv(uWorldTransform, false, wt);
    }
    gl.uniform1f(uPointSize, 5.0);

    if (pendingOpts.depthTest) {
      gl.enable(gl.DEPTH_TEST);
    } else {
      gl.disable(gl.DEPTH_TEST);
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    // Skeleton lines first (offset 0, count = lineCount/2 * 2 vertices).
    gl.drawArrays(gl.LINES, 0, lineCount);
    // Bone points immediately after.
    gl.drawArrays(gl.POINTS, lineCount, pointCount);

    // Restore.
    if (prevDepth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    if (prevCull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(prevVao);
    gl.useProgram(prevProgram);
  };

  // --- Boot ---------------------------------------------------------------
  if (!wsUrl) {
    updateHud();
    return;
  }

  // Wait until the viewer's GL context exists — app.js initializes late.
  const bootCheck = setInterval(() => {
    if (window.__STELLA_MONTIS_READY__ || document.querySelector("#viewport")?.getContext) {
      clearInterval(bootCheck);
      connect();
    }
  }, 250);
})();