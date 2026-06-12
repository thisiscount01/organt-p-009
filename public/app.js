/**
 * app.js — 마법진 디펜스 게임 클라이언트
 * 4-layer canvas / Socket.io / ShapeRecognizer TF.js
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════
   * 속성 상수
   * ═══════════════════════════════════════════════════ */
  const ATTR_COLOR = {
    fire:      '#ff4b2b',
    water:     '#2b9fff',
    earth:     '#a06030',
    wind:      '#30d090',
    lightning: '#f0d020',
  };
  const ATTR_GLOW = {
    fire:      'rgba(255,75,43,0.7)',
    water:     'rgba(43,159,255,0.7)',
    earth:     'rgba(160,96,48,0.7)',
    wind:      'rgba(48,208,144,0.7)',
    lightning: 'rgba(240,208,32,0.9)',
  };
  const ATTR_NAME = {
    fire: '불', water: '물', earth: '땅', wind: '바람', lightning: '번개',
  };
  const SHAPE_ICON = {
    circle: '○', triangle: '△', square: '□', star: '★', cross: '✚',
  };
  const SHAPE_TO_ATTR = {
    circle: 'water', triangle: 'fire', square: 'earth', star: 'lightning', cross: 'wind',
  };

  /* ═══════════════════════════════════════════════════
   * DOM 참조
   * ═══════════════════════════════════════════════════ */
  const $ = (id) => document.getElementById(id);

  // Canvases
  const cvMap  = $('cv-map');
  const cvGame = $('cv-game');
  const cvVfx  = $('cv-vfx');
  const cvUi   = $('cv-ui');
  const cvDraw = $('cv-draw');

  const ctxMap  = cvMap.getContext('2d');
  const ctxGame = cvGame.getContext('2d');
  const ctxVfx  = cvVfx.getContext('2d');
  const ctxUi   = cvUi.getContext('2d');
  const ctxDraw = cvDraw.getContext('2d');

  // HUD
  const barHp   = $('bar-hp');
  const txtHp   = $('txt-hp');
  const barMana = $('bar-mana');
  const txtMana = $('txt-mana');
  const barXp   = $('bar-xp');
  const txtXp   = $('txt-xp');
  const txtLevel = $('txt-level');
  const txtGold  = $('txt-gold');
  const txtSp    = $('txt-sp');
  const txtWave  = $('txt-wave');
  const intermissionTimer = $('intermission-timer');
  const txtTimer = $('txt-timer');

  // Panels
  const towerSlotsEl   = $('tower-slots');
  const slotBtnsEl     = $('slot-btns');
  const drawHint       = $('draw-hint');
  const drawFeedback   = $('draw-feedback');
  const recognizedShape = $('recognized-shape');
  const recShapeIcon   = $('rec-shape-icon');
  const recAttrName    = $('rec-attr-name');
  const btnClearDraw   = $('btn-clear-draw');

  // Overlays
  const overlayConnecting = $('overlay-connecting');
  const overlayWave       = $('overlay-wave');
  const overlayWaveTitle  = $('overlay-wave-title');
  const overlayWaveSub    = $('overlay-wave-sub');
  const wavePreview       = $('wave-preview');
  const overlayGameover   = $('overlay-gameover');
  const gameoverWave      = $('gameover-wave');
  const btnReload         = $('btn-reload');
  const floatMsgs         = $('float-msgs');
  const levelupPopup      = $('levelup-popup');

  /* ═══════════════════════════════════════════════════
   * 클라이언트 상태
   * ═══════════════════════════════════════════════════ */
  let CFG = null;
  let myId = null;

  // 서버 스냅샷 (tick에서 갱신)
  let snap = null;
  // 로컬 보간용 적 위치 (id → {x,y,progress})
  const localEnemies = new Map();
  // 로컬 투사체 (id → spell obj)
  const localSpells  = new Map();

  // 선택된 타워 슬롯 (드로잉 발사 대상)
  let selectedSlot = 0;

  // 마지막 렌더 시간
  let lastRender = 0;

  // 게임 준비 여부
  let gameReady = false;

  /* ═══════════════════════════════════════════════════
   * VFX 파티클 시스템
   * ═══════════════════════════════════════════════════ */
  const particles = [];
  const dmgNumbers = [];
  const beams = [];

  function spawnParticles(x, y, attr, count, opts) {
    const color = ATTR_COLOR[attr] || '#ffffff';
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (opts && opts.speed ? opts.speed : 80) * (0.5 + Math.random());
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1.0,
        decay: 0.03 + Math.random() * 0.04,
        size: (opts && opts.size ? opts.size : 4) * (0.5 + Math.random()),
        color,
        glow: ATTR_GLOW[attr] || color,
      });
    }
  }

  function spawnDmgNumber(x, y, dmg, attr, isCrit) {
    dmgNumbers.push({
      x, y: y - 10,
      vy: -60,
      life: 1.0,
      decay: 0.025,
      text: (isCrit ? '★' : '') + dmg,
      color: ATTR_COLOR[attr] || '#ffffff',
      size: isCrit ? 16 : 13,
    });
  }

  function spawnBeam(x1, y1, x2, y2, attr, dur) {
    beams.push({
      x1, y1, x2, y2,
      life: 1.0,
      decay: 1.0 / (dur || 8),
      color: ATTR_COLOR[attr] || '#ffffff',
      glow: ATTR_GLOW[attr] || '#ffffff',
    });
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 120 * dt; // gravity
      p.life -= p.decay;
      if (p.life <= 0) particles.splice(i, 1);
    }
    for (let i = dmgNumbers.length - 1; i >= 0; i--) {
      const d = dmgNumbers[i];
      d.y += d.vy * dt;
      d.vy *= 0.95;
      d.life -= d.decay;
      if (d.life <= 0) dmgNumbers.splice(i, 1);
    }
    for (let i = beams.length - 1; i >= 0; i--) {
      const b = beams[i];
      b.life -= b.decay;
      if (b.life <= 0) beams.splice(i, 1);
    }
  }

  /* ═══════════════════════════════════════════════════
   * 맵 렌더 (cv-map — 정적, 한 번만)
   * ═══════════════════════════════════════════════════ */
  function drawMap() {
    if (!CFG) return;
    const ctx = ctxMap;
    const W = cvMap.width, H = cvMap.height;
    ctx.clearRect(0, 0, W, H);

    // 배경 그라디언트
    const bg = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, W * 0.8);
    bg.addColorStop(0, '#111320');
    bg.addColorStop(1, '#070810');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 격자 패턴 (미세)
    ctx.strokeStyle = 'rgba(60,70,120,0.12)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // 경로 그림자
    const path = CFG.map.path;
    const roadW = 56;

    // 경로 아웃라인
    ctx.save();
    ctx.strokeStyle = 'rgba(180,140,60,0.18)';
    ctx.lineWidth = roadW + 12;
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.stroke();
    ctx.restore();

    // 경로 본체
    ctx.save();
    ctx.strokeStyle = '#2a2510';
    ctx.lineWidth = roadW;
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.stroke();
    ctx.restore();

    // 경로 중앙선
    ctx.save();
    ctx.strokeStyle = 'rgba(100,90,50,0.4)';
    ctx.lineWidth = 2;
    ctx.setLineDash([12, 8]);
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // 경로 가장자리 글로우
    ctx.save();
    ctx.strokeStyle = 'rgba(150,120,40,0.08)';
    ctx.lineWidth = roadW + 4;
    ctx.filter = 'blur(6px)';
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.stroke();
    ctx.restore();

    // 방향 화살표 (경로 각 구간 중간)
    ctx.save();
    ctx.fillStyle = 'rgba(150,130,60,0.25)';
    for (let i = 0; i < path.length - 1; i++) {
      const mx = (path[i].x + path[i+1].x) / 2;
      const my = (path[i].y + path[i+1].y) / 2;
      const ang = Math.atan2(path[i+1].y - path[i].y, path[i+1].x - path[i].x);
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.lineTo(-6, -6);
      ctx.lineTo(-6, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // 시작점 (입구)
    ctx.save();
    const startGlow = ctx.createRadialGradient(path[0].x, path[0].y, 0, path[0].x, path[0].y, 30);
    startGlow.addColorStop(0, 'rgba(255,80,80,0.5)');
    startGlow.addColorStop(1, 'rgba(255,80,80,0)');
    ctx.fillStyle = startGlow;
    ctx.beginPath();
    ctx.arc(path[0].x, path[0].y, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ff5050';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(path[0].x, path[0].y, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ff7070';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('START', path[0].x, path[0].y + 24);
    ctx.restore();

    // 끝점 (출구)
    const ep = path[path.length - 1];
    ctx.save();
    const endGlow = ctx.createRadialGradient(ep.x, ep.y, 0, ep.x, ep.y, 30);
    endGlow.addColorStop(0, 'rgba(80,80,255,0.5)');
    endGlow.addColorStop(1, 'rgba(80,80,255,0)');
    ctx.fillStyle = endGlow;
    ctx.beginPath();
    ctx.arc(ep.x, ep.y, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#5050ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ep.x, ep.y, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#7070ff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('END', ep.x, ep.y + 24);
    ctx.restore();

    // 타워 슬롯 기저 (플랫폼)
    if (CFG.towers && CFG.towers.slots) {
      CFG.towers.slots.forEach((slot) => {
        const { x, y } = slot.position;
        ctx.save();
        // 플랫폼 그림자
        const pglow = ctx.createRadialGradient(x, y, 0, x, y, 38);
        pglow.addColorStop(0, 'rgba(80,100,200,0.25)');
        pglow.addColorStop(1, 'rgba(80,100,200,0)');
        ctx.fillStyle = pglow;
        ctx.beginPath();
        ctx.arc(x, y, 38, 0, Math.PI * 2);
        ctx.fill();

        // 플랫폼 원
        ctx.fillStyle = '#181c38';
        ctx.strokeStyle = '#3a4080';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 24, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // 마법진 패턴 (6각)
        ctx.strokeStyle = 'rgba(100,120,220,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = k * Math.PI / 3;
          const r = 20;
          if (k === 0) ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
          else ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
        }
        ctx.closePath();
        ctx.stroke();

        ctx.restore();
      });
    }
  }

  /* ═══════════════════════════════════════════════════
   * 게임 레이어 렌더 (cv-game — 매프레임)
   * ═══════════════════════════════════════════════════ */
  function renderGame(dt) {
    const ctx = ctxGame;
    const W = cvGame.width, H = cvGame.height;
    ctx.clearRect(0, 0, W, H);

    if (!snap) return;

    // 적 이동 보간
    const enemies = snap.enemies || [];
    enemies.forEach((e) => {
      let local = localEnemies.get(e.id);
      if (!local) {
        local = { x: e.position.x, y: e.position.y, progress: e.progress };
        localEnemies.set(e.id, local);
      }
      // 보간: 서버 위치로 부드럽게
      const lerpSpeed = 12;
      local.x += (e.position.x - local.x) * Math.min(1, lerpSpeed * dt);
      local.y += (e.position.y - local.y) * Math.min(1, lerpSpeed * dt);
      local.progress = e.progress;
    });

    // 로컬에만 있는 적 제거
    const aliveIds = new Set(enemies.map(e => e.id));
    for (const [id] of localEnemies) {
      if (!aliveIds.has(id)) localEnemies.delete(id);
    }

    // 적 렌더
    enemies.forEach((e) => {
      const local = localEnemies.get(e.id);
      if (!local) return;
      drawEnemy(ctx, e, local.x, local.y);
    });

    // 타워 렌더
    if (snap.players && myId && snap.players[myId]) {
      const towers = snap.players[myId].towers || [];
      towers.forEach((t) => {
        drawTower(ctx, t);
      });
    }
  }

  function drawEnemy(ctx, e, x, y) {
    const isBoss = e.type === 'boss';
    const r = isBoss ? 20 : 12;
    const attr = e.attribute;
    const col = attr ? ATTR_COLOR[attr] : '#cc8844';
    const hp = Math.max(0, e.health) / e.maxHealth;

    ctx.save();

    // 보스 외곽 글로우
    if (isBoss) {
      const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 2.5);
      glow.addColorStop(0, (attr ? ATTR_GLOW[attr] : 'rgba(200,100,50,0.5)'));
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 속성 글로우 링
    if (attr) {
      ctx.strokeStyle = ATTR_GLOW[attr];
      ctx.lineWidth = 3;
      ctx.shadowBlur = 8;
      ctx.shadowColor = ATTR_GLOW[attr];
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // 적 본체
    ctx.fillStyle = isBoss ? '#2a0a0a' : '#1a0808';
    ctx.strokeStyle = col;
    ctx.lineWidth = isBoss ? 3 : 2;
    ctx.beginPath();
    if (isBoss) {
      // 보스: 다이아몬드
      ctx.moveTo(x,      y - r);
      ctx.lineTo(x + r,  y);
      ctx.lineTo(x,      y + r);
      ctx.lineTo(x - r,  y);
      ctx.closePath();
    } else if (attr) {
      // 속성적: 육각형
      for (let k = 0; k < 6; k++) {
        const a = k * Math.PI / 3 - Math.PI / 6;
        if (k === 0) ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
        else ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
      }
      ctx.closePath();
    } else {
      // 일반: 원
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();

    // 적 속성 아이콘 텍스트
    if (attr) {
      ctx.fillStyle = ATTR_COLOR[attr];
      ctx.font = `bold ${isBoss ? 14 : 10}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowBlur = 4;
      ctx.shadowColor = ATTR_GLOW[attr];
      ctx.fillText(ATTR_NAME[attr][0], x, y);
      ctx.shadowBlur = 0;
    }

    // HP 바
    const barW = r * 2.5;
    const barH = 4;
    const bx = x - barW / 2;
    const by = y - r - 10;
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(bx, by, barW, barH);
    const hpColor = hp > 0.6 ? '#40d040' : hp > 0.3 ? '#d0c020' : '#d04020';
    ctx.fillStyle = hpColor;
    ctx.fillRect(bx, by, barW * hp, barH);
    ctx.strokeStyle = '#00000060';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(bx, by, barW, barH);

    ctx.restore();
  }

  function drawTower(ctx, t) {
    const { x, y } = t.position;
    const attr = t.attribute;
    if (!attr) {
      // 미배정 타워
      ctx.save();
      ctx.strokeStyle = 'rgba(100,100,180,0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }

    const col = ATTR_COLOR[attr];
    const glow = ATTR_GLOW[attr];
    const lvl = t.level || 1;

    ctx.save();

    // 레벨별 글로우 크기
    ctx.shadowBlur = 8 + lvl * 3;
    ctx.shadowColor = glow;

    // 타워 본체 (별 모양으로 레벨 표시)
    const r = 14 + (lvl - 1) * 2;
    ctx.fillStyle = '#0d1020';
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    // 8각형
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4;
      const rr = k % 2 === 0 ? r : r * 0.75;
      if (k === 0) ctx.moveTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
      else ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 내부 속성 심볼
    ctx.fillStyle = col;
    ctx.font = `bold ${11 + (lvl - 1)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ATTR_NAME[attr][0], x, y);

    ctx.restore();
  }

  /* ═══════════════════════════════════════════════════
   * VFX 레이어 렌더 (cv-vfx — 매프레임)
   * ═══════════════════════════════════════════════════ */
  function renderVfx(dt) {
    const ctx = ctxVfx;
    const W = cvVfx.width, H = cvVfx.height;
    ctx.clearRect(0, 0, W, H);

    // 투사체 (스냅샷 기반 + 로컬 보간)
    if (snap && snap.spells) {
      snap.spells.forEach((s) => {
        drawProjectile(ctx, s);
      });
    }

    // 파티클
    particles.forEach((p) => {
      const alpha = Math.max(0, p.life);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowBlur = 8;
      ctx.shadowColor = p.glow;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    // 빔
    beams.forEach((b) => {
      const alpha = Math.max(0, b.life);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 3;
      ctx.shadowBlur = 12;
      ctx.shadowColor = b.glow;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(b.x1, b.y1);
      ctx.lineTo(b.x2, b.y2);
      ctx.stroke();
      ctx.restore();
    });

    // 데미지 숫자
    dmgNumbers.forEach((d) => {
      const alpha = Math.max(0, d.life);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = d.color;
      ctx.font = `bold ${d.size}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowBlur = 8;
      ctx.shadowColor = d.color;
      ctx.fillText(d.text, d.x, d.y);
      ctx.restore();
    });

    // 마법진 활성 이펙트 (선택된 타워 슬롯 위 마법진)
    renderCircleEffect(ctx);

    updateParticles(dt);
  }

  function drawProjectile(ctx, s) {
    const col = ATTR_COLOR[s.attribute] || '#ffffff';
    const glow = ATTR_GLOW[s.attribute] || col;
    const x = s.position.x, y = s.position.y;

    ctx.save();
    // 트레일 효과 (뒤쪽 글로우)
    const trailGrad = ctx.createRadialGradient(x, y, 0, x, y, 12);
    trailGrad.addColorStop(0, col + 'cc');
    trailGrad.addColorStop(1, col + '00');
    ctx.fillStyle = trailGrad;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();

    // 투사체 핵심
    ctx.shadowBlur = 16;
    ctx.shadowColor = glow;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 마법진 회전 애니메이션 각도
  let magicCircleAngle = 0;
  function renderCircleEffect(ctx) {
    if (!CFG || !snap || !snap.players || !myId || !snap.players[myId]) return;
    const towers = snap.players[myId].towers || [];
    const t = towers[selectedSlot];
    if (!t || !t.attribute) return;

    const { x, y } = t.position;
    const attr = t.attribute;
    const col = ATTR_COLOR[attr];
    const glow = ATTR_GLOW[attr];

    magicCircleAngle += 0.02;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(magicCircleAngle);

    // 마법진 외곽 회전 링
    ctx.strokeStyle = col + '60';
    ctx.lineWidth = 2;
    ctx.shadowBlur = 12;
    ctx.shadowColor = glow;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.arc(0, 0, t.range, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  /* ═══════════════════════════════════════════════════
   * UI 레이어 (cv-ui — 매프레임)
   * ═══════════════════════════════════════════════════ */
  function renderUi() {
    const ctx = ctxUi;
    const W = cvUi.width, H = cvUi.height;
    ctx.clearRect(0, 0, W, H);

    if (!snap || !snap.players || !myId || !snap.players[myId]) return;

    const towers = snap.players[myId].towers || [];
    towers.forEach((t, idx) => {
      if (idx !== selectedSlot) return;
      const { x, y } = t.position;
      const range = t.range || (CFG && CFG.towers && CFG.towers.baseStats ? CFG.towers.baseStats.range : 130);
      const attr = t.attribute;
      const col = attr ? ATTR_COLOR[attr] : '#6080c0';

      ctx.save();
      ctx.strokeStyle = col + '60';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.shadowBlur = 6;
      ctx.shadowColor = col;
      ctx.beginPath();
      ctx.arc(x, y, range, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    });
  }

  /* ═══════════════════════════════════════════════════
   * 드로잉 캔버스 (cv-draw)
   * ═══════════════════════════════════════════════════ */
  let isDrawing = false;
  let strokePoints = [];
  let clearTimer = null;
  let feedbackTimer = null;

  function getDrawPos(e) {
    const rect = cvDraw.getBoundingClientRect();
    const scaleX = cvDraw.width / rect.width;
    const scaleY = cvDraw.height / rect.height;
    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
      clientX = e.changedTouches[0].clientX;
      clientY = e.changedTouches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top)  * scaleY,
    };
  }

  function onDrawStart(e) {
    e.preventDefault();
    isDrawing = true;
    strokePoints = [];
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }

    clearDrawCanvas();
    drawHint.style.display = 'none';
    recognizedShape.classList.add('hidden');

    const pos = getDrawPos(e);
    strokePoints.push(pos);

    // 드로잉 글로우 활성
    cvDraw.style.boxShadow = '0 0 24px rgba(140,80,255,0.7), 0 0 40px rgba(100,60,200,0.4), inset 0 0 16px #0a0b1a';
  }

  function onDrawMove(e) {
    e.preventDefault();
    if (!isDrawing) return;
    const pos = getDrawPos(e);
    strokePoints.push(pos);
    redrawStroke('rgba(160,100,255,0.9)', 2.5, true);
  }

  function onDrawEnd(e) {
    e.preventDefault();
    if (!isDrawing) return;
    isDrawing = false;

    cvDraw.style.boxShadow = '0 0 24px #1a1f6040, inset 0 0 16px #0a0b1a';

    if (strokePoints.length < 5) {
      clearDrawCanvas();
      drawHint.style.display = '';
      return;
    }

    // ShapeRecognizer로 예측
    if (window.ShapeRecognizer && window.ShapeRecognizer.isReady()) {
      const result = window.ShapeRecognizer.predict(strokePoints);
      handleShapeResult(result);
    } else {
      // 모델 미준비: 마나바 아래 힌트
      showDrawFeedback('⏳', '#aaa');
      scheduleAutoClear(2000);
    }
  }

  function handleShapeResult(result) {
    if (!result) {
      // 인식 실패
      redrawStroke('#ff4040', 2, false);
      showDrawFeedback('?', '#ff4040');
      floatMsg('도형 인식 실패 (다시 그려주세요)', '#ff6060');
      scheduleAutoClear(1500);
      return;
    }

    const { shape, confidence } = result;
    const attr = SHAPE_TO_ATTR[shape];
    const col = ATTR_COLOR[attr] || '#ffffff';

    // 성공 스트로크 색상으로 덮어쓰기
    redrawStroke(col, 2.5, false);

    // recognized-shape 표시
    recognizedShape.classList.remove('hidden');
    recShapeIcon.textContent = SHAPE_ICON[shape] || shape;
    recShapeIcon.style.color = col;
    recAttrName.textContent = ATTR_NAME[attr] || attr;
    recAttrName.style.color = col;

    // 서버로 castSpell 전송
    if (socket) {
      socket.emit('castSpell', {
        shape,
        slotId: selectedSlot,
        confidence,
      });
    }

    scheduleAutoClear(1500);
  }

  function redrawStroke(color, width, withGlow) {
    if (strokePoints.length < 2) return;
    clearDrawCanvas(false);
    const ctx = ctxDraw;
    ctx.save();
    if (withGlow) {
      ctx.shadowBlur = 12;
      ctx.shadowColor = 'rgba(160,100,255,0.8)';
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(strokePoints[0].x, strokePoints[0].y);
    for (let i = 1; i < strokePoints.length; i++) {
      ctx.lineTo(strokePoints[i].x, strokePoints[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function clearDrawCanvas(showHint = true) {
    ctxDraw.clearRect(0, 0, cvDraw.width, cvDraw.height);
    // 마법진 배경 원
    const cx = cvDraw.width / 2, cy = cvDraw.height / 2;
    const bg = ctxDraw.createRadialGradient(cx, cy, 0, cx, cy, cx);
    bg.addColorStop(0, '#0e0f22');
    bg.addColorStop(1, '#080910');
    ctxDraw.fillStyle = bg;
    ctxDraw.beginPath();
    ctxDraw.arc(cx, cy, cx - 2, 0, Math.PI * 2);
    ctxDraw.fill();

    // 마법진 내부 동심원
    ctxDraw.strokeStyle = 'rgba(80,80,160,0.15)';
    ctxDraw.lineWidth = 1;
    [50, 80, 100].forEach((r) => {
      ctxDraw.beginPath();
      ctxDraw.arc(cx, cy, r, 0, Math.PI * 2);
      ctxDraw.stroke();
    });

    if (showHint) {
      drawHint.style.display = '';
      recognizedShape.classList.add('hidden');
    }
  }

  function showDrawFeedback(icon, color) {
    drawFeedback.textContent = icon;
    drawFeedback.style.color = color;
    drawFeedback.classList.remove('hidden');
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      drawFeedback.classList.add('hidden');
    }, 1000);
  }

  function scheduleAutoClear(ms) {
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      clearDrawCanvas(true);
      clearTimer = null;
    }, ms);
  }

  // 이벤트 바인딩
  cvDraw.addEventListener('mousedown',  onDrawStart, { passive: false });
  cvDraw.addEventListener('mousemove',  onDrawMove,  { passive: false });
  cvDraw.addEventListener('mouseup',    onDrawEnd,   { passive: false });
  cvDraw.addEventListener('mouseleave', onDrawEnd,   { passive: false });
  cvDraw.addEventListener('touchstart', onDrawStart, { passive: false });
  cvDraw.addEventListener('touchmove',  onDrawMove,  { passive: false });
  cvDraw.addEventListener('touchend',   onDrawEnd,   { passive: false });

  btnClearDraw.addEventListener('click', () => {
    clearDrawCanvas(true);
    strokePoints = [];
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
  });

  /* ═══════════════════════════════════════════════════
   * HUD 업데이트
   * ═══════════════════════════════════════════════════ */
  function updateHud() {
    if (!snap || !snap.players || !myId || !snap.players[myId]) return;
    const p = snap.players[myId];

    // HP
    const hpPct = Math.max(0, Math.min(1, p.health / p.maxHealth));
    barHp.style.transform = `scaleX(${hpPct})`;
    txtHp.textContent = `${Math.round(p.health)}/${p.maxHealth}`;

    // Mana
    const manaPct = Math.max(0, Math.min(1, p.mana / p.maxMana));
    barMana.style.transform = `scaleX(${manaPct})`;
    txtMana.textContent = `${Math.round(p.mana)}/${p.maxMana}`;

    // XP
    const xpPct = Math.max(0, Math.min(1, p.xp / p.xpToNext));
    barXp.style.transform = `scaleX(${xpPct})`;
    txtXp.textContent = `${p.xp}/${p.xpToNext}`;

    // Stats
    txtLevel.textContent = p.level;
    txtGold.textContent  = p.gold;
    txtSp.textContent    = p.skillPoints;

    // 웨이브
    if (snap.phase === 'wave') {
      txtWave.textContent = `웨이브 ${snap.waveNumber}`;
      intermissionTimer.classList.add('hidden');
    } else if (snap.phase === 'intermission') {
      txtWave.textContent = `웨이브 ${snap.waveNumber} 클리어`;
      intermissionTimer.classList.remove('hidden');
      txtTimer.textContent = snap.intermissionSec;
    } else if (snap.phase === 'waiting') {
      txtWave.textContent = '대기중';
      intermissionTimer.classList.add('hidden');
    }
  }

  /* ═══════════════════════════════════════════════════
   * 타워 패널
   * ═══════════════════════════════════════════════════ */
  function buildTowerPanel() {
    if (!CFG || !snap || !myId || !snap.players[myId]) return;
    const towers = snap.players[myId].towers || [];
    towerSlotsEl.innerHTML = '';
    slotBtnsEl.innerHTML   = '';

    towers.forEach((t, idx) => {
      // 슬롯 선택 버튼
      const sb = document.createElement('button');
      sb.className = 'slot-btn' + (idx === selectedSlot ? ' active' : '');
      const attrLabel = t.attribute ? (ATTR_NAME[t.attribute] || t.attribute) : '미배정';
      sb.textContent = `슬롯 ${idx + 1} [${attrLabel}]`;
      sb.addEventListener('click', () => selectSlot(idx));
      slotBtnsEl.appendChild(sb);

      // 타워 카드
      const card = document.createElement('div');
      card.className = 'tower-card' + (idx === selectedSlot ? ' selected' : '');
      card.dataset.slotId = idx;

      const attr = t.attribute;
      const col  = attr ? ATTR_COLOR[attr] : '#6070a0';
      const attrBadgeClass = attr ? attr : 'none';
      const lvlStars = '★'.repeat(t.level) + '☆'.repeat((CFG.towers.maxLevel || 5) - t.level);

      card.innerHTML = `
        <div class="tower-card-top">
          <span class="tower-slot-label">슬롯 ${idx + 1}</span>
          <span class="tower-attr-badge attr-chip ${attrBadgeClass}">${attr ? ATTR_NAME[attr] : '없음'}</span>
          <span class="tower-level-stars">${lvlStars}</span>
        </div>
        <div class="tower-card-stats">
          공격력: ${t.damage || (CFG.towers.baseStats.damage)}<br>
          사정거리: ${t.range}<br>
          속도: ${(t.attackSpeed || 1.0).toFixed(1)}/s
        </div>
        <div class="tower-btn-row">
          <button class="btn-assign" data-slot="${idx}">배정</button>
          <button class="btn-upgrade" data-slot="${idx}" ${t.level >= (CFG.towers.maxLevel || 5) ? 'disabled' : ''}>
            강화 (${CFG.towers.upgradeCostBase * t.level}G)
          </button>
        </div>
      `;

      // 카드 클릭 → 슬롯 선택
      card.addEventListener('click', (e) => {
        if (!e.target.closest('button')) selectSlot(idx);
      });

      // 배정 버튼 토글
      const btnAssign = card.querySelector('.btn-assign');
      btnAssign.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleAttrPicker(card, idx);
      });

      // 강화 버튼
      const btnUpg = card.querySelector('.btn-upgrade');
      btnUpg.addEventListener('click', (e) => {
        e.stopPropagation();
        if (socket) socket.emit('upgradeTower', { slotId: idx });
      });

      towerSlotsEl.appendChild(card);
    });
  }

  function toggleAttrPicker(card, slotId) {
    // 기존 picker 제거
    const existing = card.querySelector('.attr-select-row');
    if (existing) { existing.remove(); return; }

    const row = document.createElement('div');
    row.className = 'attr-select-row';
    (CFG.attributes.list || ['fire','water','earth','wind','lightning']).forEach((attr) => {
      const btn = document.createElement('button');
      btn.className = 'attr-pick-btn';
      btn.textContent = ATTR_NAME[attr] || attr;
      btn.style.color = ATTR_COLOR[attr];
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (socket) socket.emit('assignTowerAttribute', { slotId, attribute: attr });
        row.remove();
      });
      row.appendChild(btn);
    });
    card.appendChild(row);
  }

  function selectSlot(idx) {
    selectedSlot = idx;
    buildTowerPanel();
    // 슬롯 버튼 및 카드 active 갱신
    document.querySelectorAll('.slot-btn').forEach((b, i) => {
      b.classList.toggle('active', i === idx);
    });
    document.querySelectorAll('.tower-card').forEach((c, i) => {
      c.classList.toggle('selected', i === idx);
    });
  }

  /* ═══════════════════════════════════════════════════
   * 플로팅 메시지
   * ═══════════════════════════════════════════════════ */
  function floatMsg(text, color) {
    const el = document.createElement('div');
    el.className = 'float-msg';
    el.textContent = text;
    el.style.color = color || '#ffffff';
    floatMsgs.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  /* ═══════════════════════════════════════════════════
   * 오버레이 제어
   * ═══════════════════════════════════════════════════ */
  function showWaveOverlay(data) {
    overlayWaveTitle.textContent = `웨이브 ${data.waveNumber}`;
    overlayWaveSub.textContent   = `적 ${data.enemyCount}마리`;

    wavePreview.innerHTML = '';
    const preview = data.preview || [];
    const shown = preview.slice(0, 12);
    shown.forEach((e) => {
      const chip = document.createElement('div');
      chip.className = 'preview-chip';
      const col = e.attribute ? ATTR_COLOR[e.attribute] : '#888';
      chip.textContent = (e.type === 'boss' ? '👑' : '') + (e.attribute ? ATTR_NAME[e.attribute] : '일반') + ` HP${e.health}`;
      chip.style.borderColor = col;
      chip.style.color = col;
      wavePreview.appendChild(chip);
    });
    if (preview.length > 12) {
      const more = document.createElement('div');
      more.className = 'preview-chip';
      more.textContent = `+${preview.length - 12}`;
      wavePreview.appendChild(more);
    }

    overlayWave.classList.remove('hidden');
    setTimeout(() => overlayWave.classList.add('hidden'), 2500);
  }

  function showGameOver(waveNum) {
    gameoverWave.textContent = `${waveNum}웨이브까지 방어했습니다!`;
    overlayGameover.classList.remove('hidden');
  }

  function showLevelUp() {
    levelupPopup.classList.remove('hidden');
    setTimeout(() => levelupPopup.classList.add('hidden'), 2200);
  }

  btnReload.addEventListener('click', () => window.location.reload());

  /* ═══════════════════════════════════════════════════
   * 캔버스 클릭 → 가장 가까운 타워 슬롯 선택
   * ═══════════════════════════════════════════════════ */
  cvGame.addEventListener('click', (e) => {
    if (!CFG || !CFG.towers || !CFG.towers.slots) return;
    const rect = cvGame.getBoundingClientRect();
    const scaleX = cvGame.width / rect.width;
    const scaleY = cvGame.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top)  * scaleY;

    let bestIdx = -1, bestDist = 50;
    CFG.towers.slots.forEach((slot, idx) => {
      const dx = slot.position.x - mx;
      const dy = slot.position.y - my;
      const d  = Math.sqrt(dx*dx + dy*dy);
      if (d < bestDist) { bestDist = d; bestIdx = idx; }
    });
    if (bestIdx >= 0) selectSlot(bestIdx);
  });

  /* ═══════════════════════════════════════════════════
   * 키보드 (Enter / Space → requestNextWave)
   * ═══════════════════════════════════════════════════ */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (socket && snap && snap.phase === 'intermission') {
        socket.emit('requestNextWave');
      }
    }
  });

  /* ═══════════════════════════════════════════════════
   * Socket.io 연결 & 이벤트 핸들러
   * ═══════════════════════════════════════════════════ */
  let socket = null;

  function initSocket() {
    socket = io();

    socket.on('connect', () => {
      console.log('[Socket] 연결됨:', socket.id);
    });

    socket.on('disconnect', (reason) => {
      console.warn('[Socket] 연결 해제:', reason);
      floatMsg('서버 연결이 끊겼습니다', '#ff6060');
    });

    // ── connected: CFG 수신 후 초기화 ──
    socket.on('connected', (data) => {
      myId = data.playerId;
      CFG  = data.config;
      snap = data.gameState;

      console.log('[Game] 플레이어 ID:', myId);

      overlayConnecting.classList.add('hidden');
      drawMap();
      buildTowerPanel();
      updateHud();
    });

    // ── tick: 매 50ms 상태 갱신 ──
    let _panelTick = 0;
    socket.on('tick', (data) => {
      snap = data;
      updateHud();
      // 패널은 5틱(250ms)마다 갱신 — 불필요한 DOM 재빌드 방지
      if (++_panelTick >= 5) { _panelTick = 0; buildTowerPanel(); }
    });

    // ── waveStart ──
    socket.on('waveStart', (data) => {
      showWaveOverlay(data);
      floatMsg(`⚔ 웨이브 ${data.waveNumber} 시작!`, '#c0c8ff');
    });

    // ── waveClear ──
    socket.on('waveClear', (data) => {
      floatMsg(`✅ 웨이브 ${data.waveNumber} 클리어! +${data.bonusGold}G`, '#40d080');
    });

    // ── enemySpawned ──
    socket.on('enemySpawned', (data) => {
      localEnemies.set(data.id, {
        x: data.position.x, y: data.position.y, progress: 0,
      });
    });

    // ── enemyKilled ──
    socket.on('enemyKilled', (data) => {
      const local = localEnemies.get(data.enemyId);
      if (local) {
        spawnParticles(local.x, local.y, null, 12, { speed: 120, size: 5 });
        // 골드 파티클 (황금색)
        spawnDmgNumber(local.x, local.y - 10, `+${data.gold}G`, 'lightning', false);
        localEnemies.delete(data.enemyId);
      }
    });

    // ── enemyReachedEnd ──
    socket.on('enemyReachedEnd', (data) => {
      floatMsg(`💀 적이 통과! -20 HP`, '#ff4040');
      localEnemies.delete(data.enemyId);
    });

    // ── spellCreated ──
    socket.on('spellCreated', (data) => {
      const attr = data.attribute;
      const pos  = data.position;
      spawnParticles(pos.x, pos.y, attr, 8, { speed: 60, size: 3 });
      // 빔 이펙트 (타워 → 발사구 방향)
      if (CFG && CFG.towers && CFG.towers.slots) {
        const slot = CFG.towers.slots[data.sourceSlot];
        if (slot) {
          spawnBeam(slot.position.x, slot.position.y, pos.x + 20, pos.y, attr, 6);
        }
      }
    });

    // ── spellHit ──
    socket.on('spellHit', (data) => {
      const pos = data.position || { x: 400, y: 288 };
      const attr = data.attribute;
      const isCrit = data.isCritical;
      spawnParticles(pos.x, pos.y, attr, isCrit ? 20 : 10, { speed: isCrit ? 160 : 100, size: isCrit ? 6 : 4 });
      spawnDmgNumber(pos.x, pos.y, data.damage, attr, isCrit);
    });

    // ── towerAttack ──
    socket.on('towerAttack', (data) => {
      const pos = data.position;
      if (!pos) return;
      spawnParticles(pos.x, pos.y, data.attribute, 4, { speed: 40, size: 3 });
    });

    // ── towerUpdated ──
    socket.on('towerUpdated', () => {
      buildTowerPanel();
    });

    // ── playerLevelUp ──
    socket.on('playerLevelUp', (data) => {
      if (data.playerId === myId) {
        showLevelUp();
        floatMsg(`🎉 레벨 업! Lv.${data.level}`, '#f0d020');
      }
    });

    // ── gameOver ──
    socket.on('gameOver', (data) => {
      showGameOver(data.waveNumber);
    });

    // ── gameReady ──
    socket.on('gameReady', (data) => {
      floatMsg(`🏰 게임 시작! ${Math.round(data.firstWaveIn)}초 후 웨이브`, '#6080ff');
    });

    // ── spellResult (나에게만) ──
    socket.on('spellResult', (data) => {
      if (data.ok) {
        // 서버: { ok:true, spell:{...attribute...} } 형태이므로 양쪽 경로 처리
        const attr = data.attribute || (data.spell && data.spell.attribute) || 'fire';
        floatMsg(`✨ ${ATTR_NAME[attr] || attr} 마법 발사!`, ATTR_COLOR[attr]);
      } else {
        const msgs = {
          'NOT_IN_WAVE':        '웨이브 중에만 마법을 사용할 수 있습니다',
          'INSUFFICIENT_MANA':  `마나 부족 (${data.current || 0}/${data.required || '?'})`,
          'NO_TARGET':          '사정거리 내 적이 없습니다',
          'INVALID_SHAPE':      '알 수 없는 도형입니다',
          'INVALID_SLOT':       '잘못된 슬롯입니다',
          'LOW_CONFIDENCE':     '도형 인식 신뢰도 부족',
        };
        const msg = msgs[data.code] || data.code || '마법 실패';
        floatMsg(`⚠ ${msg}`, '#ff8040');
      }
    });

    // ── assignResult ──
    socket.on('assignResult', (data) => {
      if (data.ok) {
        const attr = data.attribute;
        floatMsg(`타워 ${data.slotId + 1} → ${ATTR_NAME[attr]} 배정 완료`, ATTR_COLOR[attr]);
      } else {
        const msgs = {
          'INSUFFICIENT_GOLD': `골드 부족 (${data.current}/${data.required})`,
          'INVALID_ATTRIBUTE': '잘못된 속성',
          'INVALID_SLOT':      '잘못된 슬롯',
        };
        floatMsg(`⚠ 배정 실패: ${msgs[data.code] || data.code}`, '#ff6040');
      }
    });

    // ── upgradeResult ──
    socket.on('upgradeResult', (data) => {
      if (data.ok) {
        floatMsg(`⬆ 슬롯 ${data.slotId + 1} 강화! Lv.${data.level}`, '#f0d020');
      } else {
        const msgs = {
          'MAX_LEVEL':         '이미 최고 레벨입니다',
          'NO_SKILL_POINTS':   '스킬 포인트가 없습니다',
          'INSUFFICIENT_GOLD': `골드 부족 (${data.current}/${data.required})`,
        };
        floatMsg(`⚠ 강화 실패: ${msgs[data.code] || data.code}`, '#ff6040');
      }
    });

    // ── nextWaveAck ──
    socket.on('nextWaveAck', (data) => {
      floatMsg(`▶ 웨이브 ${data.waveNumber} 준비 중...`, '#8090ff');
    });

    // ── error ──
    socket.on('error', (data) => {
      floatMsg(`오류: ${data.code}`, '#ff4040');
    });
  }

  /* ═══════════════════════════════════════════════════
   * 메인 게임 루프
   * ═══════════════════════════════════════════════════ */
  function gameLoop(ts) {
    const dt = Math.min((ts - lastRender) / 1000, 0.1);
    lastRender = ts;

    renderGame(dt);
    renderVfx(dt);
    renderUi();

    requestAnimationFrame(gameLoop);
  }

  /* ═══════════════════════════════════════════════════
   * ShapeRecognizer 초기화
   * ═══════════════════════════════════════════════════ */
  async function initShapeRecognizer() {
    if (!window.ShapeRecognizer) {
      console.warn('[App] ShapeRecognizer 없음 — 드로잉 기능 비활성');
      return;
    }
    try {
      floatMsg('🔮 AI 모델 학습 중... (잠시 대기)', '#a080ff');
      const metrics = await window.ShapeRecognizer.init((progress) => {
        if (progress.phase === 'training' && progress.epoch && progress.epoch % 7 === 0) {
          const pct = Math.round(progress.progress * 100);
          txtWave.textContent = `AI 학습 ${pct}%`;
        }
      });
      floatMsg(`✅ AI 준비 완료 (정확도 ${metrics.finalValAcc}%)`, '#40d080');
      console.log('[App] ShapeRecognizer 완료:', metrics);
    } catch (e) {
      console.error('[App] ShapeRecognizer 초기화 실패:', e);
      floatMsg('⚠ AI 모델 실패 — 마법 인식 불가', '#ff4040');
    }
  }

  /* ═══════════════════════════════════════════════════
   * 초기화 진입점
   * ═══════════════════════════════════════════════════ */
  function init() {
    // 드로잉 캔버스 초기 배경
    clearDrawCanvas(true);

    // 게임 루프 시작
    requestAnimationFrame((ts) => {
      lastRender = ts;
      requestAnimationFrame(gameLoop);
    });

    // 소켓 연결
    initSocket();

    // AI 모델 비동기 로드 (게임 시작과 병렬)
    initShapeRecognizer();

    console.log('[App] 마법진 디펜스 클라이언트 시작');
  }

  // DOM 로드 완료 후 실행
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
