# CrossPoint Libby plugin

Search your library via Libby, borrow an EPUB (Adobe) loan, and save its `.acsm`
to the SD card. Use the "Protected Content" plugin to fetch the book.

Files: `manifest.json`, `plugin.js`. Unofficial; Libby endpoints may change.

> Note: the Libby API this plugin uses is private. OverDrive's terms prohibit
> third-party clients, so use it at your own risk.

## Test steps

1. Start File Transfer on the e-reader in **Join Network** mode (not Hotspot)
   and open the page it shows from a phone or PC on the same Wi-Fi.
2. In the File Manager, open the folder where books should be saved.
3. Install the plugin from the catalog and open **Libby Library**.
4. In the Libby app, use the **Sonos speaker connection** option. It gives the
   8-digit setup code. (The "Copy To Another Device" menu may not show one.)
5. Enter the code in the plugin and tap **Pair with Libby**. Codes expire fast.
6. Search, pick an "available" title, and tap **Borrow**. The `.acsm` is saved
   into the open folder.
7. Open **Protected Content**, select the `.acsm`, tap **Fetch selected book**.
8. Open the book from the reader.

If a step fails, copy the plugin's **Debug log** (tokens are redacted).
