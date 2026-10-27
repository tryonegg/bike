/**
 * PWA plumbing: the "add to home screen" banner, the wake-lock that keeps
 * the screen on during a ride, and service-worker registration/update
 * prompting.
 */

import { state, el } from "./state.js";
import { confirmWithModal } from "./modal.js";
import { countSessions, countRoutes } from "./db.js";

/**
 * Shows or hides the install banner and sets its message/button state,
 * based on whether the user has dismissed it before and whether the browser
 * has actually offered an install prompt yet (`beforeinstallprompt`). Called
 * on startup and again whenever that prompt event fires.
 */
export function maybeShowInstallBanner() {
	if (state.prefs.installDismissed) {
		el.installBanner.classList.add("hidden");
		return;
	}

	el.installBanner.classList.remove("hidden");
	if (state.deferredInstallPrompt) {
		el.installMessage.textContent = "Add Bike Tracker to your home screen for quick, full-screen access.";
		el.installBtn.disabled = false;
	} else {
		el.installMessage.textContent = "Install is available from your browser menu if the button is disabled.";
		el.installBtn.disabled = true;
	}
}

/**
 * Asks the browser to keep this app's storage rather than clearing it when
 * space runs low. Rides and routes live only on this device, so losing the
 * database loses them for good. Only asked once there is something to keep,
 * since some browsers show the rider a prompt for it. Safe to call often:
 * it returns at once when storage is already persistent.
 *
 * @returns {Promise<boolean>} Whether storage is persistent afterwards.
 */
export async function protectStoredData() {
	if (!navigator.storage?.persist) return false;
	try {
		if (await navigator.storage.persisted()) return true;
		const [rides, routes] = await Promise.all([countSessions(), countRoutes()]);
		if (!rides && !routes) return false;
		return await navigator.storage.persist();
	} catch (error) {
		console.warn("Persistent storage request failed", error);
		return false;
	}
}

/**
 * Fills the settings screen's storage note: whether the browser has agreed
 * to keep the app's data, and roughly how much space it takes.
 *
 * @returns {Promise<void>}
 */
export async function renderStorageStatus() {
	const storage = navigator.storage;
	if (!storage?.persisted) {
		el.storageStatus.textContent = "This browser can't promise to keep your rides. Export your data now and then.";
		return;
	}
	try {
		const [persisted, estimate] = await Promise.all([storage.persisted(), storage.estimate ? storage.estimate() : null]);
		const used = Number.isFinite(estimate?.usage) ? ` Using ${formatBytes(estimate.usage)}.` : "";
		el.storageStatus.textContent = persisted
			? `Storage is protected: the browser won't clear your rides to free up space.${used}`
			: `Storage isn't protected yet, so the browser may clear your rides if the device runs low on space. Installing the app usually fixes this. Export your data now and then.${used}`;
	} catch (error) {
		console.warn("Reading storage status failed", error);
		el.storageStatus.textContent = "";
	}
}

/**
 * A byte count as a short size, e.g. "4.2 MB".
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Requests a screen wake lock, if the current ride asked for one and no lock
 * is already held. Safe to call repeatedly (e.g. on every resume from
 * pause) — the ride's own `keepScreenOn` preference is the single gate every
 * caller goes through, so resuming or returning to the foreground can never
 * re-arm a lock the user declined for this ride.
 *
 * @returns {Promise<void>}
 */
export async function requestWakeLock() {
	if (!("wakeLock" in navigator)) return;
	// Single gate for every caller: the ride's own preference decides, so resuming
	// from pause or returning to the foreground can never re-arm a lock the user declined.
	if (!state.currentSession?.keepScreenOn) return;
	try {
		if (state.wakeLockSentinel && !state.wakeLockSentinel.released) return;
		state.wakeLockSentinel = await navigator.wakeLock.request("screen");
		state.wakeLockSentinel.addEventListener("release", () => {
			state.wakeLockSentinel = null;
			if (state.currentSession?.paused === false && !document.hidden) {
				requestWakeLock();
			}
		});
	} catch (error) {
		console.warn("Wake lock unavailable", error);
	}
}

/**
 * Releases the held screen wake lock, if any. Failures are swallowed —
 * there's nothing useful to do about a release that doesn't succeed.
 *
 * @returns {Promise<void>}
 */
export async function releaseWakeLock() {
	try {
		if (state.wakeLockSentinel && !state.wakeLockSentinel.released) {
			await state.wakeLockSentinel.release();
			state.wakeLockSentinel = null;
		}
	} catch {
		// Ignore release failures.
	}
}

/**
 * Registers `sw.js`, then wires up update checking on success. Called once
 * during `init()`. A registration failure is logged, not surfaced to the
 * user — the app still works without a service worker, just without offline
 * support.
 */
export function registerServiceWorker() {
	if ("serviceWorker" in navigator) {
		navigator.serviceWorker
			.register("sw.js", { updateViaCache: "none" })
			.then((registration) => {
				state.swRegistration = registration;
				setupServiceWorkerUpdateChecks(registration);
			})
			.catch((error) => {
				console.warn("Service worker registration failed", error);
			});
	}
}

/**
 * Wires up the app's service-worker update lifecycle: periodic/on-focus
 * `registration.update()` checks, prompting the user to reload when a new
 * worker is waiting or the worker itself reports changed shell files, and
 * reloading once the new worker actually takes control. A ride in progress
 * always wins — every path here backs off while `state.currentSession` is set,
 * so an update never interrupts an active ride.
 *
 * @param {ServiceWorkerRegistration} registration
 */
export function setupServiceWorkerUpdateChecks(registration) {
	const promptRefresh = async (message) => {
		// Never interrupt a ride in progress: reloading would drop the live session.
		if (state.currentSession) return;
		if (state.swUpdatePromptOpen) return;
		state.swUpdatePromptOpen = true;
		const shouldUpdate = await confirmWithModal({
			title: "Update Ready",
			message,
			confirmText: "Reload",
			cancelText: "Later",
		});
		state.swUpdatePromptOpen = false;

		if (!shouldUpdate) return;

		if (registration.waiting) {
			registration.waiting.postMessage({ type: "SKIP_WAITING" });
			return;
		}

		window.location.reload();
	};

	const maybePrompt = async () => {
		if (!registration.waiting) return;
		await promptRefresh("A new version of Bike Tracker is available. Reload now to apply updates?");
	};

	if (registration.waiting) {
		maybePrompt();
	}

	navigator.serviceWorker.addEventListener("message", (event) => {
		if (event.data?.type === "APP_SHELL_UPDATE_AVAILABLE") {
			promptRefresh("Newer app files were found on the server. Reload now to get the latest version?");
		}
	});

	registration.addEventListener("updatefound", () => {
		const installingWorker = registration.installing;
		if (!installingWorker) return;

		installingWorker.addEventListener("statechange", () => {
			if (installingWorker.state === "installed" && navigator.serviceWorker.controller) {
				maybePrompt();
			}
		});
	});

	let hasRefreshed = false;
	// A first visit's worker claiming the page isn't an update: the page is
	// already current, and reloading would drop whatever it opened (a shared
	// route link, whose hash is already cleared).
	let wasControlled = Boolean(navigator.serviceWorker.controller);
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!wasControlled) {
			wasControlled = true;
			return;
		}
		if (hasRefreshed) return;
		// A mid-ride reload here would discard the active session; the new worker
		// simply takes effect on the next natural load instead.
		if (state.currentSession) return;
		hasRefreshed = true;
		window.location.reload();
	});

	const triggerUpdateCheck = () => {
		if (state.currentSession) return;
		registration.update().catch((error) => {
			console.warn("Service worker update check failed", error);
		});
	};

	triggerUpdateCheck();
	setInterval(triggerUpdateCheck, 5 * 60 * 1000);
	window.addEventListener("focus", triggerUpdateCheck);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") triggerUpdateCheck();
	});
}
