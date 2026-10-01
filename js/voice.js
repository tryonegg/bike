/**
 * Spoken directions, by the Web Speech API in the voice and at the volume
 * picked in settings (`voiceURI`, `voiceVolume`; the volume is a share of
 * the device's own).
 *
 * Phones only let a page make sound after a tap, so `unlockVoice` must run
 * from one: it's hooked to the first tap anywhere, and to Start Ride.
 */

import { state } from "./state.js";

/** Whether this browser can speak at all (the Web Speech API's synthesis half). */
export const speechSupported = typeof window !== "undefined" && "speechSynthesis" in window;
const TEST_PHRASE = "In 500 feet, turn right onto Main Street.";
// Apple's sound-effect voices, which are no use for directions: left out of the picker.
const NOVELTY_VOICES = new Set([
	"Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Deranged", "Good News", "Hysterical",
	"Jester", "Junior", "Organ", "Pipe Organ", "Ralph", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox",
	"Fred", "Kathy", "Princess",
]);

// Prompts waiting longer than this are stale (the rider has moved on) and
// are dropped rather than spoken late.
const STALE_MS = 6000;

let unlocked = false;
const queue = [];
let speaking = false;

document.addEventListener("pointerdown", unlockVoice, { once: true, capture: true });

/**
 * Lets the page make sound from now on. Must run in a tap's handler (the
 * first one does it anyway); later calls do nothing.
 */
export function unlockVoice() {
	if (unlocked) return;
	unlocked = true;
	// Speaking anything from a tap lets later prompts speak without one.
	if (speechSupported) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
}

/**
 * Says a prompt, queued behind any prompt already being spoken.
 * @param {string} text
 */
export function say(text) {
	if (!text) return;
	queue.push({ text, at: Date.now() });
	if (!speaking) speakNext();
}

/**
 * The device's voices for the voice picker: only those in the browser's
 * language (any region of it), grouped by region with the browser's own
 * first ("American English", then "British English", …), and never Apple's
 * novelty voices. A device with no voice in that language offers them all,
 * so the picker is never empty. Browsers load their voices late, so
 * this can be empty at first; see `onVoicesChanged`.
 *
 * @returns {Array<{value: string, label: string, group: string}>} `value` is the voice's URI.
 */
export function voiceChoices() {
	if (!speechSupported) return [];
	const locale = normalizeLang(navigator.language || "en-US");
	const language = locale.split("-")[0];
	const voices = window.speechSynthesis.getVoices().filter((voice) => !NOVELTY_VOICES.has(voice.name.replace(/ \(.*\)$/, "")));
	const inLanguage = voices.filter((voice) => normalizeLang(voice.lang).split("-")[0] === language);
	const names = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames([locale], { type: "language" }) : null;
	const groupOf = (voice) => {
		const lang = normalizeLang(voice.lang);
		try {
			return names?.of(lang) ?? lang;
		} catch {
			return lang;
		}
	};
	// The browser's own region first, other regions after.
	const rank = (voice) => (normalizeLang(voice.lang) === locale ? 0 : 1);

	return (inLanguage.length ? inLanguage : voices)
		.map((voice) => {
			const group = groupOf(voice);
			return { voice, group, rank: rank(voice) };
		})
		.sort((a, b) => a.rank - b.rank || a.group.localeCompare(b.group) || a.voice.name.localeCompare(b.voice.name))
		.map(({ voice, group }) => ({
			value: voice.voiceURI,
			label: `${voice.name}${voice.default ? " — default" : ""}`,
			group,
		}));
}

/** A language tag in one spelling: "en_us" and "en-US" both become "en-US". */
function normalizeLang(tag) {
	const [language, region] = tag.replace("_", "-").split("-");
	return region ? `${language.toLowerCase()}-${region.toUpperCase()}` : language.toLowerCase();
}

/**
 * Calls `fn` whenever the device's voice list changes (including when it
 * first loads).
 * @param {() => void} fn
 */
export function onVoicesChanged(fn) {
	if (speechSupported) window.speechSynthesis.addEventListener("voiceschanged", fn);
}

/** Speaks a sample direction straight away in the picked voice, cutting off anything playing. */
export function testVoice() {
	unlockVoice();
	if (!speechSupported) return;
	window.speechSynthesis.cancel();
	speak(TEST_PHRASE);
}

async function speakNext() {
	const next = queue.shift();
	if (!next) {
		speaking = false;
		return;
	}
	speaking = true;
	if (Date.now() - next.at <= STALE_MS) await speak(next.text);
	speakNext();
}

/** Speaks text in the picked voice (or the device's default), at the picked volume. */
function speak(text) {
	return new Promise((resolve) => {
		if (!speechSupported) {
			resolve();
			return;
		}
		const utterance = new SpeechSynthesisUtterance(text);
		const voice = window.speechSynthesis.getVoices().find((candidate) => candidate.voiceURI === state.prefs.voiceURI);
		if (voice) {
			utterance.voice = voice;
			utterance.lang = voice.lang;
		} else {
			utterance.lang = navigator.language || "en-US";
		}
		utterance.volume = state.prefs.voiceVolume;
		utterance.onend = resolve;
		utterance.onerror = resolve;
		window.speechSynthesis.speak(utterance);
	});
}
