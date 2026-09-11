/**
 * The app's one shared modal dialog: a single set of DOM elements
 * (`el.modalBackdrop` and friends) reused for every confirmation, message,
 * and list-picker in the app, driven as a promise-returning queue of one.
 */

import { state, el } from "./state.js";

/**
 * Shows a one-button "OK" message dialog.
 *
 * @param {string} title
 * @param {string} message
 * @returns {Promise<void>} Resolves once the dialog is dismissed.
 */
export function showMessage(title, message) {
	return showModal({
		title,
		message,
		confirmText: "OK",
		hideCancel: true,
	}).then(() => undefined);
}

/**
 * Shows a confirm/cancel dialog and resolves to whether the user confirmed.
 *
 * @param {Object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.confirmText]
 * @param {string} [options.cancelText]
 * @param {number} [options.timeoutMs] - If set, the dialog auto-cancels after
 *   this many milliseconds, showing a live countdown.
 * @param {string} [options.timeoutLabel] - Label shown next to the countdown.
 * @param {boolean} [options.danger] - Styles the confirm button as destructive.
 * @returns {Promise<boolean>} `true` if confirmed, `false` for cancel or timeout.
 */
export function confirmWithModal({ title, message, confirmText, cancelText, timeoutMs, timeoutLabel, danger }) {
	return showModal({
		title,
		message,
		confirmText,
		cancelText,
		timeoutMs,
		timeoutLabel,
		danger,
	}).then((result) => result === "confirm");
}

/**
 * The underlying modal primitive that `showMessage`/`confirmWithModal`/the
 * day-picker in history-view.js all build on. Populates and shows the shared
 * modal DOM, then returns a promise that settles when it closes.
 *
 * Only one modal can be open at a time: opening a new one first force-closes
 * (cancels) whatever modal is currently showing, resolving its promise rather
 * than leaving it pending forever.
 *
 * @param {Object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.confirmText]
 * @param {string} [options.cancelText]
 * @param {boolean} [options.hideCancel]
 * @param {boolean} [options.hideConfirm]
 * @param {boolean} [options.danger] - Colours the confirm button red, for
 *   actions that destroy data.
 * @param {Array<HTMLElement>} [options.listItems] - Buttons to pick from
 *   instead of (or alongside) confirm/cancel. Choosing one closes the modal,
 *   settling it with the item's index as a string, and then runs the item's
 *   own click handler.
 * @param {number} [options.timeoutMs]
 * @param {string} [options.timeoutLabel]
 * @returns {Promise<string>} Resolves with `"confirm"`, `"cancel"`,
 *   `"timeout"`, or a list-item's index (as a string).
 */
export function showModal({
	title,
	message,
	confirmText = "OK",
	cancelText = "Cancel",
	hideCancel = false,
	hideConfirm = false,
	// Colours the confirm button red, for actions that destroy data.
	danger = false,
	// Buttons to pick from. Choosing one closes the modal, settling it with the
	// item's index as a string, and then runs the item's own click handler.
	listItems = [],
	timeoutMs,
	timeoutLabel = "Auto cancel",
}) {
	// Settle any modal this one supersedes instead of dropping its resolver on the
	// floor - an unsettled promise left callers (the nav guard) awaiting forever.
	closeModal("cancel");

	el.modalTitle.textContent = title;
	el.modalMessage.textContent = message;
	el.modalConfirmBtn.textContent = confirmText;
	el.modalCancelBtn.textContent = cancelText;
	el.modalCancelBtn.classList.toggle("hidden", hideCancel);
	el.modalConfirmBtn.classList.toggle("hidden", hideConfirm);
	el.modalConfirmBtn.classList.toggle("danger", danger);

	el.modalList.innerHTML = "";
	el.modalList.classList.toggle("hidden", !listItems.length);
	listItems.forEach((item, index) => {
		item.addEventListener("click", () => closeModal(String(index)));
		const li = document.createElement("li");
		li.appendChild(item);
		el.modalList.appendChild(li);
	});
	el.modalCountdown.classList.add("hidden");
	el.modalBackdrop.classList.remove("hidden");
	el.modalBackdrop.setAttribute("aria-hidden", "false");

	return new Promise((resolve) => {
		state.modalResolver = resolve;

		if (timeoutMs) {
			const endAt = Date.now() + timeoutMs;
			const tick = () => {
				const seconds = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
				el.modalCountdown.textContent = `${timeoutLabel} in ${seconds}s`;
				el.modalCountdown.classList.remove("hidden");
				if (seconds === 0) return;
				state.modalCountdownTimer = setTimeout(tick, 250);
			};

			tick();
			state.modalTimer = setTimeout(() => closeModal("timeout"), timeoutMs);
		}
	});
}

/**
 * Hides the modal and settles whichever promise `showModal` is currently
 * awaiting. Safe to call when no modal is open (the resolver is just `null`
 * and nothing happens beyond re-hiding already-hidden UI).
 *
 * @param {string} [result] - The value the open `showModal` promise resolves
 *   with: `"cancel"`, `"confirm"`, `"timeout"`, or a list-item index string.
 */
export function closeModal(result = "cancel") {
	if (state.modalTimer) {
		clearTimeout(state.modalTimer);
		state.modalTimer = null;
	}
	if (state.modalCountdownTimer) {
		clearTimeout(state.modalCountdownTimer);
		state.modalCountdownTimer = null;
	}

	el.modalBackdrop.classList.add("hidden");
	el.modalBackdrop.setAttribute("aria-hidden", "true");
	el.modalCountdown.classList.add("hidden");

	// Clear the resolver before settling so a continuation that opens another modal
	// cannot see this one still pending.
	const resolver = state.modalResolver;
	state.modalResolver = null;
	if (resolver) resolver(result);
}
