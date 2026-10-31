# Window close and system tray

This behavior is part of the current internal development update.

## Desktop

- Closing the main window hides it to the system tray by default. **File → Quit** and the tray's **Quit** action exit the application.
- Unsaved files, project configuration or shared host documents open one decision dialog: **Save and close**, **Discard and close**, or **Cancel**.
- Saving includes the host's shared documents. A failed save, a collaboration conflict or new edits during the save keeps the window open.
- `closeToTray` in the user-data `desktop-lifecycle.json` defaults to `true`. Setting it to `false` makes the main close button quit; the tray remains available while the application is open.
- Click the tray icon to restore the window. The tray menu's **Quit** action uses the same save decision as a normal exit.

The shutdown controller coalesces repeated close requests, rejects expired replies and rechecks shared documents under the collaboration write lock. A renderer that stops responding does not grant permission to discard data. Tray preferences are stored in the application's data directory.

The native protocol freezes local input, prepares the shared-document transaction, then asks the renderer to commit against a fresh canonical snapshot before exiting. Discard uses a durable draft backup and blocks late shared updates from recreating the normal draft cache. A renderer restart in the same application run can recover an interrupted commit; a new application run clears the completed discard backup. Failed or timed-out commits reopen the decision and release the shared lock. Asynchronous state refreshes retain newer local configuration edits.

## Browser

The Web version registers the browser's unsaved-changes warning for local file and configuration changes. Browser security rules control its appearance and text; a browser tab's close button cannot display the desktop's custom three-choice dialog. Closing one browser tab does not exit the host service.

## Validation

Automated tests cover clean quit, cancellation, shared edits arriving after a close request, save failure, stale replies, tray hide/restore/quit, preference restoration, renderer timeouts, long save transactions, PNG structure and content-based unsaved-state comparison. Unit tests use a native-window substitute. A separate Windows Electron smoke check verified native tray creation and exercised the hide/restore/quit callbacks; manual interaction with the full workbench remains a separate acceptance step.

Manual acceptance should cover closing dirty files and project configuration, a collaborator editing while closing, cancelling and continuing to type, saving with a write error, tray restore/quit, language switching, and browser refresh/close with unsaved changes.
