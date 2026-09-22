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
import { openSharedRouteFromHash, openSharedRouteFromUrl } from "./js/route-plan.js";

const ready = init().catch((error) => {
	console.error(error);
	showMessage("Initialization Failed", "App initialization failed. Please refresh.");
});

// An installed, already-running app is normally just focused, not navigated,
// when a link to it (e.g. a shared route) is tapped again, so this is the
// only way such a tap reaches the app at all: the Launch Handler API hands
// the tapped URL straight to the page instead of a real navigation. Set
// outside `init()`, so a launch already queued before this script ran isn't
// missed (the browser holds it until a consumer exists), but every call
// waits for `init()`'s own setup (screen wiring, the initial history entry)
// so it can't run ahead of that.
if ("launchQueue" in window) {
	window.launchQueue.setConsumer((launchParams) => {
		if (!launchParams.targetURL) return;
		ready.then(() => openSharedRouteFromUrl(launchParams.targetURL)).catch((error) => console.warn("Opening a launched route failed", error));
	});
}

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
