// Shared between the map marker icons and the stop chip text so both always
// show the same symbol for a given stop type. 📍 is the fallback for any
// stop type that isn't explicitly covered yet.
const STOP_TYPE_EMOJI = {
  coffee: "☕",
  library: "📚",
  takeout: "🥐",
  food: "🥐",
  package: "📦",
  pharmacy: "💊",
  grocery: "🛒",
};

export function getStopEmoji(stopType) {
  return STOP_TYPE_EMOJI[stopType] || "📍";
}
