import { readEditorPreference, writeEditorPreference } from "../prompt_palette_state.js";

/**
 * 32 curated archetypes for deterministic seed interpretation.
 * Each archetype includes an inspirational prompt-engineering omen/aesthetic vibe.
 */
const SEED_ARCHETYPES = [
  { name: "Cosmic Serendipity", omen: "Try razor-sharp composition, celestial hues and balanced atmospheric depth.", symbol: "🌟" },
  { name: "The Alchemist", omen: "High transmutational energy; unexpected wildcard synergy and rich material textures.", symbol: "⚗️" },
  { name: "Solar Eclipse", omen: "Dramatic chiaroscuro, golden rim lighting, and velvet-deep obsidian contrast.", symbol: "☀️" },
  { name: "Velvet Horizon", omen: "Soft filmic grain, muted cinematic grading, and tranquil widescreen perspective.", symbol: "🌅" },
  { name: "Prismatic Dream", omen: "Luminous chromatic diffusion, pastel iridescence, and ethereal dreamlike lighting.", symbol: "💎" },
  { name: "The Grand Architect", omen: "Crisp structural precision, deliberate negative space, and commanding symmetry.", symbol: "🏛️" },
  { name: "Cyberpunk Neon", omen: "Electrified neon highlights, rain-slicked specular reflections, and hyper-vibrant energy.", symbol: "⚡" },
  { name: "Verdant Sanctuary", omen: "Organic harmony, dappled forest canopy light, and rich earthy botanicals.", symbol: "🌿" },
  { name: "Astral Mirage", omen: "Surrealistic wonder; floating celestial elements and luminous stellar dust.", symbol: "🌌" },
  { name: "Abyssal Pearl", omen: "Moody bioluminescence, deep sapphire shadows, and intricate fluid motion.", symbol: "🌊" },
  { name: "Chrono Drifter", omen: "Timeless analog warmth, gentle motion blur, and nostalgic vintage grain.", symbol: "⏳" },
  { name: "Golden Ratio", omen: "Sublime compositional harmony, golden-hour luminescence, and natural elegance.", symbol: "📐" },
  { name: "Obsidian Pulse", omen: "Monochrome elegance, high tactile contrast, and razor-sharp geometric edges.", symbol: "🖤" },
  { name: "Phoenix Dawn", omen: "Fiery warmth, amber sunrise luminescence, and bold energetic brushwork.", symbol: "🔥" },
  { name: "Quantum Flux", omen: "High-entropy creative chaos; daring subject juxtaposition and vivid saturation.", symbol: "⚛️" },
  { name: "Ethereal Whisper", omen: "Porcelain translucency, delicate micro-highlights, and tranquil soft-focus diffusion.", symbol: "🕊️" },
  { name: "Starlight Symphony", omen: "Glittering specular highlights, midnight navy depth, and majestic cinematic scale.", symbol: "✨" },
  { name: "Borealis Drift", omen: "Emerald and violet atmospheric auroras, crisp Arctic air, and crystalline detail.", symbol: "🌠" },
  { name: "Mythic Resonance", omen: "Heroic lighting, sculptural anatomy, and legendary epic fantasy gravitas.", symbol: "⚔️" },
  { name: "Supernova Flare", omen: "Blinding dynamic range, explosive color contrast, and radiant solar corona.", symbol: "💥" },
  { name: "Zenith Glow", omen: "Pure midday studio clarity, crisp neutral shadows, and master-level sharpness.", symbol: "☀️" },
  { name: "Kitsune Spirit", omen: "Whimsical mystique, vibrant vermilion accents, and fluid enchanting curves.", symbol: "🦊" },
  { name: "Iron & Ember", omen: "Industrial warmth, weathered patinas, molten sparks, and textured realism.", symbol: "⚒️" },
  { name: "Vaporwave Sunset", omen: "Magenta and cyan twilight, retro grid aesthetics, and nostalgic synth radiance.", symbol: "🌆" },
  { name: "Celestial Navigator", omen: "Expansive horizons, guiding starlight, and sweeping panoramic camera work.", symbol: "🧭" },
  { name: "Emerald Prism", omen: "Lush jewel-toned hues, jade reflections, and opulent micro-refractions.", symbol: "🔮" },
  { name: "Gambler's Fortuity", omen: "High-stakes fortune; uncanny serendipity and wildly photogenic surprises.", symbol: "🎲" },
  { name: "Aetherial Blossom", omen: "Delicate floral petals, drifting bokeh, and romantic spring morning light.", symbol: "🌸" },
  { name: "Mirage Weaver", omen: "Silken atmospheric mirages, desert warmth, and mesmerizing textural tapestries.", symbol: "🪄" },
  { name: "Hyperion Forge", omen: "Unmatched fidelity, volumetric sunbeams, and monumental architectural presence.", symbol: "🏰" },
  { name: "Shadow & Silver", omen: "Velvety noir shadows pierced by molten moonlight and cool silver speculars.", symbol: "🌙" },
  { name: "Infinity Matrix", omen: "Mathematical fractal beauty, infinite recursive detail, and multidimensional depth.", symbol: "♾️" },
];

/**
 * Curated classic seed presets.
 */
export const SEED_PRESETS = [
  { seed: 0, label: "0 · Genesis", desc: "An easy-to-remember starting point for repeatable comparisons" },
  { seed: 42, label: "42 · Deep Thought", desc: "The answer to life, universe and everything" },
  { seed: 777, label: "777 · Triple Lucky", desc: "A memorable triple-seven bookmark; no quality advantage" },
  { seed: 1337, label: "1337 · Leet Vision", desc: "A memorable leetspeak reference" },
  { seed: 2026, label: "2026 · Next Era", desc: "A year-inspired bookmark" },
];

/**
 * Hash function that computes a 32-bit integer from a seed string or number.
 */
function hashSeed(seed) {
  const str = String(seed ?? "0").trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Numerology root digit calculation (sums digits recursively until 1-9 or 11/22/33).
 */
function getNumerologyRoot(seed) {
  const digits = String(seed ?? "0").replace(/[^0-9]/g, "");
  if (!digits) return 1;
  let sum = digits.split("").reduce((acc, c) => acc + Number(c), 0);
  while (sum > 9 && sum !== 11 && sum !== 22 && sum !== 33) {
    sum = String(sum).split("").reduce((acc, c) => acc + Number(c), 0);
  }
  return sum;
}

/**
 * Returns deterministic fortune, archetype, rarity, and color matching for any seed.
 */
export function getSeedFortune(seed) {
  const rawSeed = String(seed ?? "0").trim();
  const num = Number(rawSeed);
  const hash = hashSeed(rawSeed);
  const archetypeIdx = hash % SEED_ARCHETYPES.length;
  const archetype = SEED_ARCHETYPES[archetypeIdx];

  // Rarity determination
  const rarityPercent = ((hash >>> 8) % 100 + 100) % 100;
  let rarity = "Uncommon";
  let rarityBadge = "🔮 Uncommon";
  let rarityTier = 1;
  if (rawSeed.endsWith("777") || rawSeed === "777" || rarityPercent < 5) {
    rarity = "Mythic";
    rarityBadge = "🌟 Mythic";
    rarityTier = 5;
  } else if (rarityPercent < 18) {
    rarity = "Legendary";
    rarityBadge = "🔥 Legendary";
    rarityTier = 4;
  } else if (rarityPercent < 42) {
    rarity = "Epic";
    rarityBadge = "💎 Epic";
    rarityTier = 3;
  } else if (rarityPercent < 72) {
    rarity = "Rare";
    rarityBadge = "✨ Rare";
    rarityTier = 2;
  }

  // Resonance / Luck percentage: strictly 80% to 99%
  const resonance = 80 + (((hash >>> 16) % 20 + 20) % 20);

  // Harmonized dynamic hue
  const hue = ((hash % 360) + 360) % 360;
  const numerology = getNumerologyRoot(rawSeed);

  return {
    seed: rawSeed,
    numericSeed: Number.isFinite(num) ? num : 0,
    archetype: archetype.name,
    symbol: archetype.symbol,
    omen: archetype.omen,
    rarity,
    rarityBadge,
    rarityTier,
    resonance,
    numerology,
    hue,
    // Theme-harmonized CSS color expression
    accentColor: `color-mix(in srgb, var(--wg-accent, #d49a52) 65%, hsl(${hue}, 85%, 62%))`,
    glowColor: `color-mix(in srgb, var(--wg-accent, #d49a52) 40%, hsl(${hue}, 85%, 62%))`,
  };
}

/**
 * Generate a cryptographically random safe seed.
 */
export function generateRandomSeed() {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    // Combine two 32-bit words into safe integer range (up to 2^53 - 1)
    const high = buf[0] & 0x1fffff;
    const low = buf[1];
    return high * 0x100000000 + low;
  }
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

/**
 * In-memory & persisted seed history (last 15 rolled seeds).
 */
const SEED_HISTORY_KEY = "prompt_palette_seed_history";
const SEED_FAVORITES_KEY = "prompt_palette_seed_favorites";

// Preferences can be imported or edited outside this UI. Return canonical numeric
// identities only, with the same representable uint64 bounds as the seed input.
function cleanSeed(seed) {
  if (typeof seed !== "string" && typeof seed !== "number") return null;
  const raw = String(seed).trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value < 2 ** 64
    ? String(value) : null;
}
function seedList(key, limit) {
  const saved = readEditorPreference(key, []);
  if (!Array.isArray(saved)) return [];
  return [...new Set(saved.map(cleanSeed).filter(seed => seed !== null))].slice(0, limit);
}

export function getSeedHistory() {
  return seedList(SEED_HISTORY_KEY, 15);
}

export function addSeedHistory(seed) {
  const clean = cleanSeed(seed);
  if (clean === null) return;
  const current = getSeedHistory().filter(s => s !== clean);
  current.unshift(clean);
  if (current.length > 15) current.length = 15;
  writeEditorPreference(SEED_HISTORY_KEY, current);
}

export function clearSeedHistory() {
  writeEditorPreference(SEED_HISTORY_KEY, []);
}

export function getFavoriteSeeds() {
  return seedList(SEED_FAVORITES_KEY, 20);
}

export function toggleFavoriteSeed(seed) {
  const clean = cleanSeed(seed);
  if (clean === null) return false;
  const current = getFavoriteSeeds();
  const idx = current.indexOf(clean);
  let isFav = false;
  if (idx >= 0) {
    current.splice(idx, 1);
  } else {
    current.unshift(clean);
    if (current.length > 20) current.length = 20;
    isFav = true;
  }
  writeEditorPreference(SEED_FAVORITES_KEY, current);
  return isFav;
}

export function isFavoriteSeed(seed) {
  const clean = cleanSeed(seed);
  return clean !== null && getFavoriteSeeds().includes(clean);
}
