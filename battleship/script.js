"use strict";

const GRID_SIZE = 10;
const SHIPS = [5, 3, 2];
const SAVE_KEY = "battleship_v2_save";

const userBoardEl = document.getElementById("userBoard");
const aiBoardEl = document.getElementById("aiBoard");

const subtitleTextEl = document.getElementById("subtitleText");
const statusTextEl = document.getElementById("statusText");
const turnTextEl = document.getElementById("turnText");
const statsTextEl = document.getElementById("statsText");

const resetBtn = document.getElementById("resetBtn");
const clearSaveBtn = document.getElementById("clearSaveBtn");

function keyOf(r, c) { return `${r},${c}`; }
function parseKey(k) { const [r, c] = k.split(",").map(Number); return { r, c }; }
function inBounds(r, c) { return r >= 0 && r < GRID_SIZE && c >= 0 && c < GRID_SIZE; }
function randomInt(min, maxInclusive) { return Math.floor(Math.random() * (maxInclusive - min + 1)) + min; }

function createEmptyBoard() {
  return { shipCells: new Set(), hitCells: new Set(), missCells: new Set() };
}

let userBoard;
let aiBoard;

let currentTurn = "USER"; // USER always starts
let gameOver = false;

let userShots = { hits: 0, misses: 0 };
let aiShots = { hits: 0, misses: 0 };

/**
 * AI State:
 * - mode: "HUNT" | "TARGET"
 * - targetQueue: array of keys to try next (adjacent candidates)
 * - clusterHits: array of keys in the current contiguous hit cluster (for orientation)
 */
let aiState = {
  mode: "HUNT",
  targetQueue: [],
  clusterHits: [],
};

function setStatus(text) { statusTextEl.textContent = text; }
function setTurnUI() {
  turnTextEl.innerHTML = `Current turn: <strong>${currentTurn === "USER" ? "User" : "AI"}</strong>`;
}
function setStatsUI() {
  statsTextEl.textContent =
    `User Hits: ${userShots.hits} | User Misses: ${userShots.misses} — ` +
    `AI Hits: ${aiShots.hits} | AI Misses: ${aiShots.misses}`;
}

/* ---------------- UI BUILD ---------------- */

function buildBoardUI(containerEl, owner) {
  containerEl.innerHTML = "";
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.dataset.owner = owner;
      cell.setAttribute("aria-label", `${owner} row ${r + 1}, col ${c + 1}`);

      if (owner === "AI") {
        cell.addEventListener("click", onUserFireAtAI);
      } else {
        cell.disabled = true;
        cell.classList.add("disabled");
      }

      containerEl.appendChild(cell);
    }
  }
}

function getCellEl(boardOwner, r, c) {
  const container = boardOwner === "USER" ? userBoardEl : aiBoardEl;
  return container.children[r * GRID_SIZE + c];
}

function markCell(boardOwner, r, c, isHit) {
  const el = getCellEl(boardOwner, r, c);
  el.classList.add("disabled");
  el.disabled = true;
  el.classList.add(isHit ? "hit" : "miss");
}

/* ---------------- SHIP PLACEMENT ---------------- */

function placeAllShipsRandomly(board) {
  for (const length of SHIPS) placeOneShipRandomly(board, length);
}

function placeOneShipRandomly(board, length) {
  while (true) {
    const vertical = Math.random() < 0.5;
    const startR = vertical ? randomInt(0, GRID_SIZE - length) : randomInt(0, GRID_SIZE - 1);
    const startC = vertical ? randomInt(0, GRID_SIZE - 1) : randomInt(0, GRID_SIZE - length);

    const candidate = [];
    for (let i = 0; i < length; i++) {
      const r = vertical ? startR + i : startR;
      const c = vertical ? startC : startC + i;
      candidate.push(keyOf(r, c));
    }

    if (candidate.some(k => board.shipCells.has(k))) continue;
    candidate.forEach(k => board.shipCells.add(k));
    return;
  }
}

/* ---------------- GAME LOGIC ---------------- */

function alreadyShot(board, k) {
  return board.hitCells.has(k) || board.missCells.has(k);
}

function applyShot(board, targetOwner, r, c) {
  const k = keyOf(r, c);
  if (alreadyShot(board, k)) return { valid: false };

  const isHit = board.shipCells.has(k);
  if (isHit) board.hitCells.add(k);
  else board.missCells.add(k);

  markCell(targetOwner, r, c, isHit);

  return { valid: true, isHit, key: k };
}

function hasWon(defenderBoard) {
  return defenderBoard.hitCells.size === defenderBoard.shipCells.size;
}

function updateInteractivity() {
  // User should only be able to click AI cells if it's USER turn and game not over.
  for (let i = 0; i < aiBoardEl.children.length; i++) {
    const cell = aiBoardEl.children[i];
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    const k = keyOf(r, c);

    const shotAlready = alreadyShot(aiBoard, k);
    const shouldDisable = gameOver || currentTurn !== "USER" || shotAlready;

    cell.disabled = shouldDisable;
    cell.classList.toggle("disabled", shouldDisable);

    // keep hit/miss classes as-is
  }
}

/* ---------------- AI: HUNT / TARGET ---------------- */

function neighbors4(r, c) {
  return [
    { r: r - 1, c },
    { r: r + 1, c },
    { r, c: c - 1 },
    { r, c: c + 1 },
  ].filter(p => inBounds(p.r, p.c));
}

function recomputeClusterFromHit(hitKey) {
  // BFS over AI's hit cells on USER board to find the connected component containing hitKey.
  const visited = new Set();
  const queue = [hitKey];
  visited.add(hitKey);

  while (queue.length) {
    const k = queue.shift();
    const { r, c } = parseKey(k);
    for (const nb of neighbors4(r, c)) {
      const nk = keyOf(nb.r, nb.c);
      if (!visited.has(nk) && userBoard.hitCells.has(nk)) {
        visited.add(nk);
        queue.push(nk);
      }
    }
  }
  return Array.from(visited);
}

function uniquePush(queue, k) {
  if (!queue.includes(k)) queue.push(k);
}

function aiQueueAdjacentsFromHits(clusterHits) {
  // Add adjacent, unshot cells around the entire cluster.
  for (const hk of clusterHits) {
    const { r, c } = parseKey(hk);
    for (const nb of neighbors4(r, c)) {
      const nk = keyOf(nb.r, nb.c);
      if (!alreadyShot(userBoard, nk)) uniquePush(aiState.targetQueue, nk);
    }
  }
}

function inferOrientation(clusterHits) {
  if (clusterHits.length < 2) return null;
  const coords = clusterHits.map(parseKey);
  const allSameRow = coords.every(p => p.r === coords[0].r);
  const allSameCol = coords.every(p => p.c === coords[0].c);
  if (allSameRow) return "H";
  if (allSameCol) return "V";
  return null;
}

function extendLineTargets(clusterHits, orientation) {
  // If we know orientation, prioritize extending from min..max along that line
  const coords = clusterHits.map(parseKey);

  if (orientation === "H") {
    const row = coords[0].r;
    const cols = coords.map(p => p.c);
    const minC = Math.min(...cols);
    const maxC = Math.max(...cols);

    const left = { r: row, c: minC - 1 };
    const right = { r: row, c: maxC + 1 };

    // Put line extensions FIRST in queue (front-loaded)
    const front = [];
    if (inBounds(left.r, left.c)) {
      const lk = keyOf(left.r, left.c);
      if (!alreadyShot(userBoard, lk)) front.push(lk);
    }
    if (inBounds(right.r, right.c)) {
      const rk = keyOf(right.r, right.c);
      if (!alreadyShot(userBoard, rk)) front.push(rk);
    }

    // then also keep adjacents as fallback
    aiQueueAdjacentsFromHits(clusterHits);

    // rebuild queue with priority
    aiState.targetQueue = [...front, ...aiState.targetQueue.filter(k => !front.includes(k))];
    return;
  }

  if (orientation === "V") {
    const col = coords[0].c;
    const rows = coords.map(p => p.r);
    const minR = Math.min(...rows);
    const maxR = Math.max(...rows);

    const up = { r: minR - 1, c: col };
    const down = { r: maxR + 1, c: col };

    const front = [];
    if (inBounds(up.r, up.c)) {
      const uk = keyOf(up.r, up.c);
      if (!alreadyShot(userBoard, uk)) front.push(uk);
    }
    if (inBounds(down.r, down.c)) {
      const dk = keyOf(down.r, down.c);
      if (!alreadyShot(userBoard, dk)) front.push(dk);
    }

    aiQueueAdjacentsFromHits(clusterHits);
    aiState.targetQueue = [...front, ...aiState.targetQueue.filter(k => !front.includes(k))];
  }
}

function aiChooseHuntTarget() {
  // Checkerboard first: (r+c)%2==0
  const parityCells = [];
  const otherCells = [];

  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const k = keyOf(r, c);
      if (alreadyShot(userBoard, k)) continue;
      ((r + c) % 2 === 0 ? parityCells : otherCells).push({ r, c });
    }
  }

  const pool = parityCells.length ? parityCells : otherCells;
  const pick = pool[randomInt(0, pool.length - 1)];
  return pick;
}

function aiChooseTargetModeCell() {
  // Pop until we find a valid unshot cell
  while (aiState.targetQueue.length) {
    const k = aiState.targetQueue.shift();
    if (!alreadyShot(userBoard, k)) return parseKey(k);
  }
  return null;
}

function aiDecideNextShot() {
  if (aiState.mode === "TARGET") {
    const t = aiChooseTargetModeCell();
    if (t) return t;
    // queue dried up -> go back to hunt
    aiState.mode = "HUNT";
    aiState.clusterHits = [];
  }
  return aiChooseHuntTarget();
}

function aiAfterHit(hitKey) {
  // Enter/continue target mode
  aiState.mode = "TARGET";
  aiState.clusterHits = recomputeClusterFromHit(hitKey);

  // Always add adjacents
  aiQueueAdjacentsFromHits(aiState.clusterHits);

  // If we can infer orientation, prioritize extending in that direction
  const ori = inferOrientation(aiState.clusterHits);
  if (ori) extendLineTargets(aiState.clusterHits, ori);
}

function aiAfterMiss() {
  // if no queued targets remain, drop back to hunt
  if (aiState.targetQueue.length === 0) {
    aiState.mode = "HUNT";
    aiState.clusterHits = [];
  }
}

/* ---------------- TURNS ---------------- */

function onUserFireAtAI(e) {
  if (gameOver) return;
  if (currentTurn !== "USER") return;

  const r = Number(e.currentTarget.dataset.r);
  const c = Number(e.currentTarget.dataset.c);

  const shot = applyShot(aiBoard, "AI", r, c);
  if (!shot.valid) return;

  if (shot.isHit) {
    userShots.hits++;
    setStatus("You hit a ship! Shoot again.");
    if (hasWon(aiBoard)) {
      endGame("User");
      saveGame();
      return;
    }
    currentTurn = "USER"; // keep turn
  } else {
    userShots.misses++;
    setStatus("You missed. AI is firing...");
    currentTurn = "AI";
    setTimeout(aiTakeTurnLoop, 550);
  }

  setTurnUI();
  setStatsUI();
  updateInteractivity();
  saveGame();
}

function aiTakeTurnLoop() {
  if (gameOver) return;
  if (currentTurn !== "AI") return;

  const { r, c } = aiDecideNextShot();
  const shot = applyShot(userBoard, "USER", r, c);
  if (!shot.valid) return; // should not happen

  if (shot.isHit) {
    aiShots.hits++;
    setStatus("AI hit your ship! AI shoots again.");

    aiAfterHit(shot.key);

    if (hasWon(userBoard)) {
      endGame("AI");
      saveGame();
      return;
    }

    // AI keeps turn
    currentTurn = "AI";
    setTurnUI();
    setStatsUI();
    updateInteractivity();
    saveGame();
    setTimeout(aiTakeTurnLoop, 550);
  } else {
    aiShots.misses++;
    setStatus("AI missed. Your turn — fire on the AI board.");

    aiAfterMiss();

    currentTurn = "USER";
    setTurnUI();
    setStatsUI();
    updateInteractivity();
    saveGame();
  }
}

function endGame(winner) {
  gameOver = true;
  setTurnUI();

  if (winner === "User") setStatus("You win! You sank all AI ships.");
  else setStatus("AI wins! It sank all your ships.");

  updateInteractivity();
}

/* ---------------- SAVE / LOAD ---------------- */

function setToArray(s) { return Array.from(s); }
function arrayToSet(a) { return new Set(a || []); }

function saveGame() {
  const payload = {
    version: 2,
    currentTurn,
    gameOver,
    userShots,
    aiShots,
    userBoard: {
      shipCells: setToArray(userBoard.shipCells),
      hitCells: setToArray(userBoard.hitCells),
      missCells: setToArray(userBoard.missCells),
    },
    aiBoard: {
      shipCells: setToArray(aiBoard.shipCells),
      hitCells: setToArray(aiBoard.hitCells),
      missCells: setToArray(aiBoard.missCells),
    },
    aiState: {
      mode: aiState.mode,
      targetQueue: aiState.targetQueue,
      clusterHits: aiState.clusterHits,
    },
    ui: {
      subtitle: subtitleTextEl.textContent,
      status: statusTextEl.textContent,
    },
  };

  localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
}

function loadGame() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return false;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }

  // Build UI first (so we can paint cells)
  buildBoardUI(userBoardEl, "USER");
  buildBoardUI(aiBoardEl, "AI");

  userBoard = createEmptyBoard();
  aiBoard = createEmptyBoard();

  userBoard.shipCells = arrayToSet(data?.userBoard?.shipCells);
  userBoard.hitCells = arrayToSet(data?.userBoard?.hitCells);
  userBoard.missCells = arrayToSet(data?.userBoard?.missCells);

  aiBoard.shipCells = arrayToSet(data?.aiBoard?.shipCells);
  aiBoard.hitCells = arrayToSet(data?.aiBoard?.hitCells);
  aiBoard.missCells = arrayToSet(data?.aiBoard?.missCells);

  currentTurn = data?.currentTurn === "AI" ? "AI" : "USER";
  gameOver = !!data?.gameOver;

  userShots = data?.userShots || { hits: 0, misses: 0 };
  aiShots = data?.aiShots || { hits: 0, misses: 0 };

  aiState = {
    mode: data?.aiState?.mode === "TARGET" ? "TARGET" : "HUNT",
    targetQueue: Array.isArray(data?.aiState?.targetQueue) ? data.aiState.targetQueue : [],
    clusterHits: Array.isArray(data?.aiState?.clusterHits) ? data.aiState.clusterHits : [],
  };

  subtitleTextEl.textContent = data?.ui?.subtitle || "You start first. Click on the AI board to fire.";
  setStatus(data?.ui?.status || "You start first. Fire on the AI board.");

  // Paint existing shots
  for (const k of userBoard.hitCells) {
    const { r, c } = parseKey(k);
    markCell("USER", r, c, true);
  }
  for (const k of userBoard.missCells) {
    const { r, c } = parseKey(k);
    markCell("USER", r, c, false);
  }

  for (const k of aiBoard.hitCells) {
    const { r, c } = parseKey(k);
    markCell("AI", r, c, true);
  }
  for (const k of aiBoard.missCells) {
    const { r, c } = parseKey(k);
    markCell("AI", r, c, false);
  }

  setTurnUI();
  setStatsUI();
  updateInteractivity();

  return true;
}

function clearSavedGame() {
  localStorage.removeItem(SAVE_KEY);
  // start fresh immediately
  resetGame();
}

/* ---------------- RESET ---------------- */

function resetGame() {
  userBoard = createEmptyBoard();
  aiBoard = createEmptyBoard();

  userShots = { hits: 0, misses: 0 };
  aiShots = { hits: 0, misses: 0 };

  aiState = { mode: "HUNT", targetQueue: [], clusterHits: [] };

  gameOver = false;
  currentTurn = "USER";

  buildBoardUI(userBoardEl, "USER");
  buildBoardUI(aiBoardEl, "AI");

  placeAllShipsRandomly(userBoard);
  placeAllShipsRandomly(aiBoard);

  subtitleTextEl.textContent = "You start first. Click on the AI board to fire.";
  setStatus("You start first. Fire on the AI board.");
  setTurnUI();
  setStatsUI();
  updateInteractivity();

  saveGame();
}

/* ---------------- INIT ---------------- */

resetBtn.addEventListener("click", resetGame);
clearSaveBtn.addEventListener("click", clearSavedGame);

// Auto-restore on reload, else new game
if (!loadGame()) {
  resetGame();
}