import {
  Map as MapLibreMap,
  Marker,
  MercatorCoordinate,
  NavigationControl,
  LngLat,
  LngLatBounds,
  setMaxParallelImageRequests,
  setWorkerCount,
} from './vendor/maplibre-gl.mjs';

const $ = (id) => document.getElementById(id);
const ui = {
  file: $('gpx-file'), fileName: $('file-name'), title: $('video-title'), token: $('mapbox-token'),
  toggleToken: $('toggle-token'), labels: $('map-labels'), duration: $('duration'), resolution: $('resolution'),
  fps: $('fps'), quality: $('render-quality'), metric: $('metric'), orientation: $('orientation'),
  routeColoring: $('route-coloring'), routeColor: $('route-color'), routeColorValue: $('route-color-value'),
  heartRate: $('heart-rate'), heartRateText: $('heart-rate-text'),
  trimStart: $('trim-start'), trimEnd: $('trim-end'), trimValue: $('trim-value'),
  trimFill: $('trim-fill'), trimDetail: $('trim-detail'), trimPreview: $('trim-preview'),
  statsDistance: $('stats-distance'), statsElevation: $('stats-elevation'), statsMovingTime: $('stats-moving-time'),
  statsHeartRate: $('stats-heart-rate'),
  hudTop: $('hud-top'), hudTopValue: $('hud-top-value'), hudSize: $('hud-size'), hudSizeValue: $('hud-size-value'),
  labelSize: $('label-size'), labelSizeValue: $('label-size-value'), cameraDistance: $('camera-distance'),
  cameraDistanceValue: $('camera-distance-value'), cameraHeight: $('camera-height'),
  cameraHeightValue: $('camera-height-value'), prepare: $('prepare'), preview: $('preview'),
  export: $('export'), cancel: $('cancel'), map: $('map'), viewport: $('viewport-shell'), previewHud: $('preview-hud'),
  recordCanvas: $('record-canvas'), empty: $('empty-state'), activityHeading: $('activity-heading'),
  status: $('status'), statusDetail: $('status-detail'), frameCounter: $('frame-counter'), progress: $('progress'),
};

const state = {
  activity: null,
  sourceActivity: null,
  sourceText: '',
  sourceFileName: '',
  map: null,
  ready: false,
  preparing: false,
  animating: false,
  exporting: false,
  cancelled: false,
  previewPaused: false,
  raf: 0,
  currentProgress: 0,
  overview: null,
  cameraCenter: null,
  cameraBearing: null,
  cameraZoom: null,
  cameraPitch: null,
  outroPose: null,
  positionMarker: null,
  positionMarkerElement: null,
  pendingPositionMarker: null,
  route3dLayer: null,
  nativeRouteProgress: null,
  nativeRouteColorMode: null,
  nativeRouteColor: null,
  nativeRouteSegmentCount: 0,
  nativeRouteVisibleSegment: -1,
  nativeRouteFinished: null,
  routeFinalBoost: null,
  terrainProfileRequest: 0,
  mapErrors: new Set(),
  saveTimer: 0,
};

const COLORS = {
  orange: '#fc4c02',
  routeOutline: '#111318',
  green: '#35d04f',
  red: '#ef3e42',
  water: '#68b9ff',
};

// Keep the visible route close to the relief, but high enough to avoid the
// usual terrain z-fighting on steep slopes.
const ROUTE_HEIGHT_OFFSET_METERS = 20;
// Depth-only allowance for small DEM/GPX mismatches. The route remains at the
// visual height above, while terrain more than this far in front still hides it.
const ROUTE_OCCLUSION_TOLERANCE_METERS = 30;
// Ignore very small terrain-depth differences around the marker. They are
// normally DEM precision noise rather than a ridge actually covering it.
const MARKER_OCCLUSION_TOLERANCE_METERS = 8;
// MapLibre stores terrain depth in normalized camera space. A fixed floor is
// needed because a few metres can otherwise become an extremely small value
// and make the marker look covered while it is still clearly in front.
const MARKER_OCCLUSION_DEPTH_TOLERANCE = 0.008;

const QUALITY = {
  Fast: { terrain: 1.22, maxPixelRatio: 1.5, gradientStops: 28, bitrate: 0.72 },
  Balanced: { terrain: 1.38, maxPixelRatio: 2.35, gradientStops: 52, bitrate: 1.0 },
  Best: { terrain: 1.52, maxPixelRatio: 3.1, gradientStops: 88, bitrate: 1.35 },
};

setWorkerCount(Math.max(2, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))));
setMaxParallelImageRequests(16);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

function setStatus(title, detail = '') {
  ui.status.textContent = title;
  ui.statusDetail.textContent = detail;
}

function settingsSnapshot() {
  return {
    mapbox_token: ui.token.value.trim(),
    map_labels: ui.labels.checked,
    seconds: Number(ui.duration.value),
    fps: Number(ui.fps.value),
    quality: ui.resolution.value,
    render_mode: ui.quality.value,
    metric: ui.metric.value,
    orientation: ui.orientation.value,
    hud_top: Number(ui.hudTop.value),
    font_scale: Number(ui.hudSize.value),
    label_font_scale: Number(ui.labelSize.value),
    route_color: ui.routeColor.value,
    route_color_mode: ui.routeColoring.value,
    show_heart_rate: ui.heartRate.checked,
    camera_distance: Number(ui.cameraDistance.value),
    camera_height: Number(ui.cameraHeight.value),
  };
}

function saveSettings() {
  clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsSnapshot()),
    }).catch(() => {});
  }, 250);
}

function normalizedChoice(value, choices, fallback) {
  const text = String(value ?? '').toLowerCase();
  return choices.find((choice) => text.includes(choice.toLowerCase())) || fallback;
}

async function loadSettings() {
  try {
    const saved = await fetch('/api/settings').then((response) => response.json());
    if (saved.mapbox_token) ui.token.value = saved.mapbox_token;
    if (typeof saved.map_labels === 'boolean') ui.labels.checked = saved.map_labels;
    if (saved.seconds) ui.duration.value = clamp(Number(saved.seconds), 1, 600);
    if (saved.fps && [...ui.fps.options].some((o) => o.value === String(saved.fps))) ui.fps.value = String(saved.fps);
    if (saved.quality && [...ui.resolution.options].some((o) => o.value === String(saved.quality))) ui.resolution.value = saved.quality;
    if (saved.render_mode) ui.quality.value = normalizedChoice(saved.render_mode, ['Fast', 'Balanced', 'Best'], 'Balanced');
    if (saved.metric) ui.metric.value = normalizedChoice(saved.metric, ['Automatic', 'Pace (min/km)', 'Speed (km/h)'], 'Automatic');
    if (saved.orientation) ui.orientation.value = String(saved.orientation).toLowerCase().includes('vertical') ? 'vertical' : 'horizontal';
    if (saved.hud_top != null) ui.hudTop.value = clamp(Number(saved.hud_top), 2, 18);
    if (saved.font_scale != null) {
      const scale = Number(saved.font_scale) > 10 ? Number(saved.font_scale) / 100 : Number(saved.font_scale);
      ui.hudSize.value = clamp(scale, 0.9, 2);
    }
    if (saved.label_font_scale != null) {
      const scale = Number(saved.label_font_scale) > 10 ? Number(saved.label_font_scale) / 100 : Number(saved.label_font_scale);
      ui.labelSize.value = clamp(scale, 0.5, 2);
    }
    if (/^#[0-9a-f]{6}$/i.test(saved.route_color || '')) ui.routeColor.value = saved.route_color;
    if (saved.route_color_mode) ui.routeColoring.value = String(saved.route_color_mode).toLowerCase().includes('speed') ? 'speed' : 'single';
    if (typeof saved.show_heart_rate === 'boolean') ui.heartRate.checked = saved.show_heart_rate;
    if (saved.camera_distance != null && Number.isFinite(Number(saved.camera_distance))) {
      ui.cameraDistance.value = clamp(Number(saved.camera_distance), 0.6, 2.5);
    }
    if (saved.camera_height != null && Number.isFinite(Number(saved.camera_height))) {
      ui.cameraHeight.value = clamp(Number(saved.camera_height), 0.6, 2.2);
    }
  } catch (_) {
    // Defaults are deliberately usable if the local settings file is absent.
  }
  refreshControlLabels();
  setOrientation();
}

function refreshControlLabels() {
  ui.hudTopValue.textContent = `${Number(ui.hudTop.value).toFixed(0)}%`;
  ui.hudSizeValue.textContent = `${Number(ui.hudSize.value).toFixed(1)}x`;
  ui.labelSizeValue.textContent = `${Number(ui.labelSize.value).toFixed(1)}x`;
  ui.cameraDistanceValue.textContent = `${Number(ui.cameraDistance.value).toFixed(1)}x`;
  ui.cameraHeightValue.textContent = `${Number(ui.cameraHeight.value).toFixed(1)}x`;
  ui.routeColorValue.textContent = ui.routeColor.value.toUpperCase();
}

function updateHeartRateAvailability() {
  const available = Boolean(state.activity?.hasHeartRate);
  ui.heartRate.disabled = !available;
  ui.heartRateText.textContent = available
    ? 'Show heart rate on heads-up display'
    : 'Heart rate not found in this GPX';
}

function formatTrimTime(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function parseDurationInput(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return NaN;
  const numbers = parts.map(Number);
  const seconds = numbers.at(-1);
  const minutes = numbers.at(-2);
  if (seconds >= 60 || (parts.length === 3 && minutes >= 60)) return NaN;
  return parts.length === 3
    ? numbers[0] * 3600 + minutes * 60 + seconds
    : minutes * 60 + seconds;
}

function clearStatisticsOverrides() {
  ui.statsDistance.value = '';
  ui.statsElevation.value = '';
  ui.statsMovingTime.value = '';
  ui.statsHeartRate.value = '';
  ui.statsDistance.setCustomValidity('');
  ui.statsElevation.setCustomValidity('');
  ui.statsMovingTime.setCustomValidity('');
  ui.statsHeartRate.setCustomValidity('');
}

function effectiveActivityStatistics(paceMode = metricMode() === 'pace') {
  if (!state.activity) return null;
  const distanceText = ui.statsDistance.value.trim();
  const elevationText = ui.statsElevation.value.trim();
  const movingText = ui.statsMovingTime.value.trim();
  const heartRateText = ui.statsHeartRate.value.trim();
  const manualDistance = Number(distanceText);
  const manualElevation = Number(elevationText);
  const manualMovingSeconds = parseDurationInput(movingText);
  const manualHeartRate = Number(heartRateText);
  const automaticMovingSeconds = paceMode
    ? (state.activity.movingSecondsPace || state.activity.movingSeconds)
    : (state.activity.movingSecondsSpeed || state.activity.movingSeconds);
  return {
    distance: distanceText && Number.isFinite(manualDistance) && manualDistance > 0
      ? manualDistance * 1000
      : state.activity.totalDistance,
    elevationGain: elevationText && Number.isFinite(manualElevation) && manualElevation >= 0
      ? manualElevation
      : state.activity.elevationGain,
    movingSeconds: movingText && Number.isFinite(manualMovingSeconds) && manualMovingSeconds > 0
      ? manualMovingSeconds
      : automaticMovingSeconds,
    averageHeartRate: heartRateText && Number.isFinite(manualHeartRate) && manualHeartRate >= 25 && manualHeartRate <= 250
      ? manualHeartRate
      : state.activity.averageHeartRate,
  };
}

function updateStatisticsDisplay() {
  if (!state.activity) {
    ui.statsDistance.placeholder = 'Automatic';
    ui.statsElevation.placeholder = 'Automatic';
    ui.statsMovingTime.placeholder = 'Automatic (hh:mm:ss)';
    ui.statsHeartRate.placeholder = 'Automatic';
    return;
  }
  const paceMode = metricMode() === 'pace';
  const automaticMovingSeconds = paceMode
    ? (state.activity.movingSecondsPace || state.activity.movingSeconds)
    : (state.activity.movingSecondsSpeed || state.activity.movingSeconds);
  ui.statsDistance.placeholder = `Automatic (${(state.activity.totalDistance / 1000).toFixed(2)})`;
  ui.statsElevation.placeholder = `Automatic (${Math.round(state.activity.elevationGain)})`;
  ui.statsMovingTime.placeholder = `Automatic (${formatTrimTime(automaticMovingSeconds)})`;
  ui.statsHeartRate.placeholder = Number.isFinite(state.activity.averageHeartRate)
    ? `Automatic (${Math.round(state.activity.averageHeartRate)})`
    : 'Not available in GPX';
  const statistics = effectiveActivityStatistics(paceMode);
  ui.activityHeading.textContent = `${state.activity.title} · ${(statistics.distance / 1000).toFixed(1)} km`;
}

function seedAutomaticStatistic(control) {
  if (!state.activity || control.value.trim()) return;
  let value = null;
  if (control === ui.statsDistance) value = (state.activity.totalDistance / 1000).toFixed(2);
  if (control === ui.statsElevation) value = String(Math.round(state.activity.elevationGain));
  if (control === ui.statsHeartRate && Number.isFinite(state.activity.averageHeartRate)) {
    value = String(Math.round(state.activity.averageHeartRate));
  }
  if (value == null) return;
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
}

function trimRangeSeconds(activity = state.sourceActivity) {
  return Math.max(1, Math.round(activity?.totalSeconds || 1));
}

function sampleActivityAtElapsed(activity, seconds) {
  if (!activity?.points?.length) return null;
  const target = clamp(Number(seconds) || 0, 0, activity.totalSeconds);
  if (target <= 0) return { ...activity.points[0] };
  if (target >= activity.totalSeconds) return { ...activity.points.at(-1) };
  let lo = 0;
  let hi = activity.points.length - 1;
  while (lo + 1 < hi) {
    const middle = (lo + hi) >> 1;
    if (activity.points[middle].elapsed < target) lo = middle;
    else hi = middle;
  }
  const a = activity.points[lo];
  const b = activity.points[hi];
  const t = clamp((target - a.elapsed) / Math.max(Number.EPSILON, b.elapsed - a.elapsed), 0, 1);
  return {
    lon: lerp(a.lon, b.lon, t),
    lat: lerp(a.lat, b.lat, t),
    distance: lerp(a.distance, b.distance, t),
    elapsed: target,
  };
}

function drawTrimPreview() {
  const canvas = ui.trimPreview;
  const activity = state.sourceActivity;
  if (canvas.hidden) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round((rect.width || ui.viewport.clientWidth || 960) * ratio));
  const height = Math.max(1, Math.round((rect.height || ui.viewport.clientHeight || 540) * ratio));
  const ctx = setupCanvas(canvas, width, height);
  if (!activity?.points?.length) {
    ctx.fillStyle = '#788291';
    ctx.font = `800 ${16 * ratio}px Inter, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Route preview', width / 2, height / 2);
    return;
  }

  const firstProjected = webMercatorPoint(activity.points[0]);
  const projectPoints = (points) => points.map((point) => {
    const projected = webMercatorPoint(point);
    while (projected.x - firstProjected.x > 0.5) projected.x -= 1;
    while (projected.x - firstProjected.x < -0.5) projected.x += 1;
    return projected;
  });
  const previewStep = Math.max(1, Math.ceil(activity.points.length / 2000));
  const previewPoints = activity.points.filter((_, index) => index % previewStep === 0);
  if (previewPoints.at(-1) !== activity.points.at(-1)) previewPoints.push(activity.points.at(-1));
  const all = projectPoints(previewPoints);
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  all.forEach((point) => {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  });
  const padding = Math.min(width, height) * 0.075;
  const scale = Math.min(
    (width - padding * 2) / Math.max(Number.EPSILON, maxX - minX),
    (height - padding * 2) / Math.max(Number.EPSILON, maxY - minY),
  );
  const mapPoint = (point) => ({
    x: width / 2 + (point.x - (minX + maxX) / 2) * scale,
    y: height / 2 + (point.y - (minY + maxY) / 2) * scale,
  });
  const drawPath = (points, color, lineWidth) => {
    if (points.length < 2) return;
    ctx.beginPath();
    points.forEach((point, index) => {
      const screen = mapPoint(point);
      if (!index) ctx.moveTo(screen.x, screen.y);
      else ctx.lineTo(screen.x, screen.y);
    });
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color;
    ctx.stroke();
  };

  drawPath(all, '#4b5563', 7 * ratio);
  const rangeSeconds = trimRangeSeconds(activity);
  const startSeconds = clamp(Number(ui.trimStart.value) || 0, 0, rangeSeconds);
  const endSeconds = clamp(Number(ui.trimEnd.value) || rangeSeconds, startSeconds, rangeSeconds);
  const start = startSeconds / rangeSeconds;
  const end = endSeconds / rangeSeconds;
  const pointAtFraction = (fraction) => sampleActivityAtElapsed(activity, fraction * activity.totalSeconds);
  const selectedCount = clamp(Math.ceil((end - start) * 1600), 2, 1600);
  const selectedPoints = Array.from({ length: selectedCount }, (_, index) => pointAtFraction(lerp(start, end, index / (selectedCount - 1))));
  const selected = projectPoints(selectedPoints);
  drawPath(selected, '#090b0e', 10 * ratio);
  drawPath(selected, ui.routeColor.value, 6 * ratio);
  const drawHandle = (point, fill) => {
    const screen = mapPoint(point);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 8.5 * ratio, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 3 * ratio;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  };
  drawHandle(selected[0], COLORS.green);
  drawHandle(selected.at(-1), COLORS.red);

  const selectedKm = Math.max(0, (selectedPoints.at(-1).distance - selectedPoints[0].distance) / 1000);
  const caption = `TRIM PREVIEW  ·  ${formatTrimTime(endSeconds - startSeconds)} selected  ·  ${selectedKm.toFixed(1)} km`;
  ctx.font = `800 ${Math.max(12, Math.min(width, height) * 0.025)}px Inter, Arial, sans-serif`;
  const captionWidth = ctx.measureText(caption).width;
  const captionHeight = 38 * ratio;
  const captionX = width / 2;
  const captionY = height - Math.max(22 * ratio, padding * 0.45);
  ctx.fillStyle = 'rgba(4, 7, 11, .84)';
  ctx.beginPath();
  const captionLeft = captionX - captionWidth / 2 - 16 * ratio;
  if (ctx.roundRect) ctx.roundRect(captionLeft, captionY - captionHeight / 2,
    captionWidth + 32 * ratio, captionHeight, 18 * ratio);
  else ctx.rect(captionLeft, captionY - captionHeight / 2, captionWidth + 32 * ratio, captionHeight);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(caption, captionX, captionY);
}

function updateTrimControl(changed = '') {
  const totalSeconds = trimRangeSeconds();
  const minimumGap = Math.min(1, totalSeconds);
  ui.trimStart.max = String(totalSeconds);
  ui.trimEnd.max = String(totalSeconds);
  ui.trimStart.step = '1';
  ui.trimEnd.step = '1';
  let start = clamp(Math.round(Number(ui.trimStart.value) || 0), 0, totalSeconds);
  let end = clamp(Math.round(Number(ui.trimEnd.value) || totalSeconds), 0, totalSeconds);
  if (changed === 'start' && start > end - minimumGap) start = end - minimumGap;
  if (changed === 'end' && end < start + minimumGap) end = start + minimumGap;
  start = clamp(start, 0, totalSeconds - minimumGap);
  end = clamp(end, start + minimumGap, totalSeconds);
  ui.trimStart.value = String(start);
  ui.trimEnd.value = String(end);
  ui.trimValue.textContent = `${formatTrimTime(start)} – ${formatTrimTime(end)}`;
  ui.trimStart.setAttribute('aria-valuetext', `Start ${formatTrimTime(start)}`);
  ui.trimEnd.setAttribute('aria-valuetext', `End ${formatTrimTime(end)}`);
  ui.trimFill.style.left = `${start / totalSeconds * 100}%`;
  ui.trimFill.style.right = `${100 - end / totalSeconds * 100}%`;
  ui.trimStart.style.zIndex = changed === 'start' ? '4' : '3';
  ui.trimEnd.style.zIndex = changed === 'end' ? '4' : '3';
  if (state.sourceActivity) {
    const selectedStart = sampleActivityAtElapsed(state.sourceActivity, start / totalSeconds * state.sourceActivity.totalSeconds);
    const selectedEnd = sampleActivityAtElapsed(state.sourceActivity, end / totalSeconds * state.sourceActivity.totalSeconds);
    const selectedKm = Math.max(0, (selectedEnd.distance - selectedStart.distance) / 1000);
    ui.trimDetail.textContent = `Keep ${(selectedStart.distance / 1000).toFixed(1)}km–${(selectedEnd.distance / 1000).toFixed(1)}km · ${formatTrimTime(end - start)} selected · ${selectedKm.toFixed(1)} km`;
  } else {
    ui.trimDetail.textContent = 'Load a GPX activity to trim it.';
  }
  if (changed && state.sourceActivity) {
    if (state.animating) stopAnimation(false);
    ui.trimPreview.hidden = false;
    ui.trimPreview.classList.add('standalone');
  }
  drawTrimPreview();
}

function discardPreparedMap() {
  state.terrainProfileRequest += 1;
  state.ready = false;
  state.overview = null;
  state.route3dLayer = null;
  state.nativeRouteProgress = null;
  state.nativeRouteColorMode = null;
  state.nativeRouteColor = null;
  state.nativeRouteSegmentCount = 0;
  state.nativeRouteVisibleSegment = -1;
  state.nativeRouteFinished = null;
  state.routeFinalBoost = null;
  state.positionMarker = null;
  state.positionMarkerElement = null;
  state.pendingPositionMarker = null;
  resetCameraSmoothing();
  if (state.map) state.map.remove();
  state.map = null;
  ui.map.replaceChildren();
  ui.empty.hidden = false;
  ui.preview.disabled = true;
  ui.export.disabled = true;
  ui.progress.value = 0;
  ui.frameCounter.textContent = 'Frame – / –';
  ui.trimPreview.hidden = !state.sourceActivity;
  ui.trimPreview.classList.toggle('standalone', Boolean(state.sourceActivity));
}

function applyTrimSelection() {
  if (!state.sourceText || !state.sourceActivity) return;
  stopAnimation(false);
  const keepPreparedMap = Boolean(state.map && state.ready);
  const totalSeconds = trimRangeSeconds();
  const start = Number(ui.trimStart.value) / totalSeconds;
  const end = Number(ui.trimEnd.value) / totalSeconds;
  try {
    const chosenTitle = ui.title.value;
    clearStatisticsOverrides();
    state.activity = parseGpx(state.sourceText, state.sourceFileName, start, end);
    state.currentProgress = 0;
    resetCameraSmoothing();
    state.routeFinalBoost = null;
    if (keepPreparedMap) {
      state.pendingPositionMarker = null;
      state.map.removeFeatureState({ source: 'route' });
      state.map.getSource('route')?.setData(routeGeoJson());
      state.map.getSource('route-final')?.setData(routeOverviewGeoJson());
      state.route3dLayer?.setTerrainProfile(null);
      // Trimming changes both line metrics and the sampled speed colors.
      state.nativeRouteProgress = null;
      state.nativeRouteColorMode = null;
      state.nativeRouteVisibleSegment = -1;
      state.nativeRouteFinished = null;
      state.map.getSource('start-marker')?.setData(pointGeoJson(state.activity.points[0]));
      state.positionMarker?.setLngLat([state.activity.points[0].lon, state.activity.points[0].lat]);
      state.positionMarkerElement?.classList.remove('finish');
    } else {
      discardPreparedMap();
    }
    if (chosenTitle) ui.title.value = chosenTitle;
    updateStatisticsDisplay();
    updateHeartRateAvailability();
    updateTrimControl();
    drawPreviewOverlays(0);
    if (keepPreparedMap) {
      ui.trimPreview.hidden = true;
      ui.trimPreview.classList.remove('standalone');
      ui.preview.disabled = false;
      ui.export.disabled = false;
      updateOverview();
      setStatus('Activity trimmed', `${(state.activity.totalDistance / 1000).toFixed(1)} km selected · live 3D preview updated.`);
    } else {
      drawTrimPreview();
      setStatus('Activity trimmed', `${(state.activity.totalDistance / 1000).toFixed(1)} km selected · prepare the 3D map when ready.`);
    }
  } catch (error) {
    ui.trimPreview.hidden = Boolean(keepPreparedMap);
    setStatus('Activity could not be trimmed', error.message || String(error));
  }
}

function setOrientation() {
  ui.viewport.classList.toggle('vertical', ui.orientation.value === 'vertical');
  ui.viewport.classList.toggle('horizontal', ui.orientation.value !== 'vertical');
  requestAnimationFrame(() => {
    state.map?.resize();
    drawPreviewOverlays(state.currentProgress);
    if (state.ready) updateOverview();
  });
}

function haversineMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function webMercatorPoint(point) {
  const latitude = clamp(point.lat, -85.051129, 85.051129) * Math.PI / 180;
  return {
    x: (point.lon + 180) / 360,
    y: (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2,
  };
}

function localElements(root, name) {
  return Array.from(root.getElementsByTagNameNS('*', name));
}

function directChildText(element, name) {
  const match = Array.from(element.children).find((child) => child.localName === name);
  return match?.textContent?.trim() || '';
}

function firstNumericElement(root, names) {
  for (const name of names) {
    const value = Number(localElements(root, name)[0]?.textContent?.trim());
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function quantile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return lerp(sorted[low], sorted[high], index - low);
}

function repairAndSmoothSpeeds(points, rawSpeeds) {
  const valid = rawSpeeds.map((v) => Number.isFinite(v) && v >= 0.2 && v <= 45);
  const fallback = quantile(rawSpeeds.filter((_, i) => valid[i]), 0.5) || 2.5;
  const repaired = rawSpeeds.map((value, i) => {
    if (valid[i]) return value;
    let previous = i - 1;
    let next = i + 1;
    while (previous >= 0 && !valid[previous]) previous -= 1;
    while (next < rawSpeeds.length && !valid[next]) next += 1;
    if (previous >= 0 && next < rawSpeeds.length) return (rawSpeeds[previous] + rawSpeeds[next]) / 2;
    if (previous >= 0) return rawSpeeds[previous];
    if (next < rawSpeeds.length) return rawSpeeds[next];
    return fallback;
  });

  const smoothed = new Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    let lo = i;
    let hi = i;
    while (lo > 0 && points[i].distance - points[lo].distance < 90) lo -= 1;
    while (hi + 1 < points.length && points[hi].distance - points[i].distance < 90) hi += 1;
    const window = repaired.slice(lo, hi + 1).sort((a, b) => a - b);
    const trim = Math.floor(window.length * 0.15);
    const center = window.slice(trim, Math.max(trim + 1, window.length - trim));
    smoothed[i] = center.reduce((sum, value) => sum + value, 0) / center.length;
  }
  return smoothed;
}

function repairAndSmoothHeartRates(points) {
  const raw = points.map((point) => point.heartRate);
  const valid = raw.map((value) => Number.isFinite(value) && value >= 25 && value <= 250);
  if (!valid.some(Boolean)) return null;

  const repaired = raw.map((value, index) => {
    if (valid[index]) return value;
    let previous = index - 1;
    let next = index + 1;
    while (previous >= 0 && !valid[previous]) previous -= 1;
    while (next < raw.length && !valid[next]) next += 1;
    if (previous >= 0 && next < raw.length) {
      const span = Math.max(1, next - previous);
      return lerp(raw[previous], raw[next], (index - previous) / span);
    }
    if (previous >= 0) return raw[previous];
    return raw[next];
  });

  return repaired.map((_, index) => {
    const lo = Math.max(0, index - 2);
    const hi = Math.min(repaired.length - 1, index + 2);
    const window = repaired.slice(lo, hi + 1);
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
}

function smoothedElevationProfile(points, smoothingMeters = 3) {
  const pass = (reverse) => {
    const values = new Array(points.length);
    for (let step = 0; step < points.length; step += 1) {
      const index = reverse ? points.length - 1 - step : step;
      const neighbor = reverse ? index + 1 : index - 1;
      const elevation = points[index].elevation;
      const newSegment = neighbor < 0
        || neighbor >= points.length
        || points[index].segmentIndex !== points[neighbor].segmentIndex;
      if (newSegment || !Number.isFinite(values[neighbor])) {
        values[index] = elevation;
        continue;
      }
      const spacing = Math.max(0.1, haversineMeters(points[index], points[neighbor]));
      const weight = 1 - Math.exp(-spacing / smoothingMeters);
      values[index] = lerp(values[neighbor], elevation, weight);
    }
    return values;
  };

  const forward = pass(false);
  const backward = pass(true);
  return forward.map((value, index) => (value + backward[index]) / 2);
}

function calculateElevationGain(points, thresholdMeters = 2) {
  if (points.length < 2) return 0;
  const elevations = smoothedElevationProfile(points);
  let gain = 0;
  let valley = elevations[0];
  let peak = elevations[0];

  const finishClimb = () => {
    const climb = peak - valley;
    if (climb >= thresholdMeters) gain += climb;
  };

  for (let index = 1; index < elevations.length; index += 1) {
    const elevation = elevations[index];
    if (points[index].segmentIndex !== points[index - 1].segmentIndex) {
      finishClimb();
      valley = elevation;
      peak = elevation;
      continue;
    }
    if (elevation > peak) {
      peak = elevation;
    } else if (peak - elevation >= thresholdMeters) {
      finishClimb();
      valley = elevation;
      peak = elevation;
    } else if (elevation < valley) {
      valley = elevation;
      peak = elevation;
    }
  }
  finishClimb();
  return gain;
}

function calculateMovingTime(points, activityMetric, fallbackSeconds) {
  const minimumSpeed = activityMetric === 'pace' ? 0.2 : 0.8;
  const maximumSpeed = activityMetric === 'pace' ? 15 : 55;
  let movingSeconds = 0;
  let timedSegments = 0;
  const intervals = [];
  let hasSegmentBreak = false;

  for (let index = 1; index < points.length; index += 1) {
    if (points[index].segmentIndex !== points[index - 1].segmentIndex) {
      hasSegmentBreak = true;
      continue;
    }
    const seconds = (points[index].timestamp - points[index - 1].timestamp) / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    timedSegments += 1;
    intervals.push(seconds);
    const distance = Math.max(0, points[index].distance - points[index - 1].distance);
    const speed = Number.isFinite(points[index].recordedSpeed)
      ? points[index].recordedSpeed
      : distance / seconds;
    if (speed >= minimumSpeed && speed <= maximumSpeed) movingSeconds += seconds;
  }

  // Some exported GPX files already contain a pause-free moving-time
  // timeline. A long, uninterrupted stream with an almost perfectly uniform
  // timestamp cadence is a strong signal that pauses were handled before the
  // export. Reapplying a GPS speed threshold would incorrectly remove periods
  // where the receiver temporarily repeated the same coordinate.
  if (!hasSegmentBreak && intervals.length >= 30) {
    const sortedIntervals = [...intervals].sort((a, b) => a - b);
    const medianInterval = sortedIntervals[Math.floor(sortedIntervals.length / 2)];
    const tolerance = Math.max(0.25, medianInterval * 0.2);
    const regularIntervals = intervals.filter((seconds) => Math.abs(seconds - medianInterval) <= tolerance).length;
    const uninterrupted = intervals.every((seconds) => seconds <= medianInterval + tolerance);
    if (medianInterval > 0 && medianInterval <= 10
        && regularIntervals / intervals.length >= 0.98 && uninterrupted) {
      return fallbackSeconds;
    }
  }

  return timedSegments && movingSeconds > 0
    ? Math.min(movingSeconds, fallbackSeconds)
    : fallbackSeconds;
}

function trimTrackPoints(points, startFraction, endFraction) {
  // The handles now move in one-second steps, so do not silently expand a
  // short selection to the former 0.5% minimum.
  const minimumFraction = 1e-9;
  const start = clamp(Number(startFraction) || 0, 0, 1 - minimumFraction);
  const end = clamp(Number(endFraction) || 1, start + minimumFraction, 1);
  if (start <= 0 && end >= 1) return points;

  // Prefer the GPX timeline so the trim handles represent actual activity
  // time. Distance remains a deterministic fallback for files without time.
  const validTimeIndices = points
    .map((point, index) => (Number.isFinite(point.timestamp) ? index : -1))
    .filter((index) => index >= 0);
  let cumulative;
  if (validTimeIndices.length >= 2
      && points[validTimeIndices.at(-1)].timestamp > points[validTimeIndices[0]].timestamp) {
    const repairedTimes = new Array(points.length);
    for (let validIndex = 0; validIndex < validTimeIndices.length - 1; validIndex += 1) {
      const from = validTimeIndices[validIndex];
      const to = validTimeIndices[validIndex + 1];
      for (let index = from; index <= to; index += 1) {
        const t = (index - from) / Math.max(1, to - from);
        repairedTimes[index] = lerp(points[from].timestamp, points[to].timestamp, t);
      }
    }
    const firstValid = validTimeIndices[0];
    const lastValid = validTimeIndices.at(-1);
    for (let index = 0; index < firstValid; index += 1) repairedTimes[index] = repairedTimes[firstValid];
    for (let index = lastValid + 1; index < points.length; index += 1) repairedTimes[index] = repairedTimes[lastValid];
    const origin = repairedTimes[0];
    cumulative = repairedTimes.map((timestamp, index) => {
      const elapsed = Math.max(0, timestamp - origin);
      return index ? Math.max(elapsed, repairedTimes[index - 1] - origin) : elapsed;
    });
  } else {
    cumulative = [0];
    for (let index = 1; index < points.length; index += 1) {
      const segment = points[index].segmentIndex === points[index - 1].segmentIndex
        ? haversineMeters(points[index - 1], points[index])
        : 0;
      cumulative.push(cumulative[index - 1] + segment);
    }
  }
  const total = cumulative.at(-1);
  if (!Number.isFinite(total) || total <= 0) return points;

  const pointAtPosition = (target) => {
    if (target <= 0) return { ...points[0] };
    if (target >= total) return { ...points.at(-1) };
    let hi = cumulative.findIndex((distance) => distance >= target);
    if (hi < 1) hi = 1;
    const lo = hi - 1;
    const span = Math.max(Number.EPSILON, cumulative[hi] - cumulative[lo]);
    const t = clamp((target - cumulative[lo]) / span, 0, 1);
    const a = points[lo];
    const b = points[hi];
    const interpolateOptional = (first, second) => {
      if (Number.isFinite(first) && Number.isFinite(second)) return lerp(first, second, t);
      return Number.isFinite(first) ? first : second;
    };
    return {
      ...a,
      lat: lerp(a.lat, b.lat, t),
      lon: lerp(a.lon, b.lon, t),
      elevation: lerp(a.elevation, b.elevation, t),
      timestamp: interpolateOptional(a.timestamp, b.timestamp),
      heartRate: interpolateOptional(a.heartRate, b.heartRate),
      recordedDistance: interpolateOptional(a.recordedDistance, b.recordedDistance),
      recordedSpeed: interpolateOptional(a.recordedSpeed, b.recordedSpeed),
    };
  };

  const startPosition = total * start;
  const endPosition = total * end;
  const selected = [pointAtPosition(startPosition)];
  for (let index = 1; index < points.length - 1; index += 1) {
    if (cumulative[index] > startPosition && cumulative[index] < endPosition) selected.push({ ...points[index] });
  }
  selected.push(pointAtPosition(endPosition));
  selected[0].segmentStart = true;
  for (let index = 1; index < selected.length; index += 1) {
    selected[index].segmentStart = selected[index].segmentIndex !== selected[index - 1].segmentIndex;
  }
  return selected;
}

function parseGpx(text, fileName, trimStart = 0, trimEnd = 1) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('The GPX file is not valid XML.');
  const trk = localElements(xml, 'trk')[0];
  const metadata = localElements(xml, 'metadata')[0];
  const sourceTitle = directChildText(trk || xml.documentElement, 'name') || directChildText(metadata || xml.documentElement, 'name');
  const title = sourceTitle || fileName.replace(/\.gpx$/i, '').replaceAll('_', ' ');
  const type = `${directChildText(trk || xml.documentElement, 'type')} ${title}`.toLowerCase();
  const defaultMetric = /(run|running|trail|hike|walk|tek|pohod)/.test(type) ? 'pace' : 'speed';

  const trackSegments = localElements(xml, 'trkseg');
  const entries = trackSegments.length
    ? trackSegments.flatMap((segment, segmentIndex) => localElements(segment, 'trkpt').map((node) => ({ node, segmentIndex })))
    : localElements(xml, 'trkpt').map((node) => ({ node, segmentIndex: 0 }));
  if (entries.length < 2) throw new Error('The GPX file needs at least two track points.');

  let points = entries.map(({ node, segmentIndex }) => {
    const lat = Number(node.getAttribute('lat'));
    const lon = Number(node.getAttribute('lon'));
    const elevation = Number(directChildText(node, 'ele'));
    const timeText = directChildText(node, 'time');
    const timestamp = timeText ? Date.parse(timeText) : NaN;
    const heartRate = Number(localElements(node, 'hr')[0]?.textContent?.trim());
    const recordedDistance = firstNumericElement(node, ['distance', 'DistanceMeters']);
    const recordedSpeed = firstNumericElement(node, ['speed']);
    return {
      lat,
      lon,
      elevation: Number.isFinite(elevation) ? elevation : 0,
      timestamp,
      heartRate: Number.isFinite(heartRate) && heartRate >= 25 && heartRate <= 250 ? heartRate : null,
      recordedDistance,
      recordedSpeed: Number.isFinite(recordedSpeed) && recordedSpeed >= 0 ? recordedSpeed : null,
      segmentIndex,
      segmentStart: false,
      distance: 0,
      elapsed: 0,
      speed: 0,
    };
  }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (points.length < 2) throw new Error('The GPX file does not contain usable coordinates.');
  points.forEach((point, index) => {
    point.segmentStart = index === 0 || point.segmentIndex !== points[index - 1].segmentIndex;
  });
  points = trimTrackPoints(points, trimStart, trimEnd);

  let distance = 0;
  let renderDistance = 0;
  points[0].renderDistance = 0;
  for (let i = 1; i < points.length; i += 1) {
    const gpsSegment = haversineMeters(points[i - 1], points[i]);
    const hasRecordedDistance = Number.isFinite(points[i].recordedDistance)
      && Number.isFinite(points[i - 1].recordedDistance);
    const recordedSegment = hasRecordedDistance
      ? points[i].recordedDistance - points[i - 1].recordedDistance
      : NaN;
    const recordedDistanceIsUsable = hasRecordedDistance
      && recordedSegment >= 0
      && recordedSegment <= Math.max(1000, gpsSegment * 5 + 50);
    const segment = points[i].segmentStart
      ? 0
      : (recordedDistanceIsUsable ? recordedSegment : gpsSegment);
    distance += Number.isFinite(segment) ? segment : 0;
    points[i].distance = distance;
    const previousProjected = webMercatorPoint(points[i - 1]);
    const projected = webMercatorPoint(points[i]);
    let dx = projected.x - previousProjected.x;
    if (dx > 0.5) dx -= 1;
    if (dx < -0.5) dx += 1;
    renderDistance += Math.hypot(dx, projected.y - previousProjected.y);
    points[i].renderDistance = renderDistance;
  }

  const elevationGain = calculateElevationGain(points);

  const timed = points.filter((point) => Number.isFinite(point.timestamp));
  const startTime = timed[0]?.timestamp;
  const endTime = timed.at(-1)?.timestamp;
  const hasTimes = Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime;
  const estimatedSeconds = Math.max(1, distance / 2.5);
  const totalSeconds = hasTimes ? (endTime - startTime) / 1000 : estimatedSeconds;
  for (const point of points) {
    point.elapsed = hasTimes && Number.isFinite(point.timestamp)
      ? clamp((point.timestamp - startTime) / 1000, 0, totalSeconds)
      : totalSeconds * (distance ? point.distance / distance : 0);
  }

  const rawSpeeds = points.map((point, i) => {
    if (Number.isFinite(point.recordedSpeed) && point.recordedSpeed > 0) return point.recordedSpeed;
    const lo = Math.max(0, i - 2);
    const hi = Math.min(points.length - 1, i + 2);
    const dt = points[hi].elapsed - points[lo].elapsed;
    const dd = points[hi].distance - points[lo].distance;
    return dt > 0 ? dd / dt : NaN;
  });
  const speeds = repairAndSmoothSpeeds(points, rawSpeeds);
  points.forEach((point, i) => { point.speed = speeds[i]; });
  const heartRates = repairAndSmoothHeartRates(points);
  if (heartRates) points.forEach((point, index) => { point.heartRate = heartRates[index]; });
  const movingSecondsPace = calculateMovingTime(points, 'pace', totalSeconds);
  const movingSecondsSpeed = calculateMovingTime(points, 'speed', totalSeconds);
  const movingSeconds = defaultMetric === 'pace' ? movingSecondsPace : movingSecondsSpeed;

  return {
    title,
    points,
    totalDistance: distance,
    totalRenderDistance: renderDistance,
    totalSeconds,
    movingSeconds,
    movingSecondsPace,
    movingSecondsSpeed,
    elevationGain,
    averageSpeed: distance / Math.max(1, movingSeconds),
    hasHeartRate: Boolean(heartRates),
    averageHeartRate: heartRates ? heartRates.reduce((sum, value) => sum + value, 0) / heartRates.length : null,
    defaultMetric,
  };
}

function sampleActivity(fraction) {
  const activity = state.activity;
  const target = clamp(fraction, 0, 1) * activity.totalRenderDistance;
  if (target <= 0) return { ...activity.points[0], index: 0 };
  if (target >= activity.totalRenderDistance) return { ...activity.points.at(-1), index: activity.points.length - 1 };
  let lo = 0;
  let hi = activity.points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (activity.points[mid].renderDistance < target) lo = mid;
    else hi = mid;
  }
  const a = activity.points[lo];
  const b = activity.points[hi];
  const span = Math.max(Number.EPSILON, b.renderDistance - a.renderDistance);
  const t = clamp((target - a.renderDistance) / span, 0, 1);
  return {
    lon: lerp(a.lon, b.lon, t),
    lat: lerp(a.lat, b.lat, t),
    elevation: lerp(a.elevation, b.elevation, t),
    elapsed: lerp(a.elapsed, b.elapsed, t),
    distance: lerp(a.distance, b.distance, t),
    speed: lerp(a.speed, b.speed, t),
    heartRate: Number.isFinite(a.heartRate) && Number.isFinite(b.heartRate)
      ? lerp(a.heartRate, b.heartRate, t)
      : (Number.isFinite(a.heartRate) ? a.heartRate : b.heartRate),
    index: lo,
  };
}

function smoothedRoutePosition(fraction, radius = 0.006) {
  const base = sampleActivity(clamp(fraction, 0, 1));
  const offsets = [-1, -0.5, 0, 0.5, 1];
  const weights = [1, 2, 3, 2, 1];
  let lon = 0;
  let lat = 0;
  let weightTotal = 0;
  offsets.forEach((offset, index) => {
    const sample = sampleActivity(clamp(fraction + offset * radius, 0, 1));
    let adjustedLon = sample.lon;
    while (adjustedLon - base.lon > 180) adjustedLon -= 360;
    while (adjustedLon - base.lon < -180) adjustedLon += 360;
    lon += adjustedLon * weights[index];
    lat += sample.lat * weights[index];
    weightTotal += weights[index];
  });
  return { lon: lon / weightTotal, lat: lat / weightTotal };
}

function localElevationRelief(fraction, radius = 0.018) {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const offset of [-1, -0.72, -0.45, -0.2, 0, 0.2, 0.45, 0.72, 1]) {
    const elevation = sampleActivity(clamp(fraction + offset * radius, 0, 1)).elevation;
    if (!Number.isFinite(elevation)) continue;
    minimum = Math.min(minimum, elevation);
    maximum = Math.max(maximum, elevation);
  }
  return Number.isFinite(minimum) && Number.isFinite(maximum) ? maximum - minimum : 0;
}

function routeDescentRisk(fraction) {
  // A wider window ignores noisy individual GPX elevations and detects only
  // a sustained downhill section that needs a safer camera angle.
  const behind = sampleActivity(clamp(fraction - 0.006, 0, 1));
  const ahead = sampleActivity(clamp(fraction + 0.018, 0, 1));
  const horizontalDistance = Math.max(1, ahead.distance - behind.distance);
  const grade = (ahead.elevation - behind.elevation) / horizontalDistance;
  return smoothstep(((-grade) - 0.035) / 0.11);
}

function resetCameraSmoothing() {
  state.cameraCenter = null;
  state.cameraBearing = null;
  state.cameraZoom = null;
  state.cameraPitch = null;
  state.outroPose = null;
}

function headingBetween(a, b) {
  const rad = Math.PI / 180;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const dLon = (b.lon - a.lon) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return Math.atan2(y, x) / rad;
}

function shortestAngle(a, b, t) {
  const delta = ((b - a + 540) % 360) - 180;
  return a + delta * t;
}

function speedPosition(speed) {
  const values = state.activity.points.map((point) => point.speed).filter(Number.isFinite);
  const low = state.activity.speedLow ??= quantile(values, 0.15);
  const high = state.activity.speedHigh ??= Math.max(low + 0.1, quantile(values, 0.85));
  return clamp((speed - low) / (high - low), 0, 1);
}

function colorForSpeed(speed) {
  const t = speedPosition(speed);
  if (t < 0.5) return mixHex('#ef4444', '#f5b63a', t * 2);
  return mixHex('#f5b63a', '#23c55e', (t - 0.5) * 2);
}

function mixHex(a, b, t) {
  const pa = a.match(/[a-f\d]{2}/gi).map((part) => parseInt(part, 16));
  const pb = b.match(/[a-f\d]{2}/gi).map((part) => parseInt(part, 16));
  return `#${pa.map((value, i) => Math.round(lerp(value, pb[i], t)).toString(16).padStart(2, '0')).join('')}`;
}

function mapStyle(token) {
  const access = encodeURIComponent(token);
  const style = {
    version: 8,
    transition: { duration: 0, delay: 0 },
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      satellite: {
        type: 'raster', tileSize: 512, maxzoom: 22,
        tiles: [`https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${access}`],
        attribution: '© Mapbox © OpenStreetMap',
      },
      terrain: {
        type: 'raster-dem', tileSize: 512, maxzoom: 14, encoding: 'mapbox',
        tiles: [`https://api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}@2x.pngraw?access_token=${access}`],
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#263b3a' } },
      { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-brightness-min': 0.06, 'raster-brightness-max': 0.92, 'raster-saturation': 0.06, 'raster-contrast': 0.06, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } },
      { id: 'terrain-shade', type: 'hillshade', source: 'terrain', paint: { 'hillshade-exaggeration': 0.18, 'hillshade-shadow-color': '#17202a', 'hillshade-highlight-color': '#fff3d4', 'hillshade-accent-color': '#6c5844' } },
    ],
  };
  if (ui.labels.checked) {
    style.sources.streets = {
      type: 'vector', minzoom: 0, maxzoom: 14,
      tiles: [`https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/{z}/{x}/{y}.mvt?access_token=${access}`],
      attribution: '© Mapbox © OpenStreetMap',
    };
  }
  return style;
}

function routeGeoJson() {
  const activity = state.activity;
  // Short, stable features let feature-state reveal the route without
  // rebuilding a terrain-draped line-gradient for every animation frame. Keep
  // the features short enough that their unrevealed tail fits underneath the
  // position marker, while retaining all original GPX points inside them.
  const segmentCount = clamp(Math.ceil(activity.totalDistance / 8), 600, 8192);
  const features = [];
  let pointCursor = 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const startProgress = index / segmentCount;
    const endProgress = (index + 1) / segmentCount;
    const start = sampleActivity(startProgress);
    const end = sampleActivity(endProgress);
    const coordinates = [[start.lon, start.lat]];
    while (
      pointCursor < activity.points.length - 1
      && activity.points[pointCursor].renderDistance / activity.totalRenderDistance < endProgress
    ) {
      const point = activity.points[pointCursor];
      if (point.renderDistance / activity.totalRenderDistance > startProgress) {
        coordinates.push([point.lon, point.lat]);
      }
      pointCursor += 1;
    }
    coordinates.push([end.lon, end.lat]);
    features.push({
      type: 'Feature',
      id: index,
      properties: {
        speedColor: colorForSpeed(sampleActivity((startProgress + endProgress) * 0.5).speed),
      },
      geometry: { type: 'LineString', coordinates },
    });
  }
  state.nativeRouteSegmentCount = segmentCount;
  state.nativeRouteVisibleSegment = -1;
  state.nativeRouteFinished = null;
  return { type: 'FeatureCollection', features };
}

function routeOverviewGeoJson() {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: state.activity.points.map((point) => [point.lon, point.lat]),
    },
  };
}

function pointGeoJson(point) {
  return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [point.lon, point.lat] } };
}

function routeWidthAtZoom(zoom, outline = false) {
  const stops = outline
    ? [[7, 4.8], [11, 7.2], [16, 12]]
    : [[7, 3.8], [11, 5.9], [16, 10]];
  if (zoom <= stops[0][0]) return stops[0][1];
  if (zoom >= stops.at(-1)[0]) return stops.at(-1)[1];
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const next = stops[index];
    if (zoom <= next[0]) return lerp(previous[1], next[1], (zoom - previous[0]) / (next[0] - previous[0]));
  }
  return stops.at(-1)[1];
}

function routeLineWidthExpression(outline = false, boost = 1) {
  const stops = outline
    ? [[7, 4.8], [11, 7.2], [16, 12]]
    : [[7, 3.8], [11, 5.9], [16, 10]];
  const expression = ['interpolate', ['linear'], ['zoom']];
  for (const [zoom, width] of stops) expression.push(zoom, width * boost);
  return expression;
}

function nativeRouteBaseColorExpression(outline = false) {
  return outline
    ? COLORS.routeOutline
    : (ui.routeColoring.value === 'speed' ? ['get', 'speedColor'] : ui.routeColor.value);
}

function finalRouteGradientExpression() {
  if (ui.routeColoring.value !== 'speed') {
    return ['interpolate', ['linear'], ['line-progress'], 0, ui.routeColor.value, 1, ui.routeColor.value];
  }
  const stopCount = QUALITY[ui.quality.value]?.gradientStops || 52;
  const expression = ['interpolate', ['linear'], ['line-progress']];
  for (let index = 0; index < stopCount; index += 1) {
    const progress = stopCount === 1 ? 0 : index / (stopCount - 1);
    expression.push(progress, colorForSpeed(sampleActivity(progress).speed));
  }
  return expression;
}

function nativeRouteColorExpression(outline = false) {
  return [
    'case',
    ['boolean', ['feature-state', 'visible'], false],
    nativeRouteBaseColorExpression(outline),
    'rgba(0,0,0,0)',
  ];
}

function updateNativeRouteVisibility(progress) {
  if (!state.map?.getSource('route') || !state.nativeRouteSegmentCount) return;
  const segmentCount = state.nativeRouteSegmentCount;
  // Reveal the short segment containing the exact interpolated position. Its
  // few-metre remainder sits underneath the position marker, so the route and
  // marker always look connected without a delayed endpoint.
  const normalized = clamp(progress, 0, 1);
  const target = normalized <= 0
    ? -1
    : Math.min(segmentCount - 1, Math.ceil(normalized * segmentCount) - 1);
  let previous = state.nativeRouteVisibleSegment;
  if (target < previous) {
    state.map.removeFeatureState({ source: 'route' });
    previous = -1;
  }
  for (let id = previous + 1; id <= target; id += 1) {
    state.map.setFeatureState({ source: 'route', id }, { visible: true });
  }
  state.nativeRouteVisibleSegment = target;
}

function visibleRouteEndpointProgress(progress) {
  const normalized = clamp(progress, 0, 1);
  const segmentCount = state.nativeRouteSegmentCount;
  if (!segmentCount || normalized <= 0) return normalized;
  if (normalized >= 0.9995) return 1;
  // The animated route reveals the complete short segment containing the
  // current position. Put the marker on that segment's actual endpoint so the
  // two visuals stay connected at every camera distance.
  return Math.min(1, Math.ceil(normalized * segmentCount) / segmentCount);
}

function hexColorToRgb(color) {
  const normalized = color.replace('#', '').trim();
  const value = normalized.length === 3
    ? normalized.split('').map((part) => part + part).join('')
    : normalized.padEnd(6, '0').slice(0, 6);
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
}

function compileRouteShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Unknown shader error';
    gl.deleteShader(shader);
    throw new Error(`The 3D route shader could not be created: ${message}`);
  }
  return shader;
}

const terrainTileCache = new Map();

function routeCenterSampleCount(activity = state.activity) {
  if (!activity) return 0;
  const targetSpacing = clamp(activity.totalDistance / 24000, 0.8, 2.5);
  return clamp(Math.ceil(activity.totalDistance / targetSpacing) + 1, 1000, 48000);
}

function terrainTilePosition(point, zoom = 14) {
  const scale = 2 ** zoom;
  const latitude = clamp(point.lat, -85.05112878, 85.05112878);
  const x = (point.lon + 180) / 360 * scale;
  const y = (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * scale;
  const rawTileX = Math.floor(x);
  return {
    x: ((rawTileX % scale) + scale) % scale,
    y: clamp(Math.floor(y), 0, scale - 1),
    u: x - rawTileX,
    v: y - Math.floor(y),
  };
}

async function decodeTerrainTile(url) {
  if (terrainTileCache.has(url)) return terrainTileCache.get(url);
  const loading = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Terrain tile request failed (${response.status})`);
    const blob = await response.blob();
    let image;
    let objectUrl;
    if (typeof createImageBitmap === 'function') {
      image = await createImageBitmap(blob);
    } else {
      objectUrl = URL.createObjectURL(blob);
      image = new Image();
      image.src = objectUrl;
      await image.decode();
    }
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(image.width, image.height)
      : Object.assign(document.createElement('canvas'), { width: image.width, height: image.height });
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const decoded = context.getImageData(0, 0, image.width, image.height);
    image.close?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return decoded;
  })();
  terrainTileCache.set(url, loading);
  try {
    const decoded = await loading;
    // Keep enough decoded DEM tiles for repeated trimming without allowing
    // many different activities to accumulate unbounded image data in RAM.
    terrainTileCache.delete(url);
    terrainTileCache.set(url, Promise.resolve(decoded));
    while (terrainTileCache.size > 48) terrainTileCache.delete(terrainTileCache.keys().next().value);
    return decoded;
  } catch (error) {
    terrainTileCache.delete(url);
    throw error;
  }
}

async function loadRouteTerrainProfile(token, onProgress) {
  const zoom = 14;
  const centerCount = routeCenterSampleCount();
  const groups = new Map();
  for (let index = 0; index < centerCount; index += 1) {
    const progress = centerCount === 1 ? 0 : index / (centerCount - 1);
    const point = sampleActivity(progress);
    const tile = terrainTilePosition(point, zoom);
    const key = `${tile.x}/${tile.y}`;
    if (!groups.has(key)) groups.set(key, { x: tile.x, y: tile.y, samples: [] });
    groups.get(key).samples.push({ index, u: tile.u, v: tile.v });
  }

  const elevations = new Float64Array(centerCount);
  elevations.fill(Number.NaN);
  const entries = [...groups.values()];
  let cursor = 0;
  let complete = 0;
  let failedTiles = 0;
  const encodedToken = encodeURIComponent(token);
  const worker = async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor];
      cursor += 1;
      try {
        const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${zoom}/${entry.x}/${entry.y}@2x.pngraw?access_token=${encodedToken}`;
        const tile = await decodeTerrainTile(url);
        const elevationAtPixel = (x, y) => {
          const offset = (y * tile.width + x) * 4;
          return -10000 + (
            tile.data[offset] * 256 * 256 + tile.data[offset + 1] * 256 + tile.data[offset + 2]
          ) * 0.1;
        };
        for (const sample of entry.samples) {
          const pixelX = clamp(sample.u * (tile.width - 1), 0, tile.width - 1);
          const pixelY = clamp(sample.v * (tile.height - 1), 0, tile.height - 1);
          const x0 = Math.floor(pixelX);
          const y0 = Math.floor(pixelY);
          const x1 = Math.min(tile.width - 1, x0 + 1);
          const y1 = Math.min(tile.height - 1, y0 + 1);
          const tx = pixelX - x0;
          const ty = pixelY - y0;
          const top = lerp(elevationAtPixel(x0, y0), elevationAtPixel(x1, y0), tx);
          const bottom = lerp(elevationAtPixel(x0, y1), elevationAtPixel(x1, y1), tx);
          elevations[sample.index] = lerp(top, bottom, ty);
        }
      } catch (_) {
        failedTiles += 1;
      }
      complete += 1;
      onProgress?.(complete, entries.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => worker()));
  return { elevations, failedTiles, tileCount: entries.length };
}

async function refreshRouteTerrainProfile(showProgress = false) {
  const layer = state.route3dLayer;
  const activity = state.activity;
  const token = ui.token.value.trim();
  if (!layer || !activity || !token) return false;
  const request = ++state.terrainProfileRequest;
  try {
    const result = await loadRouteTerrainProfile(token, (done, total) => {
      if (!showProgress || request !== state.terrainProfileRequest) return;
      ui.progress.value = 0.58 + 0.07 * (done / Math.max(1, total));
      setStatus('Preparing precise route elevation', `Highest-resolution terrain tile ${done} / ${total}`);
    });
    if (request !== state.terrainProfileRequest || layer !== state.route3dLayer || activity !== state.activity) return false;
    layer.setTerrainProfile(result.elevations);
    if (result.failedTiles) {
      state.mapErrors.add(`${result.failedTiles} detailed terrain tile${result.failedTiles === 1 ? '' : 's'} could not be loaded; GPX elevation was used there.`);
    }
    return true;
  } catch (_) {
    if (request === state.terrainProfileRequest) {
      state.mapErrors.add('The fixed high-resolution terrain profile could not be prepared; map-visible elevation was used instead.');
    }
    return false;
  }
}

function createRaisedRoute3DLayer() {
  return {
    id: 'route-raised-3d',
    type: 'custom',
    renderingMode: '3d',
    progress: 0,
    renderedProgress: 0,
    finalBoost: 1,
    vertexCount: 0,
    segmentCount: 0,
    terrainElevations: null,

    setTerrainProfile(elevations) {
      this.terrainElevations = elevations;
      this.rebuild();
    },

    onAdd(map, gl) {
      this.map = map;
      this.gl = gl;
      const vertexSource = `#version 300 es
        precision highp float;
        uniform mat4 u_matrix;
        uniform vec2 u_viewport;
        uniform float u_line_width;
        uniform float u_depth_tolerance;
        in vec3 a_position_high;
        in vec3 a_position_low;
        in vec3 a_previous_high;
        in vec3 a_previous_low;
        in vec3 a_next_high;
        in vec3 a_next_low;
        in float a_meter_scale;
        in vec3 a_speed_color;
        in float a_side;
        out vec3 v_speed_color;
        out float v_side;

        vec2 clipToPixels(vec4 clipPosition) {
          float safeW = abs(clipPosition.w) < 0.000001
            ? (clipPosition.w < 0.0 ? -0.000001 : 0.000001)
            : clipPosition.w;
          vec2 ndc = clipPosition.xy / safeW;
          return (ndc * 0.5 + 0.5) * u_viewport;
        }

        vec4 projectPosition(vec3 highPart, vec3 lowPart) {
          return u_matrix * vec4(highPart, 1.0) + u_matrix * vec4(lowPart, 0.0);
        }

        void main() {
          vec4 clipPosition = projectPosition(a_position_high, a_position_low);
          vec4 previousClip = projectPosition(a_previous_high, a_previous_low);
          vec4 nextClip = projectPosition(a_next_high, a_next_low);
          vec2 currentPixels = clipToPixels(clipPosition);
          vec2 previousPixels = clipToPixels(previousClip);
          vec2 nextPixels = clipToPixels(nextClip);
          vec2 tangent = nextPixels - previousPixels;
          if (length(tangent) < 0.01) tangent = nextPixels - currentPixels;
          if (length(tangent) < 0.01) tangent = currentPixels - previousPixels;
          tangent /= max(length(tangent), 0.000001);
          vec2 normal = vec2(-tangent.y, tangent.x);
          vec2 pixelOffset = normal * a_side * u_line_width * 0.5;
          clipPosition.xy += pixelOffset / u_viewport * 2.0 * clipPosition.w;

          // Keep the visible geometry at its real raised position, but test
          // depth as though it were a little higher. Doing this in clip space
          // lets WebGL apply MapLibre's depth range correctly; writing a raw
          // gl_FragDepth value caused the earlier whole-route disappearance.
          vec3 tolerantLow = a_position_low;
          tolerantLow.z += a_meter_scale * u_depth_tolerance;
          vec4 tolerantClip = projectPosition(a_position_high, tolerantLow);
          float routeW = abs(clipPosition.w) < 0.000001
            ? (clipPosition.w < 0.0 ? -0.000001 : 0.000001)
            : clipPosition.w;
          float tolerantW = abs(tolerantClip.w) < 0.000001
            ? (tolerantClip.w < 0.0 ? -0.000001 : 0.000001)
            : tolerantClip.w;
          float routeNdcDepth = clipPosition.z / routeW;
          float tolerantNdcDepth = tolerantClip.z / tolerantW;
          clipPosition.z = min(routeNdcDepth, tolerantNdcDepth) * clipPosition.w;
          gl_Position = clipPosition;
          v_speed_color = a_speed_color;
          v_side = a_side;
        }`;
      const fragmentSource = `#version 300 es
        precision highp float;
        uniform float u_speed_mode;
        uniform float u_outline_pass;
        uniform vec3 u_single_color;
        uniform vec3 u_outline_color;
        in vec3 v_speed_color;
        in float v_side;
        out vec4 fragColor;
        void main() {
          // Keep the edge feather independent of screen-space derivatives.
          // Derivatives can briefly become undefined on the degenerate
          // triangles of a long strip, which used to make the whole route
          // disappear for several frames.
          float edgeDistance = 1.0 - abs(v_side);
          float feather = 0.10;
          float alpha = smoothstep(0.0, feather, edgeDistance);
          if (alpha <= 0.0) discard;
          vec3 routeColor = mix(u_single_color, v_speed_color, u_speed_mode);
          // A soft cylindrical highlight gives the raised ribbon a rounded 3D
          // profile without multiplying its geometry or memory footprint.
          float crown = sqrt(max(0.0, 1.0 - v_side * v_side));
          vec3 roundedRoute = min(vec3(1.0), routeColor * (0.72 + 0.28 * crown)
            + vec3(0.055 * pow(crown, 7.0)));
          vec3 color = mix(roundedRoute, u_outline_color, u_outline_pass);
          fragColor = vec4(color * alpha, alpha);
        }`;
      const vertexShader = compileRouteShader(gl, gl.VERTEX_SHADER, vertexSource);
      const fragmentShader = compileRouteShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
      this.program = gl.createProgram();
      gl.attachShader(this.program, vertexShader);
      gl.attachShader(this.program, fragmentShader);
      gl.linkProgram(this.program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
        throw new Error(`The 3D route shader could not be linked: ${gl.getProgramInfoLog(this.program) || 'Unknown program error'}`);
      }

      this.uniforms = {
        matrix: gl.getUniformLocation(this.program, 'u_matrix'),
        viewport: gl.getUniformLocation(this.program, 'u_viewport'),
        lineWidth: gl.getUniformLocation(this.program, 'u_line_width'),
        depthTolerance: gl.getUniformLocation(this.program, 'u_depth_tolerance'),
        speedMode: gl.getUniformLocation(this.program, 'u_speed_mode'),
        outlinePass: gl.getUniformLocation(this.program, 'u_outline_pass'),
        singleColor: gl.getUniformLocation(this.program, 'u_single_color'),
        outlineColor: gl.getUniformLocation(this.program, 'u_outline_color'),
      };
      this.buffer = gl.createBuffer();
      this.vertexArray = gl.createVertexArray();
      gl.bindVertexArray(this.vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      const stride = 24 * Float32Array.BYTES_PER_ELEMENT;
      const attributes = [
        ['a_position_high', 3, 0],
        ['a_position_low', 3, 3],
        ['a_previous_high', 3, 6],
        ['a_previous_low', 3, 9],
        ['a_next_high', 3, 12],
        ['a_next_low', 3, 15],
        ['a_meter_scale', 1, 18],
        ['a_speed_color', 3, 20],
        ['a_side', 1, 23],
      ];
      attributes.forEach(([name, size, offset]) => {
        const location = gl.getAttribLocation(this.program, name);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
      });
      gl.bindVertexArray(null);
      this.rebuild();
    },

    rebuild() {
      if (!this.gl || !this.map || !state.activity) return;
      // Build one visually continuous ribbon from independent triangles.
      // A single route-wide TRIANGLE_STRIP can contain near-degenerate joins
      // that intermittently invalidate a much larger part of the strip on
      // some GPUs. Independent triangles isolate every short route segment.
      const centerCount = routeCenterSampleCount();
      const terrainExaggeration = QUALITY[ui.quality.value]?.terrain || 1.38;
      const centers = new Array(centerCount);
      for (let index = 0; index < centerCount; index += 1) {
        const progress = centerCount === 1 ? 0 : index / (centerCount - 1);
        const point = sampleActivity(progress);
        const terrainElevation = this.map.queryTerrainElevation?.([point.lon, point.lat]);
        const fallbackElevation = (Number.isFinite(point.elevation) ? point.elevation : 0) * terrainExaggeration;
        const fixedElevation = this.terrainElevations?.length === centerCount
          ? this.terrainElevations[index] * terrainExaggeration
          : Number.NaN;
        const surfaceElevation = Number.isFinite(fixedElevation)
          ? fixedElevation
          : (Number.isFinite(terrainElevation) ? terrainElevation : fallbackElevation);
        const altitude = surfaceElevation + ROUTE_HEIGHT_OFFSET_METERS;
        const coordinate = MercatorCoordinate.fromLngLat([point.lon, point.lat], altitude);
        const color = hexColorToRgb(colorForSpeed(point.speed));
        centers[index] = {
          position: [coordinate.x, coordinate.y, coordinate.z],
          meterScale: coordinate.meterInMercatorCoordinateUnits(),
          progress,
          color,
        };
      }

      // Split absolute Mercator coordinates into high and low float parts.
      // At this latitude a single Float32 x/y value can shift by metres,
      // which is enough to put a route vertex into an adjacent steep face.
      const floatsPerVertex = 24;
      const stripVertices = new Float32Array(centerCount * 2 * floatsPerVertex);
      const centerSpacingMeters = state.activity.totalDistance / Math.max(1, centerCount - 1);
      // Adjacent sub-metre centres can project to the same pixel and produce
      // unstable normals. A wider tangent window smooths only the edge
      // direction; every original centre still remains in the rendered path.
      const tangentStride = clamp(Math.round(12 / Math.max(0.25, centerSpacingMeters)), 2, 24);
      const writeSplitPosition = (position, offset) => {
        for (let component = 0; component < 3; component += 1) {
          const high = Math.fround(position[component]);
          stripVertices[offset + component] = high;
          stripVertices[offset + 3 + component] = position[component] - high;
        }
      };
      for (let index = 0; index < centerCount; index += 1) {
        const center = centers[index];
        const previous = centers[Math.max(0, index - tangentStride)].position;
        const next = centers[Math.min(centerCount - 1, index + tangentStride)].position;
        for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
          const side = sideIndex === 0 ? -1 : 1;
          const offset = (index * 2 + sideIndex) * floatsPerVertex;
          writeSplitPosition(center.position, offset);
          writeSplitPosition(previous, offset + 6);
          writeSplitPosition(next, offset + 12);
          stripVertices[offset + 18] = center.meterScale;
          stripVertices[offset + 19] = center.progress;
          stripVertices.set(center.color, offset + 20);
          stripVertices[offset + 23] = side;
        }
      }

      const segmentCount = Math.max(0, centerCount - 1);
      const vertices = new Float32Array(segmentCount * 6 * floatsPerVertex);
      const copyVertex = (sourceVertex, targetVertex) => {
        const sourceOffset = sourceVertex * floatsPerVertex;
        const targetOffset = targetVertex * floatsPerVertex;
        vertices.set(stripVertices.subarray(sourceOffset, sourceOffset + floatsPerVertex), targetOffset);
      };
      for (let segment = 0; segment < segmentCount; segment += 1) {
        const left = segment * 2;
        const right = left + 1;
        const nextLeft = left + 2;
        const nextRight = left + 3;
        const target = segment * 6;
        copyVertex(left, target);
        copyVertex(right, target + 1);
        copyVertex(nextLeft, target + 2);
        copyVertex(right, target + 3);
        copyVertex(nextRight, target + 4);
        copyVertex(nextLeft, target + 5);
      }
      this.vertexCount = segmentCount * 6;
      this.segmentCount = segmentCount;
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);
      this.map.triggerRepaint();
    },

    render(gl, args) {
      if (!this.program || !this.vertexArray || !this.vertexCount) return;
      const canvas = this.map.getCanvas();
      const pixelRatio = canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
      const zoom = this.map.getZoom();
      const innerSize = routeWidthAtZoom(zoom, false) * this.finalBoost * pixelRatio;
      const outerSize = routeWidthAtZoom(zoom, true) * this.finalBoost * pixelRatio;
      // The triangles are ordered along the activity. Draw only completed
      // segments instead of drawing the full route and discarding the future
      // part in the fragment shader. This removes a GPU-wide visibility gate
      // that could intermittently hide the complete route.
      const visibleSegments = clamp(Math.ceil(this.segmentCount * this.progress), 0, this.segmentCount);
      const visibleVertexCount = visibleSegments * 6;
      if (!visibleVertexCount) {
        this.renderedProgress = this.progress;
        return;
      }
      const singleColor = hexColorToRgb(ui.routeColor.value);
      const outlineColor = hexColorToRgb(COLORS.routeOutline);
      // A custom layer shares MapLibre's WebGL context. Preserve every state
      // value that this layer changes so terrain-tile updates cannot leak a
      // transient stencil/scissor/depth setting into the next route frame.
      const previousState = {
        stencil: gl.isEnabled(gl.STENCIL_TEST),
        scissor: gl.isEnabled(gl.SCISSOR_TEST),
        cull: gl.isEnabled(gl.CULL_FACE),
        polygonOffset: gl.isEnabled(gl.POLYGON_OFFSET_FILL),
        sampleAlphaToCoverage: gl.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE),
        depthTest: gl.isEnabled(gl.DEPTH_TEST),
        depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
        depthFunc: gl.getParameter(gl.DEPTH_FUNC),
        blend: gl.isEnabled(gl.BLEND),
        blendEquationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB),
        blendEquationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
        blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB),
        blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB),
        blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
        blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
        colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
      };

      gl.useProgram(this.program);
      gl.bindVertexArray(this.vertexArray);
      gl.uniformMatrix4fv(this.uniforms.matrix, false, args.defaultProjectionData.mainMatrix);
      gl.uniform2f(this.uniforms.viewport, canvas.width, canvas.height);
      gl.uniform1f(this.uniforms.depthTolerance, ROUTE_OCCLUSION_TOLERANCE_METERS);
      gl.uniform1f(this.uniforms.speedMode, ui.routeColoring.value === 'speed' ? 1 : 0);
      gl.uniform3fv(this.uniforms.singleColor, singleColor);
      gl.uniform3fv(this.uniforms.outlineColor, outlineColor);
      // Store the exact tip drawn in this map frame. The HTML marker reads
      // this after MapLibre emits `render`, keeping both visuals synchronized.
      this.renderedProgress = this.progress;
      // Share terrain depth, but not its tile stencil/scissor masks. The
      // clip-space elevation allowance above prevents shallow DEM mismatches
      // without making the route visible through distant mountains.
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.colorMask(true, true, true, true);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.uniform1f(this.uniforms.outlinePass, 1);
      gl.uniform1f(this.uniforms.lineWidth, outerSize);
      gl.drawArrays(gl.TRIANGLES, 0, visibleVertexCount);
      gl.uniform1f(this.uniforms.outlinePass, 0);
      gl.uniform1f(this.uniforms.lineWidth, innerSize);
      gl.drawArrays(gl.TRIANGLES, 0, visibleVertexCount);

      gl.bindVertexArray(null);
      gl.colorMask(
        previousState.colorMask[0], previousState.colorMask[1],
        previousState.colorMask[2], previousState.colorMask[3],
      );
      gl.depthMask(previousState.depthMask);
      gl.depthFunc(previousState.depthFunc);
      gl.blendEquationSeparate(previousState.blendEquationRgb, previousState.blendEquationAlpha);
      gl.blendFuncSeparate(
        previousState.blendSrcRgb, previousState.blendDstRgb,
        previousState.blendSrcAlpha, previousState.blendDstAlpha,
      );
      if (previousState.stencil) gl.enable(gl.STENCIL_TEST); else gl.disable(gl.STENCIL_TEST);
      if (previousState.scissor) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
      if (previousState.cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
      if (previousState.polygonOffset) gl.enable(gl.POLYGON_OFFSET_FILL); else gl.disable(gl.POLYGON_OFFSET_FILL);
      if (previousState.sampleAlphaToCoverage) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE); else gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      if (previousState.depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
      if (previousState.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    },

    onRemove(map, gl) {
      if (this.buffer) gl.deleteBuffer(this.buffer);
      if (this.vertexArray) gl.deleteVertexArray(this.vertexArray);
      if (this.program) gl.deleteProgram(this.program);
      this.buffer = null;
      this.vertexArray = null;
      this.program = null;
      this.terrainElevations = null;
      this.segmentCount = 0;
      this.map = null;
      this.gl = null;
    },
  };
}

function createActivityPositionMarker(point) {
  state.positionMarker?.remove();
  state.pendingPositionMarker = null;
  const element = document.createElement('div');
  element.className = 'activity-position-marker';
  element.setAttribute('aria-hidden', 'true');
  element.style.setProperty('--marker-color', ui.routeColor.value);
  state.positionMarkerElement = element;
  state.positionMarker = new Marker({
    element,
    anchor: 'center',
    opacity: 1,
    // GPX Motion applies a less sensitive terrain-depth check after each
    // completed map frame instead of MapLibre's generic marker fade.
    opacityWhenCovered: 1,
    pitchAlignment: 'viewport',
    rotationAlignment: 'viewport',
    subpixelPositioning: true,
  }).setLngLat([point.lon, point.lat]).addTo(state.map);
}

function updateActivityPositionMarker(point, finished) {
  if (!state.positionMarker || !state.positionMarkerElement) return;
  state.positionMarker.setLngLat([point.lon, point.lat]);
  state.positionMarkerElement.classList.toggle('finish', finished);
  const markerHeight = state.map?.getLayer('route-line') ? 0 : ROUTE_HEIGHT_OFFSET_METERS;
  const projection = terrainProjectionData(point, markerHeight);
  state.positionMarkerElement.classList.toggle('terrain-covered', Boolean(projection?.covered));
  const markerColor = ui.routeColoring.value === 'speed' ? colorForSpeed(point.speed) : ui.routeColor.value;
  state.positionMarkerElement.style.setProperty('--marker-color', markerColor);
}

function queueActivityPositionMarker(routeProgress, videoProgress) {
  state.pendingPositionMarker = { routeProgress, videoProgress };
}

function syncActivityPositionMarkerAfterMapRender() {
  const pending = state.pendingPositionMarker;
  if (pending) {
    state.pendingPositionMarker = null;
    const renderedProgress = Number.isFinite(state.route3dLayer?.renderedProgress)
      ? state.route3dLayer.renderedProgress
      : visibleRouteEndpointProgress(pending.routeProgress);
    updateActivityPositionMarker(sampleActivity(renderedProgress), pending.routeProgress >= 0.9995);
  }
  // Keep the marker and heads-up display on the same completed map frame.
  if (!state.exporting) drawPreviewOverlays(pending?.videoProgress ?? state.currentProgress);
}

function addRouteLayers() {
  const data = routeGeoJson();
  state.map.addSource('route', {
    type: 'geojson',
    data,
    // Eight-metre features must not be simplified away when the camera zooms
    // out. A larger tile buffer also keeps line caps intact at tile edges.
    tolerance: 0,
    buffer: 256,
    maxzoom: 22,
  });
  state.map.addSource('route-final', {
    type: 'geojson',
    data: routeOverviewGeoJson(),
    lineMetrics: true,
    tolerance: 0,
    buffer: 256,
    maxzoom: 22,
  });
  // Let MapLibre drape one continuous line over its own terrain. A custom 3D
  // ribbon is split against the terrain tile depth buffers and can develop
  // camera/zoom-dependent gaps on steep slopes. Native terrain lines share the
  // exact terrain mesh, so there are no mismatched segment heights or tile-edge
  // cuts.
  state.route3dLayer = null;
  state.nativeRouteProgress = 0;
  state.nativeRouteColorMode = ui.routeColoring.value;
  state.nativeRouteColor = ui.routeColor.value;
  state.nativeRouteVisibleSegment = -1;
  state.nativeRouteFinished = false;
  state.map.addLayer({
    id: 'route-outline',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': routeLineWidthExpression(true),
      'line-color': nativeRouteColorExpression(true),
      'line-opacity': 1,
    },
  });
  state.map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': routeLineWidthExpression(false),
      'line-color': nativeRouteColorExpression(false),
      'line-opacity': 1,
    },
  });
  // The overview uses one continuous feature, so it cannot disappear when a
  // lower zoom level discards very short features. Keep it in the style from
  // the beginning (opacity zero) so its tiles are already prepared before the
  // outro starts.
  state.map.addLayer({
    id: 'route-final-outline',
    type: 'line',
    source: 'route-final',
    // Bevel joins cannot form long spikes when noisy GPX points briefly turn
    // back on themselves. The round cap still keeps both route ends soft.
    layout: { 'line-cap': 'round', 'line-join': 'bevel' },
    paint: {
      'line-width': routeLineWidthExpression(true, 1.0),
      'line-color': COLORS.routeOutline,
      'line-opacity': 0,
    },
  });
  state.map.addLayer({
    id: 'route-final-line',
    type: 'line',
    source: 'route-final',
    layout: { 'line-cap': 'round', 'line-join': 'bevel' },
    paint: {
      // Slightly narrower fill leaves a clean black outline without making the
      // overview route dominate the satellite image.
      'line-width': routeLineWidthExpression(false, 0.88),
      'line-gradient': finalRouteGradientExpression(),
      'line-opacity': 0,
    },
  });

  const start = state.activity.points[0];
  state.map.addSource('start-marker', { type: 'geojson', data: pointGeoJson(start) });
  state.map.addLayer({ id: 'start-marker-outer', type: 'circle', source: 'start-marker', paint: { 'circle-radius': 11, 'circle-color': '#ffffff', 'circle-stroke-width': 2.5, 'circle-stroke-color': '#12151a', 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'map' } });
  state.map.addLayer({ id: 'start-marker-inner', type: 'circle', source: 'start-marker', paint: { 'circle-radius': 7.3, 'circle-color': COLORS.green, 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'map' } });
  createActivityPositionMarker(start);
}

function addLabelLayers() {
  if (!ui.labels.checked || !state.map.getSource('streets')) return;
  const scale = Number(ui.labelSize.value);
  const commonLayout = {
    'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
    'text-font': ['Noto Sans Bold'],
    'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10 * scale, 10, 13 * scale, 15, 17 * scale],
    'text-allow-overlap': false,
    'text-ignore-placement': false,
    'text-pitch-alignment': 'viewport',
    'text-rotation-alignment': 'viewport',
    'text-padding': Math.max(2, 9 / Math.sqrt(scale)),
  };
  const commonPaint = { 'text-color': '#ffffff', 'text-halo-color': '#111318', 'text-halo-width': Math.max(1.6, 2.2 * Math.sqrt(scale)), 'text-halo-blur': 0.35 };
  const layers = [
    {
      id: 'place-names', type: 'symbol', source: 'streets', 'source-layer': 'place_label', minzoom: 5,
      filter: ['match', ['get', 'class'], ['city', 'town', 'village', 'settlement', 'hamlet'], true, false],
      layout: { ...commonLayout, 'symbol-sort-key': ['coalesce', ['get', 'filterrank'], 10] }, paint: commonPaint,
    },
    {
      id: 'peak-names', type: 'symbol', source: 'streets', 'source-layer': 'natural_label', minzoom: 7,
      filter: ['any', ['==', ['get', 'class'], 'landform'], ['==', ['get', 'type'], 'peak'], ['==', ['get', 'maki'], 'mountain']],
      layout: { ...commonLayout, 'text-field': ['concat', '▲  ', ['coalesce', ['get', 'name_en'], ['get', 'name']]], 'text-offset': [0, -0.65] }, paint: commonPaint,
    },
    {
      id: 'water-names', type: 'symbol', source: 'streets', 'source-layer': 'natural_label', minzoom: 6,
      filter: ['any', ['==', ['get', 'class'], 'water'], ['==', ['get', 'type'], 'lake'], ['==', ['get', 'type'], 'river']],
      layout: { ...commonLayout, 'text-size': ['interpolate', ['linear'], ['zoom'], 6, 9 * scale, 11, 12 * scale, 15, 15 * scale] },
      paint: { ...commonPaint, 'text-color': COLORS.water },
    },
  ];
  for (const layer of layers) {
    try { state.map.addLayer(layer); } catch (error) { console.warn(`Label layer ${layer.id}:`, error); }
  }
}

function updateLabelSize() {
  if (!state.map?.isStyleLoaded()) return;
  const scale = Number(ui.labelSize.value);
  for (const id of ['place-names', 'peak-names']) {
    if (state.map.getLayer(id)) state.map.setLayoutProperty(id, 'text-size', ['interpolate', ['linear'], ['zoom'], 6, 10 * scale, 10, 13 * scale, 15, 17 * scale]);
  }
  if (state.map.getLayer('water-names')) state.map.setLayoutProperty('water-names', 'text-size', ['interpolate', ['linear'], ['zoom'], 6, 9 * scale, 11, 12 * scale, 15, 15 * scale]);
}

function routeBounds() {
  const first = state.activity.points[0];
  const bounds = new LngLatBounds([first.lon, first.lat], [first.lon, first.lat]);
  for (const point of state.activity.points) bounds.extend([point.lon, point.lat]);
  return bounds;
}

function overviewPadding() {
  const w = ui.viewport.clientWidth || 1280;
  const h = ui.viewport.clientHeight || 720;
  const vertical = ui.orientation.value === 'vertical';
  const topFraction = Number(ui.hudTop.value) / 100;
  return vertical
    ? { top: Math.round(h * clamp(topFraction + 0.19, 0.22, 0.39)), right: Math.round(w * 0.055), bottom: Math.round(h * 0.055), left: Math.round(w * 0.055) }
    : { top: Math.round(h * clamp(topFraction + 0.13, 0.17, 0.31)), right: Math.round(w * 0.045), bottom: Math.round(h * 0.06), left: Math.round(w * 0.045) };
}

function updateOverview() {
  if (!state.map || !state.activity) return;
  const camera = state.map.cameraForBounds(routeBounds(), { padding: overviewPadding(), bearing: 0, pitch: 0, maxZoom: 15 });
  if (!camera) return;
  state.overview = {
    center: camera.center,
    zoom: camera.zoom - 0.18,
    bearing: 0,
    pitch: ui.orientation.value === 'vertical' ? 27 : 24,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
  };
  if (!state.animating) {
    state.map.jumpTo(state.overview);
    updateScene(1);
  }
}

function metricMode() {
  if (ui.metric.value.startsWith('Pace')) return 'pace';
  if (ui.metric.value.startsWith('Speed')) return 'speed';
  return state.activity?.defaultMetric || 'pace';
}

function updateRouteStyle(routeProgress, finished) {
  const finalBoost = finished ? 1.32 : 1;
  if (state.route3dLayer) {
    state.route3dLayer.progress = routeProgress;
    state.route3dLayer.finalBoost = finalBoost;
  }
  if (state.map?.getLayer('route-line')) {
    const progress = clamp(routeProgress, 0, 1);
    const colorsChanged = state.nativeRouteColorMode !== ui.routeColoring.value
      || state.nativeRouteColor !== ui.routeColor.value;
    const finishChanged = state.nativeRouteFinished !== finished;
    if (colorsChanged) {
      state.map.setPaintProperty('route-line', 'line-color', nativeRouteColorExpression(false));
      state.map.setPaintProperty('route-final-line', 'line-gradient', finalRouteGradientExpression());
      state.nativeRouteColorMode = ui.routeColoring.value;
      state.nativeRouteColor = ui.routeColor.value;
    }
    if (finishChanged) {
      // The animated detail layer keeps its feature-state implementation. The
      // outro swaps opacity to the separate continuous feature that was loaded
      // in advance and remains stable at every zoom level.
      state.map.setPaintProperty('route-outline', 'line-opacity', finished ? 0 : 1);
      state.map.setPaintProperty('route-line', 'line-opacity', finished ? 0 : 1);
      state.map.setPaintProperty('route-final-outline', 'line-opacity', finished ? 1 : 0);
      state.map.setPaintProperty('route-final-line', 'line-opacity', finished ? 1 : 0);
      state.nativeRouteFinished = finished;
    }
    if (state.nativeRouteProgress !== progress) {
      if (finished) state.nativeRouteVisibleSegment = state.nativeRouteSegmentCount - 1;
      else updateNativeRouteVisibility(progress);
      state.nativeRouteProgress = progress;
    }
    if (state.routeFinalBoost !== finalBoost) {
      state.map.setPaintProperty('route-outline', 'line-width', routeLineWidthExpression(true, finalBoost));
      state.map.setPaintProperty('route-line', 'line-width', routeLineWidthExpression(false, finalBoost));
    }
  }
  state.routeFinalBoost = finalBoost;
}

function updateScene(videoProgress) {
  if (!state.ready || !state.activity || !state.map) return;
  const previousProgress = state.currentProgress;
  state.currentProgress = clamp(videoProgress, 0, 1);
  const activityEnd = 0.82;
  const routeProgress = clamp(state.currentProgress / activityEnd, 0, 1);
  const finished = routeProgress >= 0.9995;
  const current = sampleActivity(routeProgress);
  const descentRisk = routeDescentRisk(routeProgress);
  const directionFrom = smoothedRoutePosition(
    routeProgress - lerp(0.008, 0.0035, descentRisk),
    lerp(0.0045, 0.0024, descentRisk),
  );
  const directionTo = smoothedRoutePosition(
    routeProgress + lerp(0.018, 0.009, descentRisk),
    lerp(0.0045, 0.0024, descentRisk),
  );
  const cameraAhead = smoothedRoutePosition(
    routeProgress + lerp(0.014, 0.009, descentRisk),
    lerp(0.0065, 0.0035, descentRisk),
  );

  // The HTML marker must wait for MapLibre to finish the matching route frame.
  // Updating it here would make it one map render ahead of the route, which is
  // tens of metres on a long activity compressed into a short video.
  queueActivityPositionMarker(routeProgress, state.currentProgress);

  const desiredBearing = headingBetween(directionFrom, directionTo);
  const cameraSeconds = Math.abs(state.currentProgress - previousProgress) * clamp(Number(ui.duration.value) || 15, 1, 600);
  const restarting = state.currentProgress < previousProgress || state.currentProgress <= 0.001 || !state.cameraCenter;
  const centerFriction = restarting ? 1 : 1 - Math.exp(-cameraSeconds * 1.65);
  const poseFriction = restarting ? 1 : 1 - Math.exp(-cameraSeconds * 1.25);
  const desiredCenter = { lng: cameraAhead.lon, lat: cameraAhead.lat };
  state.cameraCenter = restarting ? desiredCenter : {
    lng: lerp(state.cameraCenter.lng, desiredCenter.lng, centerFriction),
    lat: lerp(state.cameraCenter.lat, desiredCenter.lat, centerFriction),
  };
  const previousBearing = state.cameraBearing ?? state.map.getBearing();
  const bearingDelta = Math.abs(((desiredBearing - previousBearing + 540) % 360) - 180);
  const turnRisk = smoothstep((bearingDelta - 35) / 100);
  const bearingResponse = lerp(0.92, 2.7, Math.max(descentRisk, turnRisk));
  const bearingFriction = restarting ? 1 : 1 - Math.exp(-cameraSeconds * bearingResponse);
  const followingBearing = shortestAngle(previousBearing, desiredBearing, bearingFriction);
  state.cameraBearing = followingBearing;
  const distanceScale = clamp(Number(ui.cameraDistance.value) || 1, 0.6, 2.5);
  const heightScale = clamp(Number(ui.cameraHeight.value) || 1, 0.6, 2.2);
  // On rugged sections a very low viewing angle lets a nearby ridge cut the
  // route into disconnected pieces. Raise and slightly widen the camera only
  // where the local elevation profile is steep; flatter routes keep the more
  // dramatic low-angle view.
  const relief = localElevationRelief(routeProgress);
  const reliefRisk = smoothstep((relief - 70) / 330);
  // Very high routes can run along a fairly level shelf while steep peaks sit
  // directly between the camera and the path, so altitude is a second useful
  // signal for choosing the safer, more overhead view.
  const altitudeRisk = smoothstep((current.elevation - 1200) / 1800);
  const ruggedness = Math.max(reliefRisk, altitudeRisk);
  const followingZoom = (state.overview?.zoom ?? 10) + lerp(2.85, 2.1, smoothstep(routeProgress))
    - Math.log2(distanceScale) * 1.35 - Math.log2(heightScale) * 0.4
    - ruggedness * 0.46 - descentRisk * 0.42;
  // A higher MapLibre pitch places the camera lower and makes the relief more
  // pronounced, while center clamping keeps it above the terrain surface.
  const startPitch = ui.orientation.value === 'vertical' ? 64 : 62;
  const fullPitch = ui.orientation.value === 'vertical' ? 76 : 74;
  const desiredPitch = clamp(lerp(startPitch, fullPitch, smoothstep(routeProgress / 0.13))
    - Math.log2(heightScale) * 18
    - ruggedness * (ui.orientation.value === 'vertical' ? 14 : 12)
    - descentRisk * (ui.orientation.value === 'vertical' ? 17 : 15), 39, 79);
  state.cameraZoom = restarting || state.cameraZoom == null ? followingZoom : lerp(state.cameraZoom, followingZoom, poseFriction);
  state.cameraPitch = restarting || state.cameraPitch == null ? desiredPitch : lerp(state.cameraPitch, desiredPitch, poseFriction);
  // Move the vanishing point down so that the tracked marker stays safely
  // below the heads-up display and close to two thirds of the video height.
  const followingPaddingTop = Math.round((ui.viewport.clientHeight || 720) * (ui.orientation.value === 'vertical' ? 0.27 : 0.23));
  const following = {
    center: [state.cameraCenter.lng, state.cameraCenter.lat],
    zoom: state.cameraZoom,
    pitch: state.cameraPitch,
    bearing: followingBearing,
    padding: { top: followingPaddingTop, right: 0, bottom: 0, left: 0 },
  };
  // Set the route progress before changing the camera. jumpTo schedules the
  // MapLibre frame immediately, so the new camera and route must already
  // describe the same animation instant.
  updateRouteStyle(routeProgress, finished);
  if (finished) {
    if (!state.outroPose) {
      state.outroPose = {
        center: [...following.center],
        zoom: following.zoom,
        pitch: following.pitch,
        bearing: following.bearing,
        paddingTop: followingPaddingTop,
      };
    }
    const outro = smoothstep((state.currentProgress - activityEnd) / (1 - activityEnd));
    const target = state.overview;
    const origin = state.outroPose;
    const center = [lerp(origin.center[0], target.center.lng, outro), lerp(origin.center[1], target.center.lat, outro)];
    state.map.jumpTo({
      center,
      zoom: lerp(origin.zoom, target.zoom, outro),
      pitch: lerp(origin.pitch, target.pitch, outro),
      bearing: shortestAngle(origin.bearing, 0, outro),
      padding: { top: Math.round(lerp(origin.paddingTop, 0, outro)), right: 0, bottom: 0, left: 0 },
    });
  } else {
    state.outroPose = null;
    state.map.jumpTo(following);
  }
  state.map.triggerRepaint();
}

function waitForMapRender(timeout = 450) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (rendered) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      state.map?.off('render', onRender);
      resolve(rendered);
    };
    const onRender = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    state.map.on('render', onRender);
    state.map.triggerRepaint();
  });
}

function waitForMapTiles(timeout = 6000) {
  return new Promise((resolve) => {
    if (!state.map) return resolve(false);
    let finished = false;
    let animationFrame = 0;
    let framesChecked = 0;
    const started = performance.now();
    const complete = (loaded) => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(animationFrame);
      state.map?.off('idle', onIdle);
      resolve(loaded);
    };
    const onIdle = () => {
      if (framesChecked > 0 && state.map?.areTilesLoaded?.()) complete(true);
    };
    const check = () => {
      if (!state.map) return complete(false);
      framesChecked += 1;
      if (framesChecked > 1 && state.map.areTilesLoaded?.()) return complete(true);
      if (performance.now() - started >= timeout) return complete(false);
      state.map.triggerRepaint();
      animationFrame = requestAnimationFrame(check);
    };
    state.map.on('idle', onIdle);
    check();
  });
}

async function preloadRouteTiles() {
  const count = clamp(Math.ceil(state.activity.totalDistance / 2500), 8, 24);
  const wasAnimating = state.animating;
  state.animating = true;
  let misses = 0;
  for (let index = 0; index < count; index += 1) {
    const routeProgress = count === 1 ? 0 : index / (count - 1);
    resetCameraSmoothing();
    updateScene(routeProgress * 0.815);
    ui.progress.value = 0.65 + 0.29 * ((index + 1) / count);
    setStatus('Caching the route map', `Area ${index + 1} / ${count} · satellite and elevation tiles`);
    if (!(await waitForMapTiles(4500))) misses += 1;
  }
  state.animating = wasAnimating;
  resetCameraSmoothing();
  if (misses) state.mapErrors.add(`${misses} map area${misses === 1 ? '' : 's'} did not finish loading and may be fetched again during playback.`);
}

function displayTime(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${Math.floor(whole / 60)}:${String(secs).padStart(2, '0')}`;
}

function displayPace(speed) {
  if (!Number.isFinite(speed) || speed < 0.12) {
    speed = state.activity.totalDistance / Math.max(1, state.activity.movingSecondsPace || state.activity.movingSeconds);
  }
  const seconds = clamp(Math.round(1000 / speed), 1, 5999);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function hudValues(videoProgress) {
  const activityEnd = 0.82;
  const routeProgress = clamp(videoProgress / activityEnd, 0, 1);
  const finished = routeProgress >= 0.9995;
  const sample = sampleActivity(routeProgress);
  const paceMode = metricMode() === 'pace';
  const statistics = effectiveActivityStatistics(paceMode);
  const averageSpeed = statistics.distance / Math.max(1, statistics.movingSeconds);
  const distanceScale = state.activity.totalDistance > 0
    ? statistics.distance / state.activity.totalDistance
    : 1;
  const movingTimeProgress = state.activity.totalSeconds > 0
    ? clamp(sample.elapsed / state.activity.totalSeconds, 0, 1)
    : routeProgress;
  const movingTime = finished
    ? statistics.movingSeconds
    : statistics.movingSeconds * movingTimeProgress;
  const items = [
    { label: 'TIME', value: displayTime(movingTime), unit: 'moving' },
    { label: finished ? (paceMode ? 'AVG. PACE' : 'AVG. SPEED') : (paceMode ? 'PACE' : 'SPEED'), value: paceMode ? displayPace(finished ? averageSpeed : sample.speed) : `${((finished ? averageSpeed : sample.speed) * 3.6).toFixed(1)}`, unit: paceMode ? 'min/km' : 'km/h' },
    { label: 'DISTANCE', value: `${((finished ? statistics.distance : sample.distance * distanceScale) / 1000).toFixed(1)}`, unit: 'km' },
    { label: finished ? 'ELEVATION GAIN' : 'ELEVATION', value: `${Math.round(finished ? statistics.elevationGain : sample.elevation)}`, unit: 'm' },
  ];
  if (ui.heartRate.checked && state.activity.hasHeartRate) {
    const heartRate = finished ? statistics.averageHeartRate : sample.heartRate;
    items.push({ label: finished ? 'AVG. HEART RATE' : 'HEART RATE', value: `${Math.round(heartRate)}`, unit: 'bpm' });
  }
  return {
    finished,
    title: ui.title.value.trim() || state.activity.title,
    items,
  };
}

function setupCanvas(canvas, width, height) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

function fittedFont(ctx, text, desiredPx, maxWidth, weight = 800) {
  let size = desiredPx;
  ctx.font = `${weight} ${size}px Inter, Arial, sans-serif`;
  const measured = ctx.measureText(text).width;
  if (measured > maxWidth) size *= maxWidth / measured;
  return Math.max(8, size);
}

function outlinedText(ctx, text, x, y, size, align = 'center', weight = 800) {
  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.font = `${weight} ${size}px Inter, Arial, sans-serif`;
  ctx.lineWidth = Math.max(3, size * 0.16);
  ctx.strokeStyle = '#07090c';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function terrainProjectionData(point, heightOffsetMeters = 0) {
  if (!state.map || !point) return null;
  const lngLat = new LngLat(point.lon, point.lat);
  let projected = null;
  let covered = false;
  try {
    const transform = state.map._camera?.transform;
    if (state.map.terrain && transform?.locationToScreenPoint) {
      const terrain = state.map.terrain;
      const elevation = terrain.getElevationForLngLat?.(lngLat, transform);
      const projectionTransform = transform.currentTransform || transform;
      if (
        Number.isFinite(elevation)
        && typeof projectionTransform.coordinatePoint === 'function'
        && projectionTransform._pixelMatrix3D
      ) {
        projected = projectionTransform.coordinatePoint(
          MercatorCoordinate.fromLngLat(lngLat),
          elevation + heightOffsetMeters,
          projectionTransform._pixelMatrix3D,
        );
      }
      if (!projected) projected = transform.locationToScreenPoint(lngLat, terrain);
      const locationOccluded = Boolean(transform.isLocationOccluded?.(lngLat));
      const surfaceDepth = terrain.depthAtPoint?.(projected);
      if (Number.isFinite(surfaceDepth) && Number.isFinite(elevation)) {
        const pointDepth = transform.lngLatToCameraDepth(lngLat, elevation + heightOffsetMeters);
        const liftedDepth = transform.lngLatToCameraDepth(
          lngLat,
          elevation + heightOffsetMeters + MARKER_OCCLUSION_TOLERANCE_METERS,
        );
        const depthGap = pointDepth - surfaceDepth;
        const toleranceDepth = Math.max(
          MARKER_OCCLUSION_DEPTH_TOLERANCE,
          Math.abs(pointDepth - liftedDepth),
        );
        covered = depthGap > toleranceDepth;
      } else {
        covered = locationOccluded;
      }
    }
  } catch (_) {}
  if (!projected) projected = state.map.project(lngLat);
  const rect = ui.map.getBoundingClientRect();
  if (!rect.width || !rect.height || !Number.isFinite(projected?.x) || !Number.isFinite(projected?.y)) return null;
  return {
    x: projected.x / rect.width,
    y: projected.y / rect.height,
    covered,
  };
}

function drawMarkerGlyph(ctx, x, y, radius, fill, finish, opacity = 1) {
  const cell = radius / 2;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.shadowColor = 'rgba(0, 0, 0, .55)';
  ctx.shadowBlur = radius * 0.28;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
  if (finish) {
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        ctx.fillStyle = (row + column) % 2 ? '#ffffff' : '#101216';
        ctx.fillRect(x - radius + column * cell, y - radius + row * cell, cell + 0.5, cell + 0.5);
      }
    }
  } else {
    ctx.fillStyle = fill;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(3, radius * 0.22);
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, radius + ctx.lineWidth * 0.48, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1.5, radius * 0.09);
  ctx.strokeStyle = '#101216';
  ctx.stroke();
  ctx.restore();
}

function drawActivityPositionMarker(ctx, width, height, videoProgress) {
  if (!state.activity) return;
  const activityEnd = 0.82;
  const routeProgress = clamp(videoProgress / activityEnd, 0, 1);
  const finished = routeProgress >= 0.9995;
  const point = sampleActivity(visibleRouteEndpointProgress(routeProgress));
  // The native route is draped on the terrain surface, so the exported marker
  // must use that same surface rather than the former custom-ribbon offset.
  const projected = terrainProjectionData(point, state.map?.getLayer('route-line') ? 0 : ROUTE_HEIGHT_OFFSET_METERS);
  if (!projected || projected.x < -0.08 || projected.x > 1.08 || projected.y < -0.08 || projected.y > 1.08) return;
  const mapWidth = Math.max(1, ui.map.getBoundingClientRect().width);
  const radius = clamp(15 * width / mapWidth, 10, Math.min(width, height) * 0.048);
  const fill = ui.routeColoring.value === 'speed' ? colorForSpeed(point.speed) : ui.routeColor.value;
  drawMarkerGlyph(
    ctx,
    projected.x * width,
    projected.y * height,
    radius,
    fill,
    finished,
    projected.covered ? 0.34 : 1,
  );
}

function drawHud(ctx, width, height, videoProgress) {
  if (!state.activity) return;
  const data = hudValues(videoProgress);
  const vertical = height > width;
  const scale = Number(ui.hudSize.value);
  const top = height * Number(ui.hudTop.value) / 100;
  const titleY = top + (vertical ? height * 0.025 : height * 0.033);
  const titleDesired = Math.min(width * (vertical ? 0.056 : 0.030), height * 0.062) * scale;
  const titleSize = fittedFont(ctx, data.title, titleDesired, width * 0.91, 850);
  const usableWidth = width * (vertical ? 0.94 : (data.items.length > 4 ? 0.91 : 0.78));
  const labelSize = Math.min(width * (vertical ? 0.021 : 0.0105), height * 0.026) * scale;
  const valueSize = Math.min(width * (vertical ? 0.044 : 0.025), height * 0.057) * scale;
  const unitSize = labelSize * 0.92;
  const titleGap = titleSize * (vertical ? 0.23 : 0.19);
  const metricsY = titleY + titleSize / 2 + titleGap + labelSize / 2;
  const rows = vertical && data.items.length > 4
    ? [data.items.slice(0, 3), data.items.slice(3)]
    : [data.items];
  const layouts = [];
  let rowLabelY = metricsY;
  rows.forEach((row, rowIndex) => {
    const rowWidth = vertical && row.length === 2 ? usableWidth * 0.68 : usableWidth;
    const left = (width - rowWidth) / 2;
    const cellWidth = rowWidth / row.length;
    let rowBottom = rowLabelY;
    row.forEach((item, index) => {
      const x = left + cellWidth * (index + 0.5);
      const safeValueSize = fittedFont(ctx, item.value, valueSize, cellWidth * 0.88, 900);
      const equalGap = Math.max(labelSize * 0.38, height * 0.006);
      const valueY = rowLabelY + labelSize / 2 + equalGap + safeValueSize / 2;
      const unitY = valueY + safeValueSize / 2 + equalGap + unitSize / 2;
      layouts.push({ item, x, labelY: rowLabelY, safeValueSize, valueY, unitY });
      rowBottom = Math.max(rowBottom, unitY + unitSize / 2);
    });
    if (rowIndex < rows.length - 1) rowLabelY = rowBottom + Math.max(labelSize * 0.72, height * 0.012) + labelSize / 2;
  });

  const contentBottom = Math.max(...layouts.map((layout) => layout.unitY + unitSize / 2));
  const shieldBottom = Math.min(height, contentBottom + Math.max(height * 0.035, titleSize * 0.7));
  const shield = ctx.createLinearGradient(0, 0, 0, shieldBottom);
  shield.addColorStop(0, 'rgba(5, 8, 12, .96)');
  shield.addColorStop(0.68, 'rgba(5, 8, 12, .91)');
  shield.addColorStop(1, 'rgba(5, 8, 12, 0)');
  ctx.save();
  ctx.fillStyle = shield;
  ctx.fillRect(0, 0, width, shieldBottom);
  ctx.restore();

  outlinedText(ctx, data.title, width / 2, titleY, titleSize, 'center', 850);
  layouts.forEach(({ item, x, labelY, safeValueSize, valueY, unitY }) => {
    outlinedText(ctx, item.label, x, labelY, labelSize, 'center', 850);
    outlinedText(ctx, item.value, x, valueY, safeValueSize, 'center', 900);
    outlinedText(ctx, item.unit, x, unitY, unitSize, 'center', 800);
  });
}

function drawPreviewHud(videoProgress) {
  if (!state.activity) return;
  const rect = ui.viewport.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  const ctx = setupCanvas(ui.previewHud, width, height);
  drawHud(ctx, width, height, videoProgress);
}

function drawPreviewOverlays(videoProgress) {
  drawPreviewHud(videoProgress);
}

function composeRecordingFrame(videoProgress) {
  const canvas = ui.recordCanvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const source = state.map.getCanvas();
  ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, canvas.width, canvas.height);
  drawActivityPositionMarker(ctx, canvas.width, canvas.height, videoProgress);
  drawHud(ctx, canvas.width, canvas.height, videoProgress);
  // Keep the visible heads-up display in step with the frame currently being
  // encoded, not only the correctly updated copy inside the exported video.
  drawPreviewHud(videoProgress);
}

function targetDimensions() {
  const base = { '720p': [1280, 720], '1080p': [1920, 1080], '4K': [3840, 2160] }[ui.resolution.value] || [1920, 1080];
  return ui.orientation.value === 'vertical' ? [base[1], base[0]] : base;
}

function videoBitrate(width, height) {
  const pixels = width * height;
  const base = pixels <= 1280 * 720 ? 7_000_000 : pixels <= 1920 * 1080 ? 13_000_000 : 35_000_000;
  return Math.round(base * (QUALITY[ui.quality.value]?.bitrate || 1));
}

function recorderMime() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((type) => window.MediaRecorder?.isTypeSupported(type)) || '';
}

async function supportedAvcConfig(width, height, fps) {
  if (!window.VideoEncoder?.isConfigSupported || !window.VideoFrame || !window.Mp4Muxer) return null;
  const base = {
    width,
    height,
    bitrate: videoBitrate(width, height),
    framerate: fps,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
    avc: { format: 'avc' },
  };
  for (const codec of ['avc1.4d0034', 'avc1.420034', 'avc1.4d0033', 'avc1.420033']) {
    try {
      const result = await VideoEncoder.isConfigSupported({ ...base, codec });
      if (result.supported) return result.config;
    } catch (_) {}
  }
  return null;
}

async function supportedWebmConfig(width, height, fps) {
  if (!window.VideoEncoder?.isConfigSupported || !window.VideoFrame || !window.WebMMuxer) return null;
  const base = {
    width,
    height,
    bitrate: videoBitrate(width, height),
    framerate: fps,
    latencyMode: 'quality',
  };
  const candidates = [
    { codec: 'vp09.00.10.08', muxerCodec: 'V_VP9' },
    { codec: 'vp8', muxerCodec: 'V_VP8' },
  ];
  for (const candidate of candidates) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      try {
        const result = await VideoEncoder.isConfigSupported({
          ...base,
          codec: candidate.codec,
          hardwareAcceleration,
        });
        if (result.supported) {
          return {
            config: result.config,
            muxerCodec: candidate.muxerCodec,
          };
        }
      } catch (_) {}
    }
  }
  return null;
}

async function renderExactExportFrame(frame, totalFrames) {
  const progress = totalFrames === 1 ? 1 : frame / (totalFrames - 1);
  updateScene(progress);
  let rendered = await waitForMapRender(500);
  if (!state.map.areTilesLoaded?.()) {
    await waitForMapTiles(1200);
    rendered = await waitForMapRender(500);
  }
  // A second render lets the moving GeoJSON marker and the route paint update
  // reach the same map frame even when a worker is briefly busy.
  if (!rendered) state.map.triggerRepaint();
  composeRecordingFrame(progress);
  ui.frameCounter.textContent = `Frame ${frame + 1} / ${totalFrames}`;
  ui.progress.value = (frame + 1) / totalFrames;
  return progress;
}

async function createFrameAccurateMp4(config, width, height, fps, totalFrames) {
  const target = new window.Mp4Muxer.ArrayBufferTarget();
  const muxer = new window.Mp4Muxer.Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: { expectedVideoChunks: totalFrames },
  });
  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => { encoderError = error; },
  });
  encoder.configure(config);
  const frameDuration = Math.round(1_000_000 / fps);
  const keyFrameInterval = Math.max(1, Math.round(fps * 5));

  try {
    for (let frame = 0; frame < totalFrames && !state.cancelled; frame += 1) {
      await renderExactExportFrame(frame, totalFrames);
      if (state.cancelled) break;
      const videoFrame = new VideoFrame(ui.recordCanvas, {
        timestamp: frame * frameDuration,
        duration: frameDuration,
      });
      encoder.encode(videoFrame, { keyFrame: frame % keyFrameInterval === 0 });
      videoFrame.close();
      while (encoder.encodeQueueSize > 4 && !state.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      if (encoderError) throw encoderError;
    }
    if (state.cancelled) {
      encoder.close();
      return null;
    }
    await encoder.flush();
    if (encoderError) throw encoderError;
    encoder.close();
    muxer.finalize();
    return new Blob([target.buffer], { type: 'video/mp4' });
  } catch (error) {
    if (encoder.state !== 'closed') encoder.close();
    throw error;
  }
}

async function createFrameAccurateWebm(supported, width, height, fps, totalFrames) {
  const target = new window.WebMMuxer.ArrayBufferTarget();
  const muxer = new window.WebMMuxer.Muxer({
    target,
    video: {
      codec: supported.muxerCodec,
      width,
      height,
      frameRate: fps,
    },
    // A seekable file writes Duration and Cues when finalize() is called.
    streaming: false,
    firstTimestampBehavior: 'strict',
  });
  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => { encoderError = error; },
  });
  encoder.configure(supported.config);
  const frameDuration = Math.round(1_000_000 / fps);
  const keyFrameInterval = Math.max(1, Math.round(fps * 5));

  try {
    for (let frame = 0; frame < totalFrames && !state.cancelled; frame += 1) {
      await renderExactExportFrame(frame, totalFrames);
      if (state.cancelled) break;
      const videoFrame = new VideoFrame(ui.recordCanvas, {
        timestamp: frame * frameDuration,
        duration: frameDuration,
      });
      encoder.encode(videoFrame, { keyFrame: frame % keyFrameInterval === 0 });
      videoFrame.close();
      while (encoder.encodeQueueSize > 4 && !state.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      if (encoderError) throw encoderError;
    }
    if (state.cancelled) {
      encoder.close();
      return null;
    }
    await encoder.flush();
    if (encoderError) throw encoderError;
    encoder.close();
    muxer.finalize();
    return new Blob([target.buffer], { type: 'video/webm' });
  } catch (error) {
    if (encoder.state !== 'closed') encoder.close();
    throw error;
  }
}

async function saveFinishedVideo(blob, extension, options = {}) {
  const filename = safeFilename(ui.title.value || state.activity.title, extension);
  try {
    if (options.preferMp4) {
      setStatus('Finalizing video', 'Creating a seekable MP4 when FFmpeg is available…');
    }
    const result = await saveVideoBlob(blob, filename, options);
    const savedSize = Number.isFinite(result.size) ? result.size : blob.size;
    const detail = `${(savedSize / 1024 / 1024).toFixed(1)} MB · saved to ${result.path}`;
    setStatus('Video exported', result.warning ? `${detail} · ${result.warning}` : detail);
  } catch (_) {
    downloadBlob(blob, filename);
    setStatus('Video exported', `${(blob.size / 1024 / 1024).toFixed(1)} MB · the browser saved it to Downloads.`);
  }
}

function safeFilename(title, extension) {
  const clean = title.normalize('NFKD').replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'activity';
  return `${clean}_3D.${extension}`;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function saveVideoBlob(blob, name, options = {}) {
  const query = new URLSearchParams({ filename: name });
  if (options.preferMp4) query.set('prefer_mp4', '1');
  if (Number.isFinite(options.fps)) query.set('fps', String(options.fps));
  const response = await fetch(`/api/video?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  if (!response.ok) throw new Error(`Local save failed (${response.status})`);
  return response.json();
}

async function prepareMap() {
  if (state.preparing || state.exporting) return;
  if (!state.activity) {
    setStatus('Choose a GPX file', 'The activity is needed before the 3D map can be prepared.');
    return;
  }
  const token = ui.token.value.trim();
  if (!token) {
    setStatus('Mapbox token is missing', 'Paste a public Mapbox access token that starts with pk.');
    ui.token.focus();
    return;
  }
  state.preparing = true;
  state.terrainProfileRequest += 1;
  state.ready = false;
  state.cancelled = false;
  state.previewPaused = false;
  ui.preview.textContent = 'Play preview';
  state.mapErrors.clear();
  state.routeFinalBoost = null;
  state.route3dLayer = null;
  state.nativeRouteProgress = null;
  state.nativeRouteColorMode = null;
  state.nativeRouteColor = null;
  state.nativeRouteSegmentCount = 0;
  state.nativeRouteVisibleSegment = -1;
  state.nativeRouteFinished = null;
  ui.trimPreview.hidden = true;
  ui.trimPreview.classList.remove('standalone');
  ui.prepare.disabled = true;
  ui.preview.disabled = true;
  ui.export.disabled = true;
  ui.progress.value = 0.08;
  setStatus('Preparing the 3D map', 'Loading satellite imagery and elevation tiles…');
  try {
    if (state.map) state.map.remove();
    state.positionMarker = null;
    state.positionMarkerElement = null;
    state.pendingPositionMarker = null;
    ui.map.replaceChildren();
    state.map = new MapLibreMap({
      container: ui.map,
      style: mapStyle(token),
      center: [state.activity.points[0].lon, state.activity.points[0].lat],
      zoom: 11,
      pitch: 62,
      bearing: 0,
      maxPitch: 80,
      attributionControl: true,
      antialias: true,
      fadeDuration: 0,
      renderWorldCopies: false,
      pixelRatio: Math.min(2, window.devicePixelRatio || 1),
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true, powerPreference: 'high-performance' },
    });
    state.map.addControl(new NavigationControl({ showCompass: true, showZoom: true, visualizePitch: true }), 'bottom-right');
    state.map.on('render', syncActivityPositionMarkerAfterMapRender);
    state.map.on('error', (event) => {
      const message = event?.error?.message || 'Unknown map error';
      const url = event?.error?.url || '';
      if (/401|403|unauthorized|forbidden|token/i.test(message)) state.mapErrors.add('The Mapbox token was rejected.');
      else if (/mapbox-streets|\.mvt/i.test(`${url} ${message}`)) state.mapErrors.add('Some map labels could not be loaded.');
      else if (!/abort|cancel/i.test(message)) state.mapErrors.add('Some map tiles could not be loaded.');
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The map took too long to load. Check the internet connection and Mapbox token.')), 35000);
      state.map.once('load', () => { clearTimeout(timer); resolve(); });
    });
    ui.progress.value = 0.55;
    state.map.setTerrain({ source: 'terrain', exaggeration: QUALITY[ui.quality.value]?.terrain || 1.38 });
    state.map.setCenterClampedToGround?.(true);
    try {
      state.map.setSky({
        'sky-color': '#275f93',
        'sky-horizon-blend': 0.42,
        'horizon-color': '#b9dcf0',
        'horizon-fog-blend': 0.3,
        'fog-color': '#9ec8e4',
        'fog-ground-blend': 0.55,
      });
    } catch (_) {}
    addRouteLayers();
    addLabelLayers();
    for (const markerLayer of ['start-marker-outer', 'start-marker-inner']) {
      if (state.map.getLayer(markerLayer)) state.map.moveLayer(markerLayer);
    }
    state.ready = true;
    updateOverview();
    await waitForMapRender(1300);
    ui.empty.hidden = true;
    ui.progress.value = 0.58;
    await preloadRouteTiles();
    updateOverview();
    await waitForMapTiles(7000);
    await waitForMapRender(900);
    ui.preview.disabled = false;
    ui.export.disabled = false;
    ui.progress.value = 1;
    const warning = [...state.mapErrors].join(' ');
    setStatus(warning ? '3D map ready with a warning' : '3D map ready', warning || 'Use the preview, then export the finished video.');
  } catch (error) {
    state.terrainProfileRequest += 1;
    state.map?.remove();
    state.map = null;
    state.route3dLayer = null;
    state.nativeRouteProgress = null;
    state.nativeRouteColorMode = null;
    state.nativeRouteColor = null;
    state.nativeRouteSegmentCount = 0;
    state.nativeRouteVisibleSegment = -1;
    state.nativeRouteFinished = null;
    state.ready = false;
    ui.empty.hidden = false;
    ui.trimPreview.hidden = !state.sourceActivity;
    ui.trimPreview.classList.toggle('standalone', Boolean(state.sourceActivity));
    drawTrimPreview();
    ui.progress.value = 0;
    setStatus('Map preparation failed', error.message || String(error));
  } finally {
    state.preparing = false;
    ui.prepare.disabled = false;
  }
}

function stopAnimation(showMessage = true) {
  const stoppingPreview = state.animating && !state.exporting;
  state.cancelled = true;
  state.animating = false;
  cancelAnimationFrame(state.raf);
  if (stoppingPreview) {
    state.previewPaused = state.currentProgress > 0.0001 && state.currentProgress < 0.9999;
    ui.preview.disabled = !state.ready;
    ui.export.disabled = !state.ready;
    ui.cancel.hidden = true;
    ui.preview.textContent = state.previewPaused ? 'Continue preview' : 'Play preview';
  }
  if (showMessage) {
    if (state.exporting) setStatus('Export stopping', 'The partial video will be discarded.');
    else if (state.previewPaused) setStatus('Preview paused', 'Select “Continue preview” to carry on from this point.');
    else setStatus('Stopped', 'The preview was stopped.');
  }
}

async function playPreview() {
  if (!state.ready || state.exporting || state.animating) return;
  const resumeProgress = state.previewPaused ? clamp(state.currentProgress, 0, 0.999) : 0;
  state.cancelled = false;
  state.previewPaused = false;
  state.animating = true;
  ui.preview.textContent = 'Stop';
  ui.preview.disabled = false;
  ui.export.disabled = true;
  // Preview playback uses this same button for stopping. The separate stop
  // button remains reserved for cancelling a video export.
  ui.cancel.hidden = true;
  const seconds = clamp(Number(ui.duration.value) || 15, 1, 600);
  const finish = () => {
    if (state.cancelled) return;
    state.animating = false;
    state.previewPaused = false;
    ui.preview.textContent = 'Play preview';
    ui.preview.disabled = false;
    ui.export.disabled = false;
    ui.cancel.hidden = true;
    setStatus('Preview complete', 'The final frame shows the full route.');
  };
  if (!resumeProgress) {
    resetCameraSmoothing();
    updateScene(0);
  }
  setStatus(resumeProgress ? 'Continuing preview' : 'Preparing preview', resumeProgress ? 'Checking the map at the current position…' : 'Checking the first satellite and elevation tiles…');
  const startTilesReady = await waitForMapTiles(resumeProgress ? 4500 : 9000);
  if (state.cancelled) return;
  const start = performance.now() - resumeProgress * seconds * 1000;
  setStatus('Playing preview', startTilesReady ? 'The map is cached and the camera path is ready.' : 'Playback started; a slow map tile may still appear later.');
  const tick = (now) => {
    if (state.cancelled) return finish();
    const progress = clamp((now - start) / (seconds * 1000), 0, 1);
    updateScene(progress);
    ui.progress.value = progress;
    const totalFrames = Math.round(seconds * Number(ui.fps.value));
    ui.frameCounter.textContent = `Frame ${Math.min(totalFrames, Math.floor(progress * totalFrames) + 1)} / ${totalFrames}`;
    if (progress < 1) state.raf = requestAnimationFrame(tick);
    else finish();
  };
  state.raf = requestAnimationFrame(tick);
}

function togglePreview() {
  if (state.exporting) return;
  if (state.animating) {
    stopAnimation(true);
    return;
  }
  void playPreview();
}

async function exportVideo() {
  if (!state.ready || state.animating || state.exporting) return;
  const fps = Number(ui.fps.value);
  const seconds = clamp(Number(ui.duration.value) || 15, 1, 600);
  const totalFrames = Math.max(1, Math.round(seconds * fps));
  const [width, height] = targetDimensions();
  const fixedFrameConfig = await supportedAvcConfig(width, height, fps);
  const fixedWebmConfig = fixedFrameConfig ? null : await supportedWebmConfig(width, height, fps);
  const mimeType = recorderMime();
  if (!fixedFrameConfig && !fixedWebmConfig && (!window.MediaRecorder || !ui.recordCanvas.captureStream || !mimeType)) {
    setStatus('Video export is not supported', 'Open the application in a current version of Safari, Chrome or Edge.');
    return;
  }

  state.exporting = true;
  state.animating = true;
  state.cancelled = false;
  state.previewPaused = false;
  ui.preview.textContent = 'Play preview';
  ui.preview.disabled = true;
  ui.export.disabled = true;
  ui.prepare.disabled = true;
  ui.cancel.hidden = false;
  ui.recordCanvas.width = width;
  ui.recordCanvas.height = height;

  const rect = ui.viewport.getBoundingClientRect();
  const wantedRatio = Math.max(width / rect.width, height / rect.height);
  const renderRatio = Math.min(wantedRatio, QUALITY[ui.quality.value]?.maxPixelRatio || 2.35);
  state.map.setPixelRatio(renderRatio);
  state.map.resize();
  updateOverview();
  resetCameraSmoothing();
  updateScene(0);
  setStatus('Preparing export', 'Checking cached satellite and elevation tiles at export resolution…');
  await waitForMapTiles(10000);
  await waitForMapRender(900);
  if (state.cancelled) {
    finishExportUi();
    setStatus('Export stopped', 'No partial video was saved.');
    return;
  }
  composeRecordingFrame(0);

  if (fixedFrameConfig) {
    setStatus('Exporting smooth MP4', `${totalFrames} exact frames · rendering can take longer than the finished video`);
    try {
      const blob = await createFrameAccurateMp4(fixedFrameConfig, width, height, fps, totalFrames);
      if (blob && !state.cancelled) await saveFinishedVideo(blob, 'mp4');
      else setStatus('Export stopped', 'The partial video was discarded.');
    } catch (error) {
      state.cancelled = true;
      setStatus('Video export failed', `${error.message || error}. Try Balanced quality or a lower resolution.`);
    }
    finishExportUi();
    return;
  }

  if (fixedWebmConfig) {
    setStatus('Exporting smooth video', `${totalFrames} exact frames · every frame is rendered before encoding`);
    try {
      const blob = await createFrameAccurateWebm(fixedWebmConfig, width, height, fps, totalFrames);
      if (blob && !state.cancelled) {
        await saveFinishedVideo(blob, 'webm', { preferMp4: true, fps });
      } else {
        setStatus('Export stopped', 'The partial video was discarded.');
      }
      finishExportUi();
      return;
    } catch (error) {
      if (state.cancelled) {
        setStatus('Export stopped', 'The partial video was discarded.');
        finishExportUi();
        return;
      }
      if (!window.MediaRecorder || !ui.recordCanvas.captureStream || !mimeType) {
        setStatus('Video export failed', `${error.message || error}. Try Balanced quality or a lower resolution.`);
        finishExportUi();
        return;
      }
      setStatus('Switching video encoder', 'The exact-frame encoder was unavailable; using the browser-compatible exporter.');
      resetCameraSmoothing();
      updateScene(0);
      await waitForMapRender(500);
    }
  }

  const chunks = [];
  const stream = ui.recordCanvas.captureStream(fps);
  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: videoBitrate(width, height) });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    finishExportUi();
    setStatus('Video encoder could not start', error.message || String(error));
    return;
  }
  recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  // Emit the encoded data once at the end. Requesting a new blob every second
  // can stall the shared GPU/encoder for a few frames on Safari and makes the
  // custom route appear to blink at a regular one-second interval.
  recorder.start();
  setStatus('Exporting video', `${width} × ${height}, ${fps} FPS · compressed directly while the animation plays`);
  ui.progress.value = 0;

  try {
    const start = performance.now();
    let lastFrame = -1;
    while (!state.cancelled) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const elapsed = performance.now() - start;
      if (elapsed >= seconds * 1000) break;
      const frame = Math.min(totalFrames - 1, Math.floor(elapsed * fps / 1000));
      if (frame === lastFrame) continue;
      const progress = totalFrames === 1 ? 1 : frame / (totalFrames - 1);
      updateScene(progress);
      let rendered = await waitForMapRender(Math.max(20, Math.round(1200 / fps)));
      if (!state.map.areTilesLoaded?.()) {
        await waitForMapTiles(180);
        rendered = await waitForMapRender(Math.max(20, Math.round(1200 / fps)));
      }
      if (!rendered) continue;
      composeRecordingFrame(progress);
      ui.frameCounter.textContent = `Frame ${frame + 1} / ${totalFrames}`;
      ui.progress.value = (frame + 1) / totalFrames;
      lastFrame = frame;
    }
    if (!state.cancelled) {
      updateScene(1);
      await waitForMapRender(180);
      if (!state.map.areTilesLoaded?.()) await waitForMapTiles(500);
      composeRecordingFrame(1);
      ui.frameCounter.textContent = `Frame ${totalFrames} / ${totalFrames}`;
      ui.progress.value = 1;
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, 1200 / fps)));
    }
  } catch (error) {
    state.cancelled = true;
    setStatus('Video export failed', `${error.message || error}. Try Balanced quality or a lower resolution.`);
  }

  if (recorder.state !== 'inactive') recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  if (!state.cancelled && chunks.length) {
    const blob = new Blob(chunks, { type: mimeType });
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    await saveFinishedVideo(blob, extension, { preferMp4: extension === 'webm', fps });
  } else if (!state.cancelled) {
    setStatus('No video data was created', 'Try again in a current version of Safari, Chrome or Edge.');
  } else {
    chunks.length = 0;
    setStatus('Export stopped', 'The partial video was discarded.');
  }
  finishExportUi();
}

function finishExportUi() {
  state.exporting = false;
  state.animating = false;
  state.previewPaused = false;
  ui.preview.textContent = 'Play preview';
  ui.preview.disabled = !state.ready;
  ui.export.disabled = !state.ready;
  ui.prepare.disabled = false;
  ui.cancel.hidden = true;
  state.map?.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  state.map?.resize();
  updateOverview();
}

ui.file.addEventListener('change', async () => {
  const file = ui.file.files?.[0];
  if (!file) return;
  stopAnimation(false);
  state.previewPaused = false;
  ui.preview.textContent = 'Play preview';
  try {
    clearStatisticsOverrides();
    setStatus('Reading GPX activity', 'The file stays on this computer.');
    state.sourceText = await file.text();
    state.sourceFileName = file.name;
    state.sourceActivity = parseGpx(state.sourceText, file.name);
    state.activity = state.sourceActivity;
    state.currentProgress = 0;
    const fullDuration = trimRangeSeconds(state.sourceActivity);
    ui.trimStart.max = String(fullDuration);
    ui.trimEnd.max = String(fullDuration);
    ui.trimStart.value = '0';
    ui.trimEnd.value = String(fullDuration);
    ui.trimStart.disabled = false;
    ui.trimEnd.disabled = false;
    discardPreparedMap();
    ui.fileName.textContent = file.name;
    ui.title.value = state.activity.title;
    updateStatisticsDisplay();
    updateHeartRateAvailability();
    updateTrimControl();
    drawPreviewOverlays(0);
    const heartRateText = state.activity.hasHeartRate ? ' · heart rate available' : '';
    setStatus('GPX loaded', `${state.activity.points.length.toLocaleString()} points · ${(state.activity.totalDistance / 1000).toFixed(1)} km${heartRateText}`);
  } catch (error) {
    state.activity = null;
    state.sourceActivity = null;
    state.sourceText = '';
    state.sourceFileName = '';
    state.ready = false;
    ui.trimStart.disabled = true;
    ui.trimEnd.disabled = true;
    updateHeartRateAvailability();
    updateTrimControl();
    setStatus('GPX could not be read', error.message || String(error));
  }
});

ui.toggleToken.addEventListener('click', () => {
  const showing = ui.token.type === 'text';
  ui.token.type = showing ? 'password' : 'text';
  ui.toggleToken.textContent = showing ? 'Show' : 'Hide';
  ui.toggleToken.setAttribute('aria-label', showing ? 'Show access token' : 'Hide access token');
});
ui.prepare.addEventListener('click', prepareMap);
ui.preview.addEventListener('click', togglePreview);
ui.export.addEventListener('click', exportVideo);
ui.cancel.addEventListener('click', () => stopAnimation(true));

for (const control of [ui.token, ui.labels, ui.duration, ui.resolution, ui.fps, ui.quality, ui.metric, ui.orientation, ui.routeColoring, ui.routeColor, ui.heartRate, ui.hudTop, ui.hudSize, ui.labelSize, ui.cameraDistance, ui.cameraHeight]) {
  control.addEventListener('input', () => {
    refreshControlLabels();
    saveSettings();
    if (control === ui.orientation) setOrientation();
    if (control === ui.metric) updateStatisticsDisplay();
    if (control === ui.labelSize) updateLabelSize();
    if (control === ui.routeColor) drawTrimPreview();
    if ([ui.routeColor, ui.routeColoring].includes(control) && state.ready) updateScene(state.currentProgress);
    if ([ui.cameraDistance, ui.cameraHeight].includes(control) && state.ready) {
      resetCameraSmoothing();
      updateScene(state.currentProgress);
    }
    if ([ui.hudTop, ui.hudSize, ui.metric, ui.heartRate].includes(control)) drawPreviewOverlays(state.currentProgress);
  });
}
ui.trimStart.addEventListener('input', () => updateTrimControl('start'));
ui.trimEnd.addEventListener('input', () => updateTrimControl('end'));
ui.trimStart.addEventListener('change', applyTrimSelection);
ui.trimEnd.addEventListener('change', applyTrimSelection);
for (const control of [ui.labels, ui.quality]) {
  control.addEventListener('change', () => {
    if (state.ready) setStatus('Map settings changed', 'Select “Prepare 3D map” to apply this change.');
  });
}
ui.title.addEventListener('input', () => drawPreviewOverlays(state.currentProgress));
for (const control of [ui.statsDistance, ui.statsElevation, ui.statsMovingTime, ui.statsHeartRate]) {
  control.addEventListener('input', () => {
    const distance = Number(ui.statsDistance.value);
    const elevation = Number(ui.statsElevation.value);
    const movingSeconds = parseDurationInput(ui.statsMovingTime.value);
    const averageHeartRate = Number(ui.statsHeartRate.value);
    ui.statsDistance.setCustomValidity(ui.statsDistance.value.trim() && (!Number.isFinite(distance) || distance <= 0)
      ? 'Enter a distance greater than zero.'
      : '');
    ui.statsElevation.setCustomValidity(ui.statsElevation.value.trim() && (!Number.isFinite(elevation) || elevation < 0)
      ? 'Enter zero or a positive elevation gain.'
      : '');
    ui.statsMovingTime.setCustomValidity(ui.statsMovingTime.value.trim() && (!Number.isFinite(movingSeconds) || movingSeconds <= 0)
      ? 'Use hh:mm:ss or mm:ss.'
      : '');
    ui.statsHeartRate.setCustomValidity(ui.statsHeartRate.value.trim()
      && (!Number.isFinite(averageHeartRate) || averageHeartRate < 25 || averageHeartRate > 250)
      ? 'Enter an average heart rate between 25 and 250 bpm.'
      : '');
    updateStatisticsDisplay();
    drawPreviewOverlays(state.currentProgress);
  });
}
for (const control of [ui.statsDistance, ui.statsElevation, ui.statsHeartRate]) {
  control.addEventListener('focus', () => seedAutomaticStatistic(control));
}
window.addEventListener('resize', () => {
  drawPreviewOverlays(state.currentProgress);
  drawTrimPreview();
});
window.addEventListener('beforeunload', () => state.map?.remove());

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
await loadSettings();
updateTrimControl();
updateHeartRateAvailability();
updateStatisticsDisplay();
setStatus('Ready', 'Choose a GPX file. GPX data stays on this computer.');
