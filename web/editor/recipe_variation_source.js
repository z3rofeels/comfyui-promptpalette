// Authored alternatives remain ordinary Prompt Palette resolver syntax.
import { maskJsonObjects } from '../engine/json_literals.js';
export const hasVariationSyntax = text => /__[+\-*%~@]?[A-Za-z0-9_\-/*]+(?:\([^\n]*?\))?__|\$\{|\{[^{}]*\||\[(?:if|elif|switch)\b/i.test(maskJsonObjects(String(text)));
export const fieldVariationSource = field => field.variationTemplate || field.value;
export function choicesFromLines(text) {
  const choices = [...new Set(String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
  if (choices.length < 2) throw new Error('Enter at least two different choices, one per line.');
  if (choices.length > 256 || choices.some(choice => /[{}|]/.test(choice))) throw new Error('Use up to 256 plain choices or __wildcards__. Edit nested braces or pipe syntax directly in the field.');
  // Leading modifier/multi-pick characters belong to the resolver grammar.
  // A leading space preserves them as part of the first authored choice.
  const prefix = /^[+*~@%\-]|^\d+(?:-\d+)?\$\$/.test(choices[0]) ? ' ' : '';
  const value = `{${prefix}${choices.join('|')}}`;
  if (value.length > 100_000) throw new Error('These choices exceed the field text limit.');
  return value;
}
export function editableChoiceLines(field) {
  const source = fieldVariationSource(field), match = source.match(/^\{([^{}]+)\}$/);
  return match && !/^[+*~@%\-]/.test(match[1]) ? match[1].split('|').map(choice => choice.trim()).join('\n') : source;
}
export function fieldVariationHint(field, fields) {
  if (!field.enabled) return 'Disabled: omitted from generation.';
  if (!field.value.trim()) return 'Empty: add text, set choices or insert a library wildcard.';
  if (field.experimentState === 'lock') return 'Locked: the captured value stays fixed across seeds and reloads. Original choices are kept for reuse.';
  const dynamic = hasVariationSyntax(fieldVariationSource(field));
  const method = { cycle: 'Cycles in order on each generation, including at a fixed seed.', shuffle: 'Shuffles choices on each generation, avoiding immediate repeats.', seed: 'Uses the seed: a fixed seed intentionally repeats its choice.', syntax: 'Uses the operators written in the field; generation follows those operators.' }[field.variationMode || 'cycle'];
  if (field.experimentState === 'follow') {
    const sources = fields.filter(f => field.dependsOn.includes(f.id)).map(f => f.label);
    if (!dynamic) return "Follow has one fixed value. Set choices to let it change when its sources change.";
    return sources.length ? `Follows ${sources.join(', ')}: holds its last choice until a source changes. ${method} Lists are not automatically matched by meaning.` : 'Choose a source below. Follow needs at least one source field.';
  }
  if (!dynamic) return 'This is one fixed value. Set choices or insert a library wildcard to make it vary.';
  return field.experimentState === 'vary' ? method + ' Plain choice lists and library lists support cycling; complex expressions use their written syntax.' : 'Default: ordinary seed-driven prompt syntax. Choose Vary to change choices on each generation.';
}
