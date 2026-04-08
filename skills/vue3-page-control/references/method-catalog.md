# Method Catalog

## setPageTitle

Purpose: update the page title/subtitle displayed in the Vue app.

Suggested args:

- `title` (string)
- `subtitle` (string, optional)

## showBanner

Purpose: display a status banner/toast style message area.

Suggested args:

- `message` (string)
- `level` (`info` | `success` | `warning` | `error`)

## setThemeTokens

Purpose: update page visual tokens (for example accent and panel colors).

Suggested args:

- `accent` (hex/rgb string)
- `panelBg` (hex/rgb string)
- `textColor` (hex/rgb string)

## updateStats

Purpose: update key-value stats shown on the page.

Suggested args:

- `items` (object, such as `{ onlineUsers: 128, pendingTasks: 7 }`)
