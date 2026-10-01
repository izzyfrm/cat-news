// CatNews starfield — draws a slowly drifting, twinkling sky on <canvas id="space">.
// Three depth layers move at different speeds (and follow the mouse a little),
// and every so often a shooting star streaks across.

(() => {
  const canvas = document.getElementById("space");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // real star colours: mostly white, some blue-white, a few warm ones
  const TINTS = ["255,255,255", "255,255,255", "255,255,255", "200,220,255", "170,195,255", "255,236,210", "255,214,190"];
  const LAYERS = [
    { density: 0.00018, size: [0.3, 0.8], speed: 0.006, parallax: 6 },  // far
    { density: 0.00007, size: [0.6, 1.3], speed: 0.014, parallax: 14 }, // mid
    { density: 0.00002, size: [1.1, 1.9], speed: 0.028, parallax: 26 }, // near
  ];

  let w, h, dpr, stars = [], shooting = null;
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const rand = (a, b) => a + Math.random() * (b - a);

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth;
    h = innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    stars = [];
    LAYERS.forEach((layer, depth) => {
      const count = Math.round(w * h * layer.density);
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: rand(...layer.size),
          tint: TINTS[(Math.random() * TINTS.length) | 0],
          base: rand(0.35, 1),
          phase: Math.random() * Math.PI * 2,
          twinkle: rand(0.4, 1.6),
          depth,
        });
      }
    });
    if (still) draw(0);
  }

  function spawnShootingStar() {
    const fromLeft = Math.random() < 0.5;
    shooting = {
      x: fromLeft ? rand(0, w * 0.5) : rand(w * 0.5, w),
      y: rand(0, h * 0.35),
      vx: (fromLeft ? 1 : -1) * rand(9, 13),
      vy: rand(3, 5),
      life: 0,
      max: rand(45, 70),
    };
  }

  function draw(t) {
    ctx.clearRect(0, 0, w, h);

    // ease the parallax toward the mouse so it feels floaty, not twitchy
    mouse.x += (mouse.tx - mouse.x) * 0.04;
    mouse.y += (mouse.ty - mouse.y) * 0.04;

    for (const s of stars) {
      const layer = LAYERS[s.depth];
      if (!still) {
        s.x -= layer.speed;
        if (s.x < -2) s.x = w + 2;
      }
      const x = s.x + mouse.x * layer.parallax;
      const y = s.y + mouse.y * layer.parallax;
      const alpha = still ? s.base : s.base * (0.65 + 0.35 * Math.sin(t * 0.001 * s.twinkle + s.phase));

      ctx.fillStyle = `rgba(${s.tint},${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();

      // the brightest near stars get a soft glow + faint diffraction spikes
      if (s.depth === 2 && s.r > 1.5) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, s.r * 6);
        g.addColorStop(0, `rgba(${s.tint},${alpha * 0.35})`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x - s.r * 6, y - s.r * 6, s.r * 12, s.r * 12);
        ctx.strokeStyle = `rgba(${s.tint},${alpha * 0.25})`;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(x - s.r * 7, y); ctx.lineTo(x + s.r * 7, y);
        ctx.moveTo(x, y - s.r * 7); ctx.lineTo(x, y + s.r * 7);
        ctx.stroke();
      }
    }

    if (still) return;

    // shooting star: a fading streak with a bright head
    if (!shooting && Math.random() < 0.0025) spawnShootingStar();
    if (shooting) {
      const s = shooting;
      s.x += s.vx;
      s.y += s.vy;
      s.life++;
      const fade = Math.sin((s.life / s.max) * Math.PI);
      const tail = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * 9, s.y - s.vy * 9);
      tail.addColorStop(0, `rgba(255,255,255,${0.9 * fade})`);
      tail.addColorStop(1, "rgba(255,255,255,0)");
      ctx.strokeStyle = tail;
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 9, s.y - s.vy * 9);
      ctx.stroke();
      if (s.life >= s.max) shooting = null;
    }

    requestAnimationFrame(draw);
  }

  addEventListener("resize", resize);
  addEventListener("pointermove", (e) => {
    mouse.tx = (e.clientX / w - 0.5) * -2;
    mouse.ty = (e.clientY / h - 0.5) * -2;
  });

  resize();
  if (!still) requestAnimationFrame(draw);
})();
