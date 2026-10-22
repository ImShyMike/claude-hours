// The rewrite's style, matching the code already here: no semicolons, single
// quotes, long lines
/** @type {import('prettier').Config} */
export default {
  semi: false,
  singleQuote: true,
  printWidth: 150,
  arrowParens: 'avoid',
  plugins: ['prettier-plugin-svelte', 'prettier-plugin-tailwindcss'],
  overrides: [{ files: '*.svelte', options: { parser: 'svelte' } }],
  tailwindStylesheet: './apps/web/src/routes/layout.css',
}
