# Voice clips

Spoken turn-by-turn directions (js/voice.js) play these files, one after
another, to make each prompt: for example `in_500_feet.mp3` then
`turn_right.mp3`. Until a prompt's clips are all here, the app reads the
words below with the device's own speech instead, so directions work with
none of these files present.

Add each recording's name (without `.mp3`) to `clips.json` as you add the
file, e.g. `["turn_left", "turn_right"]`: the app only asks for the clips
listed there, and speaks the rest.

- Format: MP3, mono, 44.1 kHz, about 96 kbps.
- Trim silence at both ends (clips are chained), and keep the same voice,
  level (about -16 LUFS) and pace for all of them.
- Record distance clips so they run straight into a turn: "In 500 feet,"
  then "turn right", with no trailing pause.

| File | Says |
| --- | --- |
| `in_quarter_mile.mp3` | In a quarter mile, |
| `in_500_feet.mp3` | In 500 feet, |
| `in_400_meters.mp3` | In 400 meters, |
| `in_150_meters.mp3` | In 150 meters, |
| `turn_left.mp3` | Turn left |
| `turn_right.mp3` | Turn right |
| `bear_left.mp3` | Bear left |
| `bear_right.mp3` | Bear right |
| `sharp_left.mp3` | Make a sharp left |
| `sharp_right.mp3` | Make a sharp right |
| `u_turn.mp3` | Make a U-turn |
| `then.mp3` | Then |
| `turn_around.mp3` | Turn around when you can. |
| `arrive_waypoint.mp3` | You've reached your next point. |
| `arrive_final.mp3` | You've reached the end of your route. |
| `arrive_start.mp3` | You're back at the start. |
| `arrive_destination.mp3` | You've arrived at your destination. |
| `rerouting.mp3` | Rerouting. |
| `off_route.mp3` | You're off the route. |
| `point_skipped.mp3` | Skipping to the next point. |
| `directions_stopped.mp3` | Directions stopped. |
