# Pi Desktop Viewer for Windows

[Download the latest Windows helper](https://github.com/studiodreamsummon/pi-desktop-viewer-releases/releases/latest/download/PiDesktopViewer.exe)

This repository distributes the Windows helper and its signed update manifest. The helper lets an approved phone view the Pi Desktop screen through your own SoloHost installation. It provides read-only viewing, phone approval and revocation, tray operation, and optional Windows sign-in startup.

1. On the Windows x64 PC running Pi Desktop and Docker, install the SoloHost app `mylg/pi-desktop-viewer`.
2. Download and run `PiDesktopViewer.exe`. If prompted, exit Pi Desktop using **File → Exit**; leave Docker and the node running.
3. On your phone, open [Pi Desktop Viewer in Pi Browser](https://solohost.pinet.com?app=mylg-pi-desktop-viewer) and connect.
4. Compare the confirmation numbers and approve the phone in the Windows helper.

Keep the PC, Docker and helper running. Closing the window hides it in the tray; **Exit** stops sharing. Sessions last up to eight hours and can be restarted. The helper and Viewer UI support English, Korean, Japanese, simplified/traditional Chinese, Vietnamese and Filipino.

For version 0.3.1 or earlier, fully exit the old helper from its tray menu and run the latest EXE once. Newer releases offer **Check for updates** inside the EXE. Updates preserve the PC identity, approved phones, language and automatic startup preference. A reinstalled SoloHost app may require the explicit **Reconnect SoloHost installation** confirmation and renewed phone approval.

The EXE verifies publisher signatures and SHA-256 hashes before applying updates. Windows Authenticode signing is not included, so Windows may display a publisher warning. The custom PNG appears where SoloHost supports image icons; its phone app list may show the platform's default framed-picture emoji.

No PC profiles, account data, private signing keys or captured screens are included in releases.
