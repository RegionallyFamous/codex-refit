# Monspark Display

Monspark Display is an original angular display font with a monster-battle logo feel. It is designed to pair well with hot red/yellow fills, heavy black outlines, and blue impact shadows, but it is not copied from or affiliated with Pokemon or Bakugan.

## Files

- `MonsparkDisplay-Regular.ttf` - installable OpenType/TrueType font.
- `monspark-display.css` - `@font-face` helper for web use.
- `monspark-specimen.html` - local browser preview and usage sample.
- `monspark-preview.png` - quick rendered preview.
- `voltage-fang-codex/` - latest Codex-reviewed generated package mirrored from `~/Documents/GitHub/openai-font-foundry-runs`.

## Web Usage

Custom dev server:

```html
<link rel="stylesheet" href="/public/fonts/monspark-display.css">
```

Vite build output:

```html
<link rel="stylesheet" href="/fonts/monspark-display.css">
```

```css
.title {
  font-family: "Monspark Display", system-ui, sans-serif;
  color: #d72825;
  -webkit-text-stroke: 5px #071322;
  text-shadow: 4px 4px 0 #ffd72e, 9px 9px 0 #163da7;
}
```
