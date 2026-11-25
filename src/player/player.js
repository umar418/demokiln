(function () {
  "use strict";
  var data = JSON.parse(document.getElementById("demokiln-data").textContent);
  var root = document.getElementById("demokiln");
  var steps = data.steps;
  var index = 0;

  // All text goes in through textContent, never as markup.
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function emit(type, extra) {
    var detail = { source: "demokiln", type: type, step: index + 1, total: steps.length };
    for (var key in extra) detail[key] = extra[key];
    try { window.dispatchEvent(new CustomEvent("demokiln", { detail: detail })); } catch (e) { /* ignore */ }
    try { if (window.parent !== window) window.parent.postMessage(detail, "*"); } catch (e) { /* ignore */ }
  }

  if (data.accent && /^#[0-9a-fA-F]{6}$/.test(data.accent)) {
    document.documentElement.style.setProperty("--dk-accent", data.accent);
  }

  var frame = el("div", "dk-frame");
  var ratio = data.width / data.height;
  // Keep the whole player inside the window: the bar and footer take about 100px.
  frame.style.maxWidth = "min(" + (data.width + 2) + "px, calc((100vh - 132px) * " + ratio.toFixed(5) + "))";

  var bar = el("div", "dk-bar");
  var dots = el("div", "dk-dots");
  dots.setAttribute("aria-hidden", "true");
  dots.appendChild(el("i")); dots.appendChild(el("i")); dots.appendChild(el("i"));
  var count = el("div", "dk-count");
  bar.appendChild(dots);
  var heading = el("div", "dk-title");
  var titleText = el("span", "", data.title);
  var chapterText = el("span", "dk-chapter");
  heading.appendChild(titleText);
  heading.appendChild(chapterText);
  bar.appendChild(heading);
  bar.appendChild(count);

  var stage = el("div", "dk-stage");
  stage.style.aspectRatio = data.width + " / " + data.height;
  var view = null;
  var mountId = 0;
  var live_hotspot = null;
  var hot = el("button", "dk-hot");
  hot.type = "button";
  hot.hidden = true;
  var cap = el("div", "dk-cap");
  cap.setAttribute("aria-hidden", "true");
  var live = el("div", "dk-sr");
  live.setAttribute("aria-live", "polite");
  var end = el("div", "dk-end");
  end.hidden = true;
  var card = el("div", "dk-card");
  var endText = el("p");
  var actions = el("div", "dk-actions");
  var again = el("button", "dk-btn", "Watch again");
  again.type = "button";
  actions.appendChild(again);
  if (data.cta && /^https?:\/\//i.test(data.cta.url)) {
    var link = el("a", "dk-btn dk-primary", data.cta.label);
    link.href = data.cta.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.addEventListener("click", function () { emit("cta"); });
    actions.appendChild(link);
  } else {
    again.className = "dk-btn dk-primary";
  }
  card.appendChild(endText);
  card.appendChild(actions);
  end.appendChild(card);
  // Screens and the hotspot share one layer so they zoom together on small displays.
  var layer = el("div", "dk-layer");
  var zoom = { z: 1, tx: 0, ty: 0 };
  layer.appendChild(hot);
  stage.appendChild(layer);
  stage.appendChild(cap);
  stage.appendChild(end);
  stage.appendChild(live);

  var foot = el("div", "dk-foot");
  var back = el("button", "dk-btn", "Back");
  back.type = "button";
  var progress = el("div", "dk-progress");
  var fill = el("i");
  progress.appendChild(fill);
  var next = el("button", "dk-btn dk-primary", "Next");
  next.type = "button";
  foot.appendChild(back);
  foot.appendChild(progress);
  foot.appendChild(next);

  frame.appendChild(bar);
  frame.appendChild(stage);
  frame.appendChild(foot);
  root.appendChild(frame);

  var STYLE_TOKEN = /dk-style-7f3a:(\d+):/g;
  var RES_TOKEN = /dk-res-7f3a:(\d+):/g;
  // A captured page stores each stylesheet and file once; fill them back in before showing it.
  function expand(html) {
    return html
      .replace(STYLE_TOKEN, function (m, d) { return data.styles[+d] || ""; })
      .replace(RES_TOKEN, function (m, d) { return data.resources[+d] || "data:,"; });
  }

  function fitPage() {
    if (view && view.tagName === "IFRAME") view.style.transform = "scale(" + stage.clientWidth / data.width + ")";
  }

  function currentHotspot() {
    return live_hotspot || steps[index].hotspot;
  }

  function placeHotspot() {
    var step = steps[index];
    var spot = currentHotspot();
    if (spot && step.kind !== "end") {
      hot.hidden = false;
      hot.style.left = spot.x * 100 + "%";
      hot.style.top = spot.y * 100 + "%";
      hot.style.width = spot.w * 100 + "%";
      hot.style.height = spot.h * 100 + "%";
    } else {
      hot.hidden = true;
    }
    applyZoom();
  }

  // When the player is much smaller than the capture (a phone), move in on the hotspot
  // so the part that matters is readable.
  function applyZoom() {
    var spot = currentHotspot();
    var w = stage.clientWidth, h = stage.clientHeight;
    var shown = w / data.width;
    var z = 1, tx = 0, ty = 0;
    if (spot && steps[index].kind !== "end" && shown > 0 && shown < 0.6) {
      z = Math.min(3, 0.6 / shown);
      tx = Math.min(0, Math.max(w - w * z, w / 2 - (spot.x + spot.w / 2) * w * z));
      ty = Math.min(0, Math.max(h - h * z, h / 2 - (spot.y + spot.h / 2) * h * z));
    }
    zoom = { z: z, tx: tx, ty: ty };
    layer.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + z + ")";
    hot.style.borderWidth = 2 / z + "px";
  }

  // Puts the caption beside what it points at without covering it: below, above, right or
  // left, whichever fits. If none fits (a very large target), it goes to the emptier end.
  function placeCaption() {
    var spot = currentHotspot();
    var w = stage.clientWidth, h = stage.clientHeight;
    var gap = 12, edge = 8;
    cap.style.maxHeight = Math.max(40, h - 2 * edge) + "px";
    var cw = cap.offsetWidth, ch = cap.offsetHeight;
    var left, top;
    if (spot) {
      var hx = spot.x * w * zoom.z + zoom.tx, hy = spot.y * h * zoom.z + zoom.ty;
      var hw = spot.w * w * zoom.z, hh = spot.h * h * zoom.z;
      var clampX = function (x) { return Math.max(edge, Math.min(x, w - cw - edge)); };
      var clampY = function (y) { return Math.max(edge, Math.min(y, h - ch - edge)); };
      var centreX = clampX(hx + hw / 2 - cw / 2), centreY = clampY(hy + hh / 2 - ch / 2);
      if (hy + hh + gap + ch <= h - edge) { left = centreX; top = hy + hh + gap; }
      else if (hy - gap - ch >= edge) { left = centreX; top = hy - gap - ch; }
      else if (hx + hw + gap + cw <= w - edge) { left = hx + hw + gap; top = centreY; }
      else if (hx - gap - cw >= edge) { left = hx - gap - cw; top = centreY; }
      else { left = centreX; top = hy + hh / 2 < h / 2 ? h - ch - edge : edge; }
    } else {
      left = w / 2 - cw / 2;
      top = h - ch - 20;
    }
    cap.style.left = Math.max(edge, Math.min(left, w - cw - edge)) + "px";
    cap.style.top = Math.max(edge, Math.min(top, h - ch - edge)) + "px";
  }

  // The real element's position inside a captured page, so the hotspot stays on it
  // even if the viewer's fonts make the layout differ slightly from the capture.
  function measureTarget(frame) {
    try {
      var target = frame.contentDocument.querySelector("[data-dk-target]");
      if (!target) return null;
      var r = target.getBoundingClientRect();
      var left = Math.max(0, r.left), top = Math.max(0, r.top);
      var right = Math.min(data.width, r.right), bottom = Math.min(data.height, r.bottom);
      if (right - left < 1 || bottom - top < 1) return null;
      return { x: left / data.width, y: top / data.height, w: (right - left) / data.width, h: (bottom - top) / data.height };
    } catch (e) { return null; }
  }

  function restoreScroll(frame, scroll) {
    try {
      var nodes = frame.contentDocument.querySelectorAll("[data-dk-st],[data-dk-sl]");
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].scrollTop = Number(nodes[i].getAttribute("data-dk-st")) || 0;
        nodes[i].scrollLeft = Number(nodes[i].getAttribute("data-dk-sl")) || 0;
      }
      frame.contentWindow.scrollTo(scroll[0], scroll[1]);
    } catch (e) { /* the image hotspot position is used instead */ }
  }

  // Builds the next screen off-stage and swaps it in once it has loaded, so there is no blank flash.
  function mount(step, done) {
    var id = ++mountId;
    var next;
    function ready() {
      if (id !== mountId) { next.remove(); return; }
      var old = view;
      view = next;
      view.classList.remove("dk-loading");
      if (old) old.remove();
      live_hotspot = null;
      if (view.tagName === "IFRAME") {
        fitPage();
        restoreScroll(view, step.scroll || [0, 0]);
        if (step.hotspot) live_hotspot = measureTarget(view);
      }
      done();
    }
    if (step.html) {
      next = el("iframe", "dk-view dk-page dk-loading");
      // No "allow-scripts": nothing inside a captured page can run.
      next.setAttribute("sandbox", "allow-same-origin");
      next.setAttribute("tabindex", "-1");
      next.setAttribute("aria-hidden", "true");
      next.setAttribute("inert", "");
      next.style.width = data.width + "px";
      next.style.height = data.height + "px";
      next.addEventListener("load", ready, { once: true });
      next.srcdoc = expand(step.html);
    } else {
      next = el("img", "dk-view dk-shot dk-loading");
      next.alt = "";
      next.draggable = false;
      next.addEventListener("load", ready, { once: true });
      next.addEventListener("error", ready, { once: true });
      next.src = step.image;
    }
    layer.insertBefore(next, hot);
  }

  function show(newIndex, announce) {
    index = Math.max(0, Math.min(newIndex, steps.length - 1));
    var step = steps[index];
    var isEnd = step.kind === "end";
    var shown = index;

    count.textContent = index + 1 + " / " + steps.length;
    fill.style.width = (steps.length > 1 ? (index / (steps.length - 1)) * 100 : 100) + "%";
    back.disabled = index === 0;
    next.hidden = isEnd;
    chapterText.textContent = step.chapter ? " · " + step.chapter : "";
    // The caption is always in the page for screen readers, whether the viewer or autoplay moved on.
    live.textContent = (step.chapter ? step.chapter + ". " : "") + step.caption;

    mount(step, function () {
      if (shown !== index) return;
      var clickable = step.kind !== "note";
      hot.classList.toggle("dk-point", !clickable);
      hot.disabled = !clickable;
      hot.setAttribute("aria-label", step.caption || "Continue");
      placeHotspot();
      end.hidden = !isEnd;
      endText.textContent = isEnd ? step.caption : "";
      cap.textContent = isEnd ? "" : step.caption;
      cap.hidden = isEnd || !step.caption;
      placeCaption();
      schedule();
      if (announce) {
        if (isEnd) again.focus({ preventScroll: true });
        else if (!hot.hidden && !hot.disabled) hot.focus({ preventScroll: true });
      }
    });

    // Warm the next image so the following step appears at once.
    if (steps[index + 1] && steps[index + 1].image) { var pre = new Image(); pre.src = steps[index + 1].image; }
    emit(isEnd ? "finish" : "step");
  }

  // Autoplay advances by itself until the viewer does anything, then leaves them in control.
  var autoplay = 0;
  var timer = null;
  var asked = /[?#&]autoplay=(\d+)/.exec(location.search + location.hash);
  if (asked) autoplay = Number(asked[1]);
  else if (typeof data.autoplay === "number") autoplay = data.autoplay;
  if (!(autoplay >= 800 && autoplay <= 60000)) autoplay = 0;
  function schedule() {
    clearTimeout(timer);
    if (!autoplay) return;
    var atEnd = steps[index].kind === "end" || index === steps.length - 1;
    timer = setTimeout(function () { show(atEnd ? 0 : index + 1, false); }, atEnd ? autoplay * 2 : autoplay);
  }
  function takeOver() { autoplay = 0; clearTimeout(timer); }
  document.addEventListener("pointerdown", takeOver, true);
  document.addEventListener("keydown", takeOver, true);

  function go(delta) {
    var target = Math.max(0, Math.min(index + delta, steps.length - 1));
    if (target !== index) show(target, true);
  }

  // A double-click on the hotspot is one step forward, not two: the browser marks the
  // second click of a double-click, and that one is ignored.
  hot.addEventListener("click", function (event) {
    event.stopPropagation();
    if (event.detail > 1) return;
    go(1);
  });
  next.addEventListener("click", function () { go(1); });
  back.addEventListener("click", function () { go(-1); });
  again.addEventListener("click", function () { emit("restart"); show(0, true); });
  // A click that misses the hotspot points the viewer back to it.
  stage.addEventListener("click", function (event) {
    if (hot.hidden || hot.disabled || end.contains(event.target)) return;
    hot.classList.remove("dk-nudge");
    void hot.offsetWidth;
    hot.classList.add("dk-nudge");
  });
  document.addEventListener("keydown", function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    var tag = event.target && event.target.tagName;
    if (event.key === "ArrowRight") { go(1); event.preventDefault(); }
    else if (event.key === "ArrowLeft") { go(-1); event.preventDefault(); }
    else if (event.key === "Home") { show(0, true); event.preventDefault(); }
    else if ((event.key === "Enter" || event.key === " ") && tag !== "BUTTON" && tag !== "A") { go(1); event.preventDefault(); }
  });
  function relayout() { fitPage(); applyZoom(); placeCaption(); }
  window.addEventListener("resize", relayout);
  if (window.ResizeObserver) new ResizeObserver(relayout).observe(stage);

  show(0, false);
  emit("start");
})();
