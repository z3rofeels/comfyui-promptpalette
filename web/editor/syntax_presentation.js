import { escapeHtml } from "./text_utils.js";
export function syntaxTone(code) {
  if (/^\[(?:if|elif|else|\/if|switch|case|default|\/switch)/i.test(code)) return "logic";
  if (code.startsWith("${")) return "variable";
  if (code.startsWith("#")) return "note";
  if (/::|\$\$|:[+-]?\d+(?:\.\d+)?\)/.test(code)) return "weight";
  return "choice";
}
// Text is escaped before it reaches either popup; colors are existing theme tokens.
export function syntaxCodeHtml(code) {
  return String(code).split(/(\$\{|__[^\n]*?__|\[(?:if|elif|else|\/if|switch|case|default|\/switch)(?:\s+[^\]]+)?\]|[{}|]|\b\d+(?:\.\d+)?(?=::|\$\$)|[!*+%@])/gi).map(part => {
    const kind = /^\[/.test(part) ? "logic" : /^__/.test(part) ? "variable" : /^\d/.test(part) ? "weight" : /^(?:\$\{|[{}|!*+%@])$/.test(part) ? "delimiter" : "text";
    return `<span class="pp-syntax-${kind}">${escapeHtml(part)}</span>`;
  }).join("");
}
