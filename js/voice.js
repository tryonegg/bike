/**
 * Spoken directions. A prompt is a list of clip names, played one after
 * another from audio/<name>.mp3 (see VOICE_CLIPS for the full set and what
 * each one says), when every one of them has been recorded. Otherwise it's
 * spoken by the Web Speech API in the voice, speed and pitch picked in
 * settings (`voiceURI`, `voiceRate`, `voicePitch`), which can also say what
 * no recording can: the prompt's own words, street names included.
 * audio/clips.json lists the clips that have been recorded, so the ones
 * that haven't are never asked for (see audio/README.md).
 *
 * Phones only let a page play sound after a tap, so `unlockVoice` must run
 * from one: it's hooked to the first tap anywhere, and to Start Ride. It
 * also fetches the recorded clips, which caches them (through the service
 * worker) for riding offline.
 */

import { VOICE_CLIPS } from "./constants.js";
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

const CLIP_DIR = "audio/";
// Prompts waiting longer than this are stale (the rider has moved on) and
// are dropped rather than played late.
const STALE_MS = 6000;

const element = typeof Audio === "undefined" ? null : new Audio();
let unlocked = false;
// Which clips have a playable file: unknown until checked.
const available = new Map();
const queue = [];
let playing = false;

document.addEventListener("pointerdown", unlockVoice, { once: true, capture: true });

/**
 * Lets the page make sound from now on. Must run in a tap's handler (the
 * first one does it anyway); later calls do nothing.
 */
export function unlockVoice() {
	if (unlocked) return;
	unlocked = true;
	if (element) {
		// Playing anything from a tap unlocks this element for later clips.
		element.src = silentWav();
		element.play().catch(() => {});
	}
	if (speechSupported) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
	checkClips();
}

/**
 * Says a prompt: the recorded clips in order when they're all there, or else
 * `text` (the clips' own words by default) through speech synthesis. Queued
 * behind any prompt already playing.
 *
 * @param {string[]} clips - Names from VOICE_CLIPS.
 * @param {string} [text] - What to speak instead of the clips, when it
 *   can say more than they do (e.g. a street name).
 */
export function say(clips, text) {
	if (!clips.length) return;
	queue.push({ clips, text, at: Date.now() });
	if (!playing) playNext();
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

/** The words a prompt says, as one sentence. */
export function promptText(clips) {
	// "…bear right, then turn right": a pause before a chained turn.
	const text = clips.map((clip, i) => (clip === "then" && i ? ", then" : ` ${VOICE_CLIPS[clip] ?? clip}`)).join("").trim();
	return text.charAt(0).toUpperCase() + text.slice(1);
}

async function playNext() {
	const next = queue.shift();
	if (!next) {
		playing = false;
		return;
	}
	playing = true;
	if (Date.now() - next.at <= STALE_MS) {
		try {
			if (element && next.clips.every((clip) => available.get(clip))) {
				for (const clip of next.clips) await playClip(clip);
			} else {
				await speak(next.text ?? promptText(next.clips));
			}
		} catch (error) {
			// A clip that won't play is treated as missing from now on.
			console.warn("Voice prompt failed", error);
			for (const clip of next.clips) available.set(clip, false);
			await speak(next.text ?? promptText(next.clips)).catch(() => {});
		}
	}
	playNext();
}

function playClip(clip) {
	return new Promise((resolve, reject) => {
		const done = () => {
			element.removeEventListener("ended", done);
			element.removeEventListener("error", failed);
			resolve();
		};
		const failed = () => {
			element.removeEventListener("ended", done);
			element.removeEventListener("error", failed);
			reject(new Error(`Clip ${clip} failed`));
		};
		element.addEventListener("ended", done);
		element.addEventListener("error", failed);
		element.src = `${CLIP_DIR}${clip}.mp3`;
		element.play().catch(failed);
	});
}

/** Speaks text in the picked voice (or the device's default), at the picked speed and pitch. */
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
		utterance.rate = state.prefs.voiceRate;
		utterance.pitch = state.prefs.voicePitch;
		utterance.onend = resolve;
		utterance.onerror = resolve;
		window.speechSynthesis.speak(utterance);
	});
}

/**
 * Finds out which clips are recorded, from audio/clips.json, and fetches
 * them (which caches them for offline use too).
 */
async function checkClips() {
	let recorded = [];
	try {
		const response = await fetch(`${CLIP_DIR}clips.json`);
		if (response.ok) recorded = await response.json();
	} catch {
		// Offline before it was ever cached: speech synthesis it is.
	}
	await Promise.all(
		recorded
			.filter((clip) => clip in VOICE_CLIPS)
			.map(async (clip) => {
				try {
					const response = await fetch(`${CLIP_DIR}${clip}.mp3`);
					available.set(clip, response.ok);
				} catch {
					available.set(clip, false);
				}
			}),
	);
}

/** A tiny silent WAV, as a blob URL, for unlocking audio from a tap. */
function silentWav() {
	const samples = 800;
	const buffer = new ArrayBuffer(44 + samples);
	const view = new DataView(buffer);
	const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
	text(0, "RIFF");
	view.setUint32(4, 36 + samples, true);
	text(8, "WAVE");
	text(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 8000, true);
	view.setUint32(28, 8000, true);
	view.setUint16(32, 1, true);
	view.setUint16(34, 8, true);
	text(36, "data");
	view.setUint32(40, samples, true);
	new Uint8Array(buffer, 44).fill(128);
	return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}
