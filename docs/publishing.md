# Publishing on addons.mozilla.org

This is the runbook for listing Webtwist on
[addons.mozilla.org](https://addons.mozilla.org) (AMO), so Firefox users can
install it with one click.

## What AMO does and does not distribute

AMO hosts and signs the add-on only. The native helper
(`bin/webtwist-host`) is a separate program that users install
themselves by running `./install.sh`. AMO does not install it, review it, or even
know about it.

That has two consequences worth stating plainly, in the listing and to reviewers:

- **The add-on works on its own.** Without the helper it themes pages with the
  bundled palette the user picks in the popup. This is what makes it reviewable
  on a machine that is not running Omarchy.
- **The desktop integration is opt-in.** Only after running `./install.sh` does
  the add-on follow the live desktop theme.

## One-time setup

1. **Confirm the add-on id.** It is permanent for the listing and is already set
   to `webtwist@signaldirective.github.io`, in both
   `extension/manifest.json` and the native helper registration in `install.sh`.
   `tests/installer.test.mjs` fails if the two disagree. Don't change it after
   publication: a new id means a new listing, and existing users stop receiving
   updates.

2. **Create a Mozilla account** and open the
   [developer hub](https://addons.mozilla.org/developers/).

3. **Generate API credentials** at
   <https://addons.mozilla.org/developers/addon/api/key/> and export them:

   ```bash
   export AMO_JWT_ISSUER='user:12345:67'
   export AMO_JWT_SECRET='…'
   ```

## Listing copy

Fill these in on the listing page. The description is deliberately explicit about
the helper so the add-on is not misleading.

- **Name:** Webtwist
- **Summary** (the manifest `description`): Theme websites with your Omarchy
  desktop colors and keep them in sync when your theme changes.
- **Description:**

  > Webtwist themes web pages with your Omarchy desktop palette.
  >
  > With the Omarchy helper installed, pages follow your live desktop theme and
  > retint the moment you switch themes -- no reload. Without it, pick one of the
  > bundled palettes (Omarchy, Omarchy Light, Catppuccin Mocha, Gruvbox) from the
  > toolbar popup, and pages are themed with it instead.
  >
  > - Automatic theming on every site, with a per-site off switch and the
  >   `Alt+Shift+O` shortcut.
  > - Images, video, and pages that carry their own artwork are left alone.
  > - Sites can opt in precisely with the `--webtwist-*` CSS variables and the
  >   `window.webtwist` JavaScript API.
  > - Works with [Stylus](https://add0n.com/stylus.html) userstyles, which read
  >   the same variables and stay in sync for free.
  >
  > The desktop integration uses a small local program (a native messaging host)
  > that is installed separately, outside the browser. Everything runs on your
  > machine; nothing is sent anywhere.

- **Category:** Appearance
- **License:** MIT (see `LICENSE`)
- **Homepage / Support:** the project repository and its issue tracker
- **Privacy policy:** a short note on the repository, or a link to
  `docs/security.md`.

## Data collection

Declared `none` in the manifest
(`browser_specific_settings.gecko.data_collection_permissions.required:
["none"]`), which is accurate: the add-on reads the desktop palette and writes it
into pages, and makes no outbound requests beyond the user-triggered wallpaper
download on an allowlisted host. Keep that declaration in every release; once
used, AMO expects it to stay.

## Notes to reviewers

AMO reviewers cannot run Omarchy, so give them the working path up front:

> This extension has two modes. With no native helper present it uses a bundled
> palette, so it is fully testable without Omarchy:
>
> 1. Install the extension and open any site. It is re-themed from the bundled
>    "Omarchy" palette; the toolbar popup shows the palette source as "no helper".
> 2. In the popup, switch the source to a preset (Catppuccin Mocha, Gruvbox) and
>    watch the page retint with no reload.
> 3. Toggle "Theme this site" (or press Alt+Shift+O) to turn theming off for one
>    site.
>
> The desktop integration is the optional path: it talks to a native messaging
> host named `com.webtwist.host`, installed by a separate `install.sh` on an
> Omarchy machine. Native messaging hosts are not installed or distributed by the
> browser; the add-on degrades to the bundled palette when the host is absent.
> `nativeMessaging` is declared for that path only.

Also point them at `docs/security.md` and note there is no build step, so the
submitted package is the source.

## Screenshots

AMO wants at least one; up to ten. Useful ones:

1. A light site (for example a plain documentation page) before and after theming.
2. The toolbar popup, showing the palette strip and the source chips.
3. A themed page next to the desktop, so the match is obvious.

The popup is the easiest: load the add-on, click the toolbar icon, capture the
popup.

## Build and submit

There is no build step. The package is the contents of `extension/` with
`manifest.json` at its root, which `web-ext` handles.

```bash
npx web-ext@latest lint --source-dir extension   # expect 0 errors
npx web-ext@latest sign --source-dir extension --channel listed \
  --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
```

The first submission goes to review; later ones update the listing. You can also
upload the signed file from the developer hub.

## Updates

- Bump `version` in `extension/manifest.json` for every upload; AMO rejects a
  version that is not newer than the last.
- Keep the add-on id unchanged.
- Re-run the tests and `web-ext lint` before uploading:

  ```bash
  node --test tests/*.test.mjs
  ```

## Checklist

- [ ] Add-on id decided and consistent between `extension/manifest.json` and `install.sh`
- [ ] `version` bumped
- [ ] `node --test tests/*.test.mjs` passes
- [ ] `web-ext lint --source-dir extension` reports no errors
- [ ] Listing copy, category, license, and support links filled in
- [ ] Data collection declared `none`
- [ ] Reviewer notes pasted
- [ ] At least one screenshot uploaded
