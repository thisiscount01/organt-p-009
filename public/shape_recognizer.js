/**
 * ShapeRecognizer — TF.js 브라우저 CNN 도형 인식 모듈
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 서빙 환경: 브라우저 클라이언트 (TF.js WebGL 백엔드)                │
 * │ 레이턴시 목표: < 5ms / predict (GPU 워밍업 후)                      │
 * │ 학습 데이터: 완전 합성 (Synthetic) — 외부 파일·서버 없음             │
 * │   - 클래스: circle · triangle · square · star · cross               │
 * │   - 클래스당 샘플: SAMPLES_PER_CLASS (기본 400)                     │
 * │   - Augmentation: 회전 ±45°, 스케일 0.45~0.95, 평행이동 ±25%       │
 * │                   + 지터 ±4px, 선 굵기 변화                        │
 * │ 모델: Lightweight CNN + GlobalAvgPool (~28k 파라미터)               │
 * │   Conv32 → Pool → Conv64 → Pool → Conv128 → GAP → Dense64 → Dense5 │
 * │ 라이선스: 자체 합성 학습 — 외부 데이터셋 없음                       │
 * │ API: window.ShapeRecognizer.init / predict / isReady                │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * I/O 스펙 (api-spec.md 합의 사항):
 *   입력: strokePoints = [{x, y}, ...] — 220×220 캔버스 좌표
 *   출력: { shape: 'circle'|'triangle'|'square'|'star'|'cross', confidence: 0~1 }
 *         confidence < MIN_CONFIDENCE(0.65)이면 null 반환
 */
(function (global) {
  'use strict';

  /* ──────────────────────────────────────────────────────────────────────
   * 설정 상수 (game-config.json ml 섹션과 동기화)
   * ────────────────────────────────────────────────────────────────────── */
  var SHAPES          = ['circle', 'triangle', 'square', 'star', 'cross'];
  var IMG_SIZE        = 28;       // 28×28 grayscale 입력
  var CANVAS_SIZE     = 220;      // 드로잉 캔버스 크기 (px)
  var MIN_CONFIDENCE  = 0.65;     // game-config.json ml.minConfidence
  var SAMPLES_PER_CLASS = 400;    // 클래스당 합성 샘플 수
  var BATCH_SIZE      = 64;
  var EPOCHS          = 28;
  var VAL_SPLIT       = 0.12;     // 12% 검증 세트

  /* ──────────────────────────────────────────────────────────────────────
   * 내부 상태
   * ────────────────────────────────────────────────────────────────────── */
  var _model    = null;
  var _ready    = false;
  var _metrics  = null;
  var _offCtx   = null;  // 28×28 오프스크린 캔버스 컨텍스트

  /* ──────────────────────────────────────────────────────────────────────
   * 오프스크린 캔버스 (지연 생성 — DOM 준비 후)
   * ────────────────────────────────────────────────────────────────────── */
  function _getCtx() {
    if (!_offCtx) {
      var c = document.createElement('canvas');
      c.width  = IMG_SIZE;
      c.height = IMG_SIZE;
      _offCtx  = c.getContext('2d', { willReadFrequently: true });
    }
    return _offCtx;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * 스트로크 → 28×28 Float32 픽셀 배열
   *   - 바운딩 박스로 정규화 후 28×28에 렌더링
   *   - 흰색 선 / 검정 배경 → R 채널 값(0~1)
   * ────────────────────────────────────────────────────────────────────── */
  function _strokeToPixels(pts, lineWidth) {
    if (!pts || pts.length < 2) return null;
    lineWidth = lineWidth || 1.8;

    var ctx = _getCtx();

    /* 바운딩 박스 */
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var pi = 0; pi < pts.length; pi++) {
      var p = pts[pi];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    var bw = maxX - minX;
    var bh = maxY - minY;
    if (Math.max(bw, bh) < 2) return null; // 너무 작은 스트로크

    /* 스케일·오프셋 계산 (패딩 포함) */
    var pad = 2;
    var s   = (IMG_SIZE - pad * 2) / Math.max(bw, bh);
    var ox  = pad + (IMG_SIZE - pad * 2 - bw * s) / 2 - minX * s;
    var oy  = pad + (IMG_SIZE - pad * 2 - bh * s) / 2 - minY * s;

    /* 렌더링 */
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = lineWidth;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    ctx.beginPath();
    ctx.moveTo(pts[0].x * s + ox, pts[0].y * s + oy);
    for (var i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x * s + ox, pts[i].y * s + oy);
    }
    ctx.stroke();

    /* R 채널 추출 (흰색 = 1, 검정 = 0) */
    var raw     = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE).data;
    var pixels  = new Float32Array(IMG_SIZE * IMG_SIZE);
    for (var k = 0; k < pixels.length; k++) {
      pixels[k] = raw[k * 4] / 255;
    }
    return pixels;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Augmentation 헬퍼
   * ────────────────────────────────────────────────────────────────────── */

  /** 랜덤 회전·스케일·평행이동 */
  function _augment(pts) {
    var cx    = CANVAS_SIZE / 2;
    var cy    = CANVAS_SIZE / 2;
    var scale = 0.45 + Math.random() * 0.50;         // 0.45~0.95
    var angle = (Math.random() - 0.5) * Math.PI * 0.5; // ±45°
    var cos   = Math.cos(angle);
    var sin   = Math.sin(angle);
    var tx    = (Math.random() - 0.5) * CANVAS_SIZE * 0.25;
    var ty    = (Math.random() - 0.5) * CANVAS_SIZE * 0.25;

    return pts.map(function (p) {
      var dx = p.x - cx;
      var dy = p.y - cy;
      return {
        x: cx + (dx * cos - dy * sin) * scale + tx,
        y: cy + (dx * sin + dy * cos) * scale + ty,
      };
    });
  }

  /** 포인트별 가우시안 노이즈 */
  function _jitter(pts, mag) {
    return pts.map(function (p) {
      return {
        x: p.x + (Math.random() - 0.5) * mag,
        y: p.y + (Math.random() - 0.5) * mag,
      };
    });
  }

  /** 두 점 사이 n개 보간 */
  function _seg(a, b, n) {
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    return pts;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * 합성 도형 생성기 (220×220 공간)
   * ────────────────────────────────────────────────────────────────────── */
  var _GEN = {

    circle: function () {
      var cx = CANVAS_SIZE / 2, cy = CANVAS_SIZE / 2;
      var r  = CANVAS_SIZE * 0.38;
      var start = Math.random() * Math.PI * 2;
      var pts = [];
      /* 가끔 열린 호 생성 (실제 손그림 모사) */
      var closeRatio = 0.85 + Math.random() * 0.15; // 85~100% 완성
      var steps = Math.round(72 * closeRatio);
      for (var i = 0; i <= steps; i++) {
        var a = start + (i / steps) * Math.PI * 2 * closeRatio;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
      return _jitter(_augment(pts), 4);
    },

    triangle: function () {
      var cx = CANVAS_SIZE / 2, cy = CANVAS_SIZE / 2;
      var r  = CANVAS_SIZE * 0.38;
      var start = Math.random() * Math.PI * 2;
      var corners = [0, 1, 2].map(function (i) {
        var a = start + (i / 3) * Math.PI * 2;
        return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
      });
      var pts = [];
      for (var i = 0; i < 3; i++) {
        var arr = _seg(corners[i], corners[(i + 1) % 3], 25);
        for (var j = 0; j < arr.length; j++) pts.push(arr[j]);
      }
      return _jitter(_augment(pts), 4);
    },

    square: function () {
      var cx   = CANVAS_SIZE / 2, cy = CANVAS_SIZE / 2;
      var half = CANVAS_SIZE * 0.36;
      /* 미세 회전으로 사각형/마름모 연속 스펙트럼 */
      var r   = (Math.random() - 0.5) * 0.25;
      var cos = Math.cos(r), sin = Math.sin(r);
      var rot = function (p) {
        return {
          x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
          y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
        };
      };
      var corners = [
        rot({ x: cx - half, y: cy - half }),
        rot({ x: cx + half, y: cy - half }),
        rot({ x: cx + half, y: cy + half }),
        rot({ x: cx - half, y: cy + half }),
      ];
      var pts = [];
      for (var i = 0; i < 4; i++) {
        var arr = _seg(corners[i], corners[(i + 1) % 4], 22);
        for (var j = 0; j < arr.length; j++) pts.push(arr[j]);
      }
      return _jitter(_augment(pts), 4);
    },

    star: function () {
      var cx = CANVAS_SIZE / 2, cy = CANVAS_SIZE / 2;
      var outerR = CANVAS_SIZE * 0.40;
      /* inner/outer 비율 다양화 */
      var innerR = outerR * (0.33 + Math.random() * 0.14);
      var start  = Math.random() * Math.PI * 2;
      var verts = [];
      for (var i = 0; i < 10; i++) {
        var a = start + (i / 10) * Math.PI * 2 - Math.PI / 2;
        var rr = (i % 2 === 0) ? outerR : innerR;
        verts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
      }
      verts.push(verts[0]);
      var pts = [];
      for (var v = 0; v < verts.length - 1; v++) {
        var arr = _seg(verts[v], verts[v + 1], 10);
        for (var j = 0; j < arr.length; j++) pts.push(arr[j]);
      }
      return _jitter(_augment(pts), 4);
    },

    cross: function () {
      var cx  = CANVAS_SIZE / 2, cy = CANVAS_SIZE / 2;
      var len = CANVAS_SIZE * 0.40;
      /* 팔 길이 약간 불균형 (손그림 모사) */
      var lx = len * (0.85 + Math.random() * 0.3);
      var ly = len * (0.85 + Math.random() * 0.3);
      var h  = _seg({ x: cx - lx, y: cy }, { x: cx + lx, y: cy }, 35);
      var v  = _seg({ x: cx, y: cy - ly }, { x: cx, y: cy + ly }, 35);
      var pts = h.concat(v);
      return _jitter(_augment(pts), 4);
    },
  };

  /* ──────────────────────────────────────────────────────────────────────
   * CNN 모델 정의
   *   구조: Conv32→Pool→Conv64→Pool→Conv128→GlobalAvgPool→Dense64→Dense5
   *   파라미터: ~28k (경량, 브라우저 추론 최적)
   * ────────────────────────────────────────────────────────────────────── */
  function _buildModel() {
    var m = tf.sequential();

    /* Block 1: 28×28×1 → 14×14×32 */
    m.add(tf.layers.conv2d({
      inputShape: [IMG_SIZE, IMG_SIZE, 1],
      filters: 32, kernelSize: 3,
      activation: 'relu', padding: 'same',
    }));
    m.add(tf.layers.maxPooling2d({ poolSize: [2, 2] }));

    /* Block 2: 14×14×32 → 7×7×64 */
    m.add(tf.layers.conv2d({
      filters: 64, kernelSize: 3,
      activation: 'relu', padding: 'same',
    }));
    m.add(tf.layers.maxPooling2d({ poolSize: [2, 2] }));

    /* Block 3: 7×7×64 → 7×7×128 → GlobalAvgPool → 128 */
    m.add(tf.layers.conv2d({
      filters: 128, kernelSize: 3,
      activation: 'relu', padding: 'same',
    }));
    m.add(tf.layers.globalAveragePooling2d({}));

    /* Classifier head */
    m.add(tf.layers.dense({ units: 64, activation: 'relu' }));
    m.add(tf.layers.dropout({ rate: 0.35 }));
    m.add(tf.layers.dense({ units: SHAPES.length, activation: 'softmax' }));

    m.compile({
      optimizer: tf.train.adam(0.0015),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy'],
    });
    return m;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * 데이터셋 생성 (합성)
   *   - 클래스 균형: 클래스당 정확히 SAMPLES_PER_CLASS 생성
   *   - 각 클래스 생성 후 이벤트 루프에 양보 (브라우저 블로킹 방지)
   * ────────────────────────────────────────────────────────────────────── */
  var _GENS = [_GEN.circle, _GEN.triangle, _GEN.square, _GEN.star, _GEN.cross];

  async function _buildDataset(onProgress) {
    var pixelBufs = [];
    var labels    = [];

    for (var ci = 0; ci < SHAPES.length; ci++) {
      var gen = _GENS[ci];
      for (var si = 0; si < SAMPLES_PER_CLASS; si++) {
        /* 선 굵기 약간 변화 (1.2~2.4) */
        var lw = 1.2 + Math.random() * 1.2;
        var px = _strokeToPixels(gen(), lw);
        if (px) {
          pixelBufs.push(px);
          labels.push(ci);
        }
      }
      if (onProgress) {
        onProgress({ phase: 'generating', progress: (ci + 1) / SHAPES.length });
      }
      /* 클래스 단위 양보 */
      await new Promise(function (r) { setTimeout(r, 0); });
    }

    var n = pixelBufs.length;

    /* Fisher-Yates 셔플 */
    for (var i = n - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var tmpPx = pixelBufs[i]; pixelBufs[i] = pixelBufs[j]; pixelBufs[j] = tmpPx;
      var tmpLb = labels[i];    labels[i]    = labels[j];    labels[j]    = tmpLb;
    }

    /* Float32Array로 평탄화 */
    var flat = new Float32Array(n * IMG_SIZE * IMG_SIZE);
    for (var k = 0; k < n; k++) {
      flat.set(pixelBufs[k], k * IMG_SIZE * IMG_SIZE);
    }

    var xs = tf.tensor4d(flat, [n, IMG_SIZE, IMG_SIZE, 1]);
    var labelT = tf.tensor1d(labels, 'int32');
    var ys = tf.oneHot(labelT, SHAPES.length).cast('float32');
    labelT.dispose();

    /* 클래스 분포 확인 (콘솔 로그) */
    var dist = new Array(SHAPES.length).fill(0);
    for (var l = 0; l < labels.length; l++) dist[labels[l]]++;
    console.log('[ShapeRecognizer] 클래스 분포:', SHAPES.map(function (s, idx) {
      return s + ':' + dist[idx];
    }).join(' | '));

    return { xs: xs, ys: ys, n: n };
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Public API
   * ────────────────────────────────────────────────────────────────────── */

  /**
   * ShapeRecognizer.init([onProgress]) → Promise<metrics>
   *
   * 합성 데이터 생성 + CNN 학습. 이미 완료된 경우 즉시 반환.
   *
   * @param {function} [onProgress]
   *   콜백({ phase:'generating'|'training'|'ready', progress:0~1, epoch?, loss?, acc?, val_acc? })
   * @returns {Promise<{samplesPerClass, totalSamples, epochs, finalValAcc, trainMs}>}
   */
  async function init(onProgress) {
    if (_ready) return _metrics;
    if (!global.tf) {
      throw new Error('[ShapeRecognizer] TensorFlow.js가 로드되지 않았습니다. CDN 스크립트를 먼저 로드하세요.');
    }

    console.log('[ShapeRecognizer] ▶ 합성 데이터 생성 중...');
    var t0 = performance.now();

    var dataset = await _buildDataset(onProgress);
    console.log('[ShapeRecognizer] ▶ ' + dataset.n + '개 샘플 준비 (' +
      SHAPES.length + '클래스 × ' + SAMPLES_PER_CLASS + ')');

    _model = _buildModel();
    console.log('[ShapeRecognizer] ▶ CNN 학습 시작 (WebGL 백엔드)...');
    if (onProgress) onProgress({ phase: 'training', progress: 0 });

    var finalValAcc = 0;

    await _model.fit(dataset.xs, dataset.ys, {
      epochs:          EPOCHS,
      batchSize:       BATCH_SIZE,
      validationSplit: VAL_SPLIT,
      shuffle:         true,
      callbacks: {
        onEpochEnd: function (epoch, logs) {
          finalValAcc = logs.val_acc != null ? logs.val_acc : logs.acc;
          var pct = function (v) { return (v * 100).toFixed(1) + '%'; };
          console.log(
            '[ShapeRecognizer] E' + String(epoch + 1).padStart(2, '0') + '/' + EPOCHS +
            ' | loss=' + logs.loss.toFixed(3) +
            ' | acc=' + pct(logs.acc) +
            (logs.val_acc != null ? ' | val_acc=' + pct(logs.val_acc) : '')
          );
          if (onProgress) {
            onProgress({
              phase:    'training',
              progress: (epoch + 1) / EPOCHS,
              epoch:    epoch + 1,
              loss:     logs.loss,
              acc:      logs.acc,
              val_acc:  logs.val_acc,
            });
          }
        },
      },
    });

    dataset.xs.dispose();
    dataset.ys.dispose();

    /* GPU 셰이더 워밍업 (첫 predict 레이턴시 방지) */
    tf.tidy(function () {
      var dummy = tf.zeros([1, IMG_SIZE, IMG_SIZE, 1]);
      _model.predict(dummy);
    });

    var trainMs = Math.round(performance.now() - t0);

    _metrics = {
      samplesPerClass: SAMPLES_PER_CLASS,
      totalSamples:    dataset.n,
      epochs:          EPOCHS,
      finalValAcc:     parseFloat((finalValAcc * 100).toFixed(1)),
      trainMs:         trainMs,
    };

    _ready = true;
    console.log(
      '[ShapeRecognizer] ✅ 준비 완료 | val_acc=' + _metrics.finalValAcc + '%' +
      ' | 학습시간=' + (trainMs / 1000).toFixed(1) + 's'
    );

    if (onProgress) onProgress({ phase: 'ready', progress: 1, metrics: _metrics });
    return _metrics;
  }

  /**
   * ShapeRecognizer.predict(strokePoints) → { shape, confidence } | null
   *
   * @param {Array<{x:number, y:number}>} strokePoints  — 220×220 캔버스 좌표 배열
   * @returns {{ shape: string, confidence: number } | null}
   *   confidence < MIN_CONFIDENCE(0.65)이면 null 반환
   */
  function predict(strokePoints) {
    if (!_ready || !_model) {
      console.warn('[ShapeRecognizer] 아직 준비되지 않았습니다. init() 완료를 기다리세요.');
      return null;
    }
    if (!strokePoints || strokePoints.length < 5) return null;

    var pixels = _strokeToPixels(strokePoints);
    if (!pixels) return null;

    return tf.tidy(function () {
      var input  = tf.tensor4d(pixels, [1, IMG_SIZE, IMG_SIZE, 1]);
      var preds  = _model.predict(input);
      var values = preds.dataSync(); // Float32Array

      var maxIdx = 0;
      for (var i = 1; i < values.length; i++) {
        if (values[i] > values[maxIdx]) maxIdx = i;
      }

      var confidence = values[maxIdx];
      if (confidence < MIN_CONFIDENCE) return null;

      return { shape: SHAPES[maxIdx], confidence: confidence };
    });
  }

  /**
   * ShapeRecognizer.isReady() → boolean
   * 모델 학습이 완료되어 predict 가능한 상태인지 반환
   */
  function isReady() {
    return _ready;
  }

  /**
   * ShapeRecognizer.getMetrics() → Object | null
   * 학습 완료 후 메트릭 반환
   * { samplesPerClass, totalSamples, epochs, finalValAcc(%), trainMs }
   */
  function getMetrics() {
    return _metrics;
  }

  /**
   * ShapeRecognizer.getShapes() → string[]
   * 인식 가능한 도형 목록
   */
  function getShapes() {
    return SHAPES.slice();
  }

  /* ──────────────────────────────────────────────────────────────────────
   * 글로벌 노출
   * ────────────────────────────────────────────────────────────────────── */
  global.ShapeRecognizer = {
    init:       init,
    predict:    predict,
    isReady:    isReady,
    getMetrics: getMetrics,
    getShapes:  getShapes,
    /* 디버그용: 합성 샘플 한 개를 data URL로 시각화 */
    debugSample: function (shapeName) {
      var idx = SHAPES.indexOf(shapeName);
      if (idx < 0) return null;
      var pts = _GENS[idx]();
      _strokeToPixels(pts);
      return _getCtx().canvas.toDataURL();
    },
  };

  console.log('[ShapeRecognizer] 모듈 로드 완료. ShapeRecognizer.init() 을 호출하면 학습이 시작됩니다.');
  console.log('[ShapeRecognizer] 인식 도형:', SHAPES.join(' / '), '| 최소신뢰도:', MIN_CONFIDENCE);

})(window);
