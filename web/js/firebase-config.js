/**
 * Firebase config for web booking page.
 * Uses compat SDK - loaded via script tags in index.html.
 */
const firebaseConfig = {
  apiKey: "AIzaSyB9DwVkkCM-0cpYhkWRnTfScHIRNIDyJ3g",
  authDomain: "test-app-96812.firebaseapp.com",
  projectId: "test-app-96812",
  storageBucket: "test-app-96812.firebasestorage.app",
  messagingSenderId: "729589639948",
  appId: "1:729589639948:web:af6eb6c640f3364c6d7729",
  measurementId: "G-L01T86TY3K"
};

/**
 * Shared Adobe Fonts Web Project (one kit for all businesses on this site).
 * In Adobe Fonts → Web Projects: add Squash MN, Sincopa, Mercato Variable (or a subset),
 * allow your hosting domains (e.g. getbookking.com, www.getbookking.com, *.web.app), then paste the kit ID from the embed URL:
 *   https://use.typekit.net/<KIT_ID>.css
 * Leave empty until configured; Adobe headline fonts won’t load without it.
 */
window.adobeFontsKitId = "";
