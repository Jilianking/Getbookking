/**
 * Firebase config for web booking page.
 * Uses compat SDK - loaded via script tags in index.html.
 */
/**
 * Stripe publishable key (pk_test_… / pk_live_…). Used for embedded checkout on signup.html if the
 * createProviderSubscriptionCheckout callable does not return publishableKey (set STRIPE_PUBLISHABLE_KEY on Functions).
 * Safe to expose in the browser; pair with secret key only on the server.
 */
window.stripePublishableKey =
  "pk_live_51TP6NFEC5gt8o49hpbWXQMukWP8Miuo4H0RC2z26o1XJHSt8tpGAjGsIeIBFMKrQVF1FptbGyA6NJAnIMvWOl6Pe00fsa5c3CJ";

const firebaseConfig = {
  apiKey: "AIzaSyB9DwVkkCM-0cpYhkWRnTfScHIRNIDyJ3g",
  authDomain: "test-app-96812.firebaseapp.com",
  projectId: "test-app-96812",
  storageBucket: "test-app-96812.firebasestorage.app",
  messagingSenderId: "729589639948",
  appId: "1:729589639948:web:af6eb6c640f3364c6d7729",
  measurementId: "G-L01T86TY3K"
};
window.firebaseConfig = firebaseConfig;

/**
 * Shared Adobe Fonts Web Project (one kit for all businesses on this site).
 * In Adobe Fonts → Web Projects: add Squash MN, Sincopa, Mercato Variable (or a subset),
 * allow your hosting domains (e.g. getbookking.com, www.getbookking.com, *.web.app), then paste the kit ID from the embed URL:
 *   https://use.typekit.net/<KIT_ID>.css
 * Leave empty until configured; Adobe headline fonts won’t load without it.
 */
window.adobeFontsKitId = "";

/**
 * iOS App Store product page URL (optional). Example: https://apps.apple.com/app/id0000000000
 * When set, account.html and signup success "Download the app" use this link.
 */
window.appStoreUrl = "";

/**
 * TestFlight public join URL (optional). Example: https://testflight.apple.com/join/AbCdEfGh
 * When set, signup.html shows a direct "Join the beta" button after signup.
 */
window.testflightPublicJoinUrl = "https://testflight.apple.com/join/GD8AUjpS";
