# Who's Hat

Who's Hat is a Chrome Extension that is designed to help with live demos of web application. What is often difficult for people to follow in live demo's is the persona of the person that is being represented in the demo. The person running the demo often switches tabs and jumps around quickly and for the person watching, its hard to see who is who.

This Extension will let a User setup any number of "Personas". 

Each "Persona" will be defined with:
- Name
- Role
- Colour
- Upload an optional avatar image

Once setup, the User will be able to click the Extension icon to open a menu that will have the following:
- A list of each persona
- An option to add a new persona
- An option to deactivate the persona

For each of the persona in the menu, the user will be able to click on the name to "activate" or can click on an edit icon to edit the persons. 

Editing will let the user change any of the above details or delete the persona (with confirmation).

When activated, a persona will be applied to the current tab only. Each tab can be activated with a different persona so each tab can represent a different persona and be clearly visible.

When activated a 6 pixel border will be shown around the entire inner tab window, such that the web page is shown within the border. In the top middle the persona name will be shown in a notch style box embedded in the border. The avatar image will also be shown in the notch to the left of the name.

---

## Installing locally

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin "Who's Hat" to the toolbar so the icon is always visible

After editing any file, hit the reload icon on the extension card. Reload open
tabs too, so they pick up the new content script.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `popup/` | The menu: persona list, activate/deactivate, add/edit/delete |
| `background/service-worker.js` | Owns the tab → persona mapping, pushes it to tabs |
| `content/overlay.js` | Draws the frame and notch on the page |
| `shared/personas.js` | Persona storage + colour helpers |

- **Personas** live in `chrome.storage.local`, so they persist across restarts.
- **Tab assignments** live in `chrome.storage.session`, so they survive the
  service worker sleeping but are cleared when Chrome restarts — a persona
  never outlives the demo.
- The overlay sits in a **closed shadow root** on `<html>`, so page CSS can't
  restyle it and page scripts can't see it. It is `pointer-events: none`, so it
  never swallows a click even where the frame covers the scrollbar.
- The host is promoted into the browser's **top layer** (popover API), which
  paints above every page element whatever its z-index. A plain high z-index is
  not enough: the host is `position: fixed`, and fixed elements always create
  their own stacking context, so a z-index set inside it is trapped there.
- If a tab has no live content script (it was open before the extension was
  installed or reloaded), the worker injects one on demand rather than
  silently doing nothing.
- Assignment follows the tab, not the URL: navigating within an activated tab
  keeps the persona.

## Notes / limits

- Chrome blocks extensions on internal pages (`chrome://`, the Web Store, the
  New Tab page). The popup says so when you're on one.
- Avatars are centre-cropped and downscaled to 128×128 WebP on upload, so
  storage stays small.
- Going fullscreen puts that element in the top layer above us, so the overlay
  re-promotes itself on `fullscreenchange` to stay on top.
