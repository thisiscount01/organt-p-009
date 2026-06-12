'use strict';

/**
 * Magic Defense Game Server
 * ─────────────────────────
 * 아키텍처 원칙:
 *   - 게임 규칙·데미지 계산은 서버에서만 (server-authoritative)
 *   - ML 추론은 별도 마이크로서비스(POST /api/spell-recognized 로 수신)
 *   - 밸런스 수치는 config/game-config.json 에 외부화 → 재배포 없이 반영
 *   - 게임 루프 목표: 20 TPS (50ms 틱)
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────
// Config 로딩 (외부화 — 재배포 없이 /api/reload-config 로 반영)
// ─────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config', 'game-config.json');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

let CFG = loadConfig();

// ─────────────────────────────────────────────────────────────
// Express + Socket.io 초기화
// ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────
const TICK_RATE = 20;               // TPS
const TICK_MS   = 1000 / TICK_RATE; // 50 ms

// ─────────────────────────────────────────────────────────────
// 경로(Path) 시스템
// ─────────────────────────────────────────────────────────────
function computePathLength(waypoints) {
  let total = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

function positionOnPath(waypoints, progress) {
  if (waypoints.length < 2) return { ...waypoints[0] };
  const segments = waypoints.length - 1;
  const sp = clamp(progress, 0, 1) * segments;
  const si = Math.min(Math.floor(sp), segments - 1);
  const t  = sp - si;
  const a  = waypoints[si], b = waypoints[si + 1];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// ─────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────
let _enemySeq = 0, _spellSeq = 0;

function nextEnemyId() { return `e_${_enemySeq++}`; }
function nextSpellId() { return `s_${_spellSeq++}`; }

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

function assertNonNegative(value, label) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative number (got ${value})`);
  }
}

function dist2D(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ─────────────────────────────────────────────────────────────
// 게임 상태
// ─────────────────────────────────────────────────────────────
function createGameState() {
  return {
    phase:             'waiting',   // waiting | intermission | wave | gameover
    waveNumber:        0,
    enemies:           new Map(),   // id → enemy
    spells:            new Map(),   // id → spell
    players:           new Map(),   // socketId → player
    spawnQueue:        [],
    spawnTick:         0,
    intermissionTimer: 0,
    tickCount:         0,
  };
}

let STATE = createGameState();

// ─────────────────────────────────────────────────────────────
// 플레이어 생성·성장
// ─────────────────────────────────────────────────────────────
function createPlayer(socketId) {
  const bs = CFG.player.baseStats;
  return {
    id:           socketId,
    health:       bs.health,
    maxHealth:    bs.health,
    mana:         bs.mana,
    maxMana:      bs.mana,
    manaRegen:    bs.manaRegen,
    gold:         bs.startingGold,
    xp:           0,
    xpToNext:     CFG.player.levelCurve.baseXp,
    level:        1,
    skillPoints:  0,
    towers:       CFG.towers.slots.map((slot) => ({
      slotId:      slot.id,
      position:    { ...slot.position },
      attribute:   null,
      level:       1,
      range:       CFG.towers.baseStats.range,
      attackSpeed: CFG.towers.baseStats.attackSpeed,
      lastAttackTick: -999,
    })),
  };
}

function applyLevelUp(player) {
  const lc = CFG.player.levelCurve;
  player.level      += 1;
  player.skillPoints += lc.skillPointsPerLevel;
  player.maxMana     = Math.floor(player.maxMana * (1 + lc.manaGrowth.maxManaMultiplier));
  player.manaRegen   = player.manaRegen * (1 + lc.manaGrowth.regenMultiplier);
  player.mana        = player.maxMana; // 레벨업 시 마나 풀 회복
  player.xpToNext    = Math.floor(
    lc.baseXp * Math.pow(lc.xpScaling, player.level - 1)
  );
  player.xp = 0;
}

function addRewards(player, goldAmt, xpAmt) {
  assertNonNegative(goldAmt, 'goldAmt');
  assertNonNegative(xpAmt,   'xpAmt');
  player.gold += goldAmt;
  player.xp   += xpAmt;
  const leveled = [];
  while (player.xp >= player.xpToNext) {
    player.xp -= player.xpToNext;
    applyLevelUp(player);
    leveled.push(player.level);
  }
  return leveled;
}

// ─────────────────────────────────────────────────────────────
// 데미지 계산 (속성 상성)
// ─────────────────────────────────────────────────────────────
function calcDamage(spellAttr, enemyAttr, baseDmg) {
  assertNonNegative(baseDmg, 'baseDmg');
  let mul = CFG.combat.neutralMultiplier;
  if (spellAttr && enemyAttr) {
    const row = CFG.combat.affinityTable[spellAttr];
    if (row && row[enemyAttr] !== undefined) mul = row[enemyAttr];
  }
  return Math.max(1, Math.floor(baseDmg * mul));
}

// ─────────────────────────────────────────────────────────────
// 마법 시스템
// ─────────────────────────────────────────────────────────────
function spellAttribute(shape) {
  return CFG.spells.shapeToAttribute[shape] || null;
}

function spellManaCost(attr) {
  return CFG.spells.manaCost[attr] || CFG.spells.defaultManaCost;
}

function spellBaseDamage(attr) {
  return CFG.spells.attributeDamage[attr] || CFG.spells.defaultDamage;
}

function towerDamage(tower, attr) {
  const base = spellBaseDamage(attr || tower.attribute);
  return Math.floor(base * (1 + (tower.level - 1) * CFG.towers.levelDamageBonus));
}

function findNearestInRange(enemies, pos, range) {
  let best = null, bestDist = Infinity;
  for (const e of enemies.values()) {
    const d = dist2D(e.position, pos);
    if (d <= range && d < bestDist) { best = e; bestDist = d; }
  }
  return best;
}

/**
 * 마법 생성 (플레이어 주도 시전 — shape 기반)
 * 반환: { ok, spell } | { ok: false, code, ... }
 */
function castSpell(player, slotId, shape) {
  const validShapes = Object.keys(CFG.spells.shapeToAttribute);
  if (!validShapes.includes(shape)) {
    return { ok: false, code: 'INVALID_SHAPE' };
  }
  if (slotId < 0 || slotId >= player.towers.length) {
    return { ok: false, code: 'INVALID_SLOT' };
  }

  const attr     = spellAttribute(shape);
  const manaCost = spellManaCost(attr);

  if (player.mana < manaCost) {
    return { ok: false, code: 'INSUFFICIENT_MANA', current: Math.floor(player.mana), required: manaCost };
  }

  const tower     = player.towers[slotId];
  const effectAttr = tower.attribute || attr;
  const dmg        = towerDamage(tower, effectAttr);

  const target = findNearestInRange(STATE.enemies, tower.position, tower.range);
  if (!target) {
    // 사정거리 내 적 없음 — 마나 50% 환불
    player.mana = Math.min(player.maxMana, player.mana + manaCost * 0.5);
    return { ok: false, code: 'NO_TARGET' };
  }

  player.mana = Math.max(0, player.mana - manaCost);

  const spell = {
    id:         nextSpellId(),
    playerId:   player.id,
    sourceSlot: slotId,
    attribute:  effectAttr,
    damage:     dmg,
    position:   { ...tower.position },
    targetId:   target.id,
    speed:      CFG.spells.projectileSpeed,
    shape,
  };
  STATE.spells.set(spell.id, spell);
  return { ok: true, spell };
}

// ─────────────────────────────────────────────────────────────
// 웨이브 시스템
// ─────────────────────────────────────────────────────────────
function buildWaveQueue(waveNum) {
  const wc = CFG.wave;
  const count     = wc.baseCount + Math.floor(waveNum * wc.countGrowth);
  const baseHp    = wc.baseHealth + waveNum * wc.healthGrowthPerWave;
  const baseSpeed = wc.baseSpeed  + waveNum * wc.speedGrowthPerWave;
  const baseGold  = wc.baseGold   + waveNum * wc.goldGrowthPerWave;
  const baseXp    = wc.baseXp     + waveNum * wc.xpGrowthPerWave;

  const queue = [];
  for (let i = 0; i < count; i++) {
    let attribute = null;
    if (waveNum >= wc.attributeEnemyStartWave) {
      const chance = Math.min(
        wc.attributeEnemyBaseChance + (waveNum - wc.attributeEnemyStartWave) * wc.attributeEnemyChanceGrowth,
        wc.attributeEnemyMaxChance
      );
      // 결정론적 시드 대신 단순 분포 (서버 권위)
      if ((i * 7 + waveNum * 13) % 100 < chance * 100) {
        const attrList = CFG.attributes.list;
        attribute = attrList[(i + waveNum) % attrList.length];
      }
    }

    const isBoss  = (i === count - 1 && waveNum % 5 === 0);
    const hpMul   = isBoss ? wc.bossHealthMultiplier  : 1;
    const spMul   = isBoss ? wc.bossSpeedMultiplier   : 1;
    const rewardMul = isBoss ? 5 : 1;

    queue.push({
      type:       isBoss ? 'boss' : (attribute ? 'attribute' : 'normal'),
      attribute,
      health:     Math.floor(baseHp    * hpMul),
      maxHealth:  Math.floor(baseHp    * hpMul),
      speed:      baseSpeed * spMul,
      gold:       Math.floor(baseGold  * rewardMul),
      xp:         Math.floor(baseXp    * rewardMul),
      spawnDelay: i * wc.spawnInterval,
    });
  }
  return queue;
}

function startWave() {
  STATE.waveNumber++;
  STATE.phase     = 'wave';
  STATE.spawnTick = 0;
  STATE.spawnQueue = buildWaveQueue(STATE.waveNumber);

  io.emit('waveStart', {
    waveNumber:  STATE.waveNumber,
    enemyCount:  STATE.spawnQueue.length,
    preview: STATE.spawnQueue.map(e => ({
      type: e.type, attribute: e.attribute, health: e.health, speed: e.speed,
    })),
  });
  console.log(`[WAVE] Wave ${STATE.waveNumber} 시작 — 적 ${STATE.spawnQueue.length}마리`);
}

function endWave() {
  const wc      = CFG.wave;
  const waveNum = STATE.waveNumber;
  const bonus   = wc.clearBonus.gold + waveNum * wc.clearBonus.goldPerWave;

  STATE.phase             = 'intermission';
  STATE.intermissionTimer = wc.intermissionTicks;

  for (const p of STATE.players.values()) {
    p.gold = p.gold + bonus;
    p.mana = p.maxMana; // 웨이브 사이 마나 전량 회복
  }

  io.emit('waveClear', {
    waveNumber:  waveNum,
    bonusGold:   bonus,
    nextWaveIn:  wc.intermissionTicks / TICK_RATE,
  });
  console.log(`[WAVE] Wave ${waveNum} 클리어`);
}

function spawnEnemy(def) {
  const waypoints = CFG.map.path;
  const enemy = {
    id:        nextEnemyId(),
    type:      def.type,
    attribute: def.attribute,
    health:    def.health,
    maxHealth: def.maxHealth,
    speed:     def.speed,
    gold:      def.gold,
    xp:        def.xp,
    progress:  0,
    position:  { ...waypoints[0] },
  };
  STATE.enemies.set(enemy.id, enemy);
  io.emit('enemySpawned', {
    id: enemy.id, type: enemy.type, attribute: enemy.attribute,
    health: enemy.health, maxHealth: enemy.maxHealth,
    speed: enemy.speed, position: enemy.position,
  });
  return enemy;
}

function killEnemy(enemy, killerId) {
  STATE.enemies.delete(enemy.id);

  const leveled = [];
  if (killerId) {
    const p = STATE.players.get(killerId);
    if (p) {
      const lv = addRewards(p, enemy.gold, enemy.xp);
      leveled.push(...lv);
      if (lv.length) io.emit('playerLevelUp', { playerId: p.id, level: p.level, maxMana: p.maxMana, skillPoints: p.skillPoints });
    }
  } else {
    // 킬러 불명 — 전 플레이어 분배
    for (const p of STATE.players.values()) {
      const lv = addRewards(p, enemy.gold, enemy.xp);
      if (lv.length) io.emit('playerLevelUp', { playerId: p.id, level: p.level, maxMana: p.maxMana, skillPoints: p.skillPoints });
    }
  }

  io.emit('enemyKilled', { enemyId: enemy.id, killerId, gold: enemy.gold, xp: enemy.xp });
}

function damageAllPlayers(amount) {
  assertNonNegative(amount, 'reach-end damage');
  for (const p of STATE.players.values()) {
    p.health = Math.max(0, p.health - amount);
  }
  const dead = [...STATE.players.values()].some(p => p.health <= 0);
  if (dead) {
    STATE.phase = 'gameover';
    io.emit('gameOver', { waveNumber: STATE.waveNumber });
  }
}

// ─────────────────────────────────────────────────────────────
// 게임 루프 (20 TPS — 목표: 틱당 ≤50ms)
// ─────────────────────────────────────────────────────────────
function gameTick() {
  const t0 = Date.now();

  // ① 마나 자연회복 (전 플레이어)
  for (const p of STATE.players.values()) {
    p.mana = Math.min(p.maxMana, p.mana + p.manaRegen / TICK_RATE);
  }

  // ② 페이즈별 처리
  if (STATE.phase === 'wave') {
    tickWave();
  } else if (STATE.phase === 'intermission') {
    STATE.intermissionTimer--;
    if (STATE.intermissionTimer <= 0) startWave();
  }

  STATE.tickCount++;

  // ③ 상태 브로드캐스트 (스냅샷)
  io.emit('tick', buildSnapshot());

  // ④ 성능 경고
  const elapsed = Date.now() - t0;
  if (elapsed > 50) {
    console.warn(`[PERF] 틱 ${STATE.tickCount} 처리 ${elapsed}ms (목표 50ms 초과)`);
  }
}

function tickWave() {
  const waypoints = CFG.map.path;
  const pathLen   = computePathLength(waypoints);

  // ── 적 스폰 ──
  STATE.spawnTick++;
  while (STATE.spawnQueue.length && STATE.spawnQueue[0].spawnDelay <= STATE.spawnTick) {
    spawnEnemy(STATE.spawnQueue.shift());
  }

  // ── 적 이동 ──
  const reachedEnd = [];
  for (const [id, enemy] of STATE.enemies) {
    const delta = (enemy.speed / pathLen) / TICK_RATE;
    enemy.progress = clamp(enemy.progress + delta, 0, 1);
    enemy.position = positionOnPath(waypoints, enemy.progress);
    if (enemy.progress >= 1) reachedEnd.push(id);
  }
  for (const id of reachedEnd) {
    const enemy = STATE.enemies.get(id);
    if (!enemy) continue;
    STATE.enemies.delete(id);
    io.emit('enemyReachedEnd', { enemyId: id });
    damageAllPlayers(CFG.combat.enemyReachEndDamage);
    if (STATE.phase === 'gameover') return;
  }

  // ── 투사체 이동 · 충돌 ──
  const removeSpells = [];
  for (const [id, spell] of STATE.spells) {
    const target = STATE.enemies.get(spell.targetId);
    if (!target) { removeSpells.push(id); continue; }

    const d  = dist2D(spell.position, target.position);
    const mv = spell.speed / TICK_RATE;

    if (d <= mv * 1.5) {
      // 충돌 — 데미지 적용
      const dmg = calcDamage(spell.attribute, target.attribute, spell.damage);
      target.health -= dmg;
      io.emit('spellHit', {
        spellId: id, enemyId: target.id,
        damage: dmg, attribute: spell.attribute,
        isCritical: dmg > spell.damage,
        enemyHp: Math.max(0, target.health),
        enemyMaxHp: target.maxHealth,
        position: { ...target.position },
      });
      if (target.health <= 0) killEnemy(target, spell.playerId);
      removeSpells.push(id);
    } else {
      // 이동
      const dx = target.position.x - spell.position.x;
      const dy = target.position.y - spell.position.y;
      spell.position.x += (dx / d) * mv;
      spell.position.y += (dy / d) * mv;
    }
  }
  for (const id of removeSpells) STATE.spells.delete(id);

  // ── 타워 자동 공격 ──
  for (const player of STATE.players.values()) {
    for (const tower of player.towers) {
      if (!tower.attribute) continue;
      const interval = Math.floor(TICK_RATE / tower.attackSpeed);
      if (STATE.tickCount - tower.lastAttackTick < interval) continue;

      const manaCost = spellManaCost(tower.attribute);
      if (player.mana < manaCost) continue;

      const target = findNearestInRange(STATE.enemies, tower.position, tower.range);
      if (!target) continue;

      tower.lastAttackTick = STATE.tickCount;
      player.mana = Math.max(0, player.mana - manaCost);

      const dmg    = towerDamage(tower, tower.attribute);
      const actual = calcDamage(tower.attribute, target.attribute, dmg);
      target.health -= actual;

      io.emit('towerAttack', {
        playerId: player.id, slotId: tower.slotId,
        enemyId: target.id, damage: actual,
        attribute: tower.attribute, position: { ...tower.position },
      });

      if (target.health <= 0) killEnemy(target, player.id);
    }
  }

  // ── 웨이브 클리어 판정 ──
  if (STATE.spawnQueue.length === 0 && STATE.enemies.size === 0) {
    endWave();
  }
}

// ─────────────────────────────────────────────────────────────
// 스냅샷 (클라이언트 전송용 — 불변 직렬화)
// ─────────────────────────────────────────────────────────────
function buildSnapshot() {
  const players = {};
  for (const [id, p] of STATE.players) {
    players[id] = {
      id:          p.id,
      health:      Math.round(p.health),
      maxHealth:   p.maxHealth,
      mana:        Math.round(p.mana * 10) / 10,
      maxMana:     p.maxMana,
      manaRegen:   Math.round(p.manaRegen * 100) / 100,
      gold:        p.gold,
      xp:          p.xp,
      xpToNext:    p.xpToNext,
      level:       p.level,
      skillPoints: p.skillPoints,
      towers:      p.towers.map(t => ({
        slotId:    t.slotId,
        position:  t.position,
        attribute: t.attribute,
        level:     t.level,
        range:     t.range,
        damage:    t.attribute ? towerDamage(t, t.attribute) : CFG.towers.baseStats.damage,
        attackSpeed: t.attackSpeed,
      })),
    };
  }

  const enemies = [];
  for (const e of STATE.enemies.values()) {
    enemies.push({
      id: e.id, type: e.type, attribute: e.attribute,
      health: e.health, maxHealth: e.maxHealth,
      position: e.position, progress: e.progress,
    });
  }

  const spells = [];
  for (const s of STATE.spells.values()) {
    spells.push({ id: s.id, attribute: s.attribute, position: s.position, targetId: s.targetId });
  }

  return {
    phase:             STATE.phase,
    waveNumber:        STATE.waveNumber,
    tickCount:         STATE.tickCount,
    intermissionTimer: STATE.intermissionTimer,
    intermissionSec:   Math.ceil(STATE.intermissionTimer / TICK_RATE),
    players, enemies, spells,
  };
}

// ─────────────────────────────────────────────────────────────
// Socket.io 이벤트
// ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[SOCKET] 접속: ${socket.id}`);

  // 플레이어 생성 (또는 재접속)
  let player = STATE.players.get(socket.id);
  if (!player) {
    player = createPlayer(socket.id);
    STATE.players.set(socket.id, player);
  }

  // 초기 데이터 전송
  socket.emit('connected', {
    playerId: socket.id,
    player: {
      health: player.health, maxHealth: player.maxHealth,
      mana: player.mana, maxMana: player.maxMana,
      gold: player.gold, level: player.level,
      towers: player.towers,
    },
    config: {
      map:        CFG.map,
      attributes: CFG.attributes,
      spells:     CFG.spells,
      towers:     CFG.towers,
    },
    gameState: buildSnapshot(),
  });

  // 첫 플레이어가 접속하면 대기 → 인터미션
  if (STATE.players.size === 1 && STATE.phase === 'waiting') {
    STATE.phase             = 'intermission';
    STATE.intermissionTimer = CFG.wave.firstWaveDelay;
    io.emit('gameReady', { firstWaveIn: CFG.wave.firstWaveDelay / TICK_RATE });
  }

  // ── castSpell: 플레이어가 마법진에 도형 그렸을 때 ──
  socket.on('castSpell', (data) => {
    try {
      if (STATE.phase !== 'wave') {
        return socket.emit('spellResult', { ok: false, code: 'NOT_IN_WAVE' });
      }
      const { shape, slotId } = data || {};
      if (typeof shape !== 'string' || slotId == null) {
        return socket.emit('spellResult', { ok: false, code: 'MISSING_PARAMS' });
      }
      const p = STATE.players.get(socket.id);
      if (!p) return socket.emit('spellResult', { ok: false, code: 'PLAYER_NOT_FOUND' });

      const result = castSpell(p, Number(slotId), shape);
      socket.emit('spellResult', result);

      if (result.ok) {
        io.emit('spellCreated', {
          id:         result.spell.id,
          attribute:  result.spell.attribute,
          sourceSlot: result.spell.sourceSlot,
          position:   result.spell.position,
          targetId:   result.spell.targetId,
          shape,
        });
      }
    } catch (e) {
      console.error('[castSpell]', e);
      socket.emit('spellResult', { ok: false, code: 'SERVER_ERROR' });
    }
  });

  // ── assignTowerAttribute: 타워 슬롯에 속성 배정 ──
  socket.on('assignTowerAttribute', (data) => {
    try {
      const { slotId, attribute } = data || {};
      const validAttrs = CFG.attributes.list;

      if (attribute !== null && !validAttrs.includes(attribute)) {
        return socket.emit('assignResult', { ok: false, code: 'INVALID_ATTRIBUTE' });
      }
      const p = STATE.players.get(socket.id);
      if (!p) return;

      if (slotId < 0 || slotId >= p.towers.length) {
        return socket.emit('assignResult', { ok: false, code: 'INVALID_SLOT' });
      }

      const cost = CFG.towers.assignCost;
      if (p.gold < cost) {
        return socket.emit('assignResult', { ok: false, code: 'INSUFFICIENT_GOLD', current: p.gold, required: cost });
      }

      p.gold -= cost;
      p.towers[slotId].attribute = attribute;

      socket.emit('assignResult', { ok: true, slotId, attribute, gold: p.gold });
      io.emit('towerUpdated', { playerId: p.id, slotId, attribute, level: p.towers[slotId].level });
    } catch (e) {
      console.error('[assignTowerAttribute]', e);
      socket.emit('assignResult', { ok: false, code: 'SERVER_ERROR' });
    }
  });

  // ── upgradeTower: 타워 업그레이드 ──
  socket.on('upgradeTower', (data) => {
    try {
      const { slotId } = data || {};
      const p = STATE.players.get(socket.id);
      if (!p) return;

      const tower = p.towers[slotId];
      if (!tower) return socket.emit('upgradeResult', { ok: false, code: 'INVALID_SLOT' });
      if (tower.level >= CFG.towers.maxLevel) return socket.emit('upgradeResult', { ok: false, code: 'MAX_LEVEL' });
      if (p.skillPoints < 1) return socket.emit('upgradeResult', { ok: false, code: 'NO_SKILL_POINTS' });

      const cost = CFG.towers.upgradeCostBase * tower.level;
      if (p.gold < cost) return socket.emit('upgradeResult', { ok: false, code: 'INSUFFICIENT_GOLD', current: p.gold, required: cost });

      p.gold       -= cost;
      p.skillPoints -= 1;
      tower.level  += 1;
      tower.range        = Math.floor(CFG.towers.baseStats.range        * (1 + (tower.level - 1) * CFG.towers.levelRangeBonus));
      tower.attackSpeed  = CFG.towers.baseStats.attackSpeed * (1 + (tower.level - 1) * CFG.towers.levelSpeedBonus);

      socket.emit('upgradeResult', {
        ok: true, slotId, level: tower.level,
        range: tower.range, attackSpeed: tower.attackSpeed,
        gold: p.gold, skillPoints: p.skillPoints,
      });
      io.emit('towerUpdated', { playerId: p.id, slotId, attribute: tower.attribute, level: tower.level });
    } catch (e) {
      console.error('[upgradeTower]', e);
      socket.emit('upgradeResult', { ok: false, code: 'SERVER_ERROR' });
    }
  });

  // ── requestNextWave: 인터미션 스킵 ──
  socket.on('requestNextWave', () => {
    if (STATE.phase !== 'intermission') {
      return socket.emit('error', { code: 'NOT_INTERMISSION' });
    }
    STATE.intermissionTimer = 1;
    socket.emit('nextWaveAck', { waveNumber: STATE.waveNumber + 1 });
  });

  // ── disconnect ──
  socket.on('disconnect', (reason) => {
    console.log(`[SOCKET] 접속 해제: ${socket.id} (${reason})`);
    const p = STATE.players.get(socket.id);
    if (p) {
      p._disconnectedAt = Date.now();
      // 30초 유예: 재접속 시 상태 복원
      setTimeout(() => {
        if (STATE.players.has(socket.id)) {
          STATE.players.delete(socket.id);
          console.log(`[SOCKET] ${socket.id} 유예 만료, 상태 삭제`);
        }
      }, 30000);
    }
    if (STATE.players.size === 0) {
      // 모든 플레이어 이탈 → 게임 리셋
      console.log('[GAME] 전원 이탈 — 게임 상태 초기화');
      STATE = createGameState();
      _enemySeq = 0;
      _spellSeq = 0;
    }
  });
});

// ─────────────────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────────────────

/** GET /api/health — 헬스체크 & 틱 지연 측정 */
app.get('/api/health', (_req, res) => {
  res.json({
    status:    'ok',
    uptime:    Math.floor(process.uptime()),
    tickCount: STATE.tickCount,
    phase:     STATE.phase,
    waveNumber: STATE.waveNumber,
    players:   STATE.players.size,
    enemies:   STATE.enemies.size,
    tickRateTarget: TICK_RATE,
    tickMsTarget:   TICK_MS,
  });
});

/** GET /api/state — 현재 게임 스냅샷 */
app.get('/api/state', (_req, res) => {
  res.json(buildSnapshot());
});

/** GET /api/config — 게임 설정 반환 */
app.get('/api/config', (_req, res) => {
  res.json(CFG);
});

/**
 * POST /api/reload-config
 * 게임 서버 재시작 없이 config/game-config.json 를 다시 로드합니다.
 * 기획자가 밸런스 수치를 변경하면 이 엔드포인트 호출로 즉시 반영됩니다.
 */
app.post('/api/reload-config', (_req, res) => {
  try {
    CFG = loadConfig();
    console.log('[CONFIG] 게임 설정 재로드 완료');
    res.json({ ok: true, message: 'config reloaded' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/spell-recognized
 * ML 추론 서비스가 도형 인식 결과를 전달하는 엔드포인트.
 * Body: { playerId, shape, confidence, slotId }
 *
 * ML 서비스 경계 원칙:
 *   - ML 서비스는 "shape"(인식 결과)만 전달
 *   - 서버는 속성 매핑·데미지·밸런스 계산을 독자적으로 수행
 *   - ML 모델을 교체해도 게임 규칙은 영향 없음
 */
app.post('/api/spell-recognized', (req, res) => {
  const t0 = Date.now();
  const { playerId, shape, confidence, slotId } = req.body || {};

  if (!playerId || !shape || confidence == null || slotId == null) {
    return res.status(400).json({ ok: false, error: 'playerId, shape, confidence, slotId required' });
  }
  if (typeof confidence !== 'number' || confidence < CFG.ml.minConfidence) {
    return res.json({ ok: false, code: 'LOW_CONFIDENCE', confidence, threshold: CFG.ml.minConfidence });
  }

  const p = STATE.players.get(playerId);
  if (!p) return res.status(404).json({ ok: false, error: 'player not found' });
  if (STATE.phase !== 'wave') return res.json({ ok: false, code: 'NOT_IN_WAVE' });

  const result = castSpell(p, Number(slotId), shape);

  const inferenceMs = Date.now() - t0;
  if (inferenceMs > 100) {
    console.warn(`[PERF] /api/spell-recognized 처리 ${inferenceMs}ms (목표 100ms 초과)`);
  }

  if (result.ok) {
    const sock = io.sockets.sockets.get(playerId);
    if (sock) {
      sock.emit('spellResult', { ...result, shape, confidence });
    }
    io.emit('spellCreated', {
      id:         result.spell.id,
      attribute:  result.spell.attribute,
      sourceSlot: result.spell.sourceSlot,
      position:   result.spell.position,
      targetId:   result.spell.targetId,
      shape,
      confidence,
    });
  }

  res.json({
    ok:            result.ok,
    code:          result.ok ? 'OK' : result.code,
    spellId:       result.ok ? result.spell.id : null,
    attribute:     result.ok ? result.spell.attribute : null,
    manaRemaining: Math.round(p.mana),
    inferenceMs,
  });
});

// ─────────────────────────────────────────────────────────────
// 서버 시작
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║     Magic Defense Game Server  v1.0      ║
╠══════════════════════════════════════════╣
║  Port        : ${String(PORT).padEnd(26)}║
║  Tick        : ${(TICK_MS + 'ms / ' + TICK_RATE + ' TPS').padEnd(26)}║
║  Config      : config/game-config.json   ║
║  Static      : public/                   ║
╚══════════════════════════════════════════╝
`);
  // 게임 루프 시작
  setInterval(gameTick, TICK_MS);
});

server.on('error', (err) => {
  console.error('[SERVER] 치명적 오류:', err);
  process.exit(1);
});

module.exports = { app, server, io, STATE, CFG }; // 테스트용 export
