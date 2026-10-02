// Admin access — logo/brand 5 clicks
(() => {
  const adminPath = "/admin.html";

  // একাধিক সম্ভাব্য brand selector support
  const brand =
    document.querySelector("#brand") ||
    document.querySelector(".brand") ||
    document.querySelector(".logo") ||
    document.querySelector("[data-brand]");

  if (!brand) return;

  let clicks = 0;
  let timer = null;

  brand.addEventListener("click", (event) => {
    clicks++;

    clearTimeout(timer);

    timer = setTimeout(() => {
      clicks = 0;
    }, 1800);

    if (clicks >= 5) {
      clicks = 0;
      clearTimeout(timer);
      window.location.href = adminPath;
    }
  });
})();
