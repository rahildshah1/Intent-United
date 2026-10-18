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
})();
