/*
 * Lightweight first-party consent banner.
 * Stores choice in localStorage under 'fbc_consent_v1'.
 * Until consent is granted, no personalized advertising signals are sent.
 *
 * For production AdSense in the EU/UK/CH, swap this for a Google-certified CMP.
 * This banner is the minimum to (a) be transparent with users and
 * (b) gate the personalized-ads signal to AdSense via window.adsbygoogle requestNonPersonalizedAds.
 */
(function () {
  var KEY = 'fbc_consent_v1';
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}

  // Tell AdSense to default to non-personalized ads until the user opts in.
  // (AdSense reads this on first push; safe to set even before the script loads.)
  window.adsbygoogle = window.adsbygoogle || [];
  if (stored !== 'all') {
    window.adsbygoogle.requestNonPersonalizedAds = 1;
  }

  // Stored choices are already applied to Consent Mode inline in <head>
  // (tools/partials/analytics.html); here we only need Clarity.
  if (stored === 'all') loadClarity();
  if (stored === 'all' || stored === 'essential') return;

  function updateConsent(granted) {
    if (typeof window.gtag !== 'function') return;
    var v = granted ? 'granted' : 'denied';
    window.gtag('consent', 'update', {
      ad_storage: v, ad_user_data: v, ad_personalization: v, analytics_storage: v
    });
  }

  function build() {
    var bar = document.createElement('div');
    bar.id = 'fbc-consent';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cookie consent');
    bar.innerHTML =
      '<div class="fbc-consent-inner">' +
        '<p>We use cookies for basic analytics and to serve ads that keep this site free. ' +
        'Your files never leave your device &mdash; see our <a href="/pages/privacy">Privacy Policy</a>.</p>' +
        '<div class="fbc-consent-actions">' +
          '<button type="button" class="btn btn-secondary" data-c="essential">Essential only</button>' +
          '<button type="button" class="btn" data-c="all">Accept all</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bar);
    // The banner is position:fixed over the bottom of the viewport, which on a
    // phone sits right on top of the Convert button. Pad the page while it
    // is up so nothing important is unreachable behind it.
    document.body.classList.add('fbc-consent-open');

    bar.addEventListener('click', function (e) {
      var choice = e.target && e.target.getAttribute('data-c');
      if (!choice) return;
      try { localStorage.setItem(KEY, choice); } catch (err) {}
      updateConsent(choice === 'all');
      if (choice === 'all') {
        // Re-enable personalized ads on next adsbygoogle push.
        window.adsbygoogle.requestNonPersonalizedAds = 0;
        loadClarity();
      }
      bar.parentNode.removeChild(bar);
      document.body.classList.remove('fbc-consent-open');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }

  // Microsoft Clarity (heatmaps + session replay). It sets cookies, so it only
  // loads for visitors who accepted all. The ID lives in the analytics partial.
  function loadClarity() {
    var id = window.FBC_CLARITY_ID;
    if (!id || window.clarity) return;
    window.clarity = function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.clarity.ms/tag/' + encodeURIComponent(id);
    document.head.appendChild(s);
  }
})();
