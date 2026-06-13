const $ = (selector) => document.querySelector(selector);

const board = $("#board");
const elements = {
  boardStatus: $("#boardStatus"),
  boardHint: $("#boardHint"),
  centerDisplay: $(".center-display"),
  idleLogo: $("#idleLogo"),
  resultSpot: $("#resultSpot"),
  runButton: $("#runButton"),
  stopButton: $("#stopButton"),
  soundButton: $("#soundButton"),
  selectedProduct: $("#selectedProduct"),
  selectedDetail: $("#selectedDetail"),
  selectedPreview: $("#selectedPreview"),
  historyList: $("#historyList"),
};

const spotDefinitions = {
  bigBucks: {
    key: "bigBucks",
    label: "Big Bucks",
    type: "product",
    tone: "green",
    lines: ["Big", "Bucks"],
    detail: "Award the Big Bucks prize.",
  },
  fiveBySeven: {
    key: "fiveBySeven",
    label: "5x7 Print",
    type: "product",
    tone: "green",
    lines: ["5x7", "Print"],
    detail: "Award a 5x7 print.",
  },
  mini: {
    key: "mini",
    label: "Playground Mini Print",
    type: "product",
    tone: "purple",
    lines: ["Playground", "Mini", "Print"],
    detail: "Award a Playground mini print.",
  },
  miniSpin: {
    key: "miniSpin",
    label: "Playground Mini Print + One Spin",
    type: "productSpin",
    tone: "red",
    lines: ["Playground", "Mini Print", "+", "One", "Spin"],
    detail: "Award a Playground mini print, then run the board again.",
  },
  moveLeft: {
    key: "moveLeft",
    label: "Move 2 Spaces Left",
    type: "move",
    tone: "pink",
    lines: ["Move", "2 Spaces"],
    arrow: "left",
    offset: 2,
    detail: "Move two spaces left and resolve that spot.",
  },
  moveRight: {
    key: "moveRight",
    label: "Move 2 Spaces Right",
    type: "move",
    tone: "green",
    lines: ["Move", "2 Spaces"],
    arrow: "right",
    offset: -2,
    detail: "Move two spaces right and resolve that spot.",
  },
  pickCorner: {
    key: "pickCorner",
    label: "Pick A Corner",
    type: "corner",
    tone: "pink",
    lines: ["Pick", "A", "Corner"],
    detail: "Pick one of the four lit corner spots.",
  },
  spinAgain: {
    key: "spinAgain",
    label: "Spin Again",
    type: "spinAgain",
    tone: "blue",
    lines: ["Spin", "Again"],
    detail: "Run the board again.",
  },
  whammy: {
    key: "whammy",
    label: "Whammy",
    type: "whammy",
    tone: "yellow",
    lines: ["Whammy!"],
    detail: "Whammy landed. No product awarded.",
  },
};

const boardLayout = [
  "bigBucks",
  "mini",
  "moveRight",
  "fiveBySeven",
  "miniSpin",
  "spinAgain",
  "moveLeft",
  "whammy",
  "pickCorner",
  "mini",
  "bigBucks",
  "moveRight",
  "fiveBySeven",
  "spinAgain",
  "miniSpin",
  "pickCorner",
  "whammy",
  "moveLeft",
];

const slotMap = [
  [1, 1],
  [1, 2],
  [1, 3],
  [1, 4],
  [1, 5],
  [1, 6],
  [2, 6],
  [3, 6],
  [4, 6],
  [5, 6],
  [5, 5],
  [5, 4],
  [5, 3],
  [5, 2],
  [5, 1],
  [4, 1],
  [3, 1],
  [2, 1],
];

const cornerIndexes = [0, 5, 9, 14];
const maxActionDepth = 5;

const state = {
  activeIndex: 0,
  boardSpots: boardLayout.map((key, index) => ({ ...spotDefinitions[key], id: `${index}-${key}` })),
  history: [],
  isPickingCorner: false,
  isResolving: false,
  isRunning: false,
  musicTimer: null,
  soundOn: true,
  timer: null,
};

function spotCardHtml(spot, { compact = false } = {}) {
  const lines = spot.lines
    .map((line) => `<span class="spot-line">${line}</span>`)
    .join("");
  const arrow = spot.arrow ? `<span class="spot-arrow spot-arrow-${spot.arrow}"></span>` : "";
  const whammyBurst = spot.type === "whammy" ? `<span class="spot-burst" aria-hidden="true"></span>` : "";
  return `
    <div class="spot-card spot-${spot.tone} spot-type-${spot.type}${compact ? " spot-compact" : ""}">
      <div class="spot-text">${lines}</div>
      ${arrow}
      ${whammyBurst}
    </div>
  `;
}

function renderBoard() {
  board.querySelectorAll(".tile").forEach((tile) => tile.remove());
  state.boardSpots.forEach((spot, index) => {
    const [row, column] = slotMap[index];
    const tile = document.createElement("button");
    tile.className = `tile tile-${spot.tone}`;
    tile.type = "button";
    tile.style.setProperty("--row", row);
    tile.style.setProperty("--column", column);
    tile.setAttribute("aria-label", spot.label);
    tile.innerHTML = spotCardHtml(spot);
    tile.addEventListener("click", () => handleTileClick(index));
    board.append(tile);
  });
  updateActiveTile();
}

function handleTileClick(index) {
  if (state.isPickingCorner && cornerIndexes.includes(index)) {
    resolveCorner(index);
    return;
  }

  if (!state.isRunning && !state.isResolving && !state.isPickingCorner) {
    state.activeIndex = index;
    updateActiveTile();
    resolveSpot(state.boardSpots[index]);
  }
}

function updateActiveTile() {
  board.querySelectorAll(".tile").forEach((tile, index) => {
    tile.classList.toggle("is-active", index === state.activeIndex);
    tile.classList.toggle("is-corner-choice", state.isPickingCorner && cornerIndexes.includes(index));
  });
}

function setStatus(status, hint) {
  elements.boardStatus.textContent = status;
  elements.boardHint.textContent = hint;
}

function renderStatus() {
  document.body.toggleAttribute("data-spinning", state.isRunning);
  document.body.toggleAttribute("data-picking-corner", state.isPickingCorner);
  elements.stopButton.disabled = !state.isRunning;
  elements.runButton.disabled = state.isRunning || state.isResolving || state.isPickingCorner;

  if (state.isPickingCorner) {
    setStatus("Pick Corner", "Four corners are live.");
  } else if (state.isResolving) {
    setStatus("Resolving", "Following the selected spot.");
  } else if (state.isRunning) {
    setStatus("Running", "The board is cycling.");
  } else {
    setStatus("Ready", "Board paused.");
  }
}

function renderHistory() {
  elements.historyList.innerHTML = "";
  if (!state.history.length) {
    const item = document.createElement("li");
    item.textContent = "No picks yet";
    elements.historyList.append(item);
    return;
  }

  state.history.slice(0, 5).forEach((spot) => {
    const item = document.createElement("li");
    item.innerHTML = `
      <span>${spot.label}</span>
      <div class="history-mini">${spotCardHtml(spot, { compact: true })}</div>
    `;
    elements.historyList.append(item);
  });
}

function showCenterLogo() {
  elements.centerDisplay.classList.remove("has-result");
  elements.idleLogo.hidden = false;
  elements.resultSpot.hidden = true;
  elements.resultSpot.innerHTML = "";
}

function showCenterSpot(spot) {
  elements.centerDisplay.classList.add("has-result");
  elements.idleLogo.hidden = true;
  elements.resultSpot.hidden = false;
  elements.resultSpot.innerHTML = spotCardHtml(spot);
}

function showSideSpot(spot) {
  elements.selectedProduct.textContent = spot.label;
  elements.selectedDetail.textContent = spot.detail;
  elements.selectedPreview.innerHTML = spotCardHtml(spot, { compact: true });
}

function addHistory(spot) {
  state.history.unshift(spot);
  renderHistory();
}

function advanceActiveTile() {
  state.activeIndex = (state.activeIndex + 1) % state.boardSpots.length;
  updateActiveTile();
  playTone(420 + (state.activeIndex % 6) * 34, 0.028, "square", 0.018);
}

function runBoard() {
  if (state.isRunning || state.isResolving || state.isPickingCorner) return;
  state.isRunning = true;
  showCenterLogo();
  elements.selectedProduct.textContent = "Board running";
  elements.selectedDetail.textContent = "The board is cycling.";
  elements.selectedPreview.innerHTML = "";
  startMusic();
  state.timer = window.setInterval(advanceActiveTile, 76);
  renderStatus();
}

function stopBoard() {
  if (!state.isRunning) return;
  window.clearInterval(state.timer);
  stopMusic();
  state.isRunning = false;
  resolveSpot(state.boardSpots[state.activeIndex]);
}

async function resolveSpot(spot, { depth = 0 } = {}) {
  state.isResolving = true;
  state.isPickingCorner = false;
  showCenterSpot(spot);
  showSideSpot(spot);
  addHistory(spot);
  playResultTone(spot);
  renderStatus();
  updateActiveTile();

  if (depth > maxActionDepth) {
    finishResolution();
    return;
  }

  if (spot.type === "move") {
    await sleep(600);
    await moveSpaces(spot.offset);
    await sleep(250);
    await resolveSpot(state.boardSpots[state.activeIndex], { depth: depth + 1 });
    return;
  }

  if (spot.type === "corner") {
    state.isResolving = false;
    state.isPickingCorner = true;
    renderStatus();
    updateActiveTile();
    return;
  }

  if (spot.type === "spinAgain" || spot.type === "productSpin") {
    await sleep(1050);
    state.isResolving = false;
    renderStatus();
    runBoard();
    return;
  }

  finishResolution();
}

async function moveSpaces(offset) {
  const direction = Math.sign(offset);
  const steps = Math.abs(offset);
  for (let step = 0; step < steps; step += 1) {
    state.activeIndex = (state.activeIndex + direction + state.boardSpots.length) % state.boardSpots.length;
    updateActiveTile();
    playTone(520 + step * 80, 0.09, "square", 0.035);
    await sleep(240);
  }
}

function resolveCorner(index) {
  if (!state.isPickingCorner) return;
  state.activeIndex = index;
  state.isPickingCorner = false;
  updateActiveTile();
  resolveSpot(state.boardSpots[index], { depth: 1 });
}

function finishResolution() {
  state.isResolving = false;
  state.isPickingCorner = false;
  renderStatus();
  updateActiveTile();
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

let audioContext;

function getAudioContext() {
  audioContext ||= new AudioContext();
  return audioContext;
}

function playTone(frequency, duration, type = "triangle", gainLevel = 0.04) {
  if (!state.soundOn) return;
  try {
    const context = getAudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.value = gainLevel;
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + duration);
  } catch {
    // Audio is decorative; board selection does not depend on it.
  }
}

function startMusic() {
  if (!state.soundOn || state.musicTimer) return;
  const notes = [196, 247, 294, 330, 294, 247, 220, 262];
  let step = 0;
  state.musicTimer = window.setInterval(() => {
    playTone(notes[step % notes.length], 0.11, "sawtooth", 0.025);
    if (step % 2 === 0) playTone(notes[(step + 2) % notes.length] * 2, 0.08, "triangle", 0.014);
    step += 1;
  }, 145);
}

function stopMusic() {
  window.clearInterval(state.musicTimer);
  state.musicTimer = null;
}

function playResultTone(spot) {
  if (spot.type === "whammy") {
    playTone(142, 0.16, "sawtooth", 0.06);
    window.setTimeout(() => playTone(84, 0.24, "sawtooth", 0.045), 100);
    return;
  }

  playTone(540, 0.1, "triangle", 0.055);
  window.setTimeout(() => playTone(760, 0.12, "triangle", 0.05), 95);
}

function toggleSound() {
  state.soundOn = !state.soundOn;
  elements.soundButton.textContent = state.soundOn ? "Sound On" : "Sound Off";
  elements.soundButton.setAttribute("aria-pressed", String(state.soundOn));
  if (!state.soundOn) stopMusic();
  if (state.soundOn && state.isRunning) startMusic();
}

function init() {
  elements.selectedProduct.textContent = "Board running";
  elements.selectedDetail.textContent = "The board is cycling.";
  renderBoard();
  renderHistory();
  runBoard();
}

elements.runButton.addEventListener("click", runBoard);
elements.stopButton.addEventListener("click", stopBoard);
elements.soundButton.addEventListener("click", toggleSound);

document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  event.preventDefault();
  if (state.isPickingCorner) {
    const randomCorner = cornerIndexes[Math.floor(Math.random() * cornerIndexes.length)];
    resolveCorner(randomCorner);
  } else if (state.isRunning) {
    stopBoard();
  } else {
    runBoard();
  }
});

init();
