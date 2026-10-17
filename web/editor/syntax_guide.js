// Presentation only: examples still come from the shared injector's template builders.
export const SYNTAX_GUIDE_GROUPS = [
  { id: "choice", title: "Choose & change", subtitle: "Try different scenes, outfits, or moods.", icon: "branch", tone: "choice" },
  { id: "wildcard", title: "Use your library", subtitle: "Let a saved list supply your prompt text.", icon: "gallery", tone: "variable" },
  { id: "weight", title: "Mix & emphasize", subtitle: "Pick several options or give one more attention.", icon: "bolt", tone: "weight" },
  { id: "variable", title: "Reuse text", subtitle: "Give something a name and use it again.", icon: "copy", tone: "variable" },
  { id: "logic", title: "Make decisions", subtitle: "Choose text when your conditions are met.", icon: "branch", tone: "logic" },
  { id: "note", title: "Keep notes", subtitle: "Leave reminders that stay out of the final prompt.", icon: "edit", tone: "note" },
];
const lessons = {
  "Random choice": ["Pick one option", "Separate alternatives with |. One is chosen when your prompt resolves; the same seed repeats the same pick.", "{forest|beach|city} → one setting, such as beach."],
  "Random choice — unseeded": ["Surprise me each time", "Choose one alternative afresh on each resolve, even when you keep the same seed.", "Use this when you want variety without changing the seed."],
  "Sequential choice — next": ["Take turns, forwards", "Use the first option, then the next on each resolve. After the last option, start again.", "{+forest|beach|city} → forest, then beach, then city."],
  "Sequential choice — previous": ["Take turns, backwards", "Step through your alternatives in reverse order and wrap around at the beginning.", "Useful for walking back through a sequence of choices."],
  "Cartesian choice cycle": ["Cycle combinations", "Combine this list with other % lists. Walk through their combinations across resolves.", "Pair {%red|blue} with {%coat|dress} to cycle color + outfit pairs."],
  "Weighted choice": ["Favor some options", "A larger number before :: makes that option more likely. Options without a number have weight 1.", "{3::forest|1::beach} favors forest. It can still pick beach."],
  "Joined selection": ["Pick several together", "Choose an exact number of alternatives and join them with your chosen separator.", "{2$$, $$red|green|blue} → two colors, such as red, blue."],
  "Joined selection — range": ["Pick a flexible amount", "Choose between a minimum and maximum number of alternatives, then join the selected text.", "1-2 asks for one or two options. The text between $$ pairs is the separator."],
  "Wildcard multi-pick slots": ["Mix several library picks", "Give a saved list several chances to provide an option, then choose a few of those picks.", "4# repeats the library reference into four option slots; 2$$ picks two slots."],
  "Variable assignment": ["Name a reusable value", "Store text under a name. The assignment itself disappears from the final prompt.", "${outfit=blue coat} stores a value. Use ${outfit} later to include it."],
  "Variable — resolve once": ["Pick once, reuse the result", "Resolve the choices when you assign them. Every later use of that name keeps the same result.", "${color=!{red|blue}} picks once; ${color} repeats that picked color."],
  "Variable with default": ["Use a backup value", "Read a named value, or use your backup text when that value has not been assigned.", "${outfit:blue coat} uses blue coat if outfit is missing."],
  "Reuse a variable": ["Use a named value", "Insert text you already stored with a variable assignment earlier in this prompt.", "After ${outfit=blue coat}, ${outfit} inserts blue coat."],
  "If / otherwise": ["Choose this or that", "Check a value you assigned earlier. Use the first text when it matches, otherwise use the text after else.", 'Set ${genre=cyberpunk} first. The sample uses neon lighting when genre is cyberpunk.'],
  "If / else if / otherwise": ["Check several possibilities", "Check conditions in order. The first match supplies the text; else is your backup.", "If, then elif, then else: only one matching branch is kept."],
  "Boolean AND": ["Require both conditions", "Use and when two conditions must both be true. Assign the named values before checking them.", "Fantasy AND calm gets soft light; any other pairing gets dramatic light."],
  "Boolean OR": ["Accept either condition", "Use or when matching either condition is enough.", "Fantasy OR sci-fi gets an imaginary world. Other genres get an everyday world."],
  "Boolean NOT": ["Reverse a condition", "Use not to choose text when a condition is false. Parentheses keep several checks together.", "not (fantasy or sci-fi) means neither of those genres."],
  "Switch / case / default": ["Match a value to a branch", "Check one named value against several cases. Use the first matching case, or default if none match.", "Set genre first: cyberpunk gets neon lighting; fantasy gets soft lighting."],
  "Membership": ["Match any item in a list", "Use in to check whether a value matches any of the alternatives separated with |.", 'genre in "fantasy"|"sci-fi" accepts either genre.'],
  "Numeric comparison": ["Check a number", "Compare a value you assigned using >, >=, <, <=, ==, or !=.", "With ${detail=3}, detail >= 2 is true and selects intricate."],
  "Nested branches": ["Make a decision inside another", "Check a second condition only inside the chosen branch of your first condition.", "Choose fantasy first, then use mood to choose a quiet or stormy forest."],
  "Comment line": ["Leave yourself a note", "Start a line with #. Prompt Palette keeps it in your editor and removes that line from resolved output.", "Put the note on its own line so it does not become part of your prompt."],
  "Parameterized wildcard": ["Customize a library template", "Pass named values into a saved entry that uses variable placeholders.", "A library template containing ${color:blue} can accept color=red."],
  "Phrase weight": ["Emphasize a phrase", "Add a numeric emphasis for encoders that support CLIP-style weights. Support depends on the model and encoder.", "(blue coat:1.2) asks for more emphasis than the normal 1.0 weight."],
};
const wildcardLessons = {
  "Random": ["Pick from a saved list", "Choose one line from a library entry. The same seed repeats the same choice.", "Replace category/name with an entry path from My Library."],
  "Random — unseeded": ["Fresh library pick each time", "Pick a new line from your saved list on each resolve, even with the same seed.", "The * before the path ignores the seed. ~ is an alias."],
  "Sequential — next": ["Walk through a saved list", "Use the next line from a library entry on each resolve. Wrap around after the last line.", "The + before the path walks forwards. @ is an alias."],
  "Sequential — previous": ["Walk backwards through a list", "Use the previous line from a library entry on each resolve.", "The - before the path walks backwards and wraps around."],
  "Cartesian cycle": ["Cycle saved-list combinations", "Pair this library list with other % lists and cycle through their combinations.", "Use % on each library or inline list that should take part in the cycle."],
};
export function syntaxGuideInfo(template, tone) {
  const key = template.wildcard ? template.label.replace(/^Wildcard · /, "") : template.label;
  const [title, description, example] = (template.wildcard ? wildcardLessons : lessons)[key] || [key, template.desc, "Replace the sample values with your own prompt text."];
  return { title, description, example, group: template.wildcard || key === "Parameterized wildcard" ? "wildcard" : tone };
}
