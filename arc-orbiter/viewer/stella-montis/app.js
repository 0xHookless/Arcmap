const canvas = document.querySelector("#viewport");
const axisCanvas = document.querySelector("#axis-gizmo");
const telemetryEl = document.querySelector("#telemetry");
const statusEl = document.querySelector("#status");
const lockButton = document.querySelector("#lock");
const xrayToggle = document.querySelector("#xray");
const cinematicToggle = document.querySelector("#cinematic");
const speedInput = document.querySelector("#speed");
const speedDownButton = document.querySelector("#speed-down");
const speedUpButton = document.querySelector("#speed-up");
const speedValue = document.querySelector("#speed-value");
const scaleInput = document.querySelector("#scale");
const scaleValue = document.querySelector("#scale-value");
const gl = canvas.getContext("webgl2", { antialias: false });
const axisContext = axisCanvas?.getContext("2d") || null;

const DEFAULT_MANIFEST = "../../.tmp/stella-montis/root-meshes/manifest.json";
const manifestScript = document.querySelector("script[data-default-manifest]");
const defaultManifest = window.STELLA_MONTIS_MANIFEST ?? manifestScript?.dataset.defaultManifest ?? DEFAULT_MANIFEST;
const query = new URLSearchParams(window.location.search);
const manifestHref = query.get("manifest") || defaultManifest;
const residentBudget = parseBudget(query.get("budget"), 220);
const streamRadius = parseRadius(query.get("radius"), 14);
const userPositionScale = parsePositionScale(query.get("flip") || "x");
const settings = {
  showBackdrop: true,
  speed: parseSpeed(query.get("speed"), 0.5),
  scale: parseScale(query.get("scale"), 1),
  xray: parseBool(query.get("xray"), false),
  // Enhanced rendering (materials + SSAO + sky/fog). Disable with ?fx=0.
  postFx: parseBool(query.get("fx"), true),
  // Cinematic mode: HDR PBR + shadows + bloom + filmic exposure. Toggle key V / ?cinematic=1.
  cinematic: parseBool(query.get("cinematic"), false),
  shadows: parseBool(query.get("shadows"), true),
  exposure: parseFloat(query.get("exposure")) || 0,
};
const OBJ_LOAD_BATCH_SIZE = 12;
const PACKED_LOAD_BATCH_SIZE = 96;
const OBJ_MAX_CONCURRENT_LOADS = 2;
const PACKED_MAX_CONCURRENT_LOADS = 18;
const STREAM_INTERVAL_MS = 80;
const HUD_UPDATE_INTERVAL_MS = 250;
const TELEMETRY_LOG_INTERVAL_MS = 2000;
const SPEED_STEP = 0.1;
const SHIFT_SPEED_MULTIPLIER = 5;
const VIEWER_COORDINATE_SYSTEM = "unreal-x-z-neg-y";
const DEFAULT_CAMERA = window.STELLA_MONTIS_CAMERA || {
  position: [10658.9, 4156.1, 4330.3],
  heading: 1.8,
  pitch: -6.3,
};

const keys = new Set();
let yaw = 0;
let pitch = -0.18;
let lastFrame = performance.now();
let lastTelemetryLogAt = 0;
let lastTelemetryKey = "";
let scene = null;
let camera = {
  position: [0, 1.4, 8],
  speed: settings.speed,
  effectiveSpeed: settings.speed,
  lookDistance: 12,
};

// ---- Spectate mode -------------------------------------------------------
// Locks the freecam onto a connected player (driven by the "Spectate" panel
// in stream.js) instead of manual WASD flight. Pure camera automation over
// data already streamed to the viewer either way — no new information
// exposure, so it applies to real player data the same as simulated test
// data, unlike x-ray/locator arrows.
const spectate = { active: false, targetId: null };
const SPECTATE_FOLLOW_LERP = 4.5; // 1/s -- higher = snappier camera catch-up
const SPECTATE_OFFSET = [0, 3.5, 3.0]; // above + back, in viewer-space units

window.__telemetrySpectateEnter = (id) => {
  spectate.active = true;
  spectate.targetId = id;
};
window.__telemetrySpectateExit = () => {
  spectate.active = false;
  spectate.targetId = null;
};

initControls();

if (!manifestHref) {
  setStatus("Data endpoint is not configured.");
} else if (!gl) {
  setStatus("WebGL2 is not available in this browser.");
} else {
  queueMicrotask(() => boot().catch((error) => {
    console.error(error);
    setStatus(`Failed: ${error.message}`);
  }));
}

lockButton.addEventListener("click", () => canvas.requestPointerLock());
canvas.addEventListener("click", () => canvas.requestPointerLock());

document.addEventListener("pointerlockchange", () => {
  lockButton.textContent = document.pointerLockElement === canvas ? "Mouse captured" : "Enter flythrough";
});

document.addEventListener("mousemove", (event) => {
  if (document.pointerLockElement !== canvas) return;
  yaw += event.movementX * 0.002;
  pitch -= event.movementY * 0.002;
  pitch = clamp(pitch, -1.48, 1.48);
});

window.addEventListener("keydown", (event) => {
  keys.add(event.code);
  if (event.code === "Escape") document.exitPointerLock();
  if (event.code === "Minus" || event.code === "BracketLeft") {
    adjustSpeed(-SPEED_STEP);
    event.preventDefault();
  }
  if (event.code === "Equal" || event.code === "BracketRight") {
    adjustSpeed(SPEED_STEP);
    event.preventDefault();
  }
  if (event.code === "KeyX") {
    settings.xray = !settings.xray;
    if (xrayToggle) xrayToggle.checked = settings.xray;
    if (scene) setStatus(makeStats());
  }
  if (event.code === "KeyV") {
    settings.cinematic = !settings.cinematic;
    if (cinematicToggle) cinematicToggle.checked = settings.cinematic;
  }
  if (event.code === "KeyC" && scene) {
    void copyTelemetrySnapshot(performance.now());
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("resize", resizeCanvas);

function initControls() {
  if (xrayToggle) {
    xrayToggle.checked = settings.xray;
    xrayToggle.addEventListener("change", () => {
      settings.xray = xrayToggle.checked;
      if (scene) setStatus(makeStats());
    });
  }

  if (cinematicToggle) {
    cinematicToggle.checked = settings.cinematic;
    cinematicToggle.addEventListener("change", () => {
      settings.cinematic = cinematicToggle.checked;
    });
  }

  if (speedInput) {
    speedInput.value = String(settings.speed);
    speedInput.addEventListener("input", () => {
      settings.speed = parseSpeed(speedInput.value, settings.speed);
      camera.speed = settings.speed;
      updateMovementSpeed();
      updateSpeedLabel();
    });
  }
  if (scaleInput) {
    scaleInput.value = String(settings.scale);
    scaleInput.addEventListener("input", () => {
      settings.scale = parseScale(scaleInput.value, settings.scale);
      applySceneScale(true);
      updateScaleLabel();
    });
  }
  speedDownButton?.addEventListener("click", () => adjustSpeed(-SPEED_STEP));
  speedUpButton?.addEventListener("click", () => adjustSpeed(SPEED_STEP));
  updateSpeedLabel();
  updateScaleLabel();
}

function adjustSpeed(delta) {
  settings.speed = parseSpeed(settings.speed + delta, settings.speed);
  camera.speed = settings.speed;
  if (speedInput) speedInput.value = String(settings.speed);
  updateMovementSpeed();
  updateSpeedLabel();
}

function updateSpeedLabel() {
  if (!speedValue) return;
  speedValue.value = formatSpeed(settings.speed);
}

function updateScaleLabel() {
  if (!scaleValue) return;
  scaleValue.value = `${formatScale(settings.scale)}x`;
}

async function boot() {
  resizeCanvas();
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0.018, 0.022, 0.028, 1);

  const program = createProgram(VERTEX_SOURCE, FRAGMENT_SOURCE);
  scene = {
    program,
    uniforms: {
      projection: gl.getUniformLocation(program, "uProjection"),
      view: gl.getUniformLocation(program, "uView"),
      center: gl.getUniformLocation(program, "uCenter"),
      scale: gl.getUniformLocation(program, "uScale"),
      positionScale: gl.getUniformLocation(program, "uPositionScale"),
      light: gl.getUniformLocation(program, "uLight"),
      viewLight: gl.getUniformLocation(program, "uViewLight"),
      opacity: gl.getUniformLocation(program, "uOpacity"),
      fogDensity: gl.getUniformLocation(program, "uFogDensity"),
      detailScale: gl.getUniformLocation(program, "uDetailScale"),
      skyColor: gl.getUniformLocation(program, "uSkyColor"),
      groundColor: gl.getUniformLocation(program, "uGroundColor"),
      horizonColor: gl.getUniformLocation(program, "uHorizonColor"),
      matColor: gl.getUniformLocation(program, "uMatColor[0]"),
      matMetal: gl.getUniformLocation(program, "uMatMetal[0]"),
      matSnow: gl.getUniformLocation(program, "uMatSnow[0]"),
    },
    chunks: [],
    entries: [],
    format: "obj",
    compression: null,
    positionScale: [1, 1, 1],
    preferSpatialStreaming: false,
    manifestUrl: null,
    bounds: createBounds(),
    baseScale: 1,
    baseRadius: 1,
    scale: 1,
    radius: 1,
    vertexCount: 0,
    indexCount: 0,
    meshCount: 0,
    totalMeshCount: 0,
    visibleMeshCount: 0,
    hiddenBackdropCount: 0,
    failedCount: 0,
    loadingCount: 0,
    loadedEverCount: 0,
    drawnMeshCount: 0,
    drawnVertexCount: 0,
    drawnIndexCount: 0,
    pendingCandidateCount: 0,
    lastStreamAt: 0,
    lastHudAt: 0,
    residentBudget,
    streamRadius,
  };

  initPostFX();

  await loadManifest(manifestHref);
  placeCamera();
  applyCameraQueryOverride();
  scheduleStreaming(true);
  requestAnimationFrame(frame);
}

async function loadManifest(href) {
  const manifestUrl = new URL(href, window.location.href);
  scene.manifestUrl = manifestUrl;
  setStatus(`Indexing ${manifestUrl.pathname}...`);

  const manifest = await loadManifestIndex(manifestUrl);
  if (manifest.format === "stella-packed-scene-v1" && Array.isArray(manifest.chunks)) {
    scene.format = "packed";
    scene.compression = manifest.compression || null;
    scene.positionScale = packedPositionScale(manifest);
    scene.preferSpatialStreaming = true;
    scene.entries = manifest.chunks
      .map((chunk, index) => makePackedEntry(chunk, index, manifestUrl))
      .filter(Boolean);
    if (scene.entries.length === 0) throw new Error("packed manifest contains no chunks");
  } else {
    scene.format = "obj";
    scene.positionScale = [1, 1, 1];
    scene.preferSpatialStreaming = false;
    const meshes = normalizeManifest(manifest);
    if (meshes.length === 0) throw new Error("manifest contains no meshes");
    scene.entries = meshes
      .map((mesh, index) => makeSceneEntry(mesh, index, manifestUrl))
      .filter(Boolean);
  }
  scene.totalMeshCount = scene.entries.length;

  applyEntryVisibility(false);
  if (!hasFiniteBounds(scene.bounds)) throw new Error("manifest contains no usable mesh positions");
  setStatus(makeStats());
}

async function loadManifestIndex(manifestUrl) {
  const manifest = await fetchJson(manifestUrl);
  if (manifest.format !== "stella-packed-scene-v1" || !Array.isArray(manifest.chunkParts)) {
    return manifest;
  }

  const chunks = [];
  for (let index = 0; index < manifest.chunkParts.length; index += 1) {
    setStatus(`Indexing ${manifestUrl.pathname} ${index + 1}/${manifest.chunkParts.length}...`);
    const partUrl = new URL(manifest.chunkParts[index], manifestUrl);
    const part = await fetchJson(partUrl);
    if (Array.isArray(part)) {
      chunks.push(...part);
    } else if (Array.isArray(part.chunks)) {
      chunks.push(...part.chunks);
    } else {
      throw new Error(`manifest shard has no chunks: ${partUrl.pathname}`);
    }
  }
  return {
    ...manifest,
    chunks,
  };
}

function normalizeManifest(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (Array.isArray(manifest.meshes)) return manifest.meshes;
  if (Array.isArray(manifest.objects)) return manifest.objects;
  if (Array.isArray(manifest.exports)) return manifest.exports;
  return [];
}

function makeSceneEntry(mesh, index, manifestUrl) {
  const file = mesh.file || mesh.path || mesh.obj || "";
  if (!file) return null;
  const translation = mesh.transform && Array.isArray(mesh.transform.translation)
    ? mesh.transform.translation
    : [0, 0, 0];
  const center = mesh.parentTransform
    ? transformUnrealPoint(translation, mesh.parentTransform)
    : translation;

  return {
    index,
    mesh,
    category: isBackdropMesh(mesh) ? "backdrop" : "level",
    visible: true,
    url: new URL(file, manifestUrl),
    center: unrealToViewerPoint(center),
    state: "pending",
    chunk: null,
  };
}

function makePackedEntry(chunk, index, manifestUrl) {
  const file = chunk.file || chunk.path || "";
  if (!file) return null;
  const bounds = transformPackedBounds(chunk.bounds);
  const center = transformPackedPoint(chunk.center) || (bounds ? boundsCenter(bounds) : null);
  if (!center) return null;

  return {
    index,
    mesh: chunk,
    category: chunk.category || "level",
    visible: true,
    url: new URL(file, manifestUrl),
    center,
    bounds,
    objects: packedProbeObjects(chunk),
    state: "pending",
    chunk: null,
    binary: true,
    compression: chunk.compression || null,
  };
}

function packedProbeObjects(chunk) {
  if (!Array.isArray(chunk.objects)) return [];
  return chunk.objects
    .map((object) => {
      const bounds = transformPackedBounds(object.bounds);
      const center = transformPackedPoint(object.center) || (bounds ? boundsCenter(bounds) : null);
      if (!center) return null;
      return {
        ...object,
        center,
        bounds,
        radius: boundsRadius(bounds),
      };
    })
    .filter(Boolean);
}

function isBackdropMesh(mesh) {
  const haystack = [
    mesh.name,
    mesh.sourceMesh,
    mesh.sourcePackage,
    mesh.component,
    mesh.componentType,
    mesh.file,
  ].filter(Boolean).join(" ").toLowerCase();

  return haystack.includes("/backdrop/") ||
    haystack.includes("sm_mcp_backdrop") ||
    haystack.includes("sm_staticcloudssphere") ||
    haystack.includes("/volumeclouds/") ||
    haystack.includes("/environment/north/") ||
    haystack.includes("/environment/south/") ||
    haystack.includes("/environment/nature/") ||
    haystack.includes("volcanicred") ||
    haystack.includes("cliff_xl") ||
    haystack.includes("rock_xl") ||
    haystack.includes("ledge_xl") ||
    haystack.includes("skysphere") ||
    haystack.includes("sky_sphere");
}

function applyEntryVisibility(resetCamera) {
  scene.visibleMeshCount = 0;
  scene.hiddenBackdropCount = 0;

  for (const entry of scene.entries) {
    entry.visible = !isHiddenSceneryCategory(entry.category) || settings.showBackdrop;
    if (entry.visible) {
      scene.visibleMeshCount += 1;
    } else {
      scene.hiddenBackdropCount += 1;
      if (entry.chunk) disposeChunk(entry.chunk);
    }
  }

  rebuildSceneBounds();
  if (resetCamera) {
    placeCamera();
    scheduleStreaming(true);
  }
  setStatus(makeStats());
}

function isHiddenSceneryCategory(category) {
  return category === "backdrop" || category === "scenery";
}

function rebuildSceneBounds() {
  const visible = scene.entries.filter((entry) => entry.visible);
  const levelEntries = visible.filter((entry) => !isHiddenSceneryCategory(entry.category));
  const points = (levelEntries.length ? levelEntries : visible).map((entry) => entry.center);
  const trim = scene.format === "packed" ? 0.05 : 0.01;
  scene.bounds = points.length > 24 ? makeTrimmedBounds(points, trim, 1 - trim) : makePointBounds(points);
}

function addMesh(parsed, entry) {
  const vao = gl.createVertexArray();
  const positionBuffer = gl.createBuffer();
  const indexBuffer = parsed.indices ? gl.createBuffer() : null;
  const positionLoc = gl.getAttribLocation(scene.program, "aPosition");
  const materialLoc = gl.getAttribLocation(scene.program, "aMaterial");
  const vertexCount = parsed.positions.length / 3;

  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, parsed.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 3, gl.FLOAT, false, 0, 0);

  // Per-vertex material id: objects are packed contiguously in manifest order,
  // so each object's vertex range gets its classified material (1 byte/vertex).
  const materialBuffer = gl.createBuffer();
  const materials = buildMaterialIds(entry, vertexCount);
  gl.bindBuffer(gl.ARRAY_BUFFER, materialBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, materials, gl.STATIC_DRAW);
  if (materialLoc >= 0) {
    gl.enableVertexAttribArray(materialLoc);
    gl.vertexAttribIPointer(materialLoc, 1, gl.UNSIGNED_BYTE, 0, 0);
  }

  if (indexBuffer) {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, parsed.indices, gl.STATIC_DRAW);
  }

  gl.bindVertexArray(null);

  const indexCount = parsed.indices ? parsed.indices.length : vertexCount;
  const chunk = {
    vao,
    positionBuffer,
    indexBuffer,
    materialBuffer,
    count: indexCount,
    vertexCount,
    indexCount,
    entryIndex: entry.index,
    center: entry.center,
    bounds: parsed.bounds || entry.bounds || null,
    objects: entry.objects || [],
    radius: boundsRadius(parsed.bounds || entry.bounds),
  };
  scene.chunks.push(chunk);
  scene.meshCount += 1;
  scene.loadedEverCount += 1;
  scene.vertexCount += chunk.vertexCount;
  scene.indexCount += chunk.indexCount;
  return chunk;
}

function parseObj(text, parentTransform = null) {
  const vertices = [[0, 0, 0]];
  const positions = [];
  const bounds = createBounds();

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line[0] === "#") continue;

    const parts = line.split(/\s+/);
    if (parts[0] === "v" && parts.length >= 4) {
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      const point = parentTransform ? transformUnrealPoint([x, y, z], parentTransform) : [x, y, z];
      vertices.push(unrealToViewerPoint(point));
    } else if (parts[0] === "f" && parts.length >= 4) {
      const face = parts.slice(1).map((token) => parseObjIndex(token, vertices.length));
      for (let i = 1; i < face.length - 1; i += 1) {
        pushTriangle(vertices[face[0]], vertices[face[i]], vertices[face[i + 1]], positions, bounds);
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    bounds,
  };
}

function parsePackedChunk(buffer, bounds) {
  if (buffer.byteLength < 16) throw new Error("packed chunk is too small");
  const magic = Array.from(new Uint8Array(buffer, 0, 8), (value) => String.fromCharCode(value)).join("");
  if (magic !== "STLBIN1\0") throw new Error("packed chunk has an unknown header");

  const view = new DataView(buffer);
  const vertexCount = view.getUint32(8, true);
  const indexCount = view.getUint32(12, true);
  const positionOffset = 16;
  const positionBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  const indexOffset = positionOffset + positionBytes;
  const indexBytes = indexCount * Uint32Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength < indexOffset + indexBytes) {
    throw new Error("packed chunk is truncated");
  }

  return {
    positions: new Float32Array(buffer, positionOffset, vertexCount * 3),
    indices: new Uint32Array(buffer, indexOffset, indexCount),
    bounds: bounds || boundsFromPositions(new Float32Array(buffer, positionOffset, vertexCount * 3)),
  };
}

function parseObjIndex(token, vertexCount) {
  const value = Number(token.split("/")[0]);
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? vertexCount + value : value;
}

function pushTriangle(a, b, c, positions, bounds) {
  if (!a || !b || !c) return;

  for (const point of [a, b, c]) {
    positions.push(point[0], point[1], point[2]);
    includePoint(bounds, point);
  }
}

function placeCamera() {
  const center = boundsCenter(scene.bounds);
  const size = boundsSize(scene.bounds);
  const maxSize = Math.max(size[0], size[1], size[2], 1);
  scene.center = center;
  scene.baseScale = 36 / maxSize;
  scene.baseRadius = maxSize * scene.baseScale * 0.5;
  applySceneScale(false);
  const defaultPosition = Array.isArray(DEFAULT_CAMERA.position) && DEFAULT_CAMERA.position.length >= 3
    ? DEFAULT_CAMERA.position
    : null;
  if (defaultPosition) {
    camera.position = [
      (defaultPosition[0] - scene.center[0]) * scene.scale,
      (defaultPosition[1] - scene.center[1]) * scene.scale,
      (defaultPosition[2] - scene.center[2]) * scene.scale,
    ];
  } else {
    const height = Math.max(4, scene.radius * 0.45);
    const distance = Math.max(4, scene.radius * 0.38);
    camera.position = [0, height, distance];
  }
  yaw = degreesToRadians(Number.isFinite(DEFAULT_CAMERA.heading) ? DEFAULT_CAMERA.heading : 0);
  pitch = clamp(
    degreesToRadians(Number.isFinite(DEFAULT_CAMERA.pitch) ? DEFAULT_CAMERA.pitch : -20),
    -1.48,
    1.48,
  );
  camera.speed = settings.speed;
  updateMovementSpeed();
}

function applyCameraQueryOverride() {
  const mapPosition = readQueryPoint(["x", "y", "z"]);
  if (mapPosition) {
    camera.position = [
      (mapPosition[0] - scene.center[0]) * scene.scale,
      (mapPosition[1] - scene.center[1]) * scene.scale,
      (mapPosition[2] - scene.center[2]) * scene.scale,
    ];
  }

  const heading = parseOptionalNumber(query.get("heading"));
  if (heading != null) yaw = degreesToRadians(heading);
  const queryPitch = parseOptionalNumber(query.get("pitch"));
  if (queryPitch != null) pitch = clamp(degreesToRadians(queryPitch), -1.48, 1.48);
}

function readQueryPoint(names) {
  const values = names.map((name) => parseOptionalNumber(query.get(name)));
  return values.every((value) => value != null) ? values : null;
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  updateHud(now);
  updateCamera(dt);
  updateStreaming(now);
  draw();
  drawAxisGizmo();
  updateTelemetry(now);
  requestAnimationFrame(frame);
}

function updateStreaming(now) {
  if (now - scene.lastStreamAt < STREAM_INTERVAL_MS) return;
  scene.lastStreamAt = now;
  unloadDistantMeshes();
  scheduleStreaming(false);
}

function updateHud(now) {
  if (now - scene.lastHudAt < HUD_UPDATE_INTERVAL_MS) return;
  scene.lastHudAt = now;
  updateMovementSpeed();
  updateSpeedLabel();
}

function scheduleStreaming(initial) {
  const maxConcurrentLoads = scene.format === "packed" ? PACKED_MAX_CONCURRENT_LOADS : OBJ_MAX_CONCURRENT_LOADS;
  const loadBatchSize = scene.format === "packed" ? PACKED_LOAD_BATCH_SIZE : OBJ_LOAD_BATCH_SIZE;
  if (scene.loadingCount >= maxConcurrentLoads) return;
  if (Number.isFinite(scene.residentBudget) && scene.meshCount + scene.loadingCount >= scene.residentBudget) {
    freeBudgetForCloserPending(initial);
  }

  const openSlots = Math.max(0, maxConcurrentLoads - scene.loadingCount);
  const budgetCapacity = Number.isFinite(scene.residentBudget)
    ? Math.max(0, scene.residentBudget - scene.meshCount - scene.loadingCount)
    : Number.POSITIVE_INFINITY;
  const loadCount = Math.min(loadBatchSize, openSlots, budgetCapacity);
  if (loadCount <= 0) {
    setStatus(makeStats());
    return;
  }

  const pendingCandidates = getPendingCandidates(initial);
  scene.pendingCandidateCount = pendingCandidates.length;
  const candidates = pendingCandidates.slice(0, loadCount);

  if (candidates.length === 0) {
    setStatus(makeStats());
    return;
  }

  for (const candidate of candidates) {
    candidate.entry.state = "queued";
    void loadEntry(candidate.entry);
  }
  setStatus(makeStats());
}

function getPendingCandidates(initial) {
  const loadAll = scene.entries.length <= scene.residentBudget || !Number.isFinite(scene.streamRadius);
  return scene.entries
    .filter((entry) => entry.visible && entry.state === "pending")
    .map((entry) => ({ entry, distance: entryDistance(entry), score: entryLoadScore(entry) }))
    .filter((candidate) => loadAll || initial || candidate.distance <= scene.streamRadius)
    .sort((a, b) => a.score - b.score);
}

function freeBudgetForCloserPending(initial) {
  const loadBatchSize = scene.format === "packed" ? PACKED_LOAD_BATCH_SIZE : OBJ_LOAD_BATCH_SIZE;
  const pending = getPendingCandidates(initial).slice(0, loadBatchSize);
  if (pending.length === 0) return;

  const loaded = scene.chunks
    .map((chunk) => ({ chunk, distance: chunkDistance(chunk) }))
    .sort((a, b) => b.distance - a.distance);

  for (let i = 0; i < pending.length && i < loaded.length; i += 1) {
    if (pending[i].distance + 0.75 >= loaded[i].distance) break;
    disposeChunk(loaded[i].chunk);
  }
}

async function loadEntry(entry) {
  scene.loadingCount += 1;
  setStatus(makeStats());
  try {
    const parsed = entry.binary
      ? parsePackedChunk(await fetchPackedArrayBuffer(entry), entry.bounds)
      : parseObj(await fetchText(entry.url), entry.mesh.parentTransform);
    const drawCount = parsed.indices ? parsed.indices.length : parsed.positions.length / 3;
    if (parsed.positions.length === 0 || drawCount === 0) throw new Error("empty mesh");
    if (!entry.visible) {
      entry.state = "pending";
      return;
    }
    entry.chunk = addMesh(parsed, entry);
    entry.state = "loaded";
  } catch (error) {
    entry.state = "failed";
    scene.failedCount += 1;
    console.warn("Skipping mesh", entry.mesh, error);
  } finally {
    scene.loadingCount -= 1;
    draw();
    drawAxisGizmo();
    setStatus(makeStats());
    scheduleStreaming(false);
    await nextPaint();
  }
}

async function fetchPackedArrayBuffer(entry) {
  let buffer = await fetchArrayBuffer(entry.url);
  const compression = entry.compression || scene.compression;
  if (compression === "gzip" && !hasPackedMagic(buffer)) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("gzip scene chunks require DecompressionStream support");
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    buffer = await new Response(stream).arrayBuffer();
  }
  return buffer;
}

function hasPackedMagic(buffer) {
  if (buffer.byteLength < 8) return false;
  const bytes = new Uint8Array(buffer, 0, 8);
  return bytes[0] === 0x53 &&
    bytes[1] === 0x54 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x42 &&
    bytes[4] === 0x49 &&
    bytes[5] === 0x4e &&
    bytes[6] === 0x31 &&
    bytes[7] === 0x00;
}

function unloadDistantMeshes() {
  if (!Number.isFinite(scene.residentBudget)) return;
  if (scene.meshCount < scene.residentBudget) return;

  const unloadDistance = scene.streamRadius * 1.35;
  const removable = scene.chunks
    .map((chunk) => ({ chunk, distance: chunkDistance(chunk) }))
    .filter((candidate) => candidate.distance > unloadDistance)
    .sort((a, b) => b.distance - a.distance);

  const targetCount = Math.floor(scene.residentBudget * 0.85);
  for (const candidate of removable) {
    if (scene.meshCount <= targetCount) break;
    disposeChunk(candidate.chunk);
  }
}

function disposeChunk(chunk) {
  const chunkIndex = scene.chunks.indexOf(chunk);
  if (chunkIndex < 0) return;
  scene.chunks.splice(chunkIndex, 1);
  const entry = scene.entries[chunk.entryIndex];
  if (entry) {
    entry.state = "pending";
    entry.chunk = null;
  }
  gl.deleteBuffer(chunk.positionBuffer);
  if (chunk.indexBuffer) gl.deleteBuffer(chunk.indexBuffer);
  if (chunk.materialBuffer) gl.deleteBuffer(chunk.materialBuffer);
  gl.deleteVertexArray(chunk.vao);
  scene.meshCount -= 1;
  scene.vertexCount -= chunk.vertexCount;
  scene.indexCount -= chunk.indexCount;
}

function updateCamera(dt) {
  if (spectate.active) {
    updateSpectateCamera(dt);
    return;
  }

  const forward = getForward();
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = [0, 1, 0];
  const movement = [0, 0, 0];

  if (keys.has("KeyW")) addScaled(movement, forward, 1);
  if (keys.has("KeyS")) addScaled(movement, forward, -1);
  if (keys.has("KeyD")) addScaled(movement, right, 1);
  if (keys.has("KeyA")) addScaled(movement, right, -1);
  if (keys.has("KeyE")) addScaled(movement, up, 1);
  if (keys.has("KeyQ")) addScaled(movement, up, -1);

  const len = length(movement);
  if (len > 0) {
    const boost = keys.has("ShiftLeft") || keys.has("ShiftRight") ? SHIFT_SPEED_MULTIPLIER : 1;
    addScaled(camera.position, movement, (camera.effectiveSpeed * boost * dt) / len);
  }
}

// Bird's-eye chase cam: hover above and pulled back from the target,
// always looking straight at them. No player facing-direction is sent over
// the wire (only bone positions), so this avoids guessing it and just uses
// a fixed world-space offset.
function updateSpectateCamera(dt) {
  const target = window.__telemetryGetSpectateTarget?.(spectate.targetId);
  if (!target) return; // player not currently in the stream -- hold last position

  const desired = [
    target.position[0] + SPECTATE_OFFSET[0],
    target.position[1] + SPECTATE_OFFSET[1],
    target.position[2] + SPECTATE_OFFSET[2],
  ];

  const t = 1 - Math.exp(-SPECTATE_FOLLOW_LERP * dt);
  camera.position[0] += (desired[0] - camera.position[0]) * t;
  camera.position[1] += (desired[1] - camera.position[1]) * t;
  camera.position[2] += (desired[2] - camera.position[2]) * t;

  const toTarget = subtract(target.position, camera.position);
  const horizLen = Math.hypot(toTarget[0], toTarget[2]) || 1e-6;
  yaw = Math.atan2(toTarget[0], -toTarget[2]);
  pitch = clamp(Math.atan2(toTarget[1], horizLen), -1.48, 1.48);
}

function applySceneScale(updateStatus) {
  if (!scene) return;
  scene.scale = scene.baseScale * settings.scale;
  scene.radius = scene.baseRadius * settings.scale;
  if (updateStatus) setStatus(makeStats());
}

function updateMovementSpeed() {
  camera.speed = settings.speed;
  camera.effectiveSpeed = settings.speed;
}

// ---- Atmosphere palette & post-processing (lighting + SSAO) ----
const SKY_COLOR = [0.44, 0.55, 0.72];
const GROUND_COLOR = [0.28, 0.29, 0.33];
const HORIZON_COLOR = [0.60, 0.67, 0.78];
const ZENITH_COLOR = [0.24, 0.40, 0.63];

// Per-material palette (indexed by classifyMaterial): albedo, metalness, snow affinity.
//   0 concrete   1 metal      2 cont.blue  3 cont.rust  4 cont.green 5 wire
//   6 rock       7 snowpile   8 debris     9 wood/crate 10 electronic 11 vehicle
//   12 android   13 foliage   14 fabric    15 dirt/ground
const MAT_COLOR = new Float32Array([
  0.40, 0.41, 0.44,   0.46, 0.49, 0.54,   0.16, 0.33, 0.50,   0.55, 0.30, 0.17,
  0.20, 0.40, 0.25,   0.05, 0.05, 0.06,   0.30, 0.27, 0.24,   0.90, 0.93, 1.00,
  0.34, 0.31, 0.27,   0.53, 0.38, 0.22,   0.11, 0.13, 0.18,   0.74, 0.60, 0.13,
  0.78, 0.80, 0.84,   0.17, 0.34, 0.16,   0.36, 0.31, 0.35,   0.27, 0.23, 0.18,
]);
const MAT_METAL = new Float32Array([
  0.15, 1.0, 0.7, 0.7, 0.7, 0.2, 0.05, 0.0,
  0.05, 0.05, 0.6, 0.8, 0.5, 0.0, 0.02, 0.0,
]);
const MAT_SNOW = new Float32Array([
  1.0, 0.9, 1.0, 1.0, 1.0, 0.0, 0.7, 1.6,
  0.8, 0.9, 0.3, 0.9, 0.5, 0.6, 0.6, 0.9,
]);
// Cinematic-only: perceptual roughness (0 smooth .. 1 rough) per material.
//   concrete metal cont.b cont.r cont.g wire  rock  snow  debris wood elec veh android foliage fabric dirt
const MAT_ROUGH = new Float32Array([
  0.85, 0.35, 0.55, 0.60, 0.55, 0.5, 0.9, 0.75,
  0.95, 0.8, 0.4, 0.45, 0.6, 0.8, 0.9, 0.95,
]);
// Cinematic-only: emissive colour (HDR) per material — electronics glow at dusk.
const MAT_EMISSIVE = new Float32Array([
  0, 0, 0,   0, 0, 0,   0, 0, 0,   0, 0, 0,
  0, 0, 0,   0, 0, 0,   0, 0, 0,   0, 0, 0,
  0, 0, 0,   0, 0, 0,   0.20, 1.30, 1.55,   0.10, 0.05, 0.0,
  0, 0, 0,   0, 0, 0,   0, 0, 0,   0, 0, 0,
]);

// Blue-hour dusk lighting (cinematic). All tunable.
const CINE_SUN_DIR = normalize([0.55, 0.18, 0.42]);      // low sun near horizon
const CINE_SUN_COLOR = [3.0, 1.85, 1.05];                // warm HDR key
const CINE_SKY_ZENITH = [0.10, 0.16, 0.30];              // deep blue overhead
const CINE_SKY_HORIZON = [0.55, 0.42, 0.38];             // warm glow at horizon
const CINE_GROUND_COLOR = [0.09, 0.10, 0.13];            // cool bounce (lifts shadows)
const CINE_EXPOSURE = 1.9;                               // keeps the dusk readable
const IDENTITY4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// Classify a manifest object into a material id from its mesh/source name.
function classifyMaterial(obj) {
  const s = `${obj.sourceMesh || ""} ${obj.name || ""}`;
  if (/Wire|Cable/i.test(s)) return 5;
  if (/Snowpile/i.test(s)) return 7;
  if (/Container/i.test(s)) return 2 + (hashString(obj.sourceMesh || obj.name || "") % 3);
  if (/Android|Robot|Drone|Mannequin/i.test(s)) return 12;
  if (/Console|Computer|FuseBox|Server|Screen|Monitor|Terminal|Keyboard|Antenna|Radio|Electron|CartComputer/i.test(s)) return 10;
  if (/Forklift|Trolley|\bCart\b|Loader|\bCrane\b|Vehicle|Truck|Wheel|\bTire\b|Train/i.test(s)) return 11;
  if (/Debris|Rubble|Scrap|Wreckage/i.test(s)) return 8;
  if (/Crate|Cardboard|Pallet|\bBox\b|Wood|Plank|Barrel|Shelf|Shelves|Bookcase|Cabinet|Table|Desk|Bench/i.test(s)) return 9;
  if (/Sofa|Chair|Cushion|Curtain|Carpet|\bBed\b|Mattress|Fabric|Cloth|Rug|Pillow/i.test(s)) return 14;
  if (/Planter|Plant|Foliage|Grass|Leaf|Moss|Bush|Fern|Seed|Flower|Ivy|Hedge/i.test(s)) return 13;
  if (/Rock|Cliff|Vine|Tree|Boulder|Shrub/i.test(s)) return 6;
  if (/Ground|Terrain|Dirt|Soil|Landscape|\bSand\b|\bMud\b|Gravel/i.test(s)) return 15;
  if (/Pipe|Duct|CableTray|Vent|Tank|MachineArm|Beam|Catwalk|Railing|Stair|Girder|Truss|Fence|Ladder|Metal|Grate|\bRail\b|Rebar|Track/i.test(s)) return 1;
  return 0;
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// One material id per vertex. Packed objects are contiguous in manifest order, so
// walk objects[] filling each object's vertex range with its classified material.
function buildMaterialIds(entry, vertexCount) {
  const materials = new Uint8Array(vertexCount); // default 0 = concrete
  const objects = entry && entry.mesh && Array.isArray(entry.mesh.objects) ? entry.mesh.objects : null;
  if (!objects || !objects.length) return materials;
  let v = 0;
  for (const o of objects) {
    const vc = o.vertices || 0;
    if (vc <= 0) continue;
    const end = Math.min(v + vc, vertexCount);
    if (end > v) materials.fill(classifyMaterial(o), v, end);
    v = end;
    if (v >= vertexCount) break;
  }
  return materials;
}

const postfx = {
  enabled: false,
  ready: false,
  width: 0,
  height: 0,
  mode: null,             // "fast" | "cinematic" — targets rebuild on change
  sceneFbo: null,
  colorTex: null,
  viewPosTex: null,
  viewNormalTex: null,
  depthRb: null,
  aoFbo: null,
  aoTex: null,
  aoWidth: 0,
  aoHeight: 0,
  compositeFbo: null,
  compositeTex: null,
  quadVao: null,
  ssao: null,
  composite: null,
  fxaa: null,
  kernel: null,
  // Cinematic-only targets/programs.
  shadowFbo: null,
  shadowTex: null,
  shadowSize: 2048,
  hdrFbo: null,
  hdrTex: null,
  bloomFboA: null,
  bloomTexA: null,
  bloomFboB: null,
  bloomTexB: null,
  bloomWidth: 0,
  bloomHeight: 0,
  shadow: null,
  cineComposite: null,
  bloomPrefilter: null,
  bloomBlur: null,
  tonemap: null,
};

function initPostFX() {
  // View-space position/normal need float render targets for enough precision.
  const ext = gl.getExtension("EXT_color_buffer_float");
  if (!ext) {
    console.warn("EXT_color_buffer_float unavailable; running with lighting only (no SSAO).");
    postfx.enabled = false;
    return;
  }
  postfx.enabled = true;
  const shadowmapReq = parseInt(query.get("shadowmap"), 10);
  if ([1024, 2048, 4096].includes(shadowmapReq)) postfx.shadowSize = shadowmapReq;

  const ssaoProgram = createProgram(FULLSCREEN_VERTEX_SOURCE, SSAO_FRAGMENT_SOURCE);
  postfx.ssao = {
    program: ssaoProgram,
    uniforms: {
      viewPos: gl.getUniformLocation(ssaoProgram, "uViewPos"),
      viewNormal: gl.getUniformLocation(ssaoProgram, "uViewNormal"),
      projection: gl.getUniformLocation(ssaoProgram, "uProjection"),
      kernel: gl.getUniformLocation(ssaoProgram, "uKernel"),
      radius: gl.getUniformLocation(ssaoProgram, "uRadius"),
      bias: gl.getUniformLocation(ssaoProgram, "uBias"),
      strength: gl.getUniformLocation(ssaoProgram, "uStrength"),
    },
  };

  const compositeProgram = createProgram(FULLSCREEN_VERTEX_SOURCE, COMPOSITE_FRAGMENT_SOURCE);
  postfx.composite = {
    program: compositeProgram,
    uniforms: {
      color: gl.getUniformLocation(compositeProgram, "uColor"),
      viewPos: gl.getUniformLocation(compositeProgram, "uViewPos"),
      ao: gl.getUniformLocation(compositeProgram, "uAO"),
      texel: gl.getUniformLocation(compositeProgram, "uTexel"),
      aoPower: gl.getUniformLocation(compositeProgram, "uAOPower"),
      zenithColor: gl.getUniformLocation(compositeProgram, "uZenithColor"),
      horizonColor: gl.getUniformLocation(compositeProgram, "uHorizonColor"),
    },
  };

  const fxaaProgram = createProgram(FULLSCREEN_VERTEX_SOURCE, FXAA_FRAGMENT_SOURCE);
  postfx.fxaa = {
    program: fxaaProgram,
    uniforms: {
      image: gl.getUniformLocation(fxaaProgram, "uImage"),
      texel: gl.getUniformLocation(fxaaProgram, "uTexel"),
    },
  };

  // Cinematic programs. Uniforms keyed by their GLSL name (arrays stripped of [0]).
  const collect = (program, names) => {
    const u = {};
    for (const n of names) u[n.replace("[0]", "")] = gl.getUniformLocation(program, n);
    return { program, u };
  };
  postfx.shadow = collect(createProgram(SHADOW_VERTEX_SOURCE, SHADOW_FRAGMENT_SOURCE),
    ["uCenter", "uScale", "uPositionScale", "uLightViewProj"]);
  postfx.cineScene = collect(createProgram(VERTEX_SOURCE, CINEMATIC_FRAGMENT_SOURCE),
    ["uProjection", "uView", "uCenter", "uScale", "uPositionScale", "uLight", "uCamPos",
     "uSunColor", "uSkyZenith", "uSkyHorizon", "uGroundColor", "uFogColor", "uFogDensity",
     "uDetailScale", "uOpacity", "uLightViewProj", "uShadowMap", "uShadowTexel", "uShadowEnable",
     "uMatColor[0]", "uMatMetal[0]", "uMatRough[0]", "uMatEmissive[0]", "uMatSnow[0]"]);
  postfx.cineComposite = collect(createProgram(FULLSCREEN_VERTEX_SOURCE, CINE_COMPOSITE_FRAGMENT_SOURCE),
    ["uColor", "uViewPos", "uAO", "uTexel", "uAOPower", "uSunColor", "uLight", "uSkyZenith",
     "uSkyHorizon", "uCamForward", "uCamRight", "uCamUp", "uTanHalfFov", "uAspect"]);
  postfx.bloomPrefilter = collect(createProgram(FULLSCREEN_VERTEX_SOURCE, BLOOM_PREFILTER_FRAGMENT_SOURCE),
    ["uImage", "uThreshold"]);
  postfx.bloomBlur = collect(createProgram(FULLSCREEN_VERTEX_SOURCE, BLOOM_BLUR_FRAGMENT_SOURCE),
    ["uImage", "uDir"]);
  postfx.tonemap = collect(createProgram(FULLSCREEN_VERTEX_SOURCE, TONEMAP_FRAGMENT_SOURCE),
    ["uHdr", "uBloom", "uExposure", "uBloomStrength"]);

  postfx.quadVao = gl.createVertexArray();
  postfx.kernel = makeSsaoKernel(16);
  postfx.ready = true;
}

function makeSsaoKernel(count) {
  const kernel = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    let x = Math.random() * 2 - 1;
    let y = Math.random() * 2 - 1;
    let z = Math.random();                         // hemisphere around +Z
    const len = Math.hypot(x, y, z) || 1;
    x /= len; y /= len; z /= len;
    let scale = i / count;
    scale = 0.1 + 0.9 * scale * scale;             // bias toward the origin
    kernel[i * 3] = x * scale;
    kernel[i * 3 + 1] = y * scale;
    kernel[i * 3 + 2] = z * scale;
  }
  return kernel;
}

function ensureTargets(width, height, mode) {
  if (postfx.width === width && postfx.height === height && postfx.mode === mode && postfx.sceneFbo) return;
  postfx.width = width;
  postfx.height = height;
  postfx.mode = mode;
  const cinematic = mode === "cinematic";

  for (const t of [postfx.colorTex, postfx.viewPosTex, postfx.viewNormalTex, postfx.aoTex,
    postfx.compositeTex, postfx.shadowTex, postfx.hdrTex, postfx.bloomTexA, postfx.bloomTexB]) if (t) gl.deleteTexture(t);
  if (postfx.depthRb) gl.deleteRenderbuffer(postfx.depthRb);
  for (const fb of [postfx.sceneFbo, postfx.aoFbo, postfx.compositeFbo, postfx.shadowFbo,
    postfx.hdrFbo, postfx.bloomFboA, postfx.bloomFboB]) if (fb) gl.deleteFramebuffer(fb);
  postfx.shadowTex = postfx.shadowFbo = postfx.hdrTex = postfx.hdrFbo = null;
  postfx.bloomTexA = postfx.bloomTexB = postfx.bloomFboA = postfx.bloomFboB = null;

  const makeTex = (internal, format, type, filter, w, h) => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  };
  const makeFbo = (tex) => {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return fbo;
  };

  // Scene colour is HDR (RGBA16F) in cinematic mode so lighting can exceed 1.0.
  postfx.colorTex = cinematic
    ? makeTex(gl.RGBA16F, gl.RGBA, gl.FLOAT, gl.LINEAR, width, height)
    : makeTex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, width, height);
  postfx.viewPosTex = makeTex(gl.RGBA16F, gl.RGBA, gl.FLOAT, gl.NEAREST, width, height);
  postfx.viewNormalTex = makeTex(gl.RGBA16F, gl.RGBA, gl.FLOAT, gl.NEAREST, width, height);

  postfx.depthRb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, postfx.depthRb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);

  postfx.sceneFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, postfx.sceneFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, postfx.colorTex, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, postfx.viewPosTex, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, postfx.viewNormalTex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, postfx.depthRb);

  // SSAO runs at half resolution (it's low-frequency; big fill-rate saving).
  postfx.aoWidth = Math.max(1, Math.floor(width / 2));
  postfx.aoHeight = Math.max(1, Math.floor(height / 2));
  postfx.aoTex = makeTex(gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.LINEAR, postfx.aoWidth, postfx.aoHeight);
  postfx.aoFbo = makeFbo(postfx.aoTex);

  // LDR target (FXAA input; also the tonemap output in cinematic mode).
  postfx.compositeTex = makeTex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, width, height);
  postfx.compositeFbo = makeFbo(postfx.compositeTex);

  if (cinematic) {
    // Shadow depth map.
    const size = postfx.shadowSize;
    const st = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, st);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    postfx.shadowTex = st;
    postfx.shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, postfx.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, st, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);

    // HDR composite target + quarter-res bloom ping-pong.
    postfx.hdrTex = makeTex(gl.RGBA16F, gl.RGBA, gl.FLOAT, gl.LINEAR, width, height);
    postfx.hdrFbo = makeFbo(postfx.hdrTex);
    postfx.bloomWidth = Math.max(1, Math.floor(width / 4));
    postfx.bloomHeight = Math.max(1, Math.floor(height / 4));
    postfx.bloomTexA = makeTex(gl.RGBA16F, gl.RGBA, gl.FLOAT, gl.LINEAR, postfx.bloomWidth, postfx.bloomHeight);
    postfx.bloomFboA = makeFbo(postfx.bloomTexA);
    postfx.bloomTexB = makeTex(gl.RGBA16F, gl.RGBA, gl.FLOAT, gl.LINEAR, postfx.bloomWidth, postfx.bloomHeight);
    postfx.bloomFboB = makeFbo(postfx.bloomTexB);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function drawChunks(forward) {
  scene.drawnMeshCount = 0;
  scene.drawnVertexCount = 0;
  scene.drawnIndexCount = 0;
  for (const chunk of scene.chunks) {
    if (!shouldDrawChunk(chunk, forward)) continue;
    gl.bindVertexArray(chunk.vao);
    if (chunk.indexBuffer) {
      gl.drawElements(gl.TRIANGLES, chunk.count, gl.UNSIGNED_INT, 0);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, chunk.count);
    }
    scene.drawnMeshCount += 1;
    scene.drawnVertexCount += chunk.vertexCount;
    scene.drawnIndexCount += chunk.indexCount;
  }
  gl.bindVertexArray(null);
}

// Render scene depth from the sun's POV; returns the light view-projection matrix.
function renderShadowMap() {
  const L = CINE_SUN_DIR;
  const R = Math.max(scene.radius * 1.25, 20);
  const c = camera.position;
  const eye = [c[0] + L[0] * R * 2, c[1] + L[1] * R * 2, c[2] + L[2] * R * 2];
  const up = Math.abs(L[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
  const lightView = lookFrom(eye, [-L[0], -L[1], -L[2]], up);
  const lightProj = ortho(-R, R, -R, R, 0.1, R * 4);
  const lightViewProj = mat4mul(lightProj, lightView);

  gl.bindFramebuffer(gl.FRAMEBUFFER, postfx.shadowFbo);
  gl.viewport(0, 0, postfx.shadowSize, postfx.shadowSize);
  gl.enable(gl.DEPTH_TEST);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(2.0, 4.0);
  gl.useProgram(postfx.shadow.program);
  gl.uniform3fv(postfx.shadow.u.uCenter, scene.center);
  gl.uniform1f(postfx.shadow.u.uScale, scene.scale);
  gl.uniform3fv(postfx.shadow.u.uPositionScale, scene.positionScale);
  gl.uniformMatrix4fv(postfx.shadow.u.uLightViewProj, false, lightViewProj);
  for (const chunk of scene.chunks) {
    gl.bindVertexArray(chunk.vao);
    if (chunk.indexBuffer) gl.drawElements(gl.TRIANGLES, chunk.count, gl.UNSIGNED_INT, 0);
    else gl.drawArrays(gl.TRIANGLES, 0, chunk.count);
  }
  gl.bindVertexArray(null);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  return lightViewProj;
}

function draw() {
  const width = canvas.width;
  const height = canvas.height;
  const aspect = width / Math.max(height, 1);
  const projection = perspective(Math.PI / 3, aspect, 0.02, Math.max(1000, scene.radius * 24));
  const forward = getForward();
  const view = lookFrom(camera.position, forward, [0, 1, 0]);

  const usePostFX = postfx.ready && settings.postFx && !settings.xray;
  const cinematic = usePostFX && settings.cinematic;

  let lightViewProj = null;
  if (usePostFX) {
    ensureTargets(width, height, cinematic ? "cinematic" : "fast");
    if (cinematic && settings.shadows) lightViewProj = renderShadowMap();
    gl.bindFramebuffer(gl.FRAMEBUFFER, postfx.sceneFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawBuffers([gl.BACK]);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.018, 0.022, 0.028, 1);
  }
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  applyRenderMode();

  if (cinematic) {
    const p = postfx.cineScene;
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.u.uProjection, false, projection);
    gl.uniformMatrix4fv(p.u.uView, false, view);
    gl.uniform3fv(p.u.uCenter, scene.center);
    gl.uniform1f(p.u.uScale, scene.scale);
    gl.uniform3fv(p.u.uPositionScale, scene.positionScale);
    gl.uniform3fv(p.u.uLight, CINE_SUN_DIR);
    gl.uniform3fv(p.u.uCamPos, camera.position);
    gl.uniform3fv(p.u.uSunColor, CINE_SUN_COLOR);
    gl.uniform3fv(p.u.uSkyZenith, CINE_SKY_ZENITH);
    gl.uniform3fv(p.u.uSkyHorizon, CINE_SKY_HORIZON);
    gl.uniform3fv(p.u.uGroundColor, CINE_GROUND_COLOR);
    gl.uniform3fv(p.u.uFogColor, CINE_SKY_HORIZON);
    gl.uniform1f(p.u.uFogDensity, 0.28 / Math.max(scene.radius, 1));
    gl.uniform1f(p.u.uDetailScale, 1.1);
    gl.uniform1f(p.u.uOpacity, 1);
    gl.uniformMatrix4fv(p.u.uLightViewProj, false, lightViewProj || IDENTITY4);
    gl.uniform2f(p.u.uShadowTexel, 1 / postfx.shadowSize, 1 / postfx.shadowSize);
    gl.uniform1f(p.u.uShadowEnable, lightViewProj ? 1 : 0);
    gl.uniform3fv(p.u.uMatColor, MAT_COLOR);
    gl.uniform1fv(p.u.uMatMetal, MAT_METAL);
    gl.uniform1fv(p.u.uMatRough, MAT_ROUGH);
    gl.uniform3fv(p.u.uMatEmissive, MAT_EMISSIVE);
    gl.uniform1fv(p.u.uMatSnow, MAT_SNOW);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, postfx.shadowTex);
    gl.uniform1i(p.u.uShadowMap, 0);
  } else {
    gl.useProgram(scene.program);
    gl.uniformMatrix4fv(scene.uniforms.projection, false, projection);
    gl.uniformMatrix4fv(scene.uniforms.view, false, view);
    gl.uniform3fv(scene.uniforms.center, scene.center);
    gl.uniform1f(scene.uniforms.scale, scene.scale);
    gl.uniform3fv(scene.uniforms.positionScale, scene.positionScale);
    const worldLight = normalize([0.4, 0.85, 0.3]);
    const viewLight = [
      view[0] * worldLight[0] + view[4] * worldLight[1] + view[8] * worldLight[2],
      view[1] * worldLight[0] + view[5] * worldLight[1] + view[9] * worldLight[2],
      view[2] * worldLight[0] + view[6] * worldLight[1] + view[10] * worldLight[2],
    ];
    gl.uniform3fv(scene.uniforms.light, worldLight);
    gl.uniform3fv(scene.uniforms.viewLight, viewLight);
    gl.uniform1f(scene.uniforms.opacity, settings.xray ? 0.22 : 1);
    gl.uniform1f(scene.uniforms.fogDensity, 0.4 / Math.max(scene.radius, 1));
    gl.uniform1f(scene.uniforms.detailScale, 1.1);
    gl.uniform3fv(scene.uniforms.skyColor, SKY_COLOR);
    gl.uniform3fv(scene.uniforms.groundColor, GROUND_COLOR);
    gl.uniform3fv(scene.uniforms.horizonColor, HORIZON_COLOR);
    gl.uniform3fv(scene.uniforms.matColor, MAT_COLOR);
    gl.uniform1fv(scene.uniforms.matMetal, MAT_METAL);
    gl.uniform1fv(scene.uniforms.matSnow, MAT_SNOW);
  }

  drawChunks(forward);
  if (settings.xray) gl.depthMask(true);

  // Live player-stream overlay (Telementry → Cloudflare Tunnel → this viewer).
  // We invoke it between the scene depth write and postFX so postFX (FXAA,
  // bloom, etc.) is applied on top of it. depthTest is always true here —
  // the map's own X-ray toggle (settings.xray) only affects map geometry
  // opacity above, it does NOT control whether streamed players are
  // occluded by walls. stream.js decides that itself, based solely on
  // whether the server has tagged the current frame as simulated test
  // data, so occlusion-bypass can never be switched on for a real match.
  const viewProj = mat4mul(projection, view);
  window.renderLiveStreamOverlay?.(gl, viewProj, { depthTest: true }, {
    positionScale: scene.positionScale,
    center: scene.center,
    scale: scene.scale,
  });

  if (cinematic) runPostFXCinematic(projection, forward, aspect, width, height);
  else if (usePostFX) runPostFX(projection, width, height);
}

function runPostFXCinematic(projection, forward, aspect, width, height) {
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.depthMask(false);
  gl.bindVertexArray(postfx.quadVao);

  // SSAO (half res).
  gl.bindFramebuffer(gl.FRAMEBUFFER, postfx.aoFbo);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  gl.viewport(0, 0, postfx.aoWidth, postfx.aoHeight);
  gl.useProgram(postfx.ssao.program);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, postfx.viewPosTex);
  gl.uniform1i(postfx.ssao.uniforms.viewPos, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, postfx.viewNormalTex);
  gl.uniform1i(postfx.ssao.uniforms.viewNormal, 1);
  gl.uniformMatrix4fv(postfx.ssao.uniforms.projection, false, projection);
  gl.uniform3fv(postfx.ssao.uniforms.kernel, postfx.kernel);
  gl.uniform1f(postfx.ssao.uniforms.radius, Math.max(scene.radius * 0.03, 0.15));
  gl.uniform1f(postfx.ssao.uniforms.bias, 0.02);
  gl.uniform1f(postfx.ssao.uniforms.strength, 1.5);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // HDR composite (lit * AO + analytic sky) into hdrTex.
  const right = normalize(cross(forward, [0, 1, 0]));
  const camUp = normalize(cross(right, forward));
  const tanHalf = Math.tan(Math.PI / 6);
  const cc = postfx.cineComposite;
  gl.bindFramebuffer(gl.FRAMEBUFFER, postfx.hdrFbo);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  gl.viewport(0, 0, width, height);
  gl.useProgram(cc.program);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, postfx.colorTex);
  gl.uniform1i(cc.u.uColor, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, postfx.viewPosTex);
  gl.uniform1i(cc.u.uViewPos, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, postfx.aoTex);
  gl.uniform1i(cc.u.uAO, 2);
  gl.uniform2f(cc.u.uTexel, 1 / postfx.aoWidth, 1 / postfx.aoHeight);
  gl.uniform1f(cc.u.uAOPower, 1.2);
  gl.uniform3fv(cc.u.uSunColor, CINE_SUN_COLOR);
  gl.uniform3fv(cc.u.uLight, CINE_SUN_DIR);
  gl.uniform3fv(cc.u.uSkyZenith, CINE_SKY_ZENITH);
  gl.uniform3fv(cc.u.uSkyHorizon, CINE_SKY_HORIZON);
  gl.uniform3fv(cc.u.uCamForward, forward);
  gl.uniform3fv(cc.u.uCamRight, right);
  gl.uniform3fv(cc.u.uCamUp, camUp);
  gl.uniform1f(cc.u.uTanHalfFov, tanHalf);
  gl.uniform1f(cc.u.uAspect, aspect);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // Bloom: bright-pass to quarter-res, then separable blur (ping-pong).
  gl.viewport(0, 0, postfx.bloomWidth, postfx.bloomHeight);
  gl.bindFramebuffer(gl.FRAMEBUFFER, postfx.bloomFboA);
  gl.useProgram(postfx.bloomPrefilter.program);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, postfx.hdrTex);
  gl.uniform1i(postfx.bloomPrefilter.u.uImage, 0);
  gl.uniform1f(postfx.bloomPrefilter.u.uThreshold, 1.1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.useProgram(postfx.bloomBlur.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, postfx.bloomFboB);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, postfx.bloomTexA);
  gl.uniform1i(postfx.bloomBlur.u.uImage, 0);
  gl.uniform2f(postfx.bloomBlur.u.uDir, 1 / postfx.bloomWidth, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, postfx.bloomFboA);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, postfx.bloomTexB);
  gl.uniform2f(postfx.bloomBlur.u.uDir, 0, 1 / postfx.bloomHeight);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // Tonemap (exposure + bloom + filmic + grade) to the LDR target.
  gl.viewport(0, 0, width, height);
  gl.bindFramebuffer(gl.FRAMEBUFFER, postfx.compositeFbo);
  gl.useProgram(postfx.tonemap.program);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, postfx.hdrTex);
  gl.uniform1i(postfx.tonemap.u.uHdr, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, postfx.bloomTexA);
  gl.uniform1i(postfx.tonemap.u.uBloom, 1);
  gl.uniform1f(postfx.tonemap.u.uExposure, settings.exposure || CINE_EXPOSURE);
  gl.uniform1f(postfx.tonemap.u.uBloomStrength, 0.75);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // FXAA to the canvas.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.drawBuffers([gl.BACK]);
  gl.viewport(0, 0, width, height);
  gl.useProgram(postfx.fxaa.program);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, postfx.compositeTex);
  gl.uniform1i(postfx.fxaa.uniforms.image, 0);
  gl.uniform2f(postfx.fxaa.uniforms.texel, 1 / width, 1 / height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.bindVertexArray(null);
  gl.enable(gl.DEPTH_TEST);
  gl.depthMask(true);
}

function runPostFX(projection, width, height) {
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.depthMask(false);
  gl.bindVertexArray(postfx.quadVao);

  // SSAO pass (half resolution).
  gl.bindFramebuffer(gl.FRAMEBUFFER, postfx.aoFbo);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  gl.viewport(0, 0, postfx.aoWidth, postfx.aoHeight);
  gl.useProgram(postfx.ssao.program);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, postfx.viewPosTex);
  gl.uniform1i(postfx.ssao.uniforms.viewPos, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, postfx.viewNormalTex);
  gl.uniform1i(postfx.ssao.uniforms.viewNormal, 1);
  gl.uniformMatrix4fv(postfx.ssao.uniforms.projection, false, projection);
  gl.uniform3fv(postfx.ssao.uniforms.kernel, postfx.kernel);
  gl.uniform1f(postfx.ssao.uniforms.radius, Math.max(scene.radius * 0.03, 0.15));
  gl.uniform1f(postfx.ssao.uniforms.bias, 0.02);
  gl.uniform1f(postfx.ssao.uniforms.strength, 1.4);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // Composite (lit colour * AO + sky + tonemap) into a texture.
  gl.bindFramebuffer(gl.FRAMEBUFFER, postfx.compositeFbo);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  gl.viewport(0, 0, width, height);
  gl.useProgram(postfx.composite.program);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, postfx.colorTex);
  gl.uniform1i(postfx.composite.uniforms.color, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, postfx.viewPosTex);
  gl.uniform1i(postfx.composite.uniforms.viewPos, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, postfx.aoTex);
  gl.uniform1i(postfx.composite.uniforms.ao, 2);
  gl.uniform2f(postfx.composite.uniforms.texel, 1 / postfx.aoWidth, 1 / postfx.aoHeight);
  gl.uniform1f(postfx.composite.uniforms.aoPower, 1.15);
  gl.uniform3fv(postfx.composite.uniforms.zenithColor, ZENITH_COLOR);
  gl.uniform3fv(postfx.composite.uniforms.horizonColor, HORIZON_COLOR);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // FXAA pass to the canvas (cheap edge antialiasing).
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.drawBuffers([gl.BACK]);
  gl.viewport(0, 0, width, height);
  gl.useProgram(postfx.fxaa.program);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, postfx.compositeTex);
  gl.uniform1i(postfx.fxaa.uniforms.image, 0);
  gl.uniform2f(postfx.fxaa.uniforms.texel, 1 / width, 1 / height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.bindVertexArray(null);
  gl.enable(gl.DEPTH_TEST);
  gl.depthMask(true);
}

function applyRenderMode() {
  if (settings.xray) {
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    return;
  }

  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.depthMask(true);
}

function shouldDrawChunk(chunk, forward) {
  const center = normalizeScenePoint(chunk.center);
  const toCenter = subtract(center, camera.position);
  const distance = length(toCenter);
  if (!Number.isFinite(distance)) return false;
  const radius = chunk.radius * scene.scale;
  if (distance < Math.max(8, radius * 1.5)) return true;
  if (distance > scene.streamRadius * 1.6 + radius && distance > scene.radius * 1.1 + radius) return false;
  if (distance < 6) return true;
  const padding = Math.min(0.65, radius / Math.max(distance, 0.001));
  return dot(toCenter, forward) / distance > -0.2 - padding;
}

function getForward() {
  const cp = Math.cos(pitch);
  return normalize([
    Math.sin(yaw) * cp,
    Math.sin(pitch),
    -Math.cos(yaw) * cp,
  ]);
}

function drawAxisGizmo() {
  if (!axisContext || !axisCanvas) return;

  const width = axisCanvas.width;
  const height = axisCanvas.height;
  axisContext.clearRect(0, 0, width, height);
  axisContext.save();
  axisContext.scale(width / axisCanvas.clientWidth, height / axisCanvas.clientHeight);

  const size = axisCanvas.clientWidth;
  const origin = [size * 0.5, size * 0.54];
  const axisLength = size * 0.32;
  const forward = getForward();
  const cameraRight = normalize(cross(forward, [0, 1, 0]));
  const cameraUp = normalize(cross(cameraRight, forward));
  const axes = [
    { label: "X", color: "#ff5a5f", vector: [1, 0, 0] },
    { label: "Y", color: "#5ee079", vector: [0, 1, 0] },
    { label: "Z", color: "#5aa7ff", vector: [0, 0, 1] },
  ].map((axis) => ({
    ...axis,
    projected: projectAxisVector(axis.vector, cameraRight, cameraUp, axisLength),
    depth: dot(axis.vector, forward),
  })).sort((a, b) => a.depth - b.depth);

  axisContext.lineCap = "round";
  axisContext.lineJoin = "round";
  axisContext.font = "700 12px Inter, ui-sans-serif, system-ui, sans-serif";
  axisContext.textAlign = "center";
  axisContext.textBaseline = "middle";

  axisContext.strokeStyle = "rgba(255, 255, 255, 0.18)";
  axisContext.lineWidth = 1;
  axisContext.beginPath();
  axisContext.arc(origin[0], origin[1], size * 0.04, 0, Math.PI * 2);
  axisContext.stroke();

  for (const axis of axes) {
    drawAxisHalf(origin, [-axis.projected[0], -axis.projected[1]], axis.color, 0.34);
  }
  for (const axis of axes) {
    drawAxisHalf(origin, axis.projected, axis.color, 1);
    drawAxisLabel(origin, axis.projected, axis.label, axis.color);
  }

  axisContext.restore();
}

function projectAxisVector(vector, cameraRight, cameraUp, axisLength) {
  return [
    dot(vector, cameraRight) * axisLength,
    -dot(vector, cameraUp) * axisLength,
  ];
}

function drawAxisHalf(origin, projected, color, alpha) {
  axisContext.globalAlpha = alpha;
  axisContext.strokeStyle = color;
  axisContext.lineWidth = alpha >= 1 ? 3 : 2;
  axisContext.beginPath();
  axisContext.moveTo(origin[0], origin[1]);
  axisContext.lineTo(origin[0] + projected[0], origin[1] + projected[1]);
  axisContext.stroke();
  axisContext.globalAlpha = 1;
}

function drawAxisLabel(origin, projected, label, color) {
  const length = Math.hypot(projected[0], projected[1]) || 1;
  const x = origin[0] + projected[0] + (projected[0] / length) * 10;
  const y = origin[1] + projected[1] + (projected[1] / length) * 10;
  axisContext.fillStyle = "rgba(0, 0, 0, 0.72)";
  axisContext.beginPath();
  axisContext.arc(x, y, 10, 0, Math.PI * 2);
  axisContext.fill();
  axisContext.fillStyle = color;
  axisContext.fillText(label, x, y + 0.5);
}

function updateTelemetry(now) {
  if (!telemetryEl || !scene) return;
  const telemetry = getCameraTelemetry();
  const nearestChunks = nearestLoadedChunks(5);
  const aimedChunks = aimedLoadedChunks(5);
  const nearestObjects = nearestLoadedObjects(5);
  const aimedObjects = aimedLoadedObjects(5);
  telemetryEl.textContent = [
    `XYZ ${formatCoord(telemetry.position[0])}, ${formatCoord(telemetry.position[1])}, ${formatCoord(telemetry.position[2])}`,
    `Head ${formatDegrees(telemetry.heading)} Pitch ${formatSignedDegrees(telemetry.pitch)}`,
    `Aim ${formatProbeLine(aimedObjects[0] || aimedChunks[0])}`,
    `Near ${formatProbeLine(nearestObjects[0] || nearestChunks[0])}`,
  ].join("\n");
  telemetryEl.dataset.camera = JSON.stringify(telemetry);
  telemetryEl.dataset.aimedChunks = JSON.stringify(aimedChunks);
  telemetryEl.dataset.nearestChunks = JSON.stringify(nearestChunks);
  telemetryEl.dataset.aimedObjects = JSON.stringify(aimedObjects);
  telemetryEl.dataset.nearestObjects = JSON.stringify(nearestObjects);
  logCameraTelemetry(now, false, telemetry, nearestChunks, aimedChunks, nearestObjects, aimedObjects);
}

async function copyTelemetrySnapshot(now) {
  const telemetry = getCameraTelemetry();
  const aimedChunks = aimedLoadedChunks(8);
  const nearestChunks = nearestLoadedChunks(8);
  const aimedObjects = aimedLoadedObjects(12);
  const nearestObjects = nearestLoadedObjects(12);
  const snapshot = {
    camera: telemetry,
    aimedObjects,
    nearestObjects,
    aimedChunks,
    nearestChunks,
  };
  logCameraTelemetry(now, true, telemetry, nearestChunks, aimedChunks, nearestObjects, aimedObjects);

  const json = JSON.stringify(snapshot, null, 2);
  if (!navigator.clipboard?.writeText) {
    setStatus(`${makeStats()} Probe logged.`);
    return;
  }

  try {
    await navigator.clipboard.writeText(json);
    setStatus(`${makeStats()} Probe copied.`);
  } catch (error) {
    console.warn("Could not copy stella probe", error, snapshot);
    setStatus(`${makeStats()} Probe logged; clipboard blocked.`);
  }
}

function logCameraTelemetry(
  now,
  force,
  telemetry = getCameraTelemetry(),
  nearestChunks = nearestLoadedChunks(5),
  aimedChunks = aimedLoadedChunks(5),
  nearestObjects = nearestLoadedObjects(5),
  aimedObjects = aimedLoadedObjects(5),
) {
  const key = [
    Math.round(telemetry.position[0]),
    Math.round(telemetry.position[1]),
    Math.round(telemetry.position[2]),
    Math.round(telemetry.yaw),
    Math.round(telemetry.pitch),
  ].join(",");
  if (!force && (key === lastTelemetryKey || now - lastTelemetryLogAt < TELEMETRY_LOG_INTERVAL_MS)) return;
  lastTelemetryKey = key;
  lastTelemetryLogAt = now;
  console.log("stella_camera", {
    ...telemetry,
    aimedObjects,
    nearestObjects,
    aimedChunks,
    nearestChunks,
  });
}

function getCameraTelemetry() {
  const position = cameraMapPosition();
  return {
    position,
    yaw: radiansToDegrees(yaw),
    pitch: radiansToDegrees(pitch),
    roll: 0,
    heading: radiansToDegrees(Math.atan2(getForward()[0], -getForward()[2])),
    angleUnits: "degrees",
    speed: camera.effectiveSpeed,
    scale: settings.scale,
    xray: settings.xray,
  };
}

function cameraMapPosition() {
  if (!scene || !scene.center || !Number.isFinite(scene.scale) || scene.scale === 0) return [0, 0, 0];
  return [
    scene.center[0] + camera.position[0] / scene.scale,
    scene.center[1] + camera.position[1] / scene.scale,
    scene.center[2] + camera.position[2] / scene.scale,
  ];
}

function nearestLoadedChunks(count) {
  if (!scene?.chunks?.length) return [];
  return scene.chunks
    .map((chunk) => chunkProbePayload(chunk))
    .filter((chunk) => Number.isFinite(chunk.distance))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count);
}

function aimedLoadedChunks(count) {
  if (!scene?.chunks?.length) return [];
  const forward = getForward();
  return scene.chunks
    .map((chunk) => {
      const center = normalizeScenePoint(chunk.center);
      const radius = Math.max(0.2, chunk.radius * scene.scale);
      const hitDistance = raySphereIntersection(camera.position, forward, center, radius);
      if (!Number.isFinite(hitDistance)) return null;
      return chunkProbePayload(chunk, { rayDistance: Number(formatCoord(hitDistance)) });
    })
    .filter(Boolean)
    .sort((a, b) => a.rayDistance - b.rayDistance)
    .slice(0, count);
}

function nearestLoadedObjects(count) {
  return loadedProbeObjects()
    .map(({ object, chunk }) => objectProbePayload(object, chunk))
    .filter((object) => Number.isFinite(object.distance))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count);
}

function aimedLoadedObjects(count) {
  const forward = getForward();
  return loadedProbeObjects()
    .map(({ object, chunk }) => {
      const center = normalizeScenePoint(object.center);
      const radius = Math.max(0.05, object.radius * scene.scale);
      const hitDistance = raySphereIntersection(camera.position, forward, center, radius);
      if (!Number.isFinite(hitDistance)) return null;
      return objectProbePayload(object, chunk, { rayDistance: Number(formatCoord(hitDistance)) });
    })
    .filter(Boolean)
    .sort((a, b) => a.rayDistance - b.rayDistance)
    .slice(0, count);
}

function loadedProbeObjects() {
  if (!scene?.chunks?.length) return [];
  const objects = [];
  for (const chunk of scene.chunks) {
    for (const object of chunk.objects || []) {
      objects.push({ object, chunk });
    }
  }
  return objects;
}

function chunkProbePayload(chunk, extra = {}) {
  const entry = scene.entries[chunk.entryIndex];
  return {
    ...extra,
    distance: Number(formatCoord(chunkDistance(chunk))),
    file: entry?.mesh?.file || entry?.url?.pathname || "",
    category: entry?.category || "",
    triangles: Math.floor(chunk.indexCount / 3),
    sourcePackages: entry?.mesh?.sourcePackages || [],
    sourceMeshes: entry?.mesh?.sourceMeshes || [],
  };
}

function objectProbePayload(object, chunk, extra = {}) {
  const entry = scene.entries[chunk.entryIndex];
  return {
    ...extra,
    distance: Number(formatCoord(length(subtract(normalizeScenePoint(object.center), camera.position)))),
    file: object.file || entry?.mesh?.file || "",
    chunkFile: entry?.mesh?.file || entry?.url?.pathname || "",
    category: entry?.category || "",
    name: object.name || "",
    component: object.component || "",
    componentType: object.componentType || "",
    actor: object.actor || "",
    source: object.source || "",
    componentPath: object.componentPath || "",
    transform: object.transform || null,
    instanceIndex: object.instanceIndex ?? null,
    lod: object.lod ?? null,
    triangles: object.triangles || 0,
    sourcePackages: object.sourcePackage ? [{ name: object.sourcePackage, count: 1 }] : [],
    sourceMeshes: object.sourceMesh ? [{ name: object.sourceMesh, count: 1 }] : [],
  };
}

function formatProbeLine(chunk) {
  if (!chunk) return "--";
  const distance = chunk.distance;
  return `${formatCoord(distance)} ${shortProbeName(primaryProbeName(chunk))}`;
}

function primaryProbeName(chunk) {
  return chunk.name || chunk.sourceMeshes?.[0]?.name || chunk.sourcePackages?.[0]?.name || chunk.file || "unknown";
}

function shortProbeName(value) {
  const base = String(value || "unknown").split(/[\\/]/).pop() || "unknown";
  const trimmed = base.replace(/\.(umap|uasset)$/i, "");
  if (trimmed.length <= 28) return trimmed;
  return `${trimmed.slice(0, 11)}...${trimmed.slice(-12)}`;
}

function raySphereIntersection(origin, direction, center, radius) {
  const offset = subtract(origin, center);
  const b = dot(offset, direction);
  const c = dot(offset, offset) - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return Number.NaN;
  const root = Math.sqrt(discriminant);
  const near = -b - root;
  const far = -b + root;
  if (far < 0) return Number.NaN;
  return near >= 0 ? near : far;
}

function resizeCanvas() {
  // FXAA smooths edges, so we don't need a high device-pixel-ratio; capping it
  // lower is the biggest fill-rate win on high-DPI displays. Override with ?dpr=.
  const dprCap = parseFloat(query.get("dpr")) || 1.25;
  const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  if (axisCanvas) {
    const axisWidth = Math.max(1, Math.floor(axisCanvas.clientWidth * dpr));
    const axisHeight = Math.max(1, Math.floor(axisCanvas.clientHeight * dpr));
    if (axisCanvas.width !== axisWidth || axisCanvas.height !== axisHeight) {
      axisCanvas.width = axisWidth;
      axisCanvas.height = axisHeight;
    }
  }
}

function makeStats() {
  const triangles = Math.floor(scene.indexCount / 3).toLocaleString();
  const vertices = scene.vertexCount.toLocaleString();
  const drawnTriangles = Math.floor(Math.min(scene.drawnIndexCount, scene.indexCount) / 3).toLocaleString();
  const resident = scene.meshCount.toLocaleString();
  const drawn = Math.min(scene.drawnMeshCount, scene.meshCount).toLocaleString();
  const total = scene.visibleMeshCount.toLocaleString();
  const loaded = scene.loadedEverCount.toLocaleString();
  const loading = scene.loadingCount ? `, ${scene.loadingCount} loading` : "";
  const failed = scene.failedCount ? `, ${scene.failedCount} skipped` : "";
  const budget = Number.isFinite(scene.residentBudget) ? `, budget ${scene.residentBudget.toLocaleString()}` : "";
  const hidden = scene.hiddenBackdropCount ? `, ${scene.hiddenBackdropCount.toLocaleString()} scenery hidden` : "";
  const pending = scene.pendingCandidateCount ? `, ${scene.pendingCandidateCount.toLocaleString()} near pending` : "";
  const speed = `speed ${formatSpeed(camera.effectiveSpeed)}`;
  const scale = `scale ${formatScale(settings.scale)}x`;
  const xray = settings.xray ? ", x-ray" : "";
  return `${resident}/${total} resident, ${drawn} drawn${budget}${hidden}${pending}; ${loaded} loaded, ${drawnTriangles}/${triangles} triangles, ${vertices} vertices, ${speed}, ${scale}${xray}${loading}${failed}.`;
}

function setStatus(message) {
  statusEl.textContent = message;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url.href}: ${response.status} ${response.statusText}; ${snippet(text)}`);
  }
  if (!contentType.toLowerCase().includes("json")) {
    throw new Error(`${url.href}: expected JSON, got ${contentType || "unknown content-type"}; ${snippet(text)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${url.href}: invalid JSON (${error.message}); ${snippet(text)}`);
  }
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname}: ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchArrayBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname}: ${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

function snippet(text) {
  return text.trim().slice(0, 120).replace(/\s+/g, " ");
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function createProgram(vertexSource, fragmentSource) {
  const program = gl.createProgram();
  const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  // Force consistent attribute locations so scene/cinematic/shadow programs all
  // share the same VAOs (harmless for fullscreen programs that lack these attrs).
  gl.bindAttribLocation(program, 0, "aPosition");
  gl.bindAttribLocation(program, 1, "aMaterial");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "failed to link shader program");
  }
  return program;
}

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "failed to compile shader");
  }
  return shader;
}

function createBounds() {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

function hasFiniteBounds(bounds) {
  return bounds.min.every(Number.isFinite) && bounds.max.every(Number.isFinite);
}

function normalizeBounds(bounds) {
  if (!bounds || !Array.isArray(bounds.min) || !Array.isArray(bounds.max)) return null;
  const normalized = {
    min: readPoint(bounds.min),
    max: readPoint(bounds.max),
  };
  return normalized.min && normalized.max && hasFiniteBounds(normalized) ? normalized : null;
}

function packedPositionScale(manifest) {
  const sourceScale = manifest.coordinateSystem === VIEWER_COORDINATE_SYSTEM ? [1, 1, 1] : [1, 1, -1];
  return sourceScale.map((scale, axis) => scale * userPositionScale[axis]);
}

function transformPackedPoint(point) {
  const parsed = readPoint(point);
  if (!parsed) return null;
  return parsed.map((value, axis) => value * scene.positionScale[axis]);
}

function transformPackedBounds(bounds) {
  const normalized = normalizeBounds(bounds);
  if (!normalized) return null;

  const min = [...normalized.min];
  const max = [...normalized.max];
  for (let axis = 0; axis < 3; axis += 1) {
    if (scene.positionScale[axis] >= 0) continue;
    const oldMin = min[axis];
    min[axis] = max[axis] * scene.positionScale[axis];
    max[axis] = oldMin * scene.positionScale[axis];
  }

  return { min, max };
}

function readPoint(point) {
  if (!Array.isArray(point) || point.length < 3) return null;
  const parsed = [Number(point[0]), Number(point[1]), Number(point[2])];
  return parsed.every(Number.isFinite) ? parsed : null;
}

function boundsFromPositions(positions) {
  const bounds = createBounds();
  for (let i = 0; i + 2 < positions.length; i += 3) {
    includePoint(bounds, [positions[i], positions[i + 1], positions[i + 2]]);
  }
  return bounds;
}

function includePoint(bounds, point) {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
}

function mergeBounds(target, source) {
  includePoint(target, source.min);
  includePoint(target, source.max);
}

function makePointBounds(points) {
  const bounds = createBounds();
  for (const point of points) includePoint(bounds, point);
  return bounds;
}

function makeTrimmedBounds(points, lower, upper) {
  const bounds = createBounds();
  for (let axis = 0; axis < 3; axis += 1) {
    const values = points.map((point) => point[axis]).sort((a, b) => a - b);
    bounds.min[axis] = values[Math.floor((values.length - 1) * lower)];
    bounds.max[axis] = values[Math.floor((values.length - 1) * upper)];
    if (bounds.min[axis] === bounds.max[axis]) {
      bounds.min[axis] -= 0.5;
      bounds.max[axis] += 0.5;
    }
  }
  return bounds;
}

function unrealToViewerPoint(point) {
  const x = Number(point[0]);
  const y = Number(point[1]);
  const z = Number(point[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return [0, 0, 0];
  return [x, z, -y];
}

function transformUnrealPoint(point, transform) {
  const scale = Array.isArray(transform.scale) ? transform.scale : [1, 1, 1];
  const rotation = Array.isArray(transform.rotation) ? transform.rotation : [0, 0, 0, 1];
  const translation = Array.isArray(transform.translation) ? transform.translation : [0, 0, 0];
  const scaled = [
    Number(point[0]) * Number(scale[0]),
    Number(point[1]) * Number(scale[1]),
    Number(point[2]) * Number(scale[2]),
  ];
  const rotated = rotateByQuat(scaled, rotation.map(Number));
  return [
    rotated[0] + Number(translation[0]),
    rotated[1] + Number(translation[1]),
    rotated[2] + Number(translation[2]),
  ];
}

function rotateByQuat(point, quat) {
  const [qx, qy, qz, qw] = quat;
  const axis = [qx, qy, qz];
  const uv = cross(axis, point);
  const uuv = cross(axis, uv);
  return [
    point[0] + (uv[0] * qw + uuv[0]) * 2,
    point[1] + (uv[1] * qw + uuv[1]) * 2,
    point[2] + (uv[2] * qw + uuv[2]) * 2,
  ];
}

function normalizeScenePoint(point) {
  return [
    (point[0] - scene.center[0]) * scene.scale,
    (point[1] - scene.center[1]) * scene.scale,
    (point[2] - scene.center[2]) * scene.scale,
  ];
}

function entryDistance(entry) {
  return length(subtract(normalizeScenePoint(entry.center), camera.position));
}

function entryLoadScore(entry) {
  const center = normalizeScenePoint(entry.center);
  const toCenter = subtract(center, camera.position);
  const distance = length(toCenter);
  if (!Number.isFinite(distance) || distance <= 0) return Number.POSITIVE_INFINITY;
  const alignment = dot(toCenter, getForward()) / distance;
  const viewBonus = Math.max(0, alignment) * Math.min(12, distance * 0.4);
  const sizePenalty = Math.min(16, Math.sqrt(Number(entry.mesh.vertices || 0)) / 40);
  return distance - viewBonus + sizePenalty;
}

function chunkDistance(chunk) {
  return length(subtract(normalizeScenePoint(chunk.center), camera.position));
}

function boundsCenter(bounds) {
  return [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
}

function boundsSize(bounds) {
  return [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
}

function boundsRadius(bounds) {
  if (!bounds || !hasFiniteBounds(bounds)) return 0;
  return length(boundsSize(bounds)) * 0.5;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy * 0.5);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function ortho(l, r, b, t, n, f) {
  return new Float32Array([
    2 / (r - l), 0, 0, 0,
    0, 2 / (t - b), 0, 0,
    0, 0, -2 / (f - n), 0,
    -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1,
  ]);
}

// Column-major 4x4 multiply (a * b).
function mat4mul(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function lookFrom(eye, forward, up) {
  const z = normalize([-forward[0], -forward[1], -forward[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function addScaled(target, value, scale) {
  target[0] += value[0] * scale;
  target[1] += value[1] * scale;
  target[2] += value[2] * scale;
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(value) {
  return Math.hypot(value[0], value[1], value[2]);
}

function normalize(value) {
  const len = length(value);
  if (len <= 0) return [0, 0, 0];
  return [value[0] / len, value[1] / len, value[2] / len];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function degreesToRadians(value) {
  return value * Math.PI / 180;
}

function parseOptionalNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBudget(value, fallback) {
  if (value && value.toLowerCase() === "all") return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseRadius(value, fallback) {
  if (value && value.toLowerCase() === "all") return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseSpeed(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? clamp(parsed, 0.1, 10) : fallback;
}

function parseScale(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? clamp(parsed, 0.25, 4) : fallback;
}

function parsePositionScale(value) {
  const scale = [1, 1, 1];
  for (const axis of String(value || "").toLowerCase().split(/[,\s+]+/)) {
    if (axis === "none" || axis === "0" || axis === "false") continue;
    if (axis === "x") scale[0] *= -1;
    if (axis === "y") scale[1] *= -1;
    if (axis === "z") scale[2] *= -1;
  }
  return scale;
}

function formatSpeed(value) {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatScale(value) {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatCoord(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "--";
}

function formatDegrees(value) {
  return Number.isFinite(value) ? `${normalizeDegrees(value).toFixed(1)}deg` : "--";
}

function formatSignedDegrees(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}deg` : "--";
}

function radiansToDegrees(value) {
  return value * 180 / Math.PI;
}

function normalizeDegrees(value) {
  let normalized = value % 360;
  if (normalized < 0) normalized += 360;
  return normalized;
}

const VERTEX_SOURCE = `#version 300 es
precision highp float;

in vec3 aPosition;
in uint aMaterial;

uniform mat4 uProjection;
uniform mat4 uView;
uniform vec3 uCenter;
uniform float uScale;
uniform vec3 uPositionScale;

out vec3 vWorld;
out vec3 vViewPos;
flat out uint vMaterial;

void main() {
  vec3 world = ((aPosition * uPositionScale) - uCenter) * uScale;
  vWorld = world;
  vMaterial = aMaterial;
  vec4 viewPos = uView * vec4(world, 1.0);
  vViewPos = viewPos.xyz;
  gl_Position = uProjection * viewPos;
}
`;

// Scene pass writes a small G-buffer (lit colour + view-space position + view
// normal) so the SSAO pass has geometry to work with. Lighting is a hemispheric
// sky/ground ambient + a warm directional sun + fresnel rim + distance fog.
const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec3 vWorld;
in vec3 vViewPos;
flat in uint vMaterial;

uniform vec3 uLight;        // world-space sun direction (normalised)
uniform vec3 uViewLight;    // sun direction in view space (for spec)
uniform float uOpacity;
uniform float uFogDensity;
uniform float uDetailScale;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uHorizonColor;
uniform vec3 uMatColor[16];  // per-material palette (see classifyMaterial in JS)
uniform float uMatMetal[16]; // spec / metalness per material
uniform float uMatSnow[16];  // snow affinity per material

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outViewPos;
layout(location = 2) out vec4 outViewNormal;

// Cheap 3D value noise + fbm for procedural surface detail (no textures/UVs).
float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                 mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                 mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
  return v;
}

void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (!gl_FrontFacing) n = -n;
  vec3 vn = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  if (!gl_FrontFacing) vn = -vn;

  // --- Per-object material (from manifest metadata) + procedural detail ---
  int mid = int(vMaterial);
  vec3 matColor = uMatColor[mid];
  float matMetal = uMatMetal[mid];
  float matSnow = uMatSnow[mid];

  float detail = fbm(vWorld * uDetailScale);            // fine grain
  float macro = fbm(vWorld * (uDetailScale * 0.22));    // large panel variation
  vec3 base = matColor * (0.80 + 0.30 * detail) * (0.88 + 0.24 * macro);

  // Snow settles on up-facing surfaces, scaled by the material's snow affinity.
  vec3 snow = mix(vec3(0.78, 0.83, 0.93), vec3(0.95, 0.97, 1.0), detail);
  float up = clamp(n.y, 0.0, 1.0);
  float snowMask = clamp(smoothstep(0.34, 0.72, up + (macro - 0.5) * 0.4) * matSnow, 0.0, 1.0);
  vec3 albedo = mix(base, snow, snowMask);

  // --- Lighting (Layer 1) ---
  float hemi = n.y * 0.5 + 0.5;
  vec3 ambient = mix(uGroundColor, uSkyColor, hemi);
  vec3 L = normalize(uLight);
  float ndl = max(dot(n, L), 0.0);
  float wrap = max(dot(n, L) * 0.5 + 0.5, 0.0) * 0.32;
  vec3 sun = vec3(1.0, 0.95, 0.86) * (ndl * 0.8 + wrap);
  float fill = max(dot(n, -L), 0.0) * 0.12;
  sun += uSkyColor * fill;
  vec3 lit = albedo * (ambient + sun);

  // Metallic sheen scaled by the material's metalness (bright on metal/containers).
  vec3 V = normalize(-vViewPos);
  vec3 H = normalize(normalize(uViewLight) + V);
  float spec = pow(max(dot(vn, H), 0.0), 48.0) * (1.0 - snowMask) * matMetal * 0.4;
  lit += spec * vec3(1.0, 0.97, 0.9);

  // Fresnel rim for silhouette pop.
  float rim = pow(1.0 - max(dot(vn, V), 0.0), 3.0) * 0.18;
  lit += rim * uSkyColor;

  // Distance fog toward the horizon colour.
  float dist = length(vViewPos);
  float fog = clamp(1.0 - exp(-dist * uFogDensity), 0.0, 1.0);
  lit = mix(lit, uHorizonColor, fog);

  outColor = vec4(lit, uOpacity);
  outViewPos = vec4(vViewPos, 1.0);   // alpha = 1 marks covered pixels
  outViewNormal = vec4(vn, 0.0);
}
`;

// Fullscreen triangle (no vertex buffer; uses gl_VertexID).
const FULLSCREEN_VERTEX_SOURCE = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Screen-space ambient occlusion (hemisphere kernel in view space).
const SSAO_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uViewPos;
uniform sampler2D uViewNormal;
uniform mat4 uProjection;
uniform vec3 uKernel[16];
uniform float uRadius;
uniform float uBias;
uniform float uStrength;
out float outAO;

void main() {
  vec4 posSample = texture(uViewPos, vUv);
  if (posSample.a < 0.5) { outAO = 1.0; return; }   // background
  vec3 origin = posSample.xyz;
  vec3 normal = normalize(texture(uViewNormal, vUv).xyz);

  float rnd = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  vec3 randVec = normalize(vec3(rnd * 2.0 - 1.0, fract(rnd * 91.7) * 2.0 - 1.0, 0.0));
  vec3 tangent = normalize(randVec - normal * dot(randVec, normal));
  vec3 bitangent = cross(normal, tangent);
  mat3 TBN = mat3(tangent, bitangent, normal);

  float occlusion = 0.0;
  for (int i = 0; i < 16; i++) {
    vec3 samplePos = origin + (TBN * uKernel[i]) * uRadius;
    vec4 offset = uProjection * vec4(samplePos, 1.0);
    offset.xyz /= offset.w;
    vec2 uv = offset.xy * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
    vec4 occ = texture(uViewPos, uv);
    if (occ.a < 0.5) continue;
    float sampleDepth = occ.z;                       // view Z (negative)
    float rangeCheck = smoothstep(0.0, 1.0, uRadius / max(abs(origin.z - sampleDepth), 0.0001));
    occlusion += (sampleDepth >= samplePos.z + uBias ? 1.0 : 0.0) * rangeCheck;
  }
  outAO = clamp(1.0 - (occlusion / 16.0) * uStrength, 0.0, 1.0);
}
`;

// FXAA (edge antialiasing) — cheap alternative to MSAA in a deferred pipeline.
const FXAA_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uImage;
uniform vec2 uTexel;
out vec4 fragColor;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec3 rgbM = texture(uImage, vUv).rgb;
  float lM = luma(rgbM);
  float lNW = luma(texture(uImage, vUv + vec2(-1.0, -1.0) * uTexel).rgb);
  float lNE = luma(texture(uImage, vUv + vec2( 1.0, -1.0) * uTexel).rgb);
  float lSW = luma(texture(uImage, vUv + vec2(-1.0,  1.0) * uTexel).rgb);
  float lSE = luma(texture(uImage, vUv + vec2( 1.0,  1.0) * uTexel).rgb);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  vec2 dir = vec2(
    -((lNW + lNE) - (lSW + lSE)),
     ((lNW + lSW) - (lNE + lSE))
  );
  float reduce = max((lNW + lNE + lSW + lSE) * (0.25 * 0.125), 1.0 / 128.0);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, -8.0, 8.0) * uTexel;

  vec3 rgbA = 0.5 * (
    texture(uImage, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture(uImage, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture(uImage, vUv + dir * -0.5).rgb +
    texture(uImage, vUv + dir *  0.5).rgb);
  float lB = luma(rgbB);
  fragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
`;

// Composite: sky gradient for background, blurred AO * lit colour + tonemap.
const COMPOSITE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uColor;
uniform sampler2D uViewPos;
uniform sampler2D uAO;
uniform vec2 uTexel;
uniform float uAOPower;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
out vec4 fragColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec4 pos = texture(uViewPos, vUv);
  if (pos.a < 0.5) {
    // Background: vertical sky gradient.
    vec3 sky = mix(uHorizonColor, uZenithColor, clamp(vUv.y, 0.0, 1.0));
    fragColor = vec4(aces(sky), 1.0);
    return;
  }
  // 3x3 blur of the AO to hide sampling noise.
  float ao = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++)
      ao += texture(uAO, vUv + vec2(float(x), float(y)) * uTexel).r;
  ao = pow(ao / 9.0, uAOPower);
  ao = mix(0.45, 1.0, ao);          // floor so AO never crushes to black

  vec3 color = texture(uColor, vUv).rgb * ao;
  fragColor = vec4(aces(color), 1.0);
}
`;

// ---------------- Cinematic mode shaders ----------------

// Shadow map: render scene depth from the sun's point of view.
const SHADOW_VERTEX_SOURCE = `#version 300 es
precision highp float;
in vec3 aPosition;
uniform vec3 uCenter;
uniform float uScale;
uniform vec3 uPositionScale;
uniform mat4 uLightViewProj;
void main() {
  vec3 world = ((aPosition * uPositionScale) - uCenter) * uScale;
  gl_Position = uLightViewProj * vec4(world, 1.0);
}
`;
const SHADOW_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
void main() {}
`;

// Cinematic scene pass: GGX PBR + shadows + sky ambient + emissive, HDR output.
const CINEMATIC_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vViewPos;
flat in uint vMaterial;

uniform vec3 uLight;        // world-space sun direction
uniform vec3 uCamPos;       // world-space eye
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uDetailScale;
uniform float uOpacity;
uniform mat4 uLightViewProj;
uniform highp sampler2DShadow uShadowMap;
uniform vec2 uShadowTexel;
uniform float uShadowEnable;
uniform vec3 uMatColor[16];
uniform float uMatMetal[16];
uniform float uMatRough[16];
uniform vec3 uMatEmissive[16];
uniform float uMatSnow[16];

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outViewPos;
layout(location = 2) out vec4 outViewNormal;

float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                 mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                 mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; } return v; }

vec3 skyColor(vec3 dir) {
  float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, t);
  float s = max(dot(normalize(dir), normalize(uLight)), 0.0);
  sky += uSunColor * (pow(s, 200.0) * 0.6 + pow(s, 8.0) * 0.04);
  return sky;
}

void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (!gl_FrontFacing) n = -n;
  vec3 vn = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  if (!gl_FrontFacing) vn = -vn;

  int mid = int(vMaterial);
  vec3 matColor = uMatColor[mid];
  float detail = fbm(vWorld * uDetailScale);
  float macro = fbm(vWorld * (uDetailScale * 0.22));
  vec3 baseCol = matColor * (0.80 + 0.30 * detail) * (0.88 + 0.24 * macro);

  vec3 snowCol = mix(vec3(0.70, 0.76, 0.90), vec3(0.92, 0.95, 1.0), detail);
  float up = clamp(n.y, 0.0, 1.0);
  float snowMask = clamp(smoothstep(0.34, 0.72, up + (macro - 0.5) * 0.4) * uMatSnow[mid], 0.0, 1.0);
  vec3 albedo = mix(baseCol, snowCol, snowMask);
  float rough = clamp(mix(uMatRough[mid], 0.7, snowMask), 0.05, 1.0);
  float metal = uMatMetal[mid] * (1.0 - snowMask);

  vec3 N = n;
  vec3 Vd = normalize(uCamPos - vWorld);
  vec3 L = normalize(uLight);
  vec3 H = normalize(L + Vd);
  float NdL = max(dot(N, L), 0.0);
  float NdV = max(dot(N, Vd), 1e-4);
  float NdH = max(dot(N, H), 0.0);
  float VdH = max(dot(Vd, H), 0.0);

  float a = max(rough * rough, 1e-3);
  float a2 = a * a;
  float dd = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * dd * dd);
  float kg = (rough + 1.0); kg = kg * kg / 8.0;
  float G = (NdV / (NdV * (1.0 - kg) + kg)) * (NdL / (NdL * (1.0 - kg) + kg));
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VdH, 5.0);
  vec3 spec = (D * G) * F / max(4.0 * NdV * NdL, 1e-3);
  vec3 kd = (1.0 - F) * (1.0 - metal);
  vec3 diff = kd * albedo / 3.14159265;

  float shadow = 1.0;
  if (uShadowEnable > 0.5) {
    vec4 lp = uLightViewProj * vec4(vWorld, 1.0);
    vec3 sc = lp.xyz / lp.w * 0.5 + 0.5;
    if (sc.z <= 1.0 && sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0) {
      float bias = max(0.0025 * (1.0 - NdL), 0.0007);
      float s = 0.0;
      for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++)
          s += texture(uShadowMap, vec3(sc.xy + vec2(float(x), float(y)) * uShadowTexel, sc.z - bias));
      shadow = s / 9.0;
    }
  }

  vec3 direct = (diff + spec) * uSunColor * NdL * shadow;

  float upf = N.y * 0.5 + 0.5;
  vec3 skyAmb = mix(uSkyHorizon, uSkyZenith, clamp(N.y, 0.0, 1.0));
  vec3 ambient = albedo * mix(uGroundColor, skyAmb, upf);

  vec3 R = reflect(-Vd, N);
  vec3 envSpec = skyColor(R) * F0 * (1.0 - rough) * 0.6;

  vec3 color = ambient + direct + envSpec + uMatEmissive[mid];

  float dist = length(vViewPos);
  float fog = clamp(1.0 - exp(-dist * uFogDensity), 0.0, 1.0);
  color = mix(color, uFogColor, fog);

  outColor = vec4(color, uOpacity);
  outViewPos = vec4(vViewPos, 1.0);
  outViewNormal = vec4(vn, 0.0);
}
`;

// Cinematic composite: lit colour * AO for geometry, analytic sky for background,
// output HDR (tonemapping happens later).
const CINE_COMPOSITE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uColor;
uniform sampler2D uViewPos;
uniform sampler2D uAO;
uniform vec2 uTexel;
uniform float uAOPower;
uniform vec3 uSunColor;
uniform vec3 uLight;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uCamForward;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uTanHalfFov;
uniform float uAspect;
out vec4 fragColor;

vec3 skyColor(vec3 dir) {
  float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, t);
  float s = max(dot(normalize(dir), normalize(uLight)), 0.0);
  sky += uSunColor * (pow(s, 200.0) * 0.8 + pow(s, 8.0) * 0.05);
  return sky;
}

void main() {
  vec4 pos = texture(uViewPos, vUv);
  if (pos.a < 0.5) {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec3 ray = normalize(uCamForward + uCamRight * (ndc.x * uTanHalfFov * uAspect) + uCamUp * (ndc.y * uTanHalfFov));
    fragColor = vec4(skyColor(ray), 1.0);
    return;
  }
  float ao = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++)
      ao += texture(uAO, vUv + vec2(float(x), float(y)) * uTexel).r;
  ao = pow(ao / 9.0, uAOPower);
  ao = mix(0.5, 1.0, ao);
  fragColor = vec4(texture(uColor, vUv).rgb * ao, 1.0);
}
`;

// Bloom bright-pass (downsample happens via the quarter-res viewport).
const BLOOM_PREFILTER_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uImage;
uniform float uThreshold;
out vec4 fragColor;
void main() {
  vec3 c = texture(uImage, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(l - uThreshold, 0.0) / max(l, 1e-4);
  fragColor = vec4(c * k, 1.0);
}
`;

// Separable Gaussian blur (uDir = texel-scaled axis).
const BLOOM_BLUR_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uImage;
uniform vec2 uDir;
out vec4 fragColor;
void main() {
  float w[5];
  w[0] = 0.227027; w[1] = 0.194594; w[2] = 0.121621; w[3] = 0.054054; w[4] = 0.016216;
  vec3 c = texture(uImage, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    c += texture(uImage, vUv + uDir * float(i)).rgb * w[i];
    c += texture(uImage, vUv - uDir * float(i)).rgb * w[i];
  }
  fragColor = vec4(c, 1.0);
}
`;

// Tonemap: exposure + bloom add + filmic curve + grade + vignette -> LDR.
const TONEMAP_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform float uExposure;
uniform float uBloomStrength;
out vec4 fragColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 hdr = texture(uHdr, vUv).rgb + texture(uBloom, vUv).rgb * uBloomStrength;
  vec3 c = aces(hdr * uExposure);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.08);                       // saturation
  c = clamp((c - 0.5) * 1.06 + 0.5, 0.0, 1.0);     // contrast
  float vig = smoothstep(1.05, 0.4, length(vUv - 0.5));
  c *= mix(0.90, 1.0, vig);
  fragColor = vec4(c, 1.0);
}
`;
