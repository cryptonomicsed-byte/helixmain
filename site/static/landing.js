/* landing.js — HelixMain landing page interactions.
 *
 * Design rule: this file only EVER enhances. Every animation sets its own "from"
 * state at RUNTIME, so if GSAP fails to load (or the user prefers reduced motion)
 * the page is still fully readable and every control still works. Nothing here is
 * required to see the content.
 *
 * Login is the REAL passkey ceremony (same shapes AuthGate.tsx uses): usernameless
 * resident credentials, submit to /auth/login/verify, server sets an HttpOnly
 * helix_session cookie, then we hand off to /dashboard/.
 *
 * Registration is a REQUEST, not an open door — passkeys.ts is explicit that
 * enrollment is bootstrapped by an operator-issued one-time token and that
 * "there is no permanent open enrollment door". /auth/signup records the lead.
 */
(function () {
  "use strict";

  var API = "/api";
  var reduce =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── header: glassmorphism on scroll ───────────────────────────────── */
  var hdr = document.getElementById("hdr");
  function onScroll() {
    if (!hdr) return;
    if (window.scrollY > 12) hdr.classList.add("is-scrolled");
    else hdr.classList.remove("is-scrolled");
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ── mobile menu ──────────────────────────────────────────────────── */
  var burger = document.getElementById("burger");
  var menu = document.getElementById("mobile-menu");
  function closeMenu() {
    if (!menu || !burger || menu.hidden) return;
    menu.hidden = true;
    burger.setAttribute("aria-expanded", "false");
    burger.setAttribute("aria-label", "Open menu");
  }
  if (burger && menu) {
    burger.addEventListener("click", function () {
      var opening = menu.hidden;
      menu.hidden = !opening;
      burger.setAttribute("aria-expanded", opening ? "true" : "false");
      burger.setAttribute("aria-label", opening ? "Close menu" : "Open menu");
    });
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) closeMenu();
    });
  }
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeMenu();
  });

  /* ── login / register tabs (+ #login / #register deep links) ───────── */
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  var panes = Array.prototype.slice.call(document.querySelectorAll(".pane"));

  function showTab(name) {
    tabs.forEach(function (t) {
      var on = t.getAttribute("data-tab") === name;
      t.classList.toggle("is-on", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    panes.forEach(function (p) {
      p.classList.toggle("is-on", p.getAttribute("data-pane") === name);
    });
    if (name === "register") {
      var n = document.getElementById("rg-name");
      if (n) setTimeout(function () { try { n.focus({ preventScroll: true }); } catch (e) {} }, 80);
    }
  }

  tabs.forEach(function (t) {
    t.addEventListener("click", function () { showTab(t.getAttribute("data-tab")); });
  });

  // Any anchor pointing at #login / #register selects the right tab and scrolls
  // to the card (there is no element with those ids, so we handle it here).
  document.addEventListener("click", function (e) {
    var a = e.target.closest ? e.target.closest('a[href="#login"], a[href="#register"]') : null;
    if (!a) return;
    e.preventDefault();
    var want = a.getAttribute("href") === "#register" ? "register" : "login";
    showTab(want);
    var sec = document.getElementById("login");
    if (sec) {
      try { sec.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }); }
      catch (err) { sec.scrollIntoView(); }
    }
    try { history.replaceState(null, "", "#" + want); } catch (err) {}
    closeMenu();
  });

  (function fromHash() {
    var h = (location.hash || "").replace("#", "");
    if (h === "register") showTab("register");
  })();

  /* ── small fetch helper (session cookie travels same-origin) ───────── */
  function post(path, body) {
    return fetch(API + path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res
        .json()
        .catch(function () { return null; })
        .then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    });
  }

  function say(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = "pane-msg" + (kind ? " is-" + kind : "");
  }

  /* ── WebAuthn helpers — identical shapes to dashboard/src/components/AuthGate.tsx ── */
  function b64urlToBuf(s) {
    var pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    var bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function bufToB64url(buf) {
    var b = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function passkeysSupported() {
    return (
      window.isSecureContext &&
      typeof window.PublicKeyCredential !== "undefined" &&
      !!(navigator.credentials && navigator.credentials.get)
    );
  }
  async function assertPasskey(options) {
    var pk = options.publicKey || options;
    var allow = (pk.allowCredentials || []).map(function (c) {
      return { type: c.type || "public-key", id: b64urlToBuf(c.id), transports: c.transports };
    });
    var cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBuf(pk.challenge),
        rpId: pk.rpId,
        allowCredentials: allow,
        userVerification: pk.userVerification || "required",
        timeout: pk.timeout || 60000,
      },
    });
    var r = cred.response;
    return {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        authenticatorData: bufToB64url(r.authenticatorData),
        clientDataJSON: bufToB64url(r.clientDataJSON),
        signature: bufToB64url(r.signature),
        userHandle: r.userHandle ? bufToB64url(r.userHandle) : null,
      },
      extensions: (cred.getClientExtensionResults && cred.getClientExtensionResults()) || {},
    };
  }

  /* ── login: one button, one tap ───────────────────────────────────── */
  var loginBtn = document.getElementById("passkey-btn");
  var loginMsg = document.getElementById("login-msg");

  if (loginBtn) {
    loginBtn.addEventListener("click", function () {
      if (!passkeysSupported()) {
        say(loginMsg, "This browser can't use passkeys here — it needs https and a modern browser.", "err");
        return;
      }
      loginBtn.setAttribute("aria-busy", "true");
      say(loginMsg, "Waiting for your device…");
      post("/auth/login/options", {})
        .then(function (opt) {
          if (!opt.ok || !opt.data || !opt.data.options) {
            throw new Error((opt.data && opt.data.error) || "Could not start sign-in.");
          }
          return assertPasskey(opt.data.options);
        })
        .then(function (assertion) {
          return post("/auth/login/verify", { response: assertion });
        })
        .then(function (ver) {
          if (!ver.ok) throw new Error((ver.data && ver.data.error) || "Sign-in failed (" + ver.status + ").");
          say(loginMsg, "Signed in — opening your dashboard…", "ok");
          window.location.href = "/dashboard/";
        })
        .catch(function (err) {
          var m = (err && err.message) || String(err);
          if (err && err.name === "NotAllowedError") {
            m = "No passkey matched, or the prompt was dismissed. Enroll this device from your access link first.";
          }
          say(loginMsg, m, "err");
        })
        .finally(function () { loginBtn.removeAttribute("aria-busy"); });
    });
  }

  /* ── register: record the request ─────────────────────────────────── */
  var form = document.getElementById("register-form");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var nameEl = document.getElementById("rg-name");
      var emailEl = document.getElementById("rg-email");
      var siteEl = document.getElementById("rg-site");
      var rBtn = document.getElementById("register-btn");
      var rMsg = document.getElementById("register-msg");
      var business = nameEl.value.trim();
      var email = emailEl.value.trim();
      var website = siteEl.value.trim();

      [nameEl, emailEl, siteEl].forEach(function (el) { el.removeAttribute("aria-invalid"); });

      if (business.length < 2) {
        nameEl.setAttribute("aria-invalid", "true"); nameEl.focus();
        return say(rMsg, "Please give us your business name.", "err");
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        emailEl.setAttribute("aria-invalid", "true"); emailEl.focus();
        return say(rMsg, "That email doesn't look right.", "err");
      }

      rBtn.setAttribute("aria-busy", "true");
      say(rMsg, "Sending…");
      post("/auth/signup", { business: business, email: email, website: website })
        .then(function (r) {
          if (!r.ok) throw new Error((r.data && r.data.error) || "Request failed (" + r.status + ").");
          say(rMsg, "Request received. We'll email your access link — that link is what creates your passkey.", "ok");
          form.reset();
        })
        .catch(function (err) {
          say(rMsg, (err && err.message) || String(err), "err");
        })
        .finally(function () { rBtn.removeAttribute("aria-busy"); });
    });
  }

  /* ── nav state: a signed-in visitor gets "Dashboard", not "Login" ──── */
  fetch(API + "/auth/me", { credentials: "same-origin" })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (d) {
      if (!d || !d.ok) return;
      Array.prototype.forEach.call(document.querySelectorAll('[data-nav="dashboard"]'), function (el) {
        el.hidden = false;
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-nav="login"]'), function (el) {
        el.setAttribute("href", "/dashboard/");
        el.removeAttribute("data-nav");
        if (el.classList.contains("btn")) el.textContent = "Dashboard";
      });
    })
    .catch(function () { /* not signed in — leave the Login affordance alone */ });

  /* ── motion (GSAP + ScrollTrigger, both optional) ─────────────────── */
  function initMotion() {
    if (reduce || !window.gsap) return;
    var gsap = window.gsap;
    var ST = window.ScrollTrigger;
    if (ST) gsap.registerPlugin(ST);

    var heroBits = gsap.utils.toArray('[data-anim="hero"]');
    if (heroBits.length) {
      gsap.set(heroBits, { y: 22, opacity: 0 });
      gsap.to(heroBits, {
        y: 0, opacity: 1, duration: 0.85, ease: "power3.out", stagger: 0.11, delay: 0.12,
      });
    }

    var art = document.getElementById("hero-art");
    if (art && art.children.length) {
      var cards = gsap.utils.toArray(art.children);
      gsap.set(cards, { y: 26, opacity: 0 });
      gsap.to(cards, {
        y: 0, opacity: 1, duration: 0.95, ease: "power3.out", stagger: 0.12, delay: 0.35,
        // hand the transform back to the tilt handler so the two never fight
        onComplete: function () { gsap.set(cards, { clearProps: "transform" }); },
      });
    }

    if (!ST) return; // without ScrollTrigger, content is simply visible — fine

    gsap.utils.toArray('[data-anim="up"]').forEach(function (el) {
      gsap.set(el, { y: 26, opacity: 0 });
      gsap.to(el, {
        y: 0, opacity: 1, duration: 0.8, ease: "power3.out",
        scrollTrigger: { trigger: el, start: "top 88%", once: true },
      });
    });

    var steps = gsap.utils.toArray('[data-anim="step"]');
    steps.forEach(function (el, i) {
      gsap.set(el, { y: 36, opacity: 0 });
      gsap.to(el, {
        y: 0, opacity: 1, duration: 0.8, ease: "power3.out", delay: i * 0.12,
        scrollTrigger: { trigger: ".steps", start: "top 80%", once: true },
      });
    });

    var fill = document.querySelector(".steps-line-fill");
    if (fill) {
      gsap.set(fill, { width: "0%" });
      gsap.to(fill, {
        width: "100%", ease: "none",
        scrollTrigger: { trigger: ".steps", start: "top 78%", end: "bottom 62%", scrub: 0.6 },
      });
    }

    var mesh = document.querySelector(".mesh");
    if (mesh) {
      gsap.to(mesh, {
        yPercent: 12, ease: "none",
        scrollTrigger: { trigger: "#top", start: "top top", end: "bottom top", scrub: true },
      });
    }
    if (art) {
      gsap.to(art, {
        yPercent: -8, ease: "none",
        scrollTrigger: { trigger: "#top", start: "top top", end: "bottom top", scrub: true },
      });
    }
  }

  /* ── mouse-follow tilt on the floating glass cards ────────────────── */
  function initTilt() {
    if (reduce) return;
    if (!window.matchMedia || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    Array.prototype.forEach.call(document.querySelectorAll("[data-tilt]"), function (el) {
      el.addEventListener("mousemove", function (e) {
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        var gx = ((e.clientX - r.left) / r.width - 0.5) * 2;
        var gy = ((e.clientY - r.top) / r.height - 0.5) * 2;
        el.style.transform =
          "perspective(900px) rotateY(" + (gx * 7).toFixed(2) + "deg)" +
          " rotateX(" + (-gy * 7).toFixed(2) + "deg) translateY(-4px)";
      });
      el.addEventListener("mouseleave", function () { el.style.transform = ""; });
    });
  }

  function boot() {
    initMotion();
    initTilt();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
