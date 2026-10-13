# Webtwist

Theme websites with your Omarchy desktop colors.

This is the Firefox add-on. It themes web pages with your Omarchy desktop
palette, read through a small local helper, and keeps them in sync when you
change the desktop theme -- without a reload. Without the helper it still works,
using a bundled palette you pick from the popup. It also publishes the palette to
every page as CSS variables and a JavaScript API.

By default every site is themed. A built-in engine paints the page canvas, light
surfaces, text and links, and leaves media and hand-drawn art alone. Turn theming
off for a site from the toolbar popup or with `Alt+Shift+O`, and reach for
[Stylus](https://add0n.com/stylus.html) when a site deserves a hand-written look.

For the Chromium version and the original project, see
[omacom/omarchy-theme-sync](https://github.com/omacom/omarchy-theme-sync).

## Install

You need Firefox 142 or newer. There is nothing to build and no npm install.

The add-on works on its own with a bundled palette. To follow your live Omarchy
desktop theme it needs a small local helper, registered once with:

```bash
./install.sh
```

### From addons.mozilla.org

Once the add-on is published, install it the normal way from its listing page.

### From this folder, without publishing

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and
pick `extension/manifest.json`. Release Firefox keeps a temporary load only for
the session. To keep it, sign the package once with a free addons.mozilla.org
account and install the signed file:

```bash
npx web-ext sign --source-dir extension --channel unlisted \
  --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
```

Then open the generated `.xpi` from `about:addons` → gear → **Install Add-on From
File**. Firefox Developer Edition, Nightly, and ESR can instead install the
unsigned add-on permanently after setting `xpinstall.signatures.required` to
`false` in `about:config`.

Keep the project folder in place: the helper is registered from here.

The helper needs Bash, jq, inotify-tools, util-linux, and GNU coreutils with
`mv --no-copy` support. Node.js 22 or newer is only needed for the tests.

## Automatic Site Theming

Every site is themed by default. The engine pins the page canvas, text, links,
form controls, and scrollbars to the palette, then repaints the opaque surfaces a
page declares for itself -- white cards, light panels -- and darkens their text.
Images, video, and anything carrying its own background art are left alone. A
theme switch retints all of it live.

Turn it off for the current site from the toolbar popup, or press `Alt+Shift+O`.
The choice is remembered per site. The popup also shows the active theme and a
strip of its colors.

This is best-effort by design. A heavily styled page can still look wrong, and
that is the moment to turn the engine off for that site and, if you like, write a
Stylus style in its place.

## Choose the Palette

The popup's **Palette** row picks where the colors come from:

- **Desktop** follows your live Omarchy theme through the helper. This is the
  default.
- A **preset** pins a bundled palette -- Omarchy, Omarchy Light, Catppuccin Mocha,
  or Gruvbox -- and ignores the desktop theme.

With no helper running, **Desktop** falls back to the selected preset, so the
add-on themes pages on a machine without Omarchy. The pill at the top of the popup
says which source is in use: `desktop`, `preset`, or `no helper`. The bundled
palettes are plain color tables in `extension/presets.js`.

## Use Colors in CSS

The extension adds CSS variables to the page's `<html>` element:

```css
.card {
  background: var(--webtwist-background, #101913);
  color: var(--webtwist-foreground, #a1af9c);
  border: 1px solid var(--webtwist-accent, #4a9a68);
}
```

Always include a fallback color. Your site should still work when the extension is
not installed.

Color names come from the theme's `colors.toml` file. Underscores become hyphens:
`bright_green` becomes `--webtwist-bright-green`.

The `<html>` element also gets `data-webtwist-theme` and `data-webtwist-mode`
attributes for the theme name and light or dark mode.

## Use the JavaScript API

Check for `window.webtwist` before using it:

```js
const api = window.webtwist;

if (api) {
  console.log(api.theme);           // Theme name
  console.log(api.mode);            // "light" or "dark"
  console.log(api.color('accent')); // One color
  console.log(api.colors());        // All colors

  const stop = api.onChange((colors) => {
    console.log('Theme colors updated:', colors);
  });

  // Call stop() when your component or view is removed.
}
```

The palette arrives asynchronously. Initial reads can be empty; `onChange` also
fires when the first palette arrives.

## Keep the Palette in Sync with Stylus

The variables are ordinary CSS custom properties, so a Stylus userstyle can spend
them and stay in sync for free. Stylus CSS lives in the page, so
`var(--webtwist-accent)` re-resolves the instant the desktop theme changes -- no
reload, and nothing to update in Stylus.

A starter style lives at [`styles/webtwist.user.css`](styles/webtwist.user.css). Add
it to Stylus (**Install from URL**, or paste it as a new style) and edit the
selectors for the site you are working on. The built-in engine writes its
overrides inline, so turn the site's built-in theming off from the popup before a
Stylus style is expected to win the cascade.

## Apply or Install Themes

Reading colors is available to every page where the extension runs. Changing the
desktop theme is only allowed from a top-level `https://omarchy.org` page by
default. Embedded frames cannot write.

```js
const api = window.webtwist;

if (api && (await api.canSetTheme()).allowed) {
  const result = await api.setTheme('Tokyo Night');
  if (!result.ok) console.error(result.error);
}
```

To install a new palette from an allowed page:

```js
const result = await window.webtwist.installTheme({
  name: 'My Web Theme',
  colors: { background: '#101913', foreground: '#a1af9c', accent: '#4a9a68' },
});
```

- Colors must be six-digit hex strings such as `#4a9a68`.
- `background`, `foreground`, and `accent` are required.
- Existing themes are never overwritten. Use `setTheme(name)` to apply them.
- An optional `backgroundUrl` must be a direct HTTPS image on an allowed wallpaper
  host.

New themes are stored in `~/.config/omarchy/themes/<slug>/`.

## Security and Privacy

Every page where the extension runs can read your theme name and palette. Custom
colors can help identify you across sites. There is no per-site read opt-in.

An allowed write origin can change your theme without a confirmation prompt. Only
add origins you trust.

Automatic site theming runs inside the page and makes no network requests; it
never sends page content anywhere. Per-site on/off choices stay in local browser
storage. The extension limits downloads to a trusted wallpaper host, rejects
redirects, and caps image size and download time. The local helper validates
requests, protects existing themes, and limits installation rate and storage use.

See [Security Notes](docs/security.md) for the exact permissions, limits, and
remaining trust assumptions.

## Development

Plain JavaScript and Bash. No bundler and no dependencies to install. The add-on
is loaded straight from `extension/`, so there is nothing to build.

| Path | Purpose |
| --- | --- |
| `extension/` | Add-on: palette bridge, page API, auto-theme engine, popup, bundled presets |
| `bin/webtwist-host` | Local helper that reads and applies themes |
| `styles/` | Starter Stylus userstyle |
| `install.sh` | Native host registration and removal |
| `tests/` | Behavior and security regression tests |
| `docs/publishing.md` | AMO listing and submission runbook |

Run the tests from the project folder:

```bash
node --test tests/*.test.mjs
```

Tests use temporary profiles and stub desktop commands. They do not change your
real theme or browser profile. The browser DOM tests use headless Chromium and
skip if it is unavailable. The other tests still run.

After changing the add-on, reload it from `about:debugging`. Reloading also
restarts the connection to the local helper. Reload any open pages afterward.

## Troubleshooting

- **The palette is empty:** Confirm Omarchy has an active theme, then reload the add-on.
- **The add-on disappears after a restart:** A temporary load only lasts the session. Sign and install the package, as in [Install](#install).
- **A site looks wrong after theming:** Turn it off for that site from the popup or with `Alt+Shift+O`.
- **A Stylus style has no effect:** The built-in engine is still on for that site. Turn it off first.
- **You want to move the project folder:** Uninstall first, move it, then run `./install.sh` again.

## Uninstall

Run this before deleting or moving the project folder:

```bash
./install.sh --uninstall
```

Then remove the add-on from `about:addons` (a temporary load ends at restart
either way). This removes the browser registration, not themes you previously
installed or the helper's rate-limit state.

## Credits

Thanks to Discord user **anom**, for inspiring me to actually get around to
making this.

## License

[MIT](LICENSE). Externally hosted wallpapers are not covered by this license;
check the rights for those images before reusing them.

The extension icon uses the square logo from the
[official Omarchy brand assets](https://omarchy.org/brand). The logo is not
covered by this project's MIT license.
