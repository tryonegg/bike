/**
 * App entry point. Loaded by index.html as `<script type="module">`, after
 * the document body, so every element `js/state.js` looks up already
 * exists. Everything else lives under `js/`; this file only starts the app
 * and reports a hard failure if startup itself throws.
 */

import { loadPrefs } from "./js/db.js";
import { applyTheme, applyRideLayout, syncToggles, wireEvents } from "./js/navigation.js";
import { renderPastRides } from "./js/history-view.js";
import { maybeRecoverSession } from "./js/live-session.js";
import { registerServiceWorker, maybeShowInstallBanner } from "./js/pwa.js";
import { showMessage } from "./js/modal.js";
import { openSharedRouteFromHash } from "./js/route-plan.js";

init().catch((error) => {
	console.error(error);
	showMessage("Initialization Failed", "App initialization failed. Please refresh.");
});

/**
 * Boots the app: loads preferences, applies the theme/layout they imply,
 * wires up every DOM event listener, establishes the initial history entry,
 * renders the home screen's past-rides list, offers to recover an
 * in-progress ride left over from a prior session, and (last, since neither
 * is essential to a usable first paint) registers the service worker and
 * shows the install banner if appropriate.
 *
 * @returns {Promise<void>}
 */
async function init() {
	await loadPrefs();
	applyTheme();
	applyRideLayout();
	syncToggles();
	wireEvents();
	history.replaceState({ screen: "home" }, "");
	await renderPastRides();
	await maybeRecoverSession();
	await openSharedRouteFromHash();
	registerServiceWorker();
	maybeShowInstallBanner();
}
