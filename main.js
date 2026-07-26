/* Intent United — subtle motion layer
   Scroll-reveal (staggered), number count-up, and a gentle clay tilt.
   All effects bow out gracefully for prefers-reduced-motion. */

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- 1. Staggered scroll reveal ---------------------------------- */
  var reveals = Array.prototype.slice.call(document.querySelectorAll(".reveal"));

  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveals.forEach(function (el) { el.classList.add("in"); });
  } else {
    // stagger each element relative to its revealing siblings
    reveals.forEach(function (el) {
      var parent = el.parentElement;
      var sibs = Array.prototype.filter.call(parent.children, function (c) {
        return c.classList.contains("reveal");
      });
      var i = sibs.indexOf(el);
      el.style.transitionDelay = Math.min(i, 6) * 0.09 + "s";
    });

    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0, rootMargin: "0px 0px -10% 0px" });

    reveals.forEach(function (el) { revealObserver.observe(el); });

    // Safety net: reveal anything already inside the viewport on load so a
    // page never appears empty before the user scrolls. The observer alone
    // should handle this, but some browsers are slow to fire the first
    // intersection (font/layout shifts), which left in-frame items hidden.
    function revealInView() {
      var vh = window.innerHeight || document.documentElement.clientHeight;
      reveals.forEach(function (el) {
        if (el.classList.contains("in")) return;
        var r = el.getBoundingClientRect();
        if (r.top < vh && r.bottom > 0) {
          el.classList.add("in");
          revealObserver.unobserve(el);
        }
      });
    }
    if (document.readyState === "complete") revealInView();
    else window.addEventListener("load", revealInView);
  }

  /* ---- 2. Count-up numbers ----------------------------------------- */
  function formatNumber(n) {
    return Math.round(n).toLocaleString("en-US");
  }

  function animateCount(el) {
    var target = parseFloat(el.getAttribute("data-count"));
    var prefix = el.getAttribute("data-prefix") || "";
    var suffix = el.getAttribute("data-suffix") || "";
    if (isNaN(target)) return;

    if (reduceMotion) {
      el.textContent = prefix + formatNumber(target) + suffix;
      return;
    }

    var duration = 1500;
    var start = null;

    function tick(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      // easeOutCubic
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = prefix + formatNumber(target * eased) + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = prefix + formatNumber(target) + suffix;
    }
    requestAnimationFrame(tick);
  }

  var counters = document.querySelectorAll("[data-count]");
  if (counters.length) {
    if (!("IntersectionObserver" in window)) {
      Array.prototype.forEach.call(counters, animateCount);
    } else {
      var countObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            animateCount(entry.target);
            countObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.6 });
      Array.prototype.forEach.call(counters, function (el) { countObserver.observe(el); });
    }
  }

  /* ---- 3. Scroll-progress bar -------------------------------------- */
  if (!reduceMotion) {
    var bar = document.createElement("div");
    bar.className = "scroll-progress";
    document.body.appendChild(bar);

    var barRaf = null;
    function updateBar() {
      barRaf = null;
      var doc = document.documentElement;
      var scrollable = doc.scrollHeight - doc.clientHeight;
      var p = scrollable > 0 ? doc.scrollTop / scrollable : 0;
      bar.style.transform = "scaleX(" + Math.min(Math.max(p, 0), 1) + ")";
    }
    window.addEventListener("scroll", function () {
      if (barRaf === null) barRaf = requestAnimationFrame(updateBar);
    }, { passive: true });
    updateBar();
  }

  /* ---- 4. Gentle 3D tilt on the hero visual card ------------------- */
  var tiltEl = document.querySelector(".visual-card");
  var finePointer = window.matchMedia("(pointer: fine)").matches;

  if (tiltEl && finePointer && !reduceMotion) {
    var maxTilt = 6; // degrees
    var raf = null;
    var settle = null;

    function onMove(e) {
      if (settle) { clearTimeout(settle); settle = null; }
      var rect = tiltEl.getBoundingClientRect();
      var px = (e.clientX - rect.left) / rect.width - 0.5;
      var py = (e.clientY - rect.top) / rect.height - 0.5;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () {
        tiltEl.style.transition = "transform 0.12s ease-out";
        tiltEl.style.animation = "none";
        tiltEl.style.transform =
          "perspective(1000px) rotateX(" + (-py * maxTilt).toFixed(2) +
          "deg) rotateY(" + (px * maxTilt).toFixed(2) + "deg) translateY(-4px)";
      });
    }

    function onLeave() {
      if (raf) cancelAnimationFrame(raf);
      tiltEl.style.transition = "transform 0.5s var(--ease-out)";
      tiltEl.style.transform = "";
      // Hand control back to the floating keyframe *only*. Restoring the full
      // CSS shorthand ("") also replayed the entrance fade-up, which is what
      // made the card flash after the pointer left it.
      settle = window.setTimeout(function () {
        tiltEl.style.transition = "";
        tiltEl.style.animation = "gentle-float 6.5s ease-in-out infinite";
        settle = null;
      }, 520);
    }

    tiltEl.addEventListener("mousemove", onMove);
    tiltEl.addEventListener("mouseleave", onLeave);
  }

  /* ---- 5. Realistic background water ripple ------------------------ */
  // A classic height-field water simulation running on a small offscreen
  // buffer, upscaled by the browser into a smooth surface. The pointer
  // pushes the "water", the disturbance propagates and damps over time, and
  // the height gradient is painted as light/shadow so it looks like ripples
  // travelling across the page's warm background.
  if (finePointer && !reduceMotion) {
    var canvas = document.createElement("canvas");
    canvas.className = "ripple-canvas";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    var ctx = canvas.getContext("2d");

    var cols, rows, prev, cur, image, data, scaleX, scaleY;
    var DAMP = 0.965;        // energy loss per frame (0.9–0.99)
    var TARGET = 220;        // ~buffer width in px; height scales to match

    function build() {
      var vw = window.innerWidth, vh = window.innerHeight;
      cols = Math.max(80, Math.round(TARGET));
      rows = Math.max(60, Math.round(TARGET * (vh / vw)));
      canvas.width = cols;
      canvas.height = rows;
      scaleX = cols / vw;    // viewport px -> buffer cell
      scaleY = rows / vh;
      prev = new Float32Array(cols * rows);
      cur = new Float32Array(cols * rows);
      image = ctx.createImageData(cols, rows);
      data = image.data;
      // start fully transparent; we only tint where the surface bends
      for (var i = 3; i < data.length; i += 4) data[i] = 0;
      lastScrollY = window.pageYOffset || 0;
      scrollAcc = 0;
    }
    var lastScrollY = 0, scrollAcc = 0;
    build();

    // Slide the whole surface with the page so ripples stay anchored to the
    // content beneath them instead of hovering in a fixed viewport spot.
    function shiftRows(arr, n) {           // n>0 = move pattern up
      if (n > 0) {
        arr.copyWithin(0, n * cols);
        arr.fill(0, (rows - n) * cols);
      } else {
        n = -n;
        arr.copyWithin(n * cols, 0, (rows - n) * cols);
        arr.fill(0, 0, n * cols);
      }
    }

    function syncScroll() {
      var y = window.pageYOffset || 0;
      // buffer cells the page moved since last sync (fractional part kept)
      scrollAcc += (y - lastScrollY) * scaleY;
      lastScrollY = y;
      var n = scrollAcc | 0;               // whole rows to shift now
      if (n === 0) return false;
      if (n >= rows || n <= -rows) {       // scrolled past a full screen
        prev.fill(0); cur.fill(0);
      } else {
        // scroll down (n>0) => content rises => pattern moves up
        shiftRows(prev, n);
        shiftRows(cur, n);
      }
      scrollAcc -= n;
      return true;
    }

    var resizeT = null;
    window.addEventListener("resize", function () {
      if (resizeT) clearTimeout(resizeT);
      resizeT = setTimeout(build, 180);
    });

    // Drop energy into a small disc around a buffer cell.
    function disturb(cx, cy, power) {
      for (var y = -2; y <= 2; y++) {
        for (var x = -2; x <= 2; x++) {
          var gx = cx + x, gy = cy + y;
          if (gx < 1 || gy < 1 || gx >= cols - 1 || gy >= rows - 1) continue;
          if (x * x + y * y > 5) continue;            // round the splash
          prev[gy * cols + gx] += power;
        }
      }
    }

    var lastX = 0, lastY = 0, primed = false;
    window.addEventListener("mousemove", function (e) {
      var cx = Math.round(e.clientX * scaleX);
      var cy = Math.round(e.clientY * scaleY);
      if (!primed) { lastX = cx; lastY = cy; primed = true; }
      var dx = cx - lastX, dy = cy - lastY;
      var speed = Math.min(Math.sqrt(dx * dx + dy * dy), 12);
      // faster movement = stronger wake, so a still cursor barely stirs it
      disturb(cx, cy, 0.28 + speed * 0.22);
      lastX = cx; lastY = cy;
    }, { passive: true });

    // Water surface colours (specular highlight + refraction shadow).
    var hiR = 255, hiG = 251, hiB = 240;   // warm cream sheen
    var loR = 12,  loG = 63,  loB = 60;    // deep teal shadow

    // Advance the wave field. Kept at ~30fps so the water stays calm and
    // gentle; after the swap the latest field lives in `prev`.
    function simulate() {
      var w = cols;
      for (var y = 1; y < rows - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var i = y * w + x;
          // wave equation: average of 4 neighbours minus the old height
          var val =
            ((prev[i - 1] + prev[i + 1] + prev[i - w] + prev[i + w]) * 0.5) -
            cur[i];
          cur[i] = val * DAMP;
        }
      }
      var t = prev; prev = cur; cur = t;   // prev = newest field
    }

    // Paint the surface from the newest field (`prev`) via its slope.
    function render() {
      var w = cols;
      for (var y = 1; y < rows - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var i = y * w + x;
          var slope = prev[i - 1] - prev[i + 1];
          var p = i * 4;
          if (slope >= 0) {
            var a = slope * 26; if (a > 150) a = 150;
            data[p] = hiR; data[p + 1] = hiG; data[p + 2] = hiB;
            data[p + 3] = a;
          } else {
            var b = -slope * 22; if (b > 130) b = 130;
            data[p] = loR; data[p + 1] = loG; data[p + 2] = loB;
            data[p + 3] = b;
          }
        }
      }
      ctx.putImageData(image, 0, 0);
    }

    // Drive at the display's full rate: scroll-pinning and repaint happen
    // every frame (so scrolling never lags), while the physics only steps
    // on alternate frames to keep the ripples gentle. Idle frames with no
    // motion do no work.
    var frameNo = 0;
    function frame() {
      requestAnimationFrame(frame);
      var moved = syncScroll();
      var stepped = false;
      if ((frameNo++ & 1) === 0) { simulate(); stepped = true; }
      if (stepped || moved) render();
    }
    requestAnimationFrame(frame);
  }
})();
