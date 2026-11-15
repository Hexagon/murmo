// Emoji: a fixed set to pick from, and a test for messages that are only emoji (shown larger).
//
// Emoji are plain Unicode text in the message and drawn by the system's own emoji font: no images, no fonts or
// sprite sheets from elsewhere, nothing parsed into markup. A message stays text whatever it contains.

/** [label, icon, emoji] per category; the emoji of one category are one string split into graphemes. */
const SETS = [
  ["Ansikten", "😀", "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖"],
  ["Gester", "👍", "👋 🤚 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🫶 👀 🧠 🫡 🤷 🤦 🙋 🙇 💃 🕺 🏃 🚶"],
  ["Hjärtan", "❤️", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💋 💯 💢 💥 💫 💦 💨 💬 💭 💤 ✨ ⭐ 🌟 🔥 🎉 🎊 🎈 🎁 🏆 🥇 🎯"],
  ["Natur", "🌿", "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🐟 🐬 🐳 🦭 🌸 🌹 🌻 🌷 🌱 🌲 🌳 🍀 🍁 🍂 🍄 🌍 🌙 ☀️ ⛅ 🌧️ ⛈️ ❄️ ☃️ 🌈 🌊"],
  ["Mat", "🍕", "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥕 🌽 🌶️ 🥔 🥐 🍞 🥨 🧀 🥚 🥞 🧇 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🍝 🍜 🍣 🍱 🍦 🍰 🎂 🧁 🍪 🍫 🍬 🍿 ☕ 🍵 🧃 🥤 🍺 🍻 🥂 🍷 🍸"],
  ["Aktiviteter", "⚽", "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🏸 🏒 ⛳ 🎣 🎿 ⛸️ 🛹 🚴 🏊 🧗 🧘 🎮 🎲 ♟️ 🧩 🎨 🎬 🎤 🎧 🎸 🎹 🥁 🎻 📚 ✏️ 💻 📱 📷 🎥 💡 🔑 🔒 🔓 🛡️ 📎 📌 📅 ⏰ ⌛ 💰 🛒"],
  ["Resor", "✈️", "🚗 🚕 🚌 🚎 🏎️ 🚓 🚑 🚒 🚲 🛴 🛵 🏍️ 🚂 🚆 🚇 🚢 ⛵ 🚤 ✈️ 🚀 🛸 🚁 ⛺ 🏠 🏡 🏢 🏰 🗼 🗽 ⛪ 🏖️ 🏝️ 🏔️ 🌋 🗺️ 🧭 🎢 🎡"],
  ["Symboler", "✅", "✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ❓ ❗ ‼️ ⁉️ ⚠️ 🚫 ⛔ ♻️ 🔁 ▶️ ⏸️ ⏹️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🆗 🆕 🆒 🆘 ℹ️ 🔔 🔕 🎵 💲 ©️ ®️ ™️ 🇸🇪 🇳🇴 🇩🇰 🇫🇮 🇮🇸 🇪🇺 🏳️‍🌈"],
];

export const CATEGORIES = SETS.map(([label, icon, list]) => ({ label, icon, emoji: list.split(" ") }));

/** How many recently used emoji are kept (in the device's encrypted store). */
export const RECENT_MAX = 24;

const ALL = new Set(CATEGORIES.flatMap((c) => c.emoji));

/** Whether `e` is one of the emoji offered here (the recent list is checked against it when read). */
export function known(e) {
  return ALL.has(e);
}

/** `recent` with `e` first, without duplicates or anything not offered here, at most RECENT_MAX long. */
export function remember(recent, e) {
  return [e, ...(Array.isArray(recent) ? recent : [])].filter((x, i, all) => known(x) && all.indexOf(x) === i).slice(0, RECENT_MAX);
}

const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** One grapheme that is an emoji: a pictograph (with modifiers, joiners, variation selectors), a flag or a keycap. */
function isEmoji(g) {
  return /^\p{Extended_Pictographic}/u.test(g) || /^\p{Regional_Indicator}{2}$/u.test(g) || /^[0-9#*]️?⃣$/u.test(g);
}

/**
 * Whether a message is only emoji, at most `max` of them (whitespace between them allowed): such a message is shown
 * larger. Plain text with an emoji in it is not.
 */
export function emojiOnly(text, max = 3) {
  if (typeof text !== "string" || !segmenter) return false;
  const t = text.replace(/\s+/gu, "");
  if (!t || t.length > 64) return false;
  let n = 0;
  for (const { segment } of segmenter.segment(t)) {
    if (!isEmoji(segment) || ++n > max) return false;
  }
  return n > 0;
}
