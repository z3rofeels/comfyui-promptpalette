// Authored alternatives remain ordinary Prompt Palette resolver syntax.
export const hasVariationSyntax = text => /__[+\-*%~@]?[A-Za-z0-9_\-/*]+(?:\([^\n]*?\))?__|\$\{|\{[^{}]*\||\[(?:if|elif)\b/i.test(text);
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
  if (!field.enabled) return 'Disabled: excluded from the compiled prompt and variation.';
  if (!field.value.trim()) return 'Empty: enter a value, set choices or use a library wildcard.';
  const dynamic = hasVariationSyntax(fieldVariationSource(field));
  if (field.experimentState === 'lock') return hasVariationSyntax(field.value)
    ? 'Lock holds its resolved choice during this preview. Freeze current value to keep that choice across generation seeds.'
    : 'Lock protects this fixed value from variation. It stays the same across generation seeds.';
  if (field.experimentState === 'follow') {
    const sources = fields.filter(f => field.dependsOn.includes(f.id)).map(f => f.label);
    return !sources.length ? 'Follow in Vary Fields needs sources: choose the trigger fields below. Vary field can explore it directly.'
      : `Follow ${sources.join(', ')}: explores its choices only when a selected source changes.${dynamic ? '' : ' This field still needs choices to produce different values.'}`;
  }
  if (!dynamic) return `${field.experimentState === 'vary' ? 'Vary is selected, but this is fixed text.' : 'This field has one fixed value.'} Set choices or use a library wildcard to get alternatives.`;
  if (field.variationTemplate) return 'Selected value is in the prompt. Your original choices remain available for another preview; Restore choices puts them back in the editor.';
  return field.experimentState === 'vary' ? 'Vary explores these choices. Lock other fields to protect their captured results.'
    : 'Choices are ready. Select Vary to include this field in Vary Fields, or use Vary field to explore it alone.';
}
