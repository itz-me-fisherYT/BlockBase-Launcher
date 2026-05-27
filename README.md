# BlockBaseMC Launcher

BlockBaseMC is a custom Minecraft Java launcher focused on a clean profile workflow, Microsoft login, modpack imports, and Modrinth/CurseForge content management.

## Current Features

- Windows portable launcher build
- Browser-based Microsoft Java login
- Offline/dev Java accounts
- Java profile creation and imports
- Fabric, Quilt, Forge, NeoForge, Vanilla, and snapshot launch paths where upstream metadata is available
- Modrinth and CurseForge browsing/install support
- Modpack import/install support
- Installed mod/resource pack/shader management
- Running instance tracking and kill controls

## Development

Install dependencies:

```powershell
npm install
```

Build a Windows portable executable:

```powershell
npx electron-builder --win portable --config.directories.output=release-fast-local
```

## Releases

Do not commit `release-fast*` folders. Upload the generated `.exe` to GitHub Releases instead.

## Disclaimer

BlockBaseMC is not affiliated with Mojang, Microsoft, Prism Launcher, CurseForge, or Modrinth.
