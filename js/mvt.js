/**
 * A minimal Mapbox Vector Tile decoder, just enough for the route-home
 * worker to read road lines out of the map tiles the service worker has
 * already cached. It decodes one named layer's line features (properties
 * plus geometry in tile units) and skips everything else, including points
 * and polygons. Spec: https://github.com/mapbox/vector-tile-spec
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

const GEOM_LINESTRING = 2;
const CMD_MOVE_TO = 1;
const CMD_LINE_TO = 2;
const CMD_CLOSE_PATH = 7;

const textDecoder = new TextDecoder();

/** Sequential reader over a protobuf-encoded byte range. */
class Reader {
	/** @param {Uint8Array} bytes @param {number} [start] @param {number} [end] */
	constructor(bytes, start = 0, end = bytes.length) {
		this.bytes = bytes;
		this.pos = start;
		this.end = end;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	/** Reads an unsigned varint. Past 2^53 it loses precision, which only feature ids could hit, and those are skipped. */
	varint() {
		let result = 0;
		let shift = 1;
		let byte;
		do {
			byte = this.bytes[this.pos++];
			result += (byte & 0x7f) * shift;
			shift *= 128;
		} while (byte >= 0x80);
		return result;
	}

	/** Reads a zigzag-encoded signed varint. */
	svarint() {
		const n = this.varint();
		return n % 2 === 1 ? (n + 1) / -2 : n / 2;
	}

	/** Reads a length prefix and returns the [start, end) byte range it covers, advancing past it. */
	range() {
		const length = this.varint();
		const start = this.pos;
		this.pos += length;
		return [start, this.pos];
	}

	string() {
		const [start, end] = this.range();
		return textDecoder.decode(this.bytes.subarray(start, end));
	}

	/** Skips a field's value of the given wire type. */
	skip(wireType) {
		if (wireType === WIRE_VARINT) this.varint();
		else if (wireType === WIRE_FIXED64) this.pos += 8;
		else if (wireType === WIRE_BYTES) this.range();
		else if (wireType === WIRE_FIXED32) this.pos += 4;
		else throw new Error(`Unsupported protobuf wire type ${wireType}`);
	}

	/** Reads a packed repeated varint field. */
	packed() {
		const [start, end] = this.range();
		const inner = new Reader(this.bytes, start, end);
		const values = [];
		while (inner.pos < end) values.push(inner.varint());
		return values;
	}
}

/**
 * Decodes the line features of one layer of a vector tile.
 *
 * @param {ArrayBuffer|Uint8Array} data - The tile's raw (already un-gzipped) bytes.
 * @param {string} layerName - e.g. "transportation".
 * @returns {{extent: number, features: Array<{properties: Object, lines: Array<Array<[number, number]>>}>}|null}
 *   Geometry is in tile units (0..extent, possibly a little outside for the
 *   tile's buffer). Null when the tile has no layer of that name.
 */
export function decodeLineLayer(data, layerName) {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	const tile = new Reader(bytes);
	while (tile.pos < tile.end) {
		const tag = tile.varint();
		// Tile field 3 is a layer; nothing else lives at the top level.
		if (tag >> 3 !== 3 || (tag & 7) !== WIRE_BYTES) {
			tile.skip(tag & 7);
			continue;
		}
		const [start, end] = tile.range();
		const layer = readLayer(bytes, start, end, layerName);
		if (layer) return layer;
	}
	return null;
}

/**
 * Reads one layer, returning null (having decoded only its name) when it
 * isn't the wanted one. Feature ranges are collected first because the
 * layer's keys and values, which the features refer to, can come after them.
 */
function readLayer(bytes, start, end, layerName) {
	const reader = new Reader(bytes, start, end);
	let name = null;
	let extent = 4096;
	const keys = [];
	const values = [];
	const featureRanges = [];

	while (reader.pos < end) {
		const tag = reader.varint();
		const field = tag >> 3;
		if (field === 1) name = reader.string();
		else if (field === 2) featureRanges.push(reader.range());
		else if (field === 3) keys.push(reader.string());
		else if (field === 4) values.push(readValue(bytes, ...reader.range()));
		else if (field === 5) extent = reader.varint();
		else reader.skip(tag & 7);
	}
	if (name !== layerName) return null;

	const features = [];
	for (const [featureStart, featureEnd] of featureRanges) {
		const feature = readLineFeature(bytes, featureStart, featureEnd, keys, values);
		if (feature) features.push(feature);
	}
	return { extent, features };
}

/** Reads one Value message: string, float, double, int, uint, sint or bool. */
function readValue(bytes, start, end) {
	const reader = new Reader(bytes, start, end);
	let value = null;
	while (reader.pos < end) {
		const tag = reader.varint();
		const field = tag >> 3;
		if (field === 1) value = reader.string();
		else if (field === 2) {
			value = reader.view.getFloat32(reader.pos, true);
			reader.pos += 4;
		} else if (field === 3) {
			value = reader.view.getFloat64(reader.pos, true);
			reader.pos += 8;
		} else if (field === 4 || field === 5) value = reader.varint();
		else if (field === 6) value = reader.svarint();
		else if (field === 7) value = reader.varint() !== 0;
		else reader.skip(tag & 7);
	}
	return value;
}

/** Reads one feature, or null when it isn't a line. */
function readLineFeature(bytes, start, end, keys, values) {
	const reader = new Reader(bytes, start, end);
	let tags = null;
	let type = 0;
	let geometry = null;
	while (reader.pos < end) {
		const tag = reader.varint();
		const field = tag >> 3;
		if (field === 2) tags = reader.packed();
		else if (field === 3) type = reader.varint();
		else if (field === 4) geometry = reader.packed();
		else reader.skip(tag & 7);
	}
	if (type !== GEOM_LINESTRING || !geometry) return null;

	const properties = {};
	if (tags) {
		for (let i = 0; i + 1 < tags.length; i += 2) properties[keys[tags[i]]] = values[tags[i + 1]];
	}
	return { properties, lines: decodeLines(geometry) };
}

/**
 * Turns a feature's command stream into absolute-coordinate lines. A
 * multi-line feature has one MoveTo per part; the cursor carries across parts.
 */
function decodeLines(commands) {
	const lines = [];
	let line = null;
	let x = 0;
	let y = 0;
	let i = 0;
	while (i < commands.length) {
		const command = commands[i] & 7;
		const count = commands[i] >> 3;
		i++;
		if (command === CMD_CLOSE_PATH) continue;
		for (let n = 0; n < count; n++) {
			x += zigzag(commands[i++]);
			y += zigzag(commands[i++]);
			if (command === CMD_MOVE_TO) {
				line = [];
				lines.push(line);
			}
			if (command === CMD_MOVE_TO || command === CMD_LINE_TO) line?.push([x, y]);
		}
	}
	return lines.filter((part) => part.length >= 2);
}

function zigzag(n) {
	return n % 2 === 1 ? (n + 1) / -2 : n / 2;
}
