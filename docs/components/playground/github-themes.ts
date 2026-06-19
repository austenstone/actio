import type * as monaco from 'monaco-editor';

// GitHub's official VS Code themes (primer/github-vscode-theme) ported to Monaco.
// VS Code themes match TextMate scopes; Monaco's YAML Monarch tokenizer emits its
// own token names (keys -> `type`, booleans/null -> `keyword`, anchors -> `namespace`,
// tags -> `tag`). We map each Monaco token to the colour GitHub's grammar+theme would
// produce for that YAML construct, so the playground reads like a GitHub editor.
// Colours lifted verbatim from the compiled dark-default / light-default themes.

export const GITHUB_DARK = 'github-dark';
export const GITHUB_LIGHT = 'github-light';

const dark: monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'e6edf3' },
    { token: 'comment', foreground: '8b949e' },
    { token: 'type', foreground: '7ee787' }, // mapping keys
    { token: 'string', foreground: 'a5d6ff' },
    { token: 'string.invalid', foreground: 'ffa198' },
    { token: 'number', foreground: '79c0ff' },
    { token: 'keyword', foreground: '79c0ff' }, // true / false / null
    { token: 'tag', foreground: 'ff7b72' }, // !tag handles
    { token: 'namespace', foreground: 'ffa657' }, // &anchors / *aliases
    { token: 'meta.directive', foreground: 'ff7b72' },
  ],
  colors: {
    'editor.background': '#0d1117',
    'editor.foreground': '#e6edf3',
    'editor.lineHighlightBackground': '#6e76811a',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#e6edf3',
    'editorCursor.foreground': '#2f81f7',
    'editorIndentGuide.background': '#e6edf31f',
    'editorIndentGuide.activeBackground': '#e6edf33d',
    'editorWhitespace.foreground': '#484f58',
    'editor.selectionBackground': '#1f6feb40',
    'editor.selectionHighlightBackground': '#3fb95040',
    'editorBracketMatch.background': '#3fb95040',
    'editorBracketMatch.border': '#3fb95099',
  },
};

const light: monaco.editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: true,
  rules: [
    { token: '', foreground: '1f2328' },
    { token: 'comment', foreground: '6e7781' },
    { token: 'type', foreground: '116329' }, // mapping keys
    { token: 'string', foreground: '0a3069' },
    { token: 'string.invalid', foreground: '82071e' },
    { token: 'number', foreground: '0550ae' },
    { token: 'keyword', foreground: '0550ae' }, // true / false / null
    { token: 'tag', foreground: 'cf222e' }, // !tag handles
    { token: 'namespace', foreground: '953800' }, // &anchors / *aliases
    { token: 'meta.directive', foreground: 'cf222e' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#1f2328',
    'editor.lineHighlightBackground': '#eaeef280',
    'editorLineNumber.foreground': '#8c959f',
    'editorLineNumber.activeForeground': '#1f2328',
    'editorCursor.foreground': '#0969da',
    'editorIndentGuide.background': '#1f23281f',
    'editorIndentGuide.activeBackground': '#1f23283d',
    'editorWhitespace.foreground': '#afb8c1',
    'editor.selectionBackground': '#0969da33',
    'editor.selectionHighlightBackground': '#4ac26b40',
    'editorBracketMatch.background': '#4ac26b40',
    'editorBracketMatch.border': '#4ac26b99',
  },
};

export function registerGithubThemes(m: typeof monaco): void {
  m.editor.defineTheme(GITHUB_DARK, dark);
  m.editor.defineTheme(GITHUB_LIGHT, light);
}
