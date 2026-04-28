/* Cost Predictor — shared site behaviors. No dependencies. */
(function () {
  "use strict";

  /* ---- Active nav highlight (in case server doesn't set aria-current) ---- */
  function markActiveNav() {
    const here = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll(".nav a").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      if (href === here || (here === "" && href === "index.html")) {
        a.setAttribute("aria-current", "page");
      }
    });
  }

  /* ---- Copy buttons on <pre> ------------------------------------------- */
  function attachCopyButtons() {
    document.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".code-copy")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy";
      btn.textContent = "Copy";
      btn.setAttribute("aria-label", "Copy code to clipboard");
      btn.addEventListener("click", async () => {
        const code = pre.querySelector("code")
          ? pre.querySelector("code").innerText
          : pre.innerText;
        // strip the button text itself if no code child
        const toCopy = code.replace(/\n?Copy\n?$/, "").trim();
        try {
          await navigator.clipboard.writeText(toCopy);
          btn.textContent = "Copied";
          btn.dataset.state = "copied";
          setTimeout(() => {
            btn.textContent = "Copy";
            delete btn.dataset.state;
          }, 1600);
        } catch (e) {
          btn.textContent = "Press ⌘C";
          setTimeout(() => (btn.textContent = "Copy"), 1600);
        }
      });
      pre.appendChild(btn);
    });
  }

  /* ---- Tabs (install page) -------------------------------------------- */
  function attachTabs() {
    document.querySelectorAll("[data-tabs]").forEach((root) => {
      const buttons = root.querySelectorAll(".tab-btn");
      const panels = root.querySelectorAll(".tab-panel");
      function activate(name) {
        buttons.forEach((b) => {
          const match = b.dataset.tab === name;
          b.setAttribute("aria-selected", match ? "true" : "false");
          b.tabIndex = match ? 0 : -1;
        });
        panels.forEach((p) => {
          p.dataset.active = p.dataset.tab === name ? "true" : "false";
        });
      }
      buttons.forEach((b) => {
        b.addEventListener("click", () => activate(b.dataset.tab));
        b.addEventListener("keydown", (e) => {
          const order = Array.from(buttons);
          const i = order.indexOf(b);
          if (e.key === "ArrowRight") {
            e.preventDefault();
            order[(i + 1) % order.length].focus();
            activate(order[(i + 1) % order.length].dataset.tab);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            order[(i - 1 + order.length) % order.length].focus();
            activate(order[(i - 1 + order.length) % order.length].dataset.tab);
          }
        });
      });
      // initial: first tab or honor data-default
      const initial = root.dataset.default || (buttons[0] && buttons[0].dataset.tab);
      if (initial) activate(initial);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      markActiveNav();
      attachCopyButtons();
      attachTabs();
    });
  } else {
    markActiveNav();
    attachCopyButtons();
    attachTabs();
  }
})();
