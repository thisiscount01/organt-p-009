/**
 * test/server.test.js — 서버 게임 로직 유닛 테스트
 * 실행: node test/server.test.js
 *
 * 테스트 대상:
 *   1. Config 구조 검증
 *   2. 데미지 계산 (속성 상성)
 *   3. 비정상 값 거부 (assertNonNegative)
 *   4. 경로 계산 (positionOnPath)
 *   5. 웨이브 빌드 시뮬레이션
 *   6. 맵 경로 길이 검증
 *   7. 도형→속성 매핑 & 마나 비용
 *   8. 엣지 케이스 (자원 0, 경계값, 극단 입력)
 */
'use strict';

const fs   = require('fs');
const path = require('path');

/* ─────────────────────────────────────────────────────── */
/* Test runner                                             */
/* ─────────────────────────────────────────────────────── */
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

function assertThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  assert(threw, msg);
}

function assertDoesNotThrow(fn, msg) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; console.error('    Unexpected error:', e.message); }
  assert(!threw, msg);
}

/* ─────────────────────────────────────────────────────── */
/* Config 로드                                             */
/* ─────────────────────────────────────────────────────── */
const CFG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'game-config.json'), 'utf8')
);

/* ─────────────────────────────────────────────────────── */
/* 서버 로직 인라인 (server.js와 동일, 독립 테스트용)      */
/* ─────────────────────────────────────────────────────── */
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

function assertNonNegative(value, label) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative number (got ${value})`);
  }
}

function calcDamage(spellAttr, enemyAttr, baseDmg) {
  assertNonNegative(baseDmg, 'baseDmg');
  let mul = CFG.combat.neutralMultiplier;
  if (spellAttr && enemyAttr) {
    const row = CFG.combat.affinityTable[spellAttr];
    if (row && row[enemyAttr] !== undefined) mul = row[enemyAttr];
  }
  return Math.max(1, Math.floor(baseDmg * mul));
}

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
      if ((i * 7 + waveNum * 13) % 100 < chance * 100) {
        const attrList = CFG.attributes.list;
        attribute = attrList[(i + waveNum) % attrList.length];
      }
    }

    const isBoss    = (i === count - 1 && waveNum % 5 === 0);
    const hpMul     = isBoss ? wc.bossHealthMultiplier : 1;
    const spMul     = isBoss ? wc.bossSpeedMultiplier  : 1;
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

function applyLevelUp(player) {
  const lc = CFG.player.levelCurve;
  player.level      += 1;
  player.skillPoints += lc.skillPointsPerLevel;
  player.maxMana     = Math.floor(player.maxMana * (1 + lc.manaGrowth.maxManaMultiplier));
  player.manaRegen   = player.manaRegen * (1 + lc.manaGrowth.regenMultiplier);
  player.mana        = player.maxMana;
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

/* ═════════════════════════════════════════════════════════ */
/* Suite 1: Config 구조 검증                                */
/* ═════════════════════════════════════════════════════════ */
console.log('\n[1] Config 구조 검증');

assert(Array.isArray(CFG.attributes.list),              'attributes.list is array');
assert(CFG.attributes.list.length >= 5,                 'attributes.list has ≥5 attributes');
assert(CFG.attributes.list.includes('fire'),            'fire attribute present');
assert(CFG.attributes.list.includes('water'),           'water attribute present');
assert(CFG.attributes.list.includes('earth'),           'earth attribute present');
assert(CFG.attributes.list.includes('wind'),            'wind attribute present');
assert(CFG.attributes.list.includes('lightning'),       'lightning attribute present');
assert(typeof CFG.combat.affinityTable === 'object',    'affinityTable exists');
assert(CFG.towers.slots.length >= 5,                    'towers.slots has ≥5 slots');
assert(CFG.map.path.length >= 2,                        'map.path has ≥2 waypoints');
assert(typeof CFG.ml.minConfidence === 'number',        'ml.minConfidence is number');
assert(CFG.ml.minConfidence >= 0 && CFG.ml.minConfidence <= 1, 'ml.minConfidence in [0,1]');
assert(CFG.wave.intermissionTicks > 0,                  'intermissionTicks > 0');
assert(CFG.wave.spawnInterval > 0,                      'spawnInterval > 0');
assert(CFG.player.baseStats.health > 0,                 'base health > 0');
assert(CFG.player.baseStats.mana > 0,                   'base mana > 0');

/* ═════════════════════════════════════════════════════════ */
/* Suite 2: 데미지 계산 (속성 상성)                         */
/* ═════════════════════════════════════════════════════════ */
console.log('\n[2] 데미지 계산 (속성 상성)');

const B = 100;
assert(calcDamage('fire',      'earth',     B) === 200, `fire→earth = 200 (2×)`);
assert(calcDamage('water',     'fire',      B) === 200, `water→fire = 200 (2×)`);
assert(calcDamage('wind',      'water',     B) === 200, `wind→water = 200 (2×)`);
assert(calcDamage('lightning', 'wind',      B) === 200, `lightning→wind = 200 (2×)`);
assert(calcDamage('earth',     'lightning', B) === 200, `earth→lightning = 200 (2×)`);
assert(calcDamage('fire',      'water',     B) === 50,  `fire→water = 50 (0.5×)`);
assert(calcDamage('water',     'wind',      B) === 50,  `water→wind = 50 (0.5×)`);
assert(calcDamage('fire',      'fire',      B) === 100, `fire→fire = 100 (neutral)`);
assert(calcDamage(null,        'fire',      B) === 100, `null attacker attr = neutral`);
assert(calcDamage('fire',      null,        B) === 100, `null target attr = neutral`);
assert(calcDamage(null,        null,        B) === 100, `both null = neutral`);
// 최소 데미지 보장
assert(calcDamage('fire', 'water', 1) >= 1, 'min damage ≥ 1 (불리한 상성에서도)');
assert(calcDamage('fire', 'water', 0) >= 1, 'baseDmg=0 → min damage ≥ 1');

/* ═════════════════════════════════════════════════════════ */
/* Suite 3: 비정상 값 거부 (assertNonNegative)              */
/* ═════════════════════════════════════════════════════════ */
console.log('\n[3] 비정상 값 거부 (영속성 검증)');

assertThrows(() => assertNonNegative(-1, 'test'),         'negative value throws');
assertThrows(() => assertNonNegative(-0.001, 'test'),     'tiny negative throws');
assertThrows(() => assertNonNegative(NaN, 'test'),        'NaN throws');
assertThrows(() => assertNonNegative(Infinity, 'test'),   'Infinity throws');
assertThrows(() => assertNonNegative(-Infinity, 'test'),  '-Infinity throws');
assertThrows(() => assertNonNegative('5', 'test'),        'string throws');
assertThrows(() => assertNonNegative(null, 'test'),       'null throws');
assertThrows(() => calcDamage('fire', 'water', -1),       'negative baseDmg throws');

assertDoesNotThrow(() => assertNonNegative(0, 'test'),    'zero is valid');
assertDoesNotThrow(() => assertNonNegative(0.001, 'test'),'small positive is valid');
assertDoesNotThrow(() => assertNonNegative(1000, 'test'), 'large positive is valid');

/* ═════════════════════════════════════════════════════════ */
/* Suite 4: 경로 계산 (positionOnPath)                      */
/* ═════════════════════════════════════════════════════════ */
console.log('\n[4] 경로 계산 (positionOnPath)');

const testPath = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];

const p0   = positionOnPath(testPath, 0);
const p1   = positionOnPath(testPath, 1);
const p05  = positionOnPath(testPath, 0.5);
const pNeg = positionOnPath(testPath, -1);
const pOvr = positionOnPath(testPath, 2);

assert(Math.abs(p0.x)        < 0.01 && Math.abs(p0.y)        < 0.01,  'progress=0 → (0,0)');
assert(Math.abs(p1.x - 100)  < 0.01 && Math.abs(p1.y - 100)  < 0.01,  'progress=1 → (100,100)');
assert(Math.abs(p05.x - 100) < 0.01 && Math.abs(p05.y)       < 0.01,  'progress=0.5 → (100,0)');
assert(Math.abs(pNeg.x)      < 0.01 && Math.abs(pNeg.y)      < 0.01,  'progress<0 clamped to start');
assert(Math.abs(pOvr.x - 100)< 0.01 && Math.abs(pOvr.y - 100)< 0.01,  'progress>1 clamped to end');

// 실제 맵 경로 테스트
const mapPath = CFG.map.path;
const startPos = positionOnPath(mapPath, 0);
assert(Math.abs(startPos.x - mapPath[0].x) < 0.1, 'mapPath start = first waypoint');
const endPos = positionOnPath(mapPath, 1);
const lastWP = mapPath[mapPath.length - 1];
assert(Math.abs(endPos.x - lastWP.x) < 0.1 && Math.abs(endPos.y - lastWP.y) < 0.1,
  'mapPath end = last waypoint');

/* ═════════════════════════════════════════════════════════ */
/* Suite 5: 웨이브 빌드 시뮬레이션                          */
/* ═════════════════════════════════════════════════════════ */
console.log('\n[5] 웨이브 빌드 시뮬레이션');

const wave1 = buildWaveQueue(1);
const wave5 = buildWaveQueue(5);
const wave10 = buildWaveQueue(10);

assert(wave1.length > 0,                                    'wave 1 has enemies');
assert(wave1[0].spawnDelay === 0,                           'first enemy spawnDelay = 0');
assert(wave1.every(e => e.health > 0),                      'all w1 enemies have hp > 0');
assert(wave1.every(e => e.speed > 0),                       'all w1 enemies have speed > 0');
assert(wave1.every(e => e.gold >= 0),                       'all w1 enemies have gold ≥ 0');
assert(wave1.every(e => e.xp >= 0),                         'all w1 enemies have xp ≥ 0');
assert(wave10.length > wave1.length,                        'wave 10 has more enemies than wave 1');
assert(wave10[0].health > wave1[0].health,                  'wave 10 enemies have more HP');
assert(wave10[0].speed > wave1[0].speed,                    'wave 10 enemies are faster');

// 보스 체크 (5웨이브마다)
const boss5 = wave5[wave5.length - 1];
assert(boss5.type === 'boss',                               'wave 5 last enemy is boss');
assert(boss5.health > wave5[0].health * 2,                  'boss HP is significantly higher');
assert(boss5.gold > wave5[0].gold,                          'boss drops more gold');
assert(boss5.xp > wave5[0].xp,                              'boss gives more XP');

// 비-보스 웨이브
const wave3 = buildWaveQueue(3);
assert(wave3[wave3.length - 1].type !== 'boss',             'wave 3 last enemy is NOT boss');

// 스폰 딜레이 단조 증가
for (let i = 1; i < wave1.length; i++) {
  assert(wave1[i].spawnDelay >= wave1[i-1].spawnDelay,     `spawnDelay[${i}] ≥ spawnDelay[${i-1}]`);
}

// 속성 적 등장 (웨이브 5 이후)
const wave7 = buildWaveQueue(7);
const hasAttrEnemy = wave7.some(e => e.attribute !== null);
assert(hasAttrEnemy,                                        'wave 7 has attribute enemies');
const wave1NoAttr = wave1.every(e => e.attribute === null);
assert(wave1NoAttr,                                         'wave 1 has no attribute enemies (starts wave 5+)');

/* ═════════════════════════════════════════════════════════ */
/* Suite 6: 맵 경로 길이 검증                               */
/* ═════════════════════════════════════════════════════════ */
console.log('\n[6] 맵 경로 길이 검증');

const pathLen = computePathLength(CFG.map.path);
assert(pathLen > 0,       'path length > 0');
assert(pathLen > 500,     `path length (${pathLen.toFixed(0)}px) > 500px`);
assert(pathLen < 5000,    `path length (${pathLen.toFixed(0)}px) < 5000px (not absurd)`);

// 단일 웨이포인트 경우 (방어 코드)
const onePoint = [{ x: 100, y: 100 }];
const pos = positionOnPath(onePoint, 0.5);
assert(typeof pos.x === 'number', 'single waypoint returns valid position');

/* ═════════════════════════════════════════════════════════ */
/* Suite 7: 도형→속성 매핑 & 마나 비용                      */
/* ═════════════════════════════════════════════════════════ */
console.log('\n[7] 도형→속성 매핑 & 마나 비용');

const shapeMapping = CFG.spells.shapeToAttribute;
const shapes = Object.keys(shapeMapping);
assert(shapes.length >= 5, `≥5 shapes (got ${shapes.length})`);

shapes.forEach(shape => {
  const attr = shapeMapping[shape];
  assert(CFG.attributes.list.includes(attr),
    `shape '${shape}' maps to valid attribute '${attr}'`);
});

// 각 속성에 마나 비용 존재
CFG.attributes.list.forEach(attr => {
  const cost = CFG.spells.manaCost[attr];
  assert(cost > 0, `manaCost['${attr}'] = ${cost} > 0`);
});

// 각 속성에 기본 데미지 존재
CFG.attributes.list.forEach(attr => {
  const dmg = CFG.spells.attributeDamage[attr];
  assert(dmg > 0, `attributeDamage['${attr}'] = ${dmg} > 0`);
});

/* ═════════════════════════════════════════════════════════ */
/* Suite 8: 플레이어 성장 (레벨업·XP·스킬포인트)            */
/* ═════════════════════════════════════════════════════════ */
console.log('\n[8] 플레이어 성장 (레벨업·XP·스킬포인트)');

const bs = CFG.player.baseStats;
const lc = CFG.player.levelCurve;

const player = {
  level:       1,
  skillPoints: 0,
  gold:        bs.startingGold,
  mana:        bs.mana,
  maxMana:     bs.mana,
  manaRegen:   bs.manaRegen,
  xp:          0,
  xpToNext:    lc.baseXp,
};

// 충분한 XP 지급 → 레벨업
const before = { ...player };
const leveled = addRewards(player, 100, lc.baseXp);
assert(leveled.length === 1,           'gained exactly 1 level');
assert(player.level === 2,             'player level is now 2');
assert(player.skillPoints > 0,         'skill points awarded on level up');
assert(player.maxMana > before.maxMana,'maxMana increased on level up');
assert(player.mana === player.maxMana, 'mana fully restored on level up');
assert(player.xpToNext > lc.baseXp,   'xpToNext scaled up (harder to level next time)');
assert(player.gold === before.gold + 100, 'gold correctly added');

// 0 골드·XP 지급 — 레벨업 없음
const leveled2 = addRewards(player, 0, 0);
assert(leveled2.length === 0, 'zero rewards = no level up');

// 음수 XP/골드 → 거부
assertThrows(() => addRewards(player, -1, 0),  'negative gold throws');
assertThrows(() => addRewards(player, 0, -1),  'negative xp throws');

/* ═════════════════════════════════════════════════════════ */
/* Suite 9: 엣지 케이스 (자원 0·경계값·극단 입력)           */
/* ═════════════════════════════════════════════════════════ */
console.log('\n[9] 엣지 케이스');

// HP floor: 오버킬 → 0
function hpFloor(hp, dmg) { return Math.max(0, hp - dmg); }
assert(hpFloor(50, 100) === 0, 'overkill → HP floored at 0');
assert(hpFloor(0, 50)   === 0, 'attack on 0 HP enemy → stays 0');

// 데미지 최소값 (baseDmg=1, 불리한 상성 0.5× → 0.5 → floor 0 → min 1)
assert(calcDamage('fire', 'water', 1) >= 1, 'min damage ≥ 1 even with 0.5× affinity');

// 마나 0일 때 마나 소비 시뮬레이션
function tryConsumeMana(player, cost) {
  if (player.mana < cost) return false;
  player.mana -= cost;
  return true;
}
const pManaZero = { mana: 0 };
assert(!tryConsumeMana(pManaZero, 10), 'mana=0: spell blocked');

// 스폰 큐 고갈 후 웨이브 클리어 판정
const emptyQueue = [];
assert(emptyQueue.length === 0, 'empty queue detected correctly');

// clamp 경계값
assert(clamp(5, 0, 10)  === 5,  'clamp(5, 0, 10) = 5');
assert(clamp(-1, 0, 10) === 0,  'clamp(-1, 0, 10) = 0');
assert(clamp(11, 0, 10) === 10, 'clamp(11, 0, 10) = 10');
assert(clamp(0, 0, 0)   === 0,  'clamp(0, 0, 0) = 0');

// 속성 상성 테이블 완전성 검증 (순환 구조)
const attrs = CFG.attributes.list;
let affinityErrors = 0;
attrs.forEach(attacker => {
  const row = CFG.combat.affinityTable[attacker] || {};
  // 강함/약함 상대가 모두 유효 속성인지 확인
  Object.keys(row).forEach(target => {
    if (!attrs.includes(target)) affinityErrors++;
    const mul = row[target];
    if (mul !== 2.0 && mul !== 0.5) affinityErrors++;
  });
});
assert(affinityErrors === 0, `affinityTable 값이 모두 유효 (2.0 또는 0.5, 알 수 없는 속성 없음)`);

/* ═════════════════════════════════════════════════════════ */
/* 결과 요약                                                */
/* ═════════════════════════════════════════════════════════ */
console.log(`\n${'─'.repeat(60)}`);
console.log(`총 테스트: ${passed + failed} | ✅ 통과: ${passed} | ❌ 실패: ${failed}`);

if (failed === 0) {
  console.log('🎉 모든 테스트 통과!');
  process.exit(0);
} else {
  console.log(`⚠ ${failed}개 테스트 실패 — 서버 코드를 확인하세요.`);
  process.exit(1);
}
