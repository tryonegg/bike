/**
 * Reading Garmin's binary FIT activity files (from Zwift, bike computers,
 * watches) into a ride shaped like a recorded one. Only the messages a ride
 * needs are decoded: the file's maker, the activity summary, the per-second
 * records and the timer's start/stop events. Developer fields are skipped.
 *
 * Format: https://developer.garmin.com/fit/protocol/
 */

// Message numbers from the FIT profile.
const MESG_FILE_ID = 0;
const MESG_SESSION = 18;
const MESG_RECORD = 20;
const MESG_EVENT = 21;

// Values the rest of this file tests for.
const MANUFACTURER_ZWIFT = 260;
const SUB_SPORT_VIRTUAL = 58;
const EVENT_TIMER = 0;
const EVENT_TYPE_START = 0;
const EVENT_TYPES_STOP = new Set([1, 4]); // stop, stop_all

// FIT counts seconds from 1989-12-31T00:00:00Z.
const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);
const SEMICIRCLE_DEGREES = 180 / 2 ** 31;

// Base types by their low five bits: [byte size, DataView getter, invalid value].
const BASE_TYPES = {
	0x00: [1, "getUint8", 0xff], // enum
	0x01: [1, "getInt8", 0x7f],
	0x02: [1, "getUint8", 0xff],
	0x03: [2, "getInt16", 0x7fff],
	0x04: [2, "getUint16", 0xffff],
	0x05: [4, "getInt32", 0x7fffffff],
	0x06: [4, "getUint32", 0xffffffff],
	0x08: [4, "getFloat32", null],
	0x09: [8, "getFloat64", null],
	0x0a: [1, "getUint8", 0x00], // uint8z
	0x0b: [2, "getUint16", 0x0000],
	0x0c: [4, "getUint32", 0x00000000],
	0x0d: [1, "getUint8", null], // byte
};

/**
 * Whether the bytes look like a FIT file (".FIT" at offset 8 of the header).
 * @param {ArrayBuffer} buffer
 * @returns {boolean}
 */
export function isFitFile(buffer) {
	if (buffer.byteLength < 12) return false;
	const bytes = new Uint8Array(buffer, 8, 4);
	return String.fromCharCode(...bytes) === ".FIT";
}

/**
 * Decodes the messages of a FIT file that a ride needs.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{fileId: Object|null, session: Object|null, records: Array<Object>, events: Array<Object>}}
 *   Each message is a map of field number to value, with invalid values left out.
 * @throws {Error} If the file isn't FIT or is cut short.
 */
function decodeFit(buffer) {
	if (!isFitFile(buffer)) throw new Error("The file is not a valid FIT file.");
	const view = new DataView(buffer);
	const headerSize = view.getUint8(0);
	const dataSize = view.getUint32(4, true);
	const end = Math.min(headerSize + dataSize, buffer.byteLength);
	const wanted = new Set([MESG_FILE_ID, MESG_SESSION, MESG_RECORD, MESG_EVENT]);

	const definitions = [];
	const out = { fileId: null, session: null, records: [], events: [] };
	let lastTimestamp = null;
	let pos = headerSize;

	while (pos < end) {
		const header = view.getUint8(pos++);
		let local;
		let timeOffset = null;

		if (header & 0x80) {
			// Compressed timestamp header: a data message whose time is five bits
			// added to the last full timestamp.
			local = (header >> 5) & 0x03;
			timeOffset = header & 0x1f;
		} else if (header & 0x40) {
			// Definition message.
			local = header & 0x0f;
			const hasDeveloperFields = Boolean(header & 0x20);
			const littleEndian = view.getUint8(pos + 1) === 0;
			const global = view.getUint16(pos + 2, littleEndian);
			const count = view.getUint8(pos + 4);
			pos += 5;
			const fields = [];
			for (let i = 0; i < count; i++, pos += 3) {
				fields.push({ num: view.getUint8(pos), size: view.getUint8(pos + 1), type: view.getUint8(pos + 2) & 0x1f });
			}
			let developerBytes = 0;
			if (hasDeveloperFields) {
				const devCount = view.getUint8(pos++);
				for (let i = 0; i < devCount; i++, pos += 3) developerBytes += view.getUint8(pos + 1);
			}
			definitions[local] = { global, littleEndian, fields, developerBytes };
			continue;
		} else {
			local = header & 0x0f;
		}

		const def = definitions[local];
		if (!def) throw new Error("The FIT file is damaged (a message has no definition).");

		const values = wanted.has(def.global) ? {} : null;
		for (const field of def.fields) {
			if (values) {
				const value = readField(view, pos, field, def.littleEndian);
				if (value !== null) values[field.num] = value;
			}
			pos += field.size;
		}
		pos += def.developerBytes;
		if (pos > end) throw new Error("The FIT file is cut short.");

		// Every message's own timestamp (field 253) keeps compressed ones in step.
		if (values && Number.isFinite(values[253])) {
			lastTimestamp = values[253];
		} else if (timeOffset !== null && lastTimestamp !== null) {
			lastTimestamp += (timeOffset - (lastTimestamp & 0x1f) + 0x20) & 0x1f;
			if (values) values[253] = lastTimestamp;
		}
		if (!values) continue;

		if (def.global === MESG_RECORD) out.records.push(values);
		else if (def.global === MESG_EVENT) out.events.push(values);
		else if (def.global === MESG_SESSION) out.session ??= values;
		else if (def.global === MESG_FILE_ID) out.fileId ??= values;
	}

	return out;
}

/**
 * One field's value, or `null` when it holds FIT's "invalid" marker or isn't
 * a single number (arrays and strings aren't needed here).
 */
function readField(view, pos, field, littleEndian) {
	const base = BASE_TYPES[field.type];
	if (!base) return null;
	const [size, getter, invalid] = base;
	if (field.size !== size) return null;
	const value = view[getter](pos, littleEndian);
	if (value === invalid || !Number.isFinite(value)) return null;
	return value;
}

/** A FIT timestamp as epoch milliseconds. */
function fitTime(seconds) {
	return FIT_EPOCH_MS + seconds * 1000;
}

/** FIT's sport as one of the app's activities; cycling and anything unknown is a ride. */
function activityFromSport(sport) {
	if (sport === 17) return "hike"; // hiking
	if (sport === 41 || sport === 19 || sport === 37) return "kayak"; // kayaking, paddling, stand up paddleboarding
	if (sport === 1 || sport === 11) return "walk"; // running, walking
	return "bike";
}

/**
 * Reads a FIT activity into the parts of a ride: its points (in the app's
 * shape, plus heart rate, cadence, power and temperature where the file has
 * them), its pauses from the timer's stop and start events, and the totals
 * the device recorded where it recorded them.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{points: Array<Object>, pauses: Array<{start: number, end: number}>, activityType: string,
 *   virtual: boolean, totals: {totalDistance?: number, movingTime?: number, maxSpeed?: number,
 *   avgSpeed?: number, elevationGain?: number, elevationDrop?: number}}}
 * @throws {Error} If the file isn't FIT or has no located points.
 */
export function buildSessionFromFit(buffer) {
	const { fileId, session, records, events } = decodeFit(buffer);

	const points = [];
	for (const r of records) {
		if (!Number.isFinite(r[0]) || !Number.isFinite(r[1]) || !Number.isFinite(r[253])) continue;
		const lat = r[0] * SEMICIRCLE_DEGREES;
		const lng = r[1] * SEMICIRCLE_DEGREES;
		if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
		const rawAltitude = r[78] ?? r[2];
		const rawSpeed = r[73] ?? r[6];
		const point = {
			lat,
			lng,
			altitude: Number.isFinite(rawAltitude) ? rawAltitude / 5 - 500 : null,
			speed: Number.isFinite(rawSpeed) ? rawSpeed / 1000 : null,
			accuracy: null,
			timestamp: fitTime(r[253]),
		};
		// A reading of zero heart rate means no monitor was paired.
		if (r[3] > 0) point.heartRate = r[3];
		if (Number.isFinite(r[4])) point.cadence = r[4];
		if (Number.isFinite(r[7])) point.power = r[7];
		if (Number.isFinite(r[13])) point.temperature = r[13];
		points.push(point);
	}
	if (!points.length) {
		throw new Error("No GPS points found in this FIT file. Indoor rides without a route can't be imported.");
	}
	points.sort((a, b) => a.timestamp - b.timestamp);

	// A pause runs from a timer stop to the next timer start.
	const pauses = [];
	let stoppedAt = null;
	for (const e of events) {
		if (e[0] !== EVENT_TIMER || !Number.isFinite(e[253])) continue;
		const at = fitTime(e[253]);
		if (EVENT_TYPES_STOP.has(e[1])) stoppedAt ??= at;
		else if (e[1] === EVENT_TYPE_START && stoppedAt !== null) {
			if (at > stoppedAt) pauses.push({ start: stoppedAt, end: at });
			stoppedAt = null;
		}
	}

	const totals = {};
	if (session) {
		if (Number.isFinite(session[9])) totals.totalDistance = session[9] / 100;
		if (Number.isFinite(session[8])) totals.movingTime = session[8]; // total timer time, ms
		const avg = session[124] ?? session[14];
		const max = session[125] ?? session[15];
		if (Number.isFinite(avg)) totals.avgSpeed = avg / 1000;
		if (Number.isFinite(max)) totals.maxSpeed = max / 1000;
		if (Number.isFinite(session[22])) totals.elevationGain = session[22];
		if (Number.isFinite(session[23])) totals.elevationDrop = session[23];
	}

	const subSport = session?.[6];
	const virtual = subSport === SUB_SPORT_VIRTUAL || fileId?.[1] === MANUFACTURER_ZWIFT;

	return {
		points,
		pauses,
		activityType: activityFromSport(session?.[5]),
		virtual,
		totals,
	};
}
