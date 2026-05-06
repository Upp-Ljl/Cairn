const SHEET_W = 1536, SHEET_H = 1872;
const CELL_W = 192, CELL_H = 208;
const COLS = 8;
const DISPLAY_SCALE = 0.5;
const DST_W = CELL_W * DISPLAY_SCALE;
const DST_H = CELL_H * DISPLAY_SCALE;
const FPS = 8;

const STATES = [
  { name: 'idle',          row: 0, frames: 6 },
  { name: 'running-right', row: 1, frames: 8 },
  { name: 'running-left',  row: 2, frames: 8 },
  { name: 'waving',        row: 3, frames: 4 },
  { name: 'jumping',       row: 4, frames: 5 },
  { name: 'failed',        row: 5, frames: 8 },
  { name: 'waiting',       row: 6, frames: 6 },
  { name: 'running',       row: 7, frames: 6 },
  { name: 'review',        row: 8, frames: 6 },
];

const STATE_URL = 'http://localhost:7842/state';
const IN_ELECTRON = typeof window !== 'undefined' && window.cairn !== undefined;

const display = document.getElementById('display');
const statusLine = document.getElementById('status-line');
const select = document.getElementById('state-select');
const debugPanel = document.getElementById('debug-panel');
const debugToggle = document.getElementById('debug-toggle');
const manualControls = document.getElementById('manual-controls');

display.width = DST_W;
display.height = DST_H;
const ctx = display.getContext('2d');
ctx.imageSmoothingEnabled = false;
ctx.webkitImageSmoothingEnabled = false;
ctx.mozImageSmoothingEnabled = false;

let sheet = null;
let chromaCanvas = null;
let stateIdx = 0;
let frame = 0;
let lastTs = 0;
let manualOverride = false;
let jumpingOneShot = false;
let jumpingFramesDone = 0;
let wavingOneShot = false;
let wavingFramesDone = 0;
let lastRule = '';

function stateByName(name) {
  const idx = STATES.findIndex(s => s.name === name);
  return idx >= 0 ? idx : 0;
}

function pickAnimation(s) {
  if (!s.available)
    return { name: 'failed', rule: 'unavailable' };
  if (s.last_dispatch_status === 'failed' && s.last_dispatch_age_sec != null && s.last_dispatch_age_sec < 5)
    return { name: 'failed', rule: 'recent dispatch FAILED' };
  if (s.conflicts_open > 0)
    return { name: 'review', rule: `conflicts_open=${s.conflicts_open}` };
  if (s.lanes_held_for_human > 0 || s.dispatch_pending > 0)
    return { name: 'waiting', rule: `held=${s.lanes_held_for_human} pending=${s.dispatch_pending}` };
  if (s.last_dispatch_status === 'confirmed' && s.last_dispatch_age_sec != null && s.last_dispatch_age_sec < 3)
    return { name: 'jumping', rule: 'recent dispatch CONFIRMED', oneShot: true };
  if (s.lanes_reverting > 0)
    return { name: 'running-left', rule: `lanes_reverting=${s.lanes_reverting}` };
  if (s.agents_active > 0)
    return { name: 'running', rule: `agents_active=${s.agents_active}` };
  if (s.newest_agent_age_sec != null && s.newest_agent_age_sec < 5)
    return { name: 'waving', rule: 'new agent registered', oneShot: true };
  return { name: 'idle', rule: 'no signals' };
}

function applyAnimation(animName, rule) {
  if (manualOverride) return;

  if (animName === 'jumping' && !jumpingOneShot) {
    jumpingOneShot = true;
    jumpingFramesDone = 0;
    wavingOneShot = false;
    stateIdx = stateByName('jumping');
    frame = 0;
  } else if (animName === 'waving' && !wavingOneShot) {
    wavingOneShot = true;
    wavingFramesDone = 0;
    jumpingOneShot = false;
    stateIdx = stateByName('waving');
    frame = 0;
  } else if (animName !== 'jumping' && animName !== 'waving') {
    if (jumpingOneShot || wavingOneShot) return;
    const next = stateByName(animName);
    if (next !== stateIdx) { stateIdx = next; frame = 0; }
  }

  if (rule !== lastRule) {
    lastRule = rule;
    statusLine.textContent = `${animName}  [${rule}]`;
    select.value = stateIdx;
  }
}

function drawFrame() {
  if (!chromaCanvas) return;
  const st = STATES[stateIdx];
  const col = frame % COLS;
  const sx = col * CELL_W;
  const sy = st.row * CELL_H;
  ctx.clearRect(0, 0, DST_W, DST_H);
  ctx.drawImage(chromaCanvas, sx, sy, CELL_W, CELL_H, 0, 0, DST_W, DST_H);
}

function loop(ts) {
  requestAnimationFrame(loop);
  if (!sheet) return;
  if (ts - lastTs < 1000 / FPS) return;
  lastTs = ts;

  const st = STATES[stateIdx];
  frame = (frame + 1) % st.frames;

  if (jumpingOneShot) {
    jumpingFramesDone++;
    if (jumpingFramesDone >= STATES[stateByName('jumping')].frames) {
      jumpingOneShot = false;
      jumpingFramesDone = 0;
    }
  }

  if (wavingOneShot) {
    wavingFramesDone++;
    if (wavingFramesDone >= STATES[stateByName('waving')].frames) {
      wavingOneShot = false;
      wavingFramesDone = 0;
    }
  }

  drawFrame();
}

async function pollState() {
  try {
    const data = IN_ELECTRON
      ? await window.cairn.getState()
      : await fetch(STATE_URL).then(r => r.json());
    const { name, rule } = pickAnimation(data);
    applyAnimation(name, rule);
    if (debugPanel.classList.contains('visible')) {
      debugPanel.textContent = JSON.stringify(data, null, 2);
    }
  } catch {
    applyAnimation('failed', 'server_unreachable');
    if (debugPanel.classList.contains('visible')) {
      debugPanel.textContent = '{ "available": false, "error": "state server unreachable" }';
    }
    if (!manualOverride) statusLine.textContent = 'failed  [server_unreachable]';
  }
}

function buildChromaCanvas(img) {
  const offscreen = document.createElement('canvas');
  offscreen.width = SHEET_W;
  offscreen.height = SHEET_H;
  const offCtx = offscreen.getContext('2d');
  offCtx.imageSmoothingEnabled = false;
  offCtx.webkitImageSmoothingEnabled = false;
  offCtx.mozImageSmoothingEnabled = false;
  offCtx.drawImage(img, 0, 0);
  let data;
  try {
    data = offCtx.getImageData(0, 0, SHEET_W, SHEET_H);
  } catch (e) {
    return null;
  }
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (r > 200 && g > 200 && b < 120) {
      px[i + 3] = 0;
    }
  }
  offCtx.putImageData(data, 0, 0);
  return offscreen;
}

const img = new Image();
img.onload = () => {
  sheet = img;
  const built = buildChromaCanvas(img);
  chromaCanvas = built || img;
  drawFrame();
  requestAnimationFrame(loop);
};
img.onerror = () => {
  statusLine.textContent = 'ERROR: spritesheet.webp not found next to preview.html';
};
img.src = 'spritesheet.webp';

STATES.forEach((s, i) => {
  const opt = document.createElement('option');
  opt.value = i;
  opt.textContent = s.name;
  select.appendChild(opt);
});

select.addEventListener('change', () => {
  manualOverride = true;
  stateIdx = +select.value;
  frame = 0;
  jumpingOneShot = false;
  statusLine.textContent = `${STATES[stateIdx].name}  [manual]`;
  if (sheet) drawFrame();
});

debugToggle.addEventListener('click', () => {
  const on = debugPanel.classList.toggle('visible');
  manualControls.classList.toggle('visible', on);
  if (!on) manualOverride = false;
  debugToggle.style.color = on ? '#7af' : '#aaa';
});

document.querySelectorAll('[data-bg]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-bg]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const wrap = document.getElementById('canvas-wrap');
    wrap.className = 'bg-' + btn.dataset.bg;
  });
});

if (IN_ELECTRON) {
  document.querySelector('h1').style.display = 'none';
  document.getElementById('status-line').style.display = 'none';
  document.querySelector('.controls').style.display = 'none';
  document.getElementById('debug-panel').style.display = 'none';
  document.getElementById('canvas-wrap').style.cssText = 'display:inline-block;padding:0;border:none';
}

const CLICK_THRESHOLD = 5;
let dragStartX = 0, dragStartY = 0, dragging = false;

display.addEventListener('pointerdown', (e) => {
  dragStartX = e.screenX;
  dragStartY = e.screenY;
  dragging = false;
  display.setPointerCapture(e.pointerId);
  if (window.cairn) window.cairn.startDrag(e.screenX, e.screenY);
});

display.addEventListener('pointermove', (e) => {
  if (e.buttons === 0) return;
  dragging = true;
  if (window.cairn) window.cairn.doDrag(e.screenX, e.screenY);
});

display.addEventListener('pointerup', (e) => {
  const dx = e.screenX - dragStartX;
  const dy = e.screenY - dragStartY;
  if (Math.sqrt(dx * dx + dy * dy) < CLICK_THRESHOLD) {
    window.cairn?.openInspector();
  }
  dragging = false;
});

pollState();
setInterval(pollState, 1000);
