# Magic Defense Game — API Specification v1.0

> **합의 원칙**: 이 문서의 경로·필드명·이벤트명은 백엔드-프론트엔드 공동 합의 사항입니다.  
> 변경 시 양측 모두 이 문서를 먼저 수정하고 코드를 맞춥니다.

---

## 서비스 경계 (Service Boundary)

| 서비스 | 역할 | 비고 |
|--------|------|------|
| **Game Server** (`server.js`) | 게임 규칙·속성 상성·데미지 계산·웨이브 관리 | 단일 진실 원천 |
| **ML Inference Service** | 도형 인식 결과(`shape`)만 반환 | `POST /api/spell-recognized` 로 전달 |
| **Frontend Client** | 표시·입력 전용 | 규칙 계산 없음 |

---

## 공통

- Base URL: `http://localhost:3000`
- Socket.io path: `/socket.io`
- 인코딩: UTF-8 / JSON

---

## REST Endpoints

### `GET /api/health`
서버 상태 확인. 틱 카운터·현재 페이즈 포함.

**Response 200**
```json
{
  "status": "ok",
  "uptime": 42,
  "tickCount": 840,
  "phase": "wave",
  "waveNumber": 3,
  "players": 1,
  "enemies": 7,
  "tickRateTarget": 20,
  "tickMsTarget": 50
}
```

---

### `GET /api/state`
현재 게임 스냅샷 반환 (tick 이벤트와 동일한 구조).

---

### `GET /api/config`
`config/game-config.json` 전체 반환. 속성 목록·경로 좌표·마나 비용 등 UI 초기화에 사용.

---

### `POST /api/reload-config`
게임 서버 재시작 없이 `config/game-config.json` 을 다시 로드합니다.  
기획 변경(밸런스 수치) 시 이 엔드포인트만 호출하면 됩니다.

**Response 200**
```json
{ "ok": true, "message": "config reloaded" }
```

---

### `POST /api/spell-recognized`
**ML 추론 서비스 전용** — 도형 인식 결과를 게임 서버에 전달합니다.

**Request Body**
```json
{
  "playerId":   "socket-id-string",
  "shape":      "circle | triangle | square | star | cross",
  "confidence": 0.92,
  "slotId":     2
}
```

**Response 200**
```json
{
  "ok":            true,
  "code":          "OK",
  "spellId":       "s_17",
  "attribute":     "water",
  "manaRemaining": 74.5,
  "inferenceMs":   8
}
```

**오류 코드** (ok=false)

| code | 설명 |
|------|------|
| `LOW_CONFIDENCE` | confidence < minConfidence |
| `NOT_IN_WAVE` | 웨이브 진행 중이 아님 |
| `INSUFFICIENT_MANA` | 마나 부족 |
| `NO_TARGET` | 사정거리 내 적 없음 |
| `INVALID_SHAPE` | 알 수 없는 도형 |

---

## Socket.io 이벤트

### Client → Server

#### `castSpell`
플레이어가 마법진에 도형을 직접 그렸을 때 전송.
```json
{ "shape": "triangle", "slotId": 0 }
```

#### `assignTowerAttribute`
타워 슬롯에 속성 배정 (비용: `config.towers.assignCost` 골드).
```json
{ "slotId": 2, "attribute": "fire" }
```

#### `upgradeTower`
타워 업그레이드 (골드 + 스킬포인트 소모).
```json
{ "slotId": 2 }
```

#### `requestNextWave`
인터미션 스킵 요청. 페이즈가 `intermission`일 때만 유효.
```json
{}
```

---

### Server → Client

#### `connected`
접속 직후 1회 전송. 초기 플레이어 상태 + 전체 설정.
```json
{
  "playerId": "socket-id",
  "player": { "health": 100, "maxHealth": 100, "mana": 100, "maxMana": 100, "gold": 150, "level": 1, "towers": [] },
  "config": { "map": {}, "attributes": {}, "spells": {}, "towers": {} },
  "gameState": { "...": "buildSnapshot() 구조 참고" }
}
```

#### `tick`
20 TPS로 브로드캐스트되는 게임 상태 스냅샷.
```json
{
  "phase": "wave",
  "waveNumber": 3,
  "tickCount": 840,
  "intermissionTimer": 0,
  "intermissionSec": 0,
  "players": {
    "socket-id": {
      "id": "socket-id",
      "health": 100, "maxHealth": 100,
      "mana": 74.5, "maxMana": 100, "manaRegen": 4.6,
      "gold": 230, "xp": 45, "xpToNext": 100,
      "level": 2, "skillPoints": 1,
      "towers": [
        {
          "slotId": 0, "position": {"x": 192, "y": 144},
          "attribute": "fire", "level": 2,
          "range": 149, "damage": 45, "attackSpeed": 1.2
        }
      ]
    }
  },
  "enemies": [
    {
      "id": "e_3", "type": "attribute", "attribute": "water",
      "health": 110, "maxHealth": 170,
      "position": {"x": 253.4, "y": 288}, "progress": 0.18
    }
  ],
  "spells": [
    {
      "id": "s_11", "attribute": "fire",
      "position": {"x": 210.2, "y": 162.1}, "targetId": "e_3"
    }
  ]
}
```

#### `waveStart`
```json
{
  "waveNumber": 4,
  "enemyCount": 13,
  "preview": [
    { "type": "normal", "attribute": null, "health": 130, "speed": 84 }
  ]
}
```

#### `waveClear`
```json
{ "waveNumber": 3, "bonusGold": 80, "nextWaveIn": 5.0 }
```

#### `enemySpawned`
```json
{
  "id": "e_7", "type": "attribute", "attribute": "fire",
  "health": 130, "maxHealth": 130,
  "speed": 84, "position": {"x": 0, "y": 288}
}
```

#### `enemyKilled`
```json
{ "enemyId": "e_7", "killerId": "socket-id", "gold": 14, "xp": 25 }
```

#### `enemyReachedEnd`
```json
{ "enemyId": "e_5" }
```

#### `spellCreated`
```json
{
  "id": "s_11", "attribute": "fire",
  "sourceSlot": 0, "position": {"x": 192, "y": 144},
  "targetId": "e_7", "shape": "triangle"
}
```

#### `spellResult`
`castSpell` 요청의 응답 (요청한 클라이언트에게만).
```json
{ "ok": true, "spell": { "id": "s_11", "attribute": "fire", "damage": 45 } }
```

#### `spellHit`
투사체가 적에 명중했을 때 전 클라이언트 브로드캐스트.
```json
{
  "spellId": "s_11", "enemyId": "e_7",
  "damage": 90, "attribute": "fire",
  "isCritical": true,
  "enemyHp": 40, "enemyMaxHp": 130,
  "position": {"x": 253.4, "y": 288}
}
```

#### `towerAttack`
타워 자동공격 발생시 전 클라이언트 브로드캐스트.
```json
{
  "playerId": "socket-id", "slotId": 0,
  "enemyId": "e_7", "damage": 45,
  "attribute": "fire", "position": {"x": 192, "y": 144}
}
```

#### `towerUpdated`
속성 배정 또는 업그레이드 이후 전 클라이언트 브로드캐스트.
```json
{ "playerId": "socket-id", "slotId": 0, "attribute": "fire", "level": 2 }
```

#### `playerLevelUp`
```json
{ "playerId": "socket-id", "level": 3, "maxMana": 144, "skillPoints": 2 }
```

#### `assignResult` / `upgradeResult`
요청한 클라이언트에게만.
```json
{ "ok": true, "slotId": 0, "attribute": "fire", "gold": 100 }
```

#### `gameReady`
```json
{ "firstWaveIn": 4.0 }
```

#### `gameOver`
```json
{ "waveNumber": 7 }
```

---

## 속성 상성표

| 공격자 | 대상(2배) | 대상(0.5배) |
|--------|-----------|-------------|
| 불(fire) | 땅(earth) | 물(water) |
| 물(water) | 불(fire) | 바람(wind) |
| 바람(wind) | 물(water) | 번개(lightning) |
| 번개(lightning) | 바람(wind) | 땅(earth) |
| 땅(earth) | 번개(lightning) | 불(fire) |

---

## 도형 → 속성 매핑

| 도형 | shape 값 | 속성 |
|------|----------|------|
| 원 | `circle` | 물(water) |
| 삼각형 | `triangle` | 불(fire) |
| 사각형 | `square` | 땅(earth) |
| 별 | `star` | 번개(lightning) |
| 십자 | `cross` | 바람(wind) |

---

## 맵 좌표계

- 해상도: 800 × 576 px
- 원점: 좌측 상단 (0, 0)
- 경로: 8개 웨이포인트 (config.map.path 참고)
- 타워 슬롯: 5개 고정 위치 (config.towers.slots 참고)

---

*이 문서 마지막 수정: 백엔드 (server.js v1.0)*
