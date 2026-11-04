/**
 * Get Bookking Cloud Functions entry point.
 * Each area lives in its own file; shared helpers are in core.js.
 */

const {
  Stripe,
  sms,
  stripeSecretKey,
  assertPlatformAdmin,
  registerPublicSiteFunctions,
  registerTapToPayLaunchEmailFunctions,
  registerTrialReminderFunctions,
  registerMcpFunctions,
  registerCustomDomainFunctions,
  notifyOwnerAboutAccount,
} = require("./core");

Object.assign(exports, require("./connectPayments"));
Object.assign(exports, require("./checkout"));
Object.assign(exports, require("./tapToPay"));
Object.assign(exports, require("./bookings"));
Object.assign(exports, require("./billing"));
Object.assign(exports, require("./apple"));
Object.assign(exports, require("./team"));
Object.assign(exports, require("./account"));
Object.assign(exports, require("./smsFunctions"));
Object.assign(exports, require("./shop"));

registerPublicSiteFunctions(exports, { assertPlatformAdmin });

registerTapToPayLaunchEmailFunctions(exports);

registerTrialReminderFunctions(exports, { stripeSecretKey, Stripe });

registerMcpFunctions(exports, { stripeSecretKey, Stripe, twilioAccountSid: sms.twilioAccountSid, twilioAuthToken: sms.twilioAuthToken });

registerCustomDomainFunctions(exports, {
  notifyOwner: notifyOwnerAboutAccount,
});
