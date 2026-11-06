/* Range Logger script.
   The logic is the same as before the restyle. Parts marked "look only"
   were added for the new layout and do not change what the page records. */
(function () {
  "use strict";
  var KEY = "rangeLogger.v1";
  var THEME_KEY = "rangeLogger.theme";
  var FT = 3.28084;
  var TOL = 3;             // seconds of slack when matching a tap to a Relay line
  var GUARD_MS = 2000;     // ignore a second tap inside this time
  var state = { base: null, rows: [], next: 0, relayText: "", relayLines: null, method: "clock" };
  var fix = null;          // latest GPS fix: {lat, lon, acc, t}
  var watchId = null;
  var lastLogMs = 0;       // when the last tap was logged, for the tap guard
  var match = null;        // result of matching presses to Relay lines
  var $ = function (id) { return document.getElementById(id); };

  // ---------- theme switch (look only) ----------
  // Auto follows the phone. Light and Dark set data-theme on the html element.
  // The choice is remembered in localStorage, and the page works without it.
  function readTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }
  function writeTheme(choice) {
    try {
      if (choice === "light" || choice === "dark") localStorage.setItem(THEME_KEY, choice);
      else localStorage.removeItem(THEME_KEY);
    } catch (e) { /* no storage, the choice lasts until the page closes */ }
  }
  function applyTheme(choice) {
    if (choice !== "light" && choice !== "dark") choice = "auto";
    if (choice === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", choice);
    var btns = document.querySelectorAll("[data-theme-choice]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-pressed", String(btns[i].getAttribute("data-theme-choice") === choice));
    }
  }
  applyTheme(readTheme());
  Array.prototype.forEach.call(document.querySelectorAll("[data-theme-choice]"), function (b) {
    b.addEventListener("click", function () {
      var choice = b.getAttribute("data-theme-choice");
      applyTheme(choice);
      writeTheme(choice);
    });
  });

  // ---------- storage (a convenience only; wrapped because it can fail) ----------
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && Array.isArray(s.rows)) {
          state.base = s.base || null;
          state.rows = s.rows;
          state.next = s.next || 0;
          state.relayText = s.relayText || "";
          // An old saved relay map (s.relay) is ignored on purpose.
          state.relayLines = Array.isArray(s.relayLines) ? s.relayLines : null;
          state.method = s.method === "number" ? "number" : "clock";
        }
      }
    } catch (e) { /* no storage, start fresh */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  // ---------- math ----------
  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function distFromBase(f) {
    if (!state.base || !f) return null;
    return haversine(state.base.lat, state.base.lon, f.lat, f.lon);
  }
  function parseRelay(text) {
    // Relay lines look like: "<time_s> <message> <rssi> <snr> [extra words]".
    // Only the first four numbers are read. Anything after them is ignored.
    // Lines that do not start with four numbers are skipped.
    var lines = [], seen = {}, dup = false;
    text.split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^\s*(\d+(?:\.\d+)?)\s+(\d+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/);
      if (!m) return;
      var n = parseInt(m[2], 10);
      if (seen[n]) dup = true;
      seen[n] = true;
      lines.push({ t: parseFloat(m[1]), n: n, rssi: parseFloat(m[3]), snr: parseFloat(m[4]) });
    });
    return { lines: lines, dup: dup };
  }

  // ---------- matching presses to Relay lines ----------
  function secOf(t) { var p = t.split(":"); return (+p[0]) * 3600 + (+p[1]) * 60 + (+p[2]); }
  // For one clock offset d, pair each press with the nearest unused Relay line within TOL seconds.
  function assign(secs, L, d) {
    var used = {}, res = [], count = 0, resid = 0;
    for (var i = 0; i < secs.length; i++) {
      var bj = -1, bd = 1e9;
      for (var j = 0; j < L.length; j++) {
        if (used[j]) continue;
        var e = Math.abs(secs[i] - L[j].t - d);
        if (e <= TOL && e < bd) { bd = e; bj = j; }
      }
      if (bj >= 0) { used[bj] = true; count++; resid += bd; }
      res.push(bj);
    }
    return { res: res, count: count, resid: resid };
  }
  // Returns null when no Relay log is loaded. Otherwise returns one entry per press
  // ({got, n, rssi}) and a summary of how the pairing was done.
  function computeMatch() {
    var L = state.relayLines;
    if (!L || !L.length) return null;
    var R = state.rows;
    var out = R.map(function () { return { got: false, n: null, rssi: null }; });
    var info = { method: "number", offset: null, matched: 0, extra: 0, note: "" };
    if (state.method === "clock" && R.length) {
      // The phone and the Relay clocks differ by an unknown amount, so try every
      // offset that one press and one Relay line would suggest. Keep the best one.
      var secs = R.map(function (r) { return secOf(r.time); });
      var seen = {}, best = null;
      for (var i = 0; i < R.length; i++) {
        for (var j = 0; j < L.length; j++) {
          var d = secs[i] - L[j].t;
          if (seen[d]) continue;
          seen[d] = true;
          var a = assign(secs, L, d);
          if (!best || a.count > best.a.count || (a.count === best.a.count && a.resid < best.a.resid)) best = { d: d, a: a };
        }
      }
      if (best && best.a.count >= Math.min(3, R.length)) {
        best.a.res.forEach(function (j, i) {
          if (j >= 0) out[i] = { got: true, n: L[j].n, rssi: L[j].rssi };
        });
        info.method = "clock"; info.offset = best.d; info.matched = best.a.count; info.extra = L.length - best.a.count;
        return { out: out, info: info };
      }
      info.note = "Too few presses lined up by the clock, so I matched by message number instead.";
    }
    var map = {};
    L.forEach(function (l) { map[l.n] = l; });
    R.forEach(function (r, i) {
      var l = map[r.n];
      if (l) out[i] = { got: true, n: l.n, rssi: l.rssi };
    });
    info.matched = out.filter(function (o) { return o.got; }).length;
    info.extra = Math.max(0, L.length - info.matched);
    return { out: out, info: info };
  }

  // ---------- GPS ----------
  function startGps() {
    if (!("geolocation" in navigator)) { setGps("err", "This browser has no GPS support."); return; }
    if (watchId !== null) return;
    setGps("stale", "Waiting for a GPS fix...");
    $("gpsBtn").disabled = true;
    $("gpsBtn").textContent = "GPS running";
    watchId = navigator.geolocation.watchPosition(onFix, onGpsError,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    requestWake();
    refreshWarnings();
  }
  function onFix(pos) {
    fix = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() };
    $("baseBtn").disabled = false;
    updateGpsText();
    updateDistNow();
    refreshWarnings();
  }
  function onGpsError(err) {
    var why = err.code === 1 ? "Location is blocked. Allow it in the browser's site settings, then reload."
            : err.code === 2 ? "No position available yet. Move near a window or outside."
            : "GPS timed out. It keeps trying.";
    setGps("err", why);
    if (err.code === 1) { watchId = null; $("gpsBtn").disabled = false; $("gpsBtn").textContent = "Start GPS"; }
    refreshWarnings();
  }
  function setGps(kind, text) {
    $("gpsDot").className = "dot " + (kind === "ok" ? "ok" : kind === "stale" ? "stale" : kind === "err" ? "err" : "");
    // Amber text for a stale fix, a weak fix, no fix, or an error (look only).
    $("gpsText").className = (kind === "stale" || kind === "err") ? "warn" : "";
    $("gpsText").textContent = text;
  }
  function updateGpsText() {
    if (!fix) return;
    var age = Math.round((Date.now() - fix.t) / 1000);
    var accTxt = "accuracy +/- " + Math.round(fix.acc) + " m (" + Math.round(fix.acc * FT) + " ft)";
    if (age > 15) setGps("stale", "Last fix " + age + " s ago, " + accTxt);
    // Accuracy worse than 20 m shows as a warning (look only). The text is the same.
    else setGps(fix.acc > 20 ? "stale" : "ok", "GPS fix, " + accTxt + ", " + age + " s ago");
  }
  var wake = null;
  function requestWake() {
    try {
      if (navigator.wakeLock && document.visibilityState === "visible") {
        navigator.wakeLock.request("screen").then(function (w) { wake = w; }, function () {});
      }
    } catch (e) { /* optional */ }
  }
  document.addEventListener("visibilitychange", function () { if (watchId !== null) requestWake(); });
  setInterval(function () { updateGpsText(); refreshWarnings(); }, 1000);

  // ---------- setup card and warnings (look only) ----------
  // Shows amber when GPS is off, has no fix, is stale or weak, or the Relay is not set.
  // The Setup card closes by itself once GPS has a fix and the Relay position is set.
  // It closes only once, so you can reopen it and it stays open.
  var setupClosed = false;
  function refreshWarnings() {
    var age = fix ? (Date.now() - fix.t) / 1000 : 0;
    var stale = !!fix && age > 15;
    var weak = !!fix && fix.acc > 20;
    var gpsRunning = watchId !== null;

    $("distBox").classList.toggle("warn", !fix || !state.base || stale || weak);

    var gpsWord = !gpsRunning ? "GPS off" : !fix ? "GPS waiting" : stale ? "GPS stale" : weak ? "GPS weak" : "GPS ok";
    var relayWord = !state.base ? "Relay not set" : state.base.acc > 20 ? "Relay set, rough" : "Relay set";
    var st = $("setupState");
    st.textContent = gpsWord + ". " + relayWord + ".";
    var needsLook = !gpsRunning || !fix || stale || weak || !state.base || state.base.acc > 20;
    st.className = "sum-state" + (needsLook ? " warn" : "");

    if (!setupClosed && gpsRunning && fix && state.base) {
      setupClosed = true;
      $("setup").open = false;
    }
  }

  // Keep the page padding in step with the real height of the bottom bar (look only).
  function watchBarHeight() {
    var bar = $("bar");
    var set = function () { document.documentElement.style.setProperty("--bar-h", bar.offsetHeight + "px"); };
    set();
    if (typeof ResizeObserver === "function") new ResizeObserver(set).observe(bar);
    else window.addEventListener("resize", set);
  }

  // ---------- base ----------
  function setBase() {
    if (!fix) return;
    state.base = { lat: fix.lat, lon: fix.lon, acc: fix.acc, t: Date.now() };
    save(); renderBase(); updateDistNow(); renderAll();
  }
  function renderBase() {
    var el = $("baseText");
    if (!state.base) {
      el.className = "empty";
      el.textContent = "Not set. Stand at the window next to the Relay, wait for the accuracy to drop, then tap the button.";
      return;
    }
    el.className = "";
    var b = state.base;
    el.innerHTML = "";
    var l1 = document.createElement("div");
    l1.className = "mono";
    l1.textContent = b.lat.toFixed(6) + ", " + b.lon.toFixed(6);
    var l2 = document.createElement("div");
    l2.className = "small " + (b.acc > 20 ? "warn" : "muted");
    l2.textContent = "accuracy +/- " + Math.round(b.acc) + " m" +
      (b.acc > 20 ? ". Indoor GPS is rough. Distances under about 100 ft will be off by about that much." : "");
    el.appendChild(l1); el.appendChild(l2);
  }

  // ---------- live distance ----------
  function updateDistNow() {
    var d = distFromBase(fix);
    $("distNow").textContent = d === null ? "--" : Math.round(d * FT) + " ft";
    $("distNowM").textContent = d === null ? " " : Math.round(d) + " m";
  }

  // ---------- logging ----------
  function logPress(saw) {
    var msg = $("logMsg");
    // Tap guard: ignore a tap that comes too soon after the last logged one.
    var nowMs = Date.now();
    if (lastLogMs && nowMs - lastLogMs < GUARD_MS) {
      msg.className = "note warn";
      msg.textContent = "Ignored. That tap came less than 2 seconds after the last one. If it was a real new press, tap again.";
      return;
    }
    lastLogMs = nowMs;
    var f = fix && (nowMs - fix.t) < 30000 ? fix : null;
    var d = distFromBase(f);
    var now = new Date();
    var pad = function (v) { return (v < 10 ? "0" : "") + v; };
    state.rows.push({
      n: state.next,
      time: pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()),
      lat: f ? f.lat : null, lon: f ? f.lon : null, acc: f ? f.acc : null,
      d: d, saw: saw
    });
    var warnTxt = "";
    if (!f) warnTxt = " No fresh GPS fix, so this press has no position.";
    else if (!state.base) warnTxt = " Relay position not set, so there is no distance yet.";
    msg.className = "note" + (warnTxt ? " warn" : "");
    msg.textContent = "Logged message " + state.next + " as " + saw.toUpperCase() +
      (d !== null ? " at " + Math.round(d * FT) + " ft." : ".") + warnTxt;
    state.next += 1;
    save(); renderAll();
  }
  function undo() {
    if (!state.rows.length) return;
    var r = state.rows.pop();
    state.next = r.n;
    lastLogMs = 0;
    save(); renderAll();
  }
  var clearArmed = false, clearTimer = null;
  function clearAll() {
    if (!clearArmed) {
      clearArmed = true; $("clearBtn").textContent = "Tap again to clear";
      clearTimer = setTimeout(function () { clearArmed = false; $("clearBtn").textContent = "Clear all"; }, 4000);
      return;
    }
    clearTimeout(clearTimer); clearArmed = false; $("clearBtn").textContent = "Clear all";
    state.rows = []; state.next = 0; state.relayLines = null; state.relayText = ""; $("relayText").value = "";
    lastLogMs = 0;
    save(); renderAll();
    $("compareMsg").textContent = "";
  }

  // ---------- compare ----------
  function compare() {
    var txt = $("relayText").value;
    var p = parseRelay(txt);
    state.relayText = txt;
    if (!p.lines.length) {
      state.relayLines = null;
      save(); renderAll();
      var msg = $("compareMsg");
      msg.className = "note warn";
      msg.textContent = "No message lines found. Paste the lines that start with a time and a message number.";
      return;
    }
    state.relayLines = p.lines;
    save(); renderAll();
  }
  // The note under the Compare button. It says how the presses were paired.
  function describeMatch() {
    var el = $("compareMsg");
    if (!match) return;
    var i = match.info, parts = [];
    parts.push(state.relayLines.length + " Relay messages read.");
    if (state.rows.length) {
      if (i.method === "clock") parts.push("Matched by the clock: " + i.matched + " of " + state.rows.length + " presses lined up.");
      else parts.push("Matched by message number.");
      if (i.extra > 0) parts.push(i.extra + " Relay message" + (i.extra === 1 ? "" : "s") + " had no press logged here (the desk test, or presses you did not log).");
    }
    if (i.note) parts.push(i.note);
    el.className = "note" + (i.note ? " warn" : "");
    el.textContent = parts.join(" ");
  }

  // ---------- render ----------
  // A Worked or Failed chip: a check or an X shape plus a word, so color is never the only clue.
  function chip(worked) {
    var s = document.createElement("span");
    s.className = "chip " + (worked ? "good" : "bad");
    s.innerHTML = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><use href="#' +
      (worked ? "i-check" : "i-x") + '"/></svg>' + (worked ? "Worked" : "Failed");
    return s;
  }

  var view = [];    // the logged presses, each with its Relay match in r.m (or null)
  function renderAll() {
    match = computeMatch();
    view = state.rows.map(function (r, i) {
      var v = {}; for (var k in r) v[k] = r[k];
      v.m = match ? match.out[i] : null;
      return v;
    });
    $("numNow").textContent = state.next;
    $("method").value = state.method;
    $("emptyLog").hidden = view.length > 0;
    $("tableWrap").hidden = view.length === 0;
    $("undoBtn").disabled = view.length === 0;
    $("clearBtn").disabled = view.length === 0;
    var body = $("rows");
    body.innerHTML = "";
    view.forEach(function (r) {
      var tr = document.createElement("tr");
      // Each cell is [text, class]. A null text means a chip goes in the cell.
      var cells = [
        [String(r.n), "num"], [r.time, "num"],
        [r.d === null ? "--" : String(Math.round(r.d * FT)), "num"],
        [r.acc === null ? "--" : String(Math.round(r.acc)), "num"],
        [null, ""],
        r.m === null ? ["--", "none"] : [null, ""]
      ];
      cells.forEach(function (c, ci) {
        var td = document.createElement("td");
        td.className = c[1];
        if (c[0] === null) {
          if (ci === 4) td.appendChild(chip(r.saw === "green"));
          else {
            // Relay column: Worked with the Relay message number, or Failed.
            td.appendChild(chip(r.m.got));
            if (r.m.got) {
              var num = document.createElement("span");
              num.className = "relay-n mono";
              num.textContent = "#" + r.m.n;
              td.appendChild(num);
            }
          }
        } else td.textContent = c[0];
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    // The paste box is only set on page load and on Clear all, so typing is never wiped.
    $("csvBox").hidden = true;
    describeMatch();
    renderSummary();
    renderChart();
    $("copyBtn").disabled = view.length === 0;
    $("dlBtn").disabled = view.length === 0;
    refreshWarnings();
  }

  // A press counts as worked when the Relay received it. With no Relay log, the Fob light decides.
  function outcome(r) { return r.m ? r.m.got : r.saw === "green"; }

  // The headline and the split bar at the top of the Result (look only).
  function renderHeadline() {
    var rows = view;
    $("headline").hidden = rows.length === 0;
    if (!rows.length) return;
    var worked = rows.filter(outcome).length, failed = rows.length - worked;
    $("headText").textContent = worked + " of " + rows.length + " worked";
    $("barWorked").style.width = (worked / rows.length * 100) + "%";
    $("barFailed").style.width = (failed / rows.length * 100) + "%";
    $("barWorked").hidden = worked === 0;
    $("barFailed").hidden = failed === 0;
    $("splitBar").setAttribute("aria-label", worked + " worked, " + failed + " failed");
    $("cntWorked").textContent = worked;
    $("cntFailed").textContent = failed;
    $("headSrc").textContent = match
      ? "Counted from the Relay log."
      : "Counted from the Fob light. Paste the Relay log for the real result.";
  }

  function renderSummary() {
    renderHeadline();
    var dl = $("summary");
    dl.innerHTML = "";
    var rows = view;
    // The optional third argument marks a row as a warning (amber).
    var add = function (k, v, warn) {
      var dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = k; dd.textContent = v; dl.appendChild(dt); dd.className = "mono"; dl.appendChild(dd);
      if (warn) { dt.className = "warn"; dd.className = "mono warn"; }
    };
    if (!rows.length) {
      var p = document.createElement("p"); p.className = "empty"; p.textContent = "Results show up here after your first logged press.";
      dl.appendChild(p); dl.style.display = "block"; return;
    }
    dl.style.display = "grid";
    var haveRelay = !!match;
    var got = rows.filter(outcome);
    add("Presses logged", String(rows.length));
    if (haveRelay) {
      add("Relay received", got.length + " of " + rows.length);
      add("Received, Fob showed red", String(rows.filter(function (r) { return r.m.got && r.saw === "red"; }).length));
      var conflict = rows.filter(function (r) { return !r.m.got && r.saw === "green"; }).length;
      if (conflict) add("Fob green, Relay missed", String(conflict), true);
    } else {
      add("Fob showed green", got.length + " of " + rows.length);
    }
    var withD = rows.filter(function (r) { return r.d !== null; });
    var gotD = withD.filter(outcome).map(function (r) { return r.d; });
    var missD = withD.filter(function (r) { return !outcome(r); }).map(function (r) { return r.d; });
    var fmt = function (m) { return Math.round(m * FT) + " ft (" + Math.round(m) + " m)"; };
    if (gotD.length) add("Farthest received", fmt(Math.max.apply(null, gotD)));
    if (missD.length) {
      add("Nearest miss", fmt(Math.min.apply(null, missD)));
      add("Farthest miss", fmt(Math.max.apply(null, missD)));
    } else if (withD.length) add("Misses", "none");
    if (haveRelay) {
      var rs = rows.filter(function (r) { return r.m.got; }).map(function (r) { return r.m.rssi; });
      if (rs.length) add("Weakest signal", Math.min.apply(null, rs) + " dBm");
    }
  }

  function renderChart() {
    var wrap = $("chartWrap"), svg = $("chart");
    var pts = view.filter(function (r) { return r.d !== null; });
    wrap.hidden = pts.length === 0;
    if (!pts.length) return;
    $("legendSrc").textContent = match ? "Marks come from the Relay log." : "Marks come from the Fob light. Paste the Relay log for the real result.";
    // The chart grows taller with more presses: at least 250, and 9 units per press plus the margins.
    var W = 360, L = 38, R = 12, T = 12, B = 34;
    var H = Math.max(250, T + B + 9 * pts.length);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    var maxFt = Math.max.apply(null, pts.map(function (r) { return r.d * FT; }));
    var step = maxFt <= 100 ? 25 : maxFt <= 250 ? 50 : maxFt <= 600 ? 100 : 250;
    var xmax = Math.max(step, Math.ceil(maxFt / step) * step);
    var nmax = pts.length;
    var X = function (ft) { return L + (ft / xmax) * (W - L - R); };
    var Y = function (i) { return T + (nmax === 1 ? 0.5 : i / (nmax - 1)) * (H - T - B); };
    var NS = "http://www.w3.org/2000/svg";
    svg.innerHTML = "";
    var el = function (name, attrs, text) {
      var e = document.createElementNS(NS, name);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      if (text !== undefined) e.textContent = text;
      svg.appendChild(e); return e;
    };
    // Colors come from the CSS variables through these classes, so both themes work.
    for (var v = 0; v <= xmax; v += step) {
      el("line", { x1: X(v), x2: X(v), y1: T, y2: H - B, "class": "c-grid" });
      el("text", { x: X(v), y: H - B + 16, "text-anchor": "middle", "font-size": 12, "class": "c-text" }, String(v));
    }
    el("text", { x: (L + W - R) / 2, y: H - 4, "text-anchor": "middle", "font-size": 12, "class": "c-text" }, "feet from the Relay");
    el("text", { x: 4, y: T + 8, "font-size": 12, "class": "c-text" }, "first");
    el("text", { x: 4, y: H - B, "font-size": 12, "class": "c-text" }, "last");
    pts.forEach(function (r, i) {
      var x = X(r.d * FT), y = Y(i);
      if (outcome(r)) el("circle", { cx: x, cy: y, r: 4.5, "class": "mark-ok" });
      else el("path", { d: "M" + (x - 4.5) + " " + (y - 4.5) + "L" + (x + 4.5) + " " + (y + 4.5) + "M" + (x + 4.5) + " " + (y - 4.5) + "L" + (x - 4.5) + " " + (y + 4.5),
                        "class": "mark-bad", "stroke-width": 2.4, "stroke-linecap": "round" });
    });
  }

  // ---------- export ----------
  function toCsv() {
    var head = ["press_on_page", "time", "lat", "lon", "gps_accuracy_m", "distance_m", "distance_ft", "fob_showed", "relay_received", "relay_message", "relay_rssi_dbm"];
    var out = [head.join(",")];
    view.forEach(function (r) {
      var g = r.m ? r.m.got : null;
      out.push([
        r.n, r.time,
        r.lat === null ? "" : r.lat.toFixed(6), r.lon === null ? "" : r.lon.toFixed(6),
        r.acc === null ? "" : Math.round(r.acc),
        r.d === null ? "" : Math.round(r.d), r.d === null ? "" : Math.round(r.d * FT),
        r.saw, g === null ? "" : (g ? "yes" : "no"), g ? r.m.n : "", g ? r.m.rssi : ""
      ].join(","));
    });
    return out.join("\n") + "\n";
  }
  function copyCsv() {
    var csv = toCsv(), msg = $("saveMsg");
    var fallback = function () {
      // Show the CSV in its own read-only box so the Relay paste box is left alone.
      var box = $("csvBox");
      box.value = csv; box.hidden = false; box.focus(); box.select();
      msg.textContent = "Copy was blocked. The CSV is in the box below. Select it and copy by hand.";
    };
    try {
      navigator.clipboard.writeText(csv).then(function () { $("csvBox").hidden = true; msg.textContent = "CSV copied."; }, fallback);
    } catch (e) { fallback(); }
  }
  function downloadCsv() {
    try {
      var blob = new Blob([toCsv()], { type: "text/csv" });
      var a = document.createElement("a");
      var url = URL.createObjectURL(blob);
      a.href = url; a.download = "range-walk.csv";
      document.body.appendChild(a); a.click(); a.remove();
      // Release the temporary file address once the browser has started the download.
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      $("saveMsg").textContent = "CSV saved to your downloads.";
    } catch (e) { $("saveMsg").textContent = "Download failed. Use Copy as CSV."; }
  }

  // ---------- wiring ----------
  $("gpsBtn").addEventListener("click", startGps);
  $("baseBtn").addEventListener("click", setBase);
  $("saidGreen").addEventListener("click", function () { logPress("green"); });
  $("saidRed").addEventListener("click", function () { logPress("red"); });
  $("numUp").addEventListener("click", function () { state.next += 1; save(); renderAll(); });
  $("numDown").addEventListener("click", function () { if (state.next > 0) { state.next -= 1; save(); renderAll(); } });
  $("numReset").addEventListener("click", function () { state.next = 0; save(); renderAll(); });
  $("undoBtn").addEventListener("click", undo);
  $("clearBtn").addEventListener("click", clearAll);
  $("compareBtn").addEventListener("click", compare);
  $("method").addEventListener("change", function () { state.method = $("method").value; save(); renderAll(); });
  // Keep what was pasted even before Compare is tapped, so a reload does not lose it.
  $("relayText").addEventListener("input", function () { state.relayText = $("relayText").value; save(); });
  $("copyBtn").addEventListener("click", copyCsv);
  $("dlBtn").addEventListener("click", downloadCsv);

  load();
  $("relayText").value = state.relayText;
  renderBase();
  renderAll();
  watchBarHeight();
  window.__rangeLogger = { parseRelay: parseRelay, haversine: haversine };
})();
